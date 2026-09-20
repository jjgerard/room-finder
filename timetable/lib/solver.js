'use strict';

// Min-conflicts local search over components.
//
// Two decisions the whole design rests on:
//
// 1. The unit of movement is a component, not a class. Because a component
//    carries fixed internal offsets, the linked-group rules (same day,
//    contiguous, in group_order) and the exam rules are true by construction
//    and never need repairing. The search only ever has to fix room clashes,
//    cohort/staff clashes, room fit and same-day pairings.
//
// 2. Rooms move before times do. Belfast's rooms sit two-thirds empty, so most
//    conflicts resolve with a room swap that costs nothing in disruption. Time
//    moves are tried only when no room swap works, which is what keeps
//    movement low without having to trade it off explicitly.

const { build } = require('./components');

const { DAY_START, DAY_END, DAY_WIDTH } = require('./constraints');

const DAY_COUNT = 5;
const SLOT_MIN = 60;

// The teaching day is 09:15-17:15, so the legal starts are 09:15 to 16:15 —
// eight slots, not the thirteen the raw data happens to use.
const STARTS = [];
for (let t = DAY_START; t + SLOT_MIN <= DAY_END; t += SLOT_MIN) STARTS.push(t);

const HARD_MIN = DAY_START;
const HARD_MAX = DAY_END;
// The unpopular ends of the day: first hour and last hour.
const EDGE_EARLY = DAY_START + 60;
const EDGE_LATE = DAY_END - 60;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Solver {
  constructor(model, opts) {
    this.model = model;
    this.opts = Object.assign({
      seed: 12345,
      // 'current' starts from today's timetable; 'scatter' throws every
      // movable component at a random legal slot and room. Keeping today's
      // times is the lowest priority of all, so when a start anchored to them
      // plateaus short of clean, the anchor is what goes.
      start: 'current',
      maxIters: 400000,
      stallLimit: 120,   // rounds without improvement before giving up
      noise: 0.12,          // chance of taking a random repair instead of the best
      // Soft goals outrank movement: keeping the timetable still is the lowest
      // priority of all, below both the edge-slot and consecutive-days goals.
      wEdge: 10,            // soft: class in the 9-10am / 4-5pm edge slots
      wOutside: 30,         // soft: outside 09:15-18:15 altogether
      wWedPm: 0,            // soft: Wednesday afternoon (off unless asked for)
      wSpread: 8,           // soft: gap-day in a cohort's week
      // Scarcity: a seat left empty in a big room is a seat denied to the class
      // that needs it. Belfast has one room over 250 seats and three over 160,
      // so a 160-seat class parked in the 350-seat theatre does not merely
      // waste space — it is the reason the 350-seat lecture has nowhere to go.
      // Weighted per seat so the search prefers the smallest room that fits.
      wWaste: 0.05,
      // A class that does not need machines should not hold a computing lab
      // while computing classes are short of them.
      wLabSquat: 14,
      // The library's computer room is a student resource first; teaching goes
      // there only when a School lab is not free.
      wLibrary: 9,
      // A School's own lab is for that School. CEBE's IT labs and CAD lab go
      // to computing and engineering before anyone else — read from what has
      // been taught in each one rather than from a list of subject codes.
      wOtherSchool: 20,
      wMoveDay: 6,          // movement: changed day
      wMoveTime: 3,         // movement: changed time
      wMoveRoom: 1,         // movement: changed room
    }, opts || {});
    this.rand = mulberry32(this.opts.seed);

    const { components, conflicts } = build(model);
    this.components = components;
    // A component holding a pinned booking cannot move at all — the data marks
    // it "do not edit or remove", and it carries no cohort or clash information
    // to reschedule it against.
    for (let i = 0; i < components.length; i++) {
      components[i].id = i;
      components[i].fixed = components[i].members.some(m => m.cls.isFixed);
    }
    this.buildConflicts = conflicts;

    const n = Math.max(...model.classes.map(c => c.id)) + 1;
    this.n = n;
    this.day = new Int16Array(n).fill(-1);
    this.start = new Int32Array(n).fill(-1);
    this.room = new Int32Array(n).fill(-1);
    this.dur = new Int32Array(n);
    this.weeks = new Int32Array(n);
    this.compOf = new Int32Array(n).fill(-1);
    for (const c of model.classes) {
      this.dur[c.id] = c.dur;
      this.weeks[c.id] = c.weeks;
      this.compOf[c.id] = c.component;
    }

    // Per-class partner lists, so a move only re-examines what it can affect.
    this.timePartners = new Map();
    this.dayPartners = new Map();
    for (const c of model.classes) { this.timePartners.set(c.id, []); this.dayPartners.set(c.id, []); }
    for (const [a, b] of model.cannotShareTime) {
      this.timePartners.get(a).push(b); this.timePartners.get(b).push(a);
    }
    for (const [a, b] of model.cannotShareDay) {
      this.dayPartners.get(a).push(b); this.dayPartners.get(b).push(a);
    }

    // Programme → which days it currently has classes on. A cohort's days
    // should be consecutive, which is a property of the whole programme rather
    // than of any one class, so it is tracked as running counts and updated
    // only when a class actually changes day.
    this.progIdx = new Map();
    this.classProgs = new Map();
    for (const c of model.classes) {
      const list = [];
      for (const p of c.programmes) {
        if (!this.progIdx.has(p)) this.progIdx.set(p, this.progIdx.size);
        list.push(this.progIdx.get(p));
      }
      this.classProgs.set(c.id, list);
    }
    this.progDayCount = new Int32Array(this.progIdx.size * DAY_COUNT);

    // Pairs allowed to share a room, because they already do — see model.js.
    this.shares = model.mayShareRoom || new Set();
    this.candSet = new Map(model.classes.map(c => [c.id, new Set(c.cand)]));
    this.roomCount = model.rooms.length;
    // occupancy[room * 5 + day] → array of class ids
    this.occ = Array.from({ length: this.roomCount * DAY_COUNT }, () => []);

    this.reset();
  }

  reset() {
    for (let i = 0; i < this.occ.length; i++) this.occ[i].length = 0;
    this.progDayCount.fill(0);
    for (const c of this.model.classes) {
      this.day[c.id] = c.origDay;
      this.start[c.id] = c.origStart;
      this.room[c.id] = c.origRoom;
      this.occ[c.origRoom * DAY_COUNT + c.origDay].push(c.id);
      for (const p of this.classProgs.get(c.id)) this.progDayCount[p * DAY_COUNT + c.origDay]++;
    }
    // Start from today's timetable, but pulled into component geometry: 73 of
    // the 146 linked groups currently run with a gap between lecture and
    // seminar, and strict back-to-back means closing it. Placing each component
    // at its anchor's current slot keeps disruption minimal while making the
    // starting state consistent with the rules the search assumes hold.
    for (const comp of this.components) {
      comp.day = comp.origDay;
      comp.start = comp.origStart;
      if (comp.members.length > 1) this.moveComponent(comp, comp.origDay, comp.origStart);
    }
    if (this.opts.start === 'scatter') this.scatter();
    if (this.opts.start === 'greedy') this.construct();
  }

  /**
   * Build a timetable from nothing, hardest component first.
   *
   * The big-room band runs at 93-97% of usable capacity in weeks 1, 5 and 9 —
   * a near-perfect packing, which is where repairing an existing arrangement
   * stops working: every single move looks bad because everything is already
   * nearly full. Constructing instead, and letting the component with the
   * fewest rooms and the longest span choose first, is how a timetabler does
   * it by hand and puts the search in a different basin to start from.
   *
   * Fixed components keep their slots; everything else is placed against what
   * has been placed so far, never against a half-finished future.
   */
  construct() {
    // What a component really costs is a stripe through room x day x week: a
    // 7-hour block running weeks 1, 3 and 5 needs one room, on one day, free in
    // every one of those weeks. An ordinary 2-hour class running twelve weeks
    // makes that room-day unavailable to it, which is why in the last rebuild
    // ZERO of the fifty big room-days were free across weeks 1, 3 and 5 —
    // Lecture Theatre 3 looked empty on the Wednesday of week 5 and was held
    // all day in weeks 1 and 2 by another block.
    //
    // So blocks choose first, longest stripe first, and the short classes fill
    // in around them. Sorting by "fewest possible rooms" alone put the
    // specialist classes first and left the blocks picking through a grid that
    // weekly teaching had already cut to ribbons.
    const weeksOf = comp => {
      let mask = 0;
      for (const m of comp.members) mask |= m.cls.weeks;
      let n = 0;
      for (let i = 0; i < 16; i++) if (mask & (1 << i)) n++;
      return n;
    };
    const stripe = comp => (comp.span >= 5 * 60 ? 1e9 : 0) + comp.span * weeksOf(comp);
    const order = this.components
      .filter(c => !c.fixed)
      .sort((a, b) => {
        const sa = stripe(a), sb = stripe(b);
        if (sa !== sb) return sb - sa;
        const ra = Math.min(...a.members.map(m => this.roomChoices(m.cls.id).length));
        const rb = Math.min(...b.members.map(m => this.roomChoices(m.cls.id).length));
        return ra - rb || b.span - a.span || b.members.length - a.members.length;
      });

    // Lift everything movable out of the grid first, so an early component is
    // not blocked by a late one that has not chosen yet.
    for (const comp of order) {
      for (const m of comp.members) {
        const bucket = this.occ[this.room[m.cls.id] * DAY_COUNT + this.day[m.cls.id]];
        const at = bucket.indexOf(m.cls.id);
        if (at >= 0) bucket.splice(at, 1);
      }
      comp.placed = false;
    }
    // progDayCount must only count what is actually on the grid.
    this.progDayCount.fill(0);
    for (const c of this.model.classes) {
      if (!this.components[this.compOf[c.id]].fixed) continue;
      for (const p of this.classProgs.get(c.id)) this.progDayCount[p * DAY_COUNT + this.day[c.id]]++;
    }

    for (const comp of order) {
      const ids = comp.members.map(m => m.cls.id);
      const wide = comp.span > DAY_WIDTH;
      const starts = wide ? [DAY_START] : STARTS.filter(x => x + comp.span <= HARD_MAX);
      let best = null, bestScore = Infinity;
      for (let d = 0; d < DAY_COUNT; d++) {
        for (const st of starts) {
          // Put it down, choose rooms greedily, score, lift it again.
          for (const m of comp.members) {
            this.day[m.cls.id] = d;
            this.start[m.cls.id] = st + m.off;
          }
          const rooms = [];
          let score = 0;
          for (const m of comp.members) {
            const id = m.cls.id;
            let pick = null, pickCost = Infinity;
            for (const r of this.roomChoices(id)) {
              // Members of this component are not in the occupancy index yet,
              // so a sibling would be invisible here. Two that overlap in time
              // still cannot share a room — a multi-room exam is precisely
              // several sittings at one slot.
              let sibling = false;
              for (let k = 0; k < rooms.length; k++) {
                if (rooms[k] !== r) continue;
                const sib = comp.members[k];
                const ss = st + sib.off, ms = st + m.off;
                if (ms < ss + sib.cls.dur && ss < ms + m.cls.dur &&
                    (m.cls.weeks & sib.cls.weeks)) { sibling = true; break; }
              }
              if (sibling) continue;
              let clashes = 0;
              for (const other of this.occ[r * DAY_COUNT + d]) {
                if (this.shares.has(id < other ? id + ':' + other : other + ':' + id)) continue;
                if (this.start[id] < this.start[other] + this.dur[other] &&
                    this.start[other] < this.start[id] + this.dur[id] &&
                    (this.weeks[id] & this.weeks[other])) clashes++;
              }
              // Among rooms that work, take the tightest fit, so the big rooms
              // stay free for the classes that cannot use anything else.
              const room = this.model.rooms[r];
              const waste = room.capacityKnown ? Math.max(0, room.capacity - m.cls.size) : 0;
              const cost = clashes * 1000 + waste * 0.05 + this.roomReluctance(m.cls, room);
              if (cost < pickCost) { pickCost = cost; pick = r; }
              if (clashes === 0 && waste === 0) break;
            }
            if (pick === null) pick = m.cls.origRoom;
            rooms.push(pick);
            score += pickCost;
          }
          // Cohort and same-day rules, against what is already down.
          for (const m of comp.members) {
            const id = m.cls.id;
            for (const other of this.timePartners.get(id)) {
              if (this.day[other] !== d || this.room[other] < 0) continue;
              if (!this.components[this.compOf[other]].placed) continue;
              if (this.start[id] < this.start[other] + this.dur[other] &&
                  this.start[other] < this.start[id] + this.dur[id] &&
                  (this.weeks[id] & this.weeks[other])) score += 1000;
            }
            for (const other of this.dayPartners.get(id)) {
              if (!this.components[this.compOf[other]].placed) continue;
              if (this.day[other] === d) score += 1000;
            }
          }
          if (this.opts.wEdge) {
            for (const m of comp.members) {
              if (!m.cls.attended) continue;
              const ms = st + m.off;
              if (ms < EDGE_EARLY || ms >= EDGE_LATE) score += this.opts.wEdge;
            }
          }
          score += this.rand() * 4;   // break ties differently on each seed
          if (score < bestScore) { bestScore = score; best = { d, st, rooms }; }
        }
      }
      if (!best) best = { d: comp.origDay, st: comp.origStart, rooms: ids.map(i => this.model.byId.get(i).origRoom) };
      comp.day = best.d; comp.start = best.st;
      comp.members.forEach((m, k) => {
        const id = m.cls.id;
        this.day[id] = best.d;
        this.start[id] = best.st + m.off;
        this.room[id] = best.rooms[k];
        this.occ[best.rooms[k] * DAY_COUNT + best.d].push(id);
        for (const p of this.classProgs.get(id)) this.progDayCount[p * DAY_COUNT + best.d]++;
      });
      comp.placed = true;
    }
  }

  /**
   * Throw every movable component at a random legal slot, and every class into
   * a random room it may use.
   *
   * Starting from today's timetable inherits today's pile-ups: 557 bookings at
   * 09:15, and every big lecture already stacked on the handful of rooms that
   * can hold it. Min-conflicts repairs locally, so it cannot undo a bad global
   * shape — it can only shuffle within it. Scattering gives up the free
   * "nothing moved" head start in exchange for a search that is not trapped by
   * the arrangement it is asked to fix.
   */
  scatter() {
    for (const comp of this.components) {
      if (comp.fixed) continue;
      const wide = comp.span > DAY_WIDTH;
      const d = Math.floor(this.rand() * DAY_COUNT);
      const legal = wide ? [DAY_START] : STARTS.filter(s => s + comp.span <= HARD_MAX);
      if (!legal.length) continue;
      this.moveComponent(comp, d, legal[Math.floor(this.rand() * legal.length)]);
      for (const m of comp.members) {
        const choices = this.roomChoices(m.cls.id);
        if (choices.length) this.setRoom(m.cls.id, choices[Math.floor(this.rand() * choices.length)]);
      }
    }
  }

  // ---- placement primitives -------------------------------------------------

  place(id, day, start, room) {
    const oldDay = this.day[id];
    const oldKey = this.room[id] * DAY_COUNT + oldDay;
    const bucket = this.occ[oldKey];
    const at = bucket.indexOf(id);
    if (at >= 0) bucket.splice(at, 1);
    if (day !== oldDay && oldDay >= 0) {
      for (const p of this.classProgs.get(id)) {
        this.progDayCount[p * DAY_COUNT + oldDay]--;
        this.progDayCount[p * DAY_COUNT + day]++;
      }
    }
    this.day[id] = day; this.start[id] = start; this.room[id] = room;
    this.occ[room * DAY_COUNT + day].push(id);
  }

  /**
   * Gap-days for the given programmes: days with no class that sit between two
   * days that have one. A cohort taught Mon/Tue/Wed scores 0; one taught
   * Mon/Wed/Fri scores 2. Programmes on a single day cannot have a gap.
   */
  spreadPenalty(progs) {
    let total = 0;
    const iter = progs || Array.from({ length: this.progIdx.size }, (_, i) => i);
    for (const p of iter) {
      let first = -1, last = -1, used = 0;
      for (let d = 0; d < DAY_COUNT; d++) {
        if (this.progDayCount[p * DAY_COUNT + d] > 0) {
          if (first < 0) first = d;
          last = d; used++;
        }
      }
      if (used > 1) total += (last - first + 1) - used;
    }
    return total;
  }

  /** The programmes touched by a set of classes, deduplicated. */
  progsOf(ids) {
    const out = new Set();
    for (const id of ids) for (const p of this.classProgs.get(id)) out.add(p);
    return [...out];
  }

  moveComponent(comp, day, start) {
    for (const m of comp.members) {
      this.place(m.cls.id, day, start + m.off, this.room[m.cls.id]);
    }
    comp.day = day; comp.start = start;
  }

  setRoom(id, room) { this.place(id, this.day[id], this.start[id], room); }

  // ---- cost ----------------------------------------------------------------

  // Hard violations attributable to one class: every pair it is part of, plus
  // its own room fit and window. Summing this over a moving set and diffing
  // before/after gives an exact delta, because only pairs touching that set
  // can change.
  hardOf(id, seen) {
    let v = 0;
    const d = this.day[id], s = this.start[id], du = this.dur[id], w = this.weeks[id], r = this.room[id];

    const cls0 = this.model.byId.get(id);
    if (!cls0.isFixed && (s < HARD_MIN || (!cls0.windowExempt && s + du > HARD_MAX))) v++;

    const cls = this.model.byId.get(id);
    if (!(r === cls.origRoom) && !this.candSet.get(id).has(r)) v++;

    // The dedupe key carries the RULE as well as the pair. Two classes can
    // break two rules at once — sharing a room while also sharing a cohort —
    // and that is two violations, not one. Keying on the pair alone made the
    // solver blind to whichever it counted second, so it optimised a total
    // lower than the real one.
    for (const other of this.occ[r * DAY_COUNT + d]) {
      if (other === id) continue;
      if (this.shares.has(id < other ? id + ':' + other : other + ':' + id)) continue;
      const k = ROOM_RULE + pairKey(id, other);
      if (seen && seen.has(k)) continue;
      if (s < this.start[other] + this.dur[other] && this.start[other] < s + du && (w & this.weeks[other])) {
        v++;
        if (seen) seen.add(k);
      }
    }
    for (const other of this.timePartners.get(id)) {
      if (this.day[other] !== d) continue;
      const k = TIME_RULE + pairKey(id, other);
      if (seen && seen.has(k)) continue;
      if (s < this.start[other] + this.dur[other] && this.start[other] < s + du && (w & this.weeks[other])) {
        v++;
        if (seen) seen.add(k);
      }
    }
    for (const other of this.dayPartners.get(id)) {
      if (this.day[other] !== d) continue;
      const k = DAY_RULE + pairKey(id, other);
      if (seen && seen.has(k)) continue;
      v++;
      if (seen) seen.add(k);
    }
    return v;
  }

  softOf(id) {
    const cls = this.model.byId.get(id);
    const o = this.opts;
    let v = 0;
    const s = this.start[id], d = this.day[id];
    if (cls.attended) {
      // Inside a 09:15-17:15 day the only soft timing goal left is to keep the
      // first and last hours as empty as possible.
      if (s < EDGE_EARLY || s >= EDGE_LATE) v += o.wEdge;
      if (!cls.windowExempt && s + this.dur[id] > HARD_MAX) v += o.wOutside;
      if (o.wWedPm && d === 2 && s >= 13 * 60) v += o.wWedPm;
    }
    const room = this.model.rooms[this.room[id]];
    if (room) {
      if (o.wWaste && room.capacityKnown && room.capacity > cls.size) {
        v += o.wWaste * (room.capacity - Math.max(cls.size, 0));
      }
      if (o.wLabSquat && room.type === 'computer' && cls.roomType !== 'computer') v += o.wLabSquat;
      if (o.wLibrary && room.isLibrary) v += o.wLibrary;
    }
    if (d !== cls.origDay) v += o.wMoveDay;
    if (s !== cls.origStart) v += o.wMoveTime;
    if (this.room[id] !== cls.origRoom) v += o.wMoveRoom;
    return v;
  }

  costOf(ids) {
    const seen = new Set();
    let hard = 0, soft = 0;
    for (const id of ids) { hard += this.hardOf(id, seen); soft += this.softOf(id); }
    return { hard, soft };
  }

  totalHard() {
    const seen = new Set();
    let v = 0;
    for (const c of this.model.classes) v += this.hardOf(c.id, seen);
    return v;
  }

  violatingClasses() {
    const out = [];
    for (const c of this.model.classes) if (this.hardOf(c.id, null) > 0) out.push(c.id);
    return out;
  }

  // ---- moves ---------------------------------------------------------------

  // Candidate rooms for a class: its legal set, plus the room it holds today.
  roomChoices(id) {
    const cls = this.model.byId.get(id);
    const set = this.candSet.get(id);
    let out = set.size ? [...set] : [];
    if (cls.origRoom !== null && !set.has(cls.origRoom)) out.push(cls.origRoom);
    // A room held by a member of this class's own component that overlaps it
    // in time is not a choice. Those members move together, so every room
    // chooser treats them as "not in the way" — which is right for a lecture
    // and the seminar that follows it, and wrong for the several sittings of
    // one exam, which are at the same hour by construction. Excluding them
    // here fixes every chooser at once rather than each in turn.
    const comp = this.components[this.compOf[id]];
    if (comp && comp.members.length > 1) {
      const s0 = this.start[id], d0 = this.day[id], du = this.dur[id], w = this.weeks[id];
      const taken = [];
      for (const mm of comp.members) {
        const other = mm.cls.id;
        if (other === id) continue;
        if (this.day[other] !== d0) continue;
        if (!(s0 < this.start[other] + this.dur[other] && this.start[other] < s0 + du)) continue;
        if (!(w & this.weeks[other])) continue;
        taken.push(this.room[other]);
      }
      if (taken.length) out = out.filter(r => taken.indexOf(r) < 0);
    }
    return out;
  }

  /** Try to repair `id` by moving only its room. Returns true if it improved. */
  tryRoomRepair(id, force) {
    if (this.model.byId.get(id).isFixed) return false;
    const before = this.costOf([id]);
    const cur = this.room[id];
    // `force` takes the least-bad room even when it is no better than the one
    // held, which starts an ejection chain: the class displaced by the move is
    // itself a violation next round, and gets its own turn. Without it a class
    // whose every room is occupied has no room move at all, and the search has
    // to reach for the much blunter instrument of moving its whole group to
    // another day.
    let best = null, bestScore = force ? Infinity : before.hard * 1000 + before.soft;
    const choices = this.roomChoices(id);
    for (const r of choices) {
      if (r === cur) continue;
      this.setRoom(id, r);
      const c = this.costOf([id]);
      const score = c.hard * 1000 + c.soft;
      if (score < bestScore || (best === null && score === bestScore && this.rand() < 0.1)) {
        bestScore = score; best = r;
      }
      this.setRoom(id, cur);
    }
    if (best !== null) { this.setRoom(id, best); return true; }
    return false;
  }

  /**
   * Try to repair `id` by EXCHANGING rooms with a class it clashes with, or
   * with one sitting in a room it wants.
   *
   * Moving one class needs a free room. At the top of the capacity ladder there
   * are none: 19 classes need 315+ seats and Belfast has one room that size, so
   * every big room is busy whenever a big lecture is looking. A swap needs no
   * free room, only two classes each able to use the other's — which is common,
   * because "too big" never disqualifies a room, only "too small" does.
   */
  tryRoomSwap(id) {
    const cls = this.model.byId.get(id);
    if (cls.isFixed) return false;
    const d = this.day[id], s = this.start[id], du = this.dur[id], w = this.weeks[id];
    const mine = this.room[id];
    const mySet = this.candSet.get(id);

    // Partners worth trying: whoever sits in a room this class could use, on
    // this day, overlapping it. Anything else is not what is blocking it.
    const partners = [];
    for (const r of this.roomChoices(id)) {
      if (r === mine) continue;
      for (const other of this.occ[r * DAY_COUNT + d]) {
        if (other === id) continue;
        const o = this.model.byId.get(other);
        if (o.isFixed) continue;
        if (!(this.candSet.get(other).has(mine) || o.origRoom === mine)) continue;
        if (!(s < this.start[other] + this.dur[other] && this.start[other] < s + du)) continue;
        if (!(w & this.weeks[other])) continue;
        partners.push(other);
      }
    }
    if (!partners.length) return false;

    const before = this.costOf([id, ...partners]);
    let best = null, bestScore = before.hard * 1000 + before.soft;
    for (const other of partners) {
      const theirs = this.room[other];
      this.setRoom(id, theirs); this.setRoom(other, mine);
      const c = this.costOf([id, ...partners]);
      const score = c.hard * 1000 + c.soft;
      if (score < bestScore) { bestScore = score; best = other; }
      this.setRoom(id, mine); this.setRoom(other, theirs);
    }
    if (best === null) return false;
    const theirs = this.room[best];
    this.setRoom(id, theirs); this.setRoom(best, mine);
    return true;
  }

  /**
   * Try to repair `id` by putting it back exactly where it sits today.
   *
   * Today's timetable is a working arrangement for most of the term, and the
   * search throws that away: it moves a class for a soft gain, something else
   * takes the vacated slot, and the original placement — which was provably
   * fine — becomes unreachable through the ordinary moves, because each of
   * them is judged one at a time.
   *
   * Five lectures that can only use Lecture Theatre 1 sit across the week
   * today without touching each other; a search that had never considered
   * going home stacked three of them on top of each other.
   *
   * It belongs at the END, not in the repair loop. Offering it on every
   * repair was measured and made things worse — 11 violations became 16 —
   * because pulling classes back mid-search undoes the displacement the
   * repair depends on, and costs the variety the restarts feed on. Once the
   * timetable has stopped moving, the same move only helps.
   */
  tryHomeRepair(id) {
    const cls = this.model.byId.get(id);
    if (cls.isFixed) return false;
    const comp = this.components[this.compOf[id]];
    if (comp.fixed) return false;
    // The component must move as one, so home for the class means home for
    // everything attached to it, offsets intact.
    const off = comp.members.find(mm => mm.cls.id === id).off;
    const day = cls.origDay, start = cls.origStart - off;
    if (day === comp.day && start === comp.start &&
        comp.members.every(mm => this.room[mm.cls.id] === mm.cls.origRoom)) return false;
    if (start < HARD_MIN) return false;
    if (comp.span <= DAY_WIDTH && start + comp.span > HARD_MAX) return false;

    const ids = comp.members.map(mm => mm.cls.id);
    const before = this.costOf(ids);
    const oldDay = comp.day, oldStart = comp.start;
    const oldRooms = ids.map(i => this.room[i]);

    this.moveComponent(comp, day, start);
    for (const mm of comp.members) this.setRoom(mm.cls.id, mm.cls.origRoom);
    const after = this.costOf(ids);
    if (after.hard < before.hard ||
        (after.hard === before.hard && after.soft < before.soft)) return true;

    this.moveComponent(comp, oldDay, oldStart);
    ids.forEach((i, k) => this.setRoom(i, oldRooms[k]));
    return false;
  }

  /**
   * Try to repair by moving the whole component of `id` to another day/time,
   * reassigning rooms greedily at the destination.
   */
  tryTimeRepair(id, mode) {
    const comp = this.components[this.compOf[id]];
    if (comp.fixed) return false;
    const ids = comp.members.map(m => m.cls.id);
    const before = this.costOf(ids);
    const origDay = comp.day, origStart = comp.start;
    const origRooms = ids.map(i => this.room[i]);

    // 'improve' only accepts a strictly better slot. 'minconflict' takes the
    // least-bad slot available even when that is no better than where it sits,
    // which is what lets a stuck class displace others and break a deadlock —
    // the displaced classes are themselves repaired on later rounds.
    let bestScore = mode === 'minconflict' ? Infinity : before.hard * 1000 + before.soft;
    let best = null;

    const restore = () => {
      this.moveComponent(comp, origDay, origStart);
      ids.forEach((i, k) => this.setRoom(i, origRooms[k]));
    };

    const wide = comp.span > DAY_WIDTH;
    for (let d = 0; d < DAY_COUNT; d++) {
      for (const s of STARTS) {
        if (d === origDay && s === origStart) continue;
        // A component wider than the day can only start at the very beginning
        // of it; everything else must finish inside it.
        if (wide ? s !== DAY_START : s + comp.span > HARD_MAX) continue;
        this.moveComponent(comp, d, s);
        // Greedily give each member the best room available at the new time.
        for (const i of ids) this.tryRoomRepair(i);
        const c = this.costOf(ids);
        const score = c.hard * 1000 + c.soft;
        if (score < bestScore) {
          bestScore = score;
          best = { d, s, rooms: ids.map(i => this.room[i]) };
        }
        restore();
      }
    }
    if (!best && mode === 'random') {
      // Sideways/uphill step to escape a local minimum.
      const d = Math.floor(this.rand() * DAY_COUNT);
      const s = wide ? DAY_START : STARTS[Math.floor(this.rand() * STARTS.length)];
      if (wide || s + comp.span <= HARD_MAX) {
        this.moveComponent(comp, d, s);
        for (const i of ids) this.tryRoomRepair(i);
        return true;
      }
      return false;
    }
    if (best) {
      this.moveComponent(comp, best.d, best.s);
      ids.forEach((i, k) => this.setRoom(i, best.rooms[k]));
      return true;
    }
    return false;
  }

  /**
   * Main loop: repair hard violations until none remain or the budget runs out.
   *
   * Works in rounds rather than picking one violation at a time, so the full
   * scan for violations is paid once per round and amortised over the ~300
   * repairs it finds, instead of once per repair.
   */
  /**
   * Place every component that starts outside the teaching day at its
   * least-conflicted legal slot, before min-conflicts begins.
   *
   * Today's timetable piles 557 bookings into 09:15 and spills another 120
   * outside 09:15-17:15 altogether. Handing that to min-conflicts as a starting
   * point means it spends its whole budget digging out of a pile-up rather than
   * resolving genuine conflicts, and it plateaus well short of clean.
   */
  seedWindow() {
    const wide = c => c.span > DAY_WIDTH;
    const needs = this.components.filter(comp => {
      if (comp.fixed) return false;
      const s = comp.start;
      return s < HARD_MIN || (!wide(comp) && s + comp.span > HARD_MAX);
    });
    // Hardest first: a component with few legal slots should choose before the
    // flexible ones have filled them.
    needs.sort((a, b) => b.span - a.span);
    let placed = 0;
    for (const comp of needs) {
      if (this.tryTimeRepair(comp.members[0].cls.id, 'minconflict')) placed++;
    }
    return placed;
  }

  /**
   * Re-assign every room from scratch at the times currently held.
   *
   * Local repair can only ask "is there a better room for THIS class", and at
   * the top of the capacity ladder the answer is always no: every big room is
   * occupied, often by a class that did not need it. Repacking asks the
   * question the other way round — hardest class first, smallest room that
   * fits — which is how a human timetabler allocates rooms and what keeps the
   * three big lecture theatres free for the lectures that cannot go anywhere
   * else.
   *
   * Times are untouched, so nothing that depends on them (contiguity, cohort
   * clashes, the teaching day) can be disturbed by this pass.
   */
  /** Soft reluctance to put this class in this room; never a bar. */
  roomReluctance(cls, room) {
    const o = this.opts;
    let v = 0;
    if (!room) return v;
    if (o.wLabSquat && room.type === 'computer' && cls.roomType !== 'computer') v += o.wLabSquat;
    if (o.wLibrary && room.isLibrary) v += o.wLibrary;
    if (o.wOtherSchool && room.isSchoolLab && room.subjects && room.subjects.size) {
      const subj = String(cls.module || '').replace(/[0-9].*$/, '');
      if (subj && !room.subjects.has(subj)) v += o.wOtherSchool;
    }
    return v;
  }

  repackRooms(jitter) {
    const movable = this.model.classes.filter(c => !c.isFixed);
    // Hardest first: fewest rooms it could use, then biggest, then longest.
    const noise = new Map();
    if (jitter) for (const c of movable) noise.set(c.id, this.rand() * 6 - 3);
    const key = c => this.roomChoices(c.id).length + (noise.get(c.id) || 0);
    const order = movable.slice().sort((a, b) =>
      key(a) - key(b) ||
      b.size - a.size ||
      b.dur - a.dur);

    // Empty every movable class out of its room first, so an early class is
    // not blocked by a later one that has not chosen yet.
    const parked = new Map();
    for (const c of order) {
      parked.set(c.id, this.room[c.id]);
      const bucket = this.occ[this.room[c.id] * DAY_COUNT + this.day[c.id]];
      const at = bucket.indexOf(c.id);
      if (at >= 0) bucket.splice(at, 1);
    }

    for (const c of order) {
      const id = c.id, d = this.day[id], st = this.start[id], du = this.dur[id], w = this.weeks[id];
      let best = null, bestScore = Infinity;
      // Smallest adequate room first: a bigger one is only taken when the
      // smaller ones are busy.
      const choices = this.roomChoices(id).slice().sort((x, y) => {
        const rx = this.model.rooms[x], ry = this.model.rooms[y];
        const cx = rx.capacityKnown ? rx.capacity : 1e6, cy = ry.capacityKnown ? ry.capacity : 1e6;
        return cx - cy;
      });
      for (const r of choices) {
        let clashes = 0;
        for (const other of this.occ[r * DAY_COUNT + d]) {
          if (this.shares.has(id < other ? id + ':' + other : other + ':' + id)) continue;
          if (st < this.start[other] + this.dur[other] && this.start[other] < st + du &&
              (w & this.weeks[other])) clashes++;
        }
        const score = clashes * 1000 + this.roomReluctance(c, this.model.rooms[r]);
        if (score < bestScore) { bestScore = score; best = r; }
        if (score === 0) break;
      }
      if (best === null) best = parked.get(id);
      this.room[id] = best;
      this.occ[best * DAY_COUNT + d].push(id);
    }
  }

  run(report) {
    const o = this.opts;
    this.seedWindow();
    if (o.repack !== false) this.repackRooms();
    let best = this.snapshot(), bestHard = this.totalHard();
    let iter = 0, round = 0, stall = 0;

    while (iter < o.maxIters) {
      let bad = this.violatingClasses();
      if (!bad.length) break;

      // Random order. Repairing the most-constrained class first is the
      // textbook heuristic and was tried here; it made the plateau worse,
      // because the repack pass already gives scarce rooms to the classes that
      // need them, and ordering the repairs on top of that only removed the
      // variety the restarts depend on.
      for (let i = bad.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [bad[i], bad[j]] = [bad[j], bad[i]];
      }

      for (const id of bad) {
        if (iter >= o.maxIters) break;
        if (this.hardOf(id, null) === 0) continue; // an earlier repair got it
        const noisy = this.rand() < o.noise;
        if (!noisy && this.tryRoomRepair(id)) { iter++; continue; }
        if (!noisy && this.tryRoomSwap(id)) { iter++; continue; }
        if (this.tryTimeRepair(id, 'improve')) { iter++; continue; }
        // Nothing improves it. Take the least-bad slot anyway and let the
        // classes it displaces be repaired next round. A random jump is kept
        // as a rare last resort: applying one to every stuck class scatters
        // the timetable and the search never recovers.
        if (this.tryTimeRepair(id, noisy ? 'random' : 'minconflict')) { iter++; continue; }
        this.tryRoomRepair(id, true);
        iter++;
      }

      const hard = this.totalHard();
      if (hard < bestHard) { bestHard = hard; best = this.snapshot(); stall = 0; }
      else stall++;
      round++;
      if (report) report({ round, iter, hard, best: bestHard, bad: bad.length });
      if (hard === 0) break;
      // Drifting well above the best found wastes the budget — go back and
      // retry from there with different random choices.
      if (hard > bestHard * 1.5 + 10) { this.restore(best); }
      // A stall means local repair has run out of single moves. Repacking every
      // room at once is the one step that can cross that plateau, because it
      // changes hundreds of assignments together rather than one at a time.
      if (o.repack !== false && stall && stall % 6 === 0) {
        let before = this.totalHard(), keep = this.snapshot();
        // Several orders, keeping the best: the tie-breaks among equally hard
        // classes decide which of them gets the last big room, and there is no
        // way to know in advance which choice pays.
        for (let k = 0; k < 3; k++) {
          this.repackRooms(k > 0);
          const after = this.totalHard();
          if (after < before) { before = after; keep = this.snapshot(); }
          else this.restore(keep);
        }
      }
      if (stall > o.stallLimit) break;
    }

    if (this.totalHard() > bestHard) this.restore(best);
    // One last sweep home. By this point the timetable has stopped moving, so
    // a slot that was taken when a class first looked may well be free again.
    for (let pass = 0; pass < 3; pass++) {
      const bad = this.violatingClasses();
      if (!bad.length) break;
      let moved = 0;
      for (const id of bad) if (this.tryHomeRepair(id)) moved++;
      if (!moved) break;
    }
    return { iters: iter, rounds: round, hard: this.totalHard() };
  }

  /**
   * Endgame: ruin the region around each surviving violation and rebuild it.
   *
   * Min-conflicts ends up in a state where no single move helps, but a dozen
   * co-ordinated ones would: four lectures each need the same big room, and
   * untangling them means moving all four at once. This picks the components
   * caught up in a violation, plus the ones holding the rooms they want,
   * scatters that handful at random, and re-runs the ordinary repair on them.
   * If the result is worse it is thrown away, so the timetable can only
   * improve — and because the region is small, dozens of attempts cost less
   * than one more full pass.
   */
  intensify(attempts) {
    let bestHard = this.totalHard();
    if (bestHard === 0) return bestHard;
    let best = this.snapshot();

    for (let a = 0; a < (attempts || 60) && bestHard > 0; a++) {
      // The region: components in violation, and whoever holds the rooms they
      // could use at the times they are sitting at.
      const region = new Set();
      const bad = this.violatingClasses();
      if (!bad.length) break;
      // One violation's neighbourhood at a time keeps the region small enough
      // to search properly; which one is chosen rotates with the attempt.
      const pick = bad[Math.floor(this.rand() * bad.length)];
      const seeds = [pick];
      for (const other of this.timePartners.get(pick)) {
        if (this.day[other] === this.day[pick]) seeds.push(other);
      }
      for (const id of seeds) {
        region.add(this.compOf[id]);
        const d = this.day[id], st = this.start[id], du = this.dur[id];
        for (const r of this.roomChoices(id)) {
          for (const other of this.occ[r * DAY_COUNT + d]) {
            if (st < this.start[other] + this.dur[other] && this.start[other] < st + du) {
              region.add(this.compOf[other]);
            }
          }
        }
      }
      const comps = [...region].map(i => this.components[i]).filter(c => !c.fixed);
      if (comps.length < 2) continue;

      const keep = this.snapshot();
      // Ruin: scatter the region.
      for (const comp of comps) {
        const wide = comp.span > DAY_WIDTH;
        const legal = wide ? [DAY_START] : STARTS.filter(x => x + comp.span <= HARD_MAX);
        if (!legal.length) continue;
        this.moveComponent(comp, Math.floor(this.rand() * DAY_COUNT),
          legal[Math.floor(this.rand() * legal.length)]);
      }
      // Recreate: ordinary repair, but only on the region.
      const ids = [];
      for (const comp of comps) for (const m of comp.members) ids.push(m.cls.id);
      for (let round = 0; round < 12; round++) {
        let any = false;
        for (const id of ids) {
          if (this.hardOf(id, null) === 0) continue;
          any = true;
          if (this.tryRoomRepair(id)) continue;
          if (this.tryRoomSwap(id)) continue;
          if (this.tryTimeRepair(id, 'improve')) continue;
          this.tryTimeRepair(id, 'minconflict');
        }
        if (!any) break;
      }

      const now = this.totalHard();
      if (now < bestHard) { bestHard = now; best = this.snapshot(); }
      else this.restore(keep);
    }
    this.restore(best);
    return bestHard;
  }

  /**
   * Every legal placement for a component, with the components it would
   * displace. Ordered by how few that is, so a caller tries the cheapest
   * chains first.
   */
  placementOptions(comp) {
    const wide = comp.span > DAY_WIDTH;
    const starts = wide ? [DAY_START] : STARTS.filter(x => x + comp.span <= HARD_MAX);
    const out = [];
    for (let d = 0; d < DAY_COUNT; d++) {
      for (const st of starts) {
        const rooms = [];
        const displaced = new Set();
        let illegal = false;
        for (const mm of comp.members) {
          const id = mm.cls.id, s = st + mm.off, du = this.dur[id], w = this.weeks[id];
          // Cohort and same-day rules are not negotiable by displacing someone
          // else: they are about people, who cannot be moved to another room.
          for (const other of this.timePartners.get(id)) {
            if (comp.members.some(x => x.cls.id === other)) continue;
            if (this.day[other] !== d) continue;
            if (s < this.start[other] + this.dur[other] && this.start[other] < s + du &&
                (w & this.weeks[other])) { illegal = true; break; }
          }
          if (illegal) break;
          for (const other of this.dayPartners.get(id)) {
            if (comp.members.some(x => x.cls.id === other)) continue;
            if (this.day[other] === d) { illegal = true; break; }
          }
          if (illegal) break;

          // Pick the room that displaces the fewest, preferring none at all.
          let best = null, bestCount = Infinity, bestHit = null;
          for (const r of this.roomChoices(id)) {
            // Own members are skipped below because they move together, which
            // also hides a sibling collision. Two that overlap in time need
            // different rooms.
            let sibling = false;
            for (let k = 0; k < rooms.length; k++) {
              if (rooms[k] !== r) continue;
              const sib = comp.members[k];
              const ss = st + sib.off;
              if (s < ss + sib.cls.dur && ss < s + du && (w & sib.cls.weeks)) { sibling = true; break; }
            }
            if (sibling) continue;
            const hit = [];
            for (const other of this.occ[r * DAY_COUNT + d]) {
              if (comp.members.some(x => x.cls.id === other)) continue;
              if (this.shares.has(id < other ? id + ':' + other : other + ':' + id)) continue;
              if (s < this.start[other] + this.dur[other] && this.start[other] < s + du &&
                  (w & this.weeks[other])) hit.push(other);
            }
            const cost = hit.length * 10 + this.roomReluctance(mm.cls, this.model.rooms[r]) * 0.01;
            if (cost < bestCount) { bestCount = cost; best = r; bestHit = hit; }
            if (!hit.length) break;
          }
          if (best === null) { illegal = true; break; }
          rooms.push(best);
          for (const other of bestHit) displaced.add(this.compOf[other]);
        }
        if (illegal || rooms.length !== comp.members.length) continue;
        out.push({ day: d, start: st, rooms, displaced });
      }
    }
    out.sort((a, b) => a.displaced.size - b.displaced.size);
    return out;
  }

  /**
   * Move a class by moving whatever is in its way, and whatever is in THAT
   * way, up to a few links deep.
   *
   * The clashes that survive everything else are pairs stacked in one room at
   * one hour where both classes have ten rooms to choose from and all ten are
   * busy. No single move helps, and a random ruin rarely stumbles on the right
   * combination — but a chain does: move A into B's room, move B somewhere
   * that displaces C, move C into a gap. Bounded hard, because it is
   * exponential: a handful of placements per level, three levels.
   */
  chainRepair(startId, maxDepth, nodes) {
    const comp = this.components[this.compOf[startId]];
    if (comp.fixed) return false;
    const before = this.totalHard();
    const keep = this.snapshot();
    // A node budget rather than a fixed breadth. Not one of the classes still
    // stuck has a placement that displaces nobody, so every chain has to run
    // until it reaches a component with slack; capping the branching at each
    // level cut those chains off before they got there. A budget lets the
    // search go wide where the options are cheap and deep where they are not.
    const budget = { n: nodes == null ? 200000 : nodes };
    if (this.relocate(comp, maxDepth == null ? 6 : maxDepth, new Set(), budget)) {
      if (this.totalHard() < before) return true;
    }
    this.restore(keep);
    return false;
  }

  /** One link of the chain: place `comp` somewhere, recursively clearing the way. */
  relocate(comp, depth, moving, budget) {
    if (comp.fixed || moving.has(comp.id) || depth < 0 || budget.n <= 0) return false;
    moving.add(comp.id);
    const ids = comp.members.map(m => m.cls.id);
    const oldDay = comp.day, oldStart = comp.start;
    const oldRooms = ids.map(i => this.room[i]);

    for (const opt of this.placementOptions(comp)) {
      if (budget.n <= 0) break;
      if (opt.day === oldDay && opt.start === oldStart &&
          opt.rooms.every((r, k) => r === oldRooms[k])) continue;
      if (opt.displaced.size && depth <= 0) continue;
      budget.n--;

      this.moveComponent(comp, opt.day, opt.start);
      ids.forEach((i, k) => this.setRoom(i, opt.rooms[k]));

      let ok = true;
      for (const other of opt.displaced) {
        if (!this.relocate(this.components[other], depth - 1, moving, budget)) { ok = false; break; }
      }
      if (ok) { moving.delete(comp.id); return true; }

      this.moveComponent(comp, oldDay, oldStart);
      ids.forEach((i, k) => this.setRoom(i, oldRooms[k]));
    }
    moving.delete(comp.id);
    return false;
  }

  /**
   * Run the chain repair over everything still broken, until it stops paying.
   *
   * Cheap enough to be worth doing on every solve: the search exhausts itself
   * in a few thousand nodes when there is no chain, and finds one in a few
   * hundred when there is.
   */
  chainSweep(rounds, depth, nodes) {
    let fixed = 0;
    for (let r = 0; r < (rounds || 4); r++) {
      const bad = this.violatingClasses();
      if (!bad.length) break;
      let any = false;
      for (const id of bad) {
        if (this.hardOf(id, null) === 0) continue;
        if (this.chainRepair(id, depth == null ? 8 : depth, nodes == null ? 400000 : nodes)) {
          fixed++; any = true;
        }
      }
      if (!any) break;
    }
    return fixed;
  }

  /**
   * A bigger ruin: tear up a random slice of the whole timetable, not just the
   * neighbourhood of one clash, and rebuild it.
   *
   * intensify() works on what a violation touches, which is the right first
   * move but leaves the search inside the same basin. Once it has stopped
   * paying, displacing a percent or two of the term at random gives the repair
   * loop somewhere genuinely new to land, while still being small enough that
   * a failed attempt costs little to undo.
   */
  ruinAndRecreate(attempts, frac) {
    frac = frac || 0.03;
    let bestHard = this.totalHard();
    if (bestHard === 0) return bestHard;
    let best = this.snapshot();

    const movable = this.components.filter(c => !c.fixed);
    for (let a = 0; a < (attempts || 40) && bestHard > 0; a++) {
      const keep = this.snapshot();
      // Always include whatever is broken; the rest is a random slice.
      const region = new Set();
      for (const id of this.violatingClasses()) region.add(this.compOf[id]);
      const want = Math.max(8, Math.floor(movable.length * frac));
      while (region.size < want) {
        region.add(movable[Math.floor(this.rand() * movable.length)].id);
      }

      const comps = [...region].map(i => this.components[i]).filter(c => c && !c.fixed);
      for (const comp of comps) {
        const wide = comp.span > DAY_WIDTH;
        const legal = wide ? [DAY_START] : STARTS.filter(x => x + comp.span <= HARD_MAX);
        if (!legal.length) continue;
        this.moveComponent(comp, Math.floor(this.rand() * DAY_COUNT),
          legal[Math.floor(this.rand() * legal.length)]);
      }
      const ids = [];
      for (const comp of comps) for (const m of comp.members) ids.push(m.cls.id);
      for (let round = 0; round < 10; round++) {
        let any = false;
        for (const id of ids) {
          if (this.hardOf(id, null) === 0) continue;
          any = true;
          if (this.tryRoomRepair(id)) continue;
          if (this.tryRoomSwap(id)) continue;
          if (this.tryTimeRepair(id, 'improve')) continue;
          this.tryTimeRepair(id, 'minconflict');
        }
        if (!any) break;
      }
      // Let the rest of the timetable settle around the slice that moved.
      for (let round = 0; round < 3; round++) {
        const bad = this.violatingClasses();
        if (!bad.length) break;
        for (const id of bad) {
          if (this.tryRoomRepair(id)) continue;
          if (this.tryRoomSwap(id)) continue;
          this.tryTimeRepair(id, 'improve');
        }
      }

      const now = this.totalHard();
      if (now < bestHard) { bestHard = now; best = this.snapshot(); }
      else this.restore(keep);
    }
    this.restore(best);
    return bestHard;
  }

  /**
   * Soft-goal polish: only moves that do not add hard violations.
   *
   * Deliberately narrow. Sweeping every component against every slot and
   * re-optimising rooms at each one costs millions of evaluations per round and
   * buys almost nothing, because a component already in a good slot has nothing
   * to gain. Only components actually sitting in an edge or out-of-hours slot
   * are considered, and each trial keeps the rooms it already holds — a
   * destination that needs a different room is left to the main search.
   */
  polish(rounds) {
    const o = this.opts;
    const baseHard = this.totalHard();
    let improved = 0;
    for (let r = 0; r < (rounds || 2); r++) {
      // Worth trying to move: a component sitting in an edge or out-of-hours
      // slot, or one belonging to a cohort whose teaching week has a gap in it.
      const gappy = new Set();
      for (let p = 0; p < this.progIdx.size; p++) {
        if (this.spreadPenalty([p]) > 0) gappy.add(p);
      }
      const targets = [];
      for (const comp of this.components) {
        let want = false;
        for (const m of comp.members) {
          const cls = m.cls;
          const s = this.start[cls.id];
          if (cls.attended) {
            const outside = s < HARD_MIN || (!cls.windowExempt && s + this.dur[cls.id] > HARD_MAX);
            const edge = s < EDGE_EARLY || s >= EDGE_LATE;
            if (outside || edge) { want = true; break; }
          }
          if (this.classProgs.get(cls.id).some(p => gappy.has(p))) { want = true; break; }
        }
        if (want) targets.push(comp);
      }
      if (!targets.length) break;
      for (let i = targets.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }

      let movedThisRound = 0;
      for (const comp of targets) {
        if (comp.fixed) continue;
        const ids = comp.members.map(m => m.cls.id);
        const progs = this.progsOf(ids);
        const before = this.costOf(ids);
        const beforeSpread = this.spreadPenalty(progs);
        const od = comp.day, os = comp.start;
        let best = null;
        let bestScore = before.hard * 1000 + before.soft + o.wSpread * beforeSpread;
        const wide = comp.span > DAY_WIDTH;
        for (let d = 0; d < DAY_COUNT; d++) {
          for (const s of STARTS) {
            if (d === od && s === os) continue;
            if (wide ? s !== DAY_START : s + comp.span > HARD_MAX) continue;
            this.moveComponent(comp, d, s);
            const c = this.costOf(ids);
            const score = c.hard * 1000 + c.soft + o.wSpread * this.spreadPenalty(progs);
            if (c.hard <= before.hard && score < bestScore) { bestScore = score; best = { d, s }; }
            this.moveComponent(comp, od, os);
          }
        }
        if (best) { this.moveComponent(comp, best.d, best.s); improved++; movedThisRound++; }
      }
      if (this.totalHard() > baseHard) break;
      if (!movedThisRound) break;
    }
    return improved;
  }

  snapshot() {
    return { day: this.day.slice(), start: this.start.slice(), room: this.room.slice() };
  }

  restore(s) {
    for (let i = 0; i < this.occ.length; i++) this.occ[i].length = 0;
    this.progDayCount.fill(0);
    for (const c of this.model.classes) {
      this.day[c.id] = s.day[c.id];
      this.start[c.id] = s.start[c.id];
      this.room[c.id] = s.room[c.id];
      this.occ[s.room[c.id] * DAY_COUNT + s.day[c.id]].push(c.id);
      for (const p of this.classProgs.get(c.id)) this.progDayCount[p * DAY_COUNT + s.day[c.id]]++;
    }
    for (const comp of this.components) {
      const anchor = comp.members[0].cls.id;
      comp.day = s.day[anchor];
      comp.start = s.start[anchor];
    }
  }

  assignment() {
    const m = new Map();
    for (const c of this.model.classes) {
      m.set(c.id, { day: this.day[c.id], start: this.start[c.id], room: this.room[c.id] });
    }
    return m;
  }
}

// Distinct prefixes so the same pair can be recorded once per rule it breaks.
const ROOM_RULE = 'r';
const TIME_RULE = 't';
const DAY_RULE = 'd';

function pairKey(a, b) { return a < b ? a * 100000 + b : b * 100000 + a; }

module.exports = { Solver, STARTS, DAY_COUNT, HARD_MIN, HARD_MAX, EDGE_EARLY, EDGE_LATE };
