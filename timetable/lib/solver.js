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
      maxIters: 400000,
      stallLimit: 120,   // rounds without improvement before giving up
      noise: 0.12,          // chance of taking a random repair instead of the best
      // Soft goals outrank movement: keeping the timetable still is the lowest
      // priority of all, below both the edge-slot and consecutive-days goals.
      wEdge: 10,            // soft: class in the 9-10am / 4-5pm edge slots
      wOutside: 30,         // soft: outside 09:15-18:15 altogether
      wWedPm: 0,            // soft: Wednesday afternoon (off unless asked for)
      wSpread: 8,           // soft: gap-day in a cohort's week
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
    for (const comp of components) comp.fixed = comp.members.some(m => m.cls.isFixed);
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
    const out = set.size ? [...set] : [];
    if (cls.origRoom !== null && !set.has(cls.origRoom)) out.push(cls.origRoom);
    return out;
  }

  /** Try to repair `id` by moving only its room. Returns true if it improved. */
  tryRoomRepair(id) {
    if (this.model.byId.get(id).isFixed) return false;
    const before = this.costOf([id]);
    const cur = this.room[id];
    let best = null, bestScore = before.hard * 1000 + before.soft;
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

  run(report) {
    const o = this.opts;
    this.seedWindow();
    let best = this.snapshot(), bestHard = this.totalHard();
    let iter = 0, round = 0, stall = 0;

    while (iter < o.maxIters) {
      let bad = this.violatingClasses();
      if (!bad.length) break;

      for (let i = bad.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [bad[i], bad[j]] = [bad[j], bad[i]];
      }

      for (const id of bad) {
        if (iter >= o.maxIters) break;
        if (this.hardOf(id, null) === 0) continue; // an earlier repair got it
        const noisy = this.rand() < o.noise;
        if (!noisy && this.tryRoomRepair(id)) { iter++; continue; }
        if (this.tryTimeRepair(id, 'improve')) { iter++; continue; }
        // Nothing improves it. Take the least-bad slot anyway and let the
        // classes it displaces be repaired next round. A random jump is kept
        // as a rare last resort: applying one to every stuck class scatters
        // the timetable and the search never recovers.
        if (this.tryTimeRepair(id, noisy ? 'random' : 'minconflict')) { iter++; continue; }
        this.tryRoomRepair(id);
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
      if (stall > o.stallLimit) break;
    }

    if (this.totalHard() > bestHard) this.restore(best);
    return { iters: iter, rounds: round, hard: this.totalHard() };
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
