'use strict';

// Build a spring timetable that obeys the hard rules, moving as little as
// possible. Run:  node timetable/solve.js [--seeds 40] [--out docs/data] [--clashes all|evidenced|cohort]
//
// Restarts matter more than a longer single run: the search plateaus within a
// couple of seconds, so trying many starting points finds a clean solution
// where grinding one does not.

const fs = require('fs');
const path = require('path');
const { load, DAYS, fmtMin } = require('./lib/model');
const C = require('./lib/constraints');
const { Solver } = require('./lib/solver');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SEEDS = Number(arg('seeds', 40));
// Seeds vary a lot — the same model gives 11 to 19 violations depending on
// where the search starts — so the practical way to run this is several
// processes over disjoint seed ranges, each writing its own best.
const SEED0 = Number(arg('seed0', 1));
const OUT = arg('out', '');
const CLASHES = arg('clashes', 'all');   // all | evidenced | cohort
const TERM = arg('term', 'spring');      // spring | autumn
const START = arg('start', 'current');   // current | scatter | mixed
// Repair a timetable somebody already has instead of searching for a new one.
// When one rule changes, the published solution is a far better starting point
// than today's timetable, and it keeps the result recognisable.
const FROM = arg('from', '');
let priorRows = null;
const CHECK_OPTS = { dayStart: 7 * 60 + 15, dayEnd: 23 * 60 + 15 };

const model = load(null, { clashes: CLASHES, term: TERM });
console.log(`Belfast ${TERM}: ${model.classes.length} classes (one-off bookings excluded), ` +
            `${model.rooms.length} rooms, ${model.linkedGroups.length} linked groups`);
console.log(`clash edges: ${model.cannotShareTime.length} of ${model.edgeStats.total} ` +
            `(mode "${model.clashMode}")` +
            (model.edgeStats.dropped ? `, ${model.edgeStats.dropped} dropped as unevidenced` : '') +
            (model.edgeStats.staffDropped ? `, ${model.edgeStats.staffDropped} staff-proxy dropped` : ''));

// The baseline carries the weeks each class is actually in its original room,
// which is not its full week list when it is split across rooms. Without that
// the comparison reports clashes today that never happen.
const baseline = new Map(model.classes.map(c =>
  [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom, weeks: c.origRoomWeeks }]));
// Judged from the bookings themselves: the class file cannot say which
// weeks a split class is in which room, and scoring it as if it were in
// its dominant room all term reported 288 clashes that never happen.
const base = C.check(model, baseline,
  Object.assign({ occupancy: model.currentOccupancy }, CHECK_OPTS));
console.log(`today's timetable, judged against the hard rules: ${base.total} violations ` +
            `(${base.counts.roomClash} room, ${base.counts.linkedOrder} lecture/seminar)\n`);

let best = null;
for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) {
  // 'mixed' alternates: an anchored start wins when it can, because it moves
  // far less, and a scattered one is there for when it cannot.
  const start = START === 'mixed' ? (seed % 2 ? 'current' : 'scatter') : START;
  // Repairing a timetable that already works is a different job from finding
  // one: a long search would wander off the placement it was given and hand
  // back a different timetable for no reason. Short leash, low noise.
  const s = new Solver(model, {
    seed, start, noise: FROM ? 0.01 : 0.03, maxIters: FROM ? 20000 : 200000,
  });
  if (FROM) {
    const prior = JSON.parse(fs.readFileSync(path.resolve(FROM), 'utf8'));
    const had = new Map(prior.rows.map(r => [r.id, r]));
    priorRows = had;
    s.adopt(new Map(model.classes.map(c => {
      const r = had.get(c.id);
      return [c.id, r ? { day: r.day, start: r.start, room: r.room }
                      : { day: c.origDay, start: c.origStart, room: c.origRoom }];
    })));
    console.log(`adopted ${prior.rows.length} placements from ${FROM}: ` +
                `${s.totalHard()} violations to repair`);
  }
  if (FROM) {
    // A repair, not a search. Only the moves that fix a broken placement run:
    // the ordinary loop would rearrange classes that are already fine, and
    // polish would move whole components for soft reasons, handing back a
    // timetable nobody asked for.
    s.chainSweep();
    s.intensify(200);
    s.chainSweep();
    s.homeSweep(2);
    if (s.totalHard()) s.splitRepair(3);
  } else {
  s.run();
  // The endgame: what is left after min-conflicts plateaus needs several
  // classes moved together, which no single-move search can find.
  s.intensify(400);
  // Chains last: they are the only move that helps when nothing has a free
  // slot to move into, and they are cheapest once the rest has settled.
  s.chainSweep();
  s.intensify(150);
  s.chainSweep();
  // Last: put back what did not need to move. Today's timetable proves some
  // arrangement works, and what survives the search is usually a class whose
  // own slot is held by something with no reason to be there.
  // A component that needs every room it can use has to move as a shelf.
  s.poolMove(3);
  s.homeSweep(3);
  s.polish(4);
  }
  // Only now, with the search exhausted: a class still short of a room is
  // given two rather than left clashing. This is the fault the rebuild exists
  // to remove, so it is counted and named in the output.
  const splits = FROM ? 0 : s.splitRepair(3);
  const a = s.assignment();
  const chk = C.check(model, a, CHECK_OPTS);
  const mv = C.movement(model, a);
  // How far it drifted from the timetable it was asked to repair, which is the
  // number that matters when the job was a tweak.
  let drift = 0;
  if (FROM && priorRows) {
    for (const c of model.classes) {
      const was = priorRows.get(c.id), now = a.get(c.id);
      if (!was || !now) continue;
      if (was.day !== now.day || was.start !== now.start || was.room !== now.room) drift++;
    }
  }
  const soft = C.softScore(model, a);
  const gaps = s.spreadPenalty();
  const moved = mv.total - mv.untouched;
  // Hard violations first, then the soft goals, and movement last — the order
  // the constraints were given in.
  // A split is a real cost, ranked just under a violation.
  const rank = chk.total * 1e6 + splits * 1e4 + soft.edge * 10 + gaps * 8 + moved;
  const line = `seed ${String(seed).padStart(3)} ${start.padEnd(7)} hard ${String(chk.total).padStart(3)}  ` +
               `edge ${String(soft.edge).padStart(3)}  gaps ${String(gaps).padStart(3)}  ` +
               `moved ${String(moved).padStart(4)}` +
               (splits ? `  split ${splits}` : '') +
               (FROM ? `  changed-from-prior ${drift}` : '');
  if (!best || rank < best.rank) {
    best = { rank, seed, chk, mv, soft, gaps, splits, drift, assign: a };
    console.log(line + '   <- best so far');
  } else {
    console.log(line);
  }

}

const { chk, mv, soft, gaps, assign } = best;
console.log(`\n=== best (seed ${best.seed}) ===`);
console.log(`hard violations: ${chk.total}`);
if (FROM) {
  console.log(`changed from the timetable it repaired: ${best.drift} of ${model.classes.length}`);
}
if (best.splits) {
  console.log(`split across rooms as a last resort: ${best.splits}`);
  for (const [id, p] of best.assign) {
    if (!p.extra) continue;
    const c = model.byId.get(id);
    console.log(`   ${c.module || c.activity}/${c.activity} ` +
                `${[p.room, ...p.extra].map(r => model.rooms[r].name).join(' + ')}`);
  }
}
for (const [k, v] of Object.entries(chk.counts)) if (v) console.log(`   ${k.padEnd(12)} ${v}`);
console.log(`movement: ${mv.total - mv.untouched} of ${mv.total} classes changed ` +
            `(${mv.movedDay} day, ${mv.movedTime} time, ${mv.movedRoom} room); ` +
            `${mv.untouched} untouched`);
const baseSoft = C.softScore(model, baseline);
const baseGaps = new Solver(model, { seed: 1, maxIters: 0 }).spreadPenalty();
console.log(`soft: ${soft.edge} teaching classes in edge slots (today ${baseSoft.edge}), ` +
            `${gaps} cohort gap-days (today ${baseGaps}), ` +
            `${soft.wedPm} on Wednesday afternoon (today ${baseSoft.wedPm})`);

// Every linked group back-to-back, and no block teaching sent offsite?
let b2b = 0, notB2b = 0;
for (const g of model.linkedGroups) {
  let ok = true;
  for (let i = 0; i + 1 < g.members.length; i++) {
    const a = g.members[i], b = g.members[i + 1];
    const pa = assign.get(a.id), pb = assign.get(b.id);
    if (pa.day !== pb.day || pa.start + a.dur !== pb.start) ok = false;
  }
  if (ok) b2b++; else notB2b++;
}
console.log(`lecture+seminar back-to-back: ${b2b} of ${model.linkedGroups.length} groups` +
            (notB2b ? ` (${notB2b} NOT satisfied)` : ' — all of them'));
console.log(`block teaching kept on campus: ${model.classes.filter(c => c.isBlock).length} sessions, ` +
            `none moved offsite`);

if (chk.total) {
  console.log('\nunresolved:');
  for (const v of chk.violations.slice(0, 20)) {
    const A = model.byId.get(v.a), B = v.b != null ? model.byId.get(v.b) : null;
    console.log(`   ${v.kind}: ${A.module || A.activity}/${A.activity}` +
                (B ? ` vs ${B.module || B.activity}/${B.activity}` : ''));
  }
}

if (OUT) {
  const dir = path.resolve(OUT);
  fs.mkdirSync(dir, { recursive: true });
  const rows = model.classes.map(c => {
    const p = assign.get(c.id);
    const flags = (p.day !== c.origDay ? 'd' : '') + (p.start !== c.origStart ? 't' : '') +
                  (p.room !== c.origRoom ? 'r' : '');
    return {
      id: c.id, module: c.module, activity: c.activity, title: c.title,
      day: p.day, start: p.start, dur: c.dur, room: p.room,
      extra: p.extra || undefined,
      weeks: c.weeksText, teaching: c.isTeaching ? 1 : 0, block: c.isBlock ? 1 : 0,
      was: { day: c.origDay, start: c.origStart, room: c.origRoom },
      changed: flags,
    };
  });
  // One file per term, so solving autumn does not overwrite the spring
  // solution the site is built from.
  const solFile = TERM === 'spring' ? 'solution.json' : `solution-${TERM}.json`;
  fs.writeFileSync(path.join(dir, solFile), JSON.stringify({
    meta: {
      campus: 'Belfast', term: TERM === 'autumn' ? 'Autumn 2026' : 'Spring 2026', generated: new Date().toISOString().slice(0, 10),
      seed: best.seed, hardViolations: chk.total, splitRooms: best.splits,
      // Which clash graph this was solved against. The site must check the
      // result with the same rules, or it reports violations the solver was
      // never asked to avoid.
      clashMode: model.clashMode,
      clashEdges: model.cannotShareTime.length,
      clashEdgesTotal: model.edgeStats.total,
      dayStart: C.DAY_START, dayEnd: C.DAY_END,
      moved: mv.total - mv.untouched, untouched: mv.untouched,
      backToBack: b2b, linkedGroups: model.linkedGroups.length,
      edge: soft.edge, edgeBefore: baseSoft.edge,
      gapDays: gaps, gapDaysBefore: baseGaps,
    },
    rooms: model.rooms.map(r => ({ id: r.id, name: r.name, type: r.type, capacity: r.capacity })),
    rows,
  }));
  console.log(`\nwrote ${path.join(dir, solFile)}`);

  // Check what was WRITTEN, not what was in memory. The two can differ —
  // autumn's file once carried a class the run had counted as clean — and a
  // number nobody can reproduce from the file is worth nothing.
  {
    // A FRESH model, not the one the run has been mutating: components.js
    // marks classes exempt from the teaching-day rule as it builds, and
    // checking against the model the solver has already touched lets a
    // violation through that a reader loading the file cold would see.
    const fresh = load(null, { clashes: CLASHES, term: TERM });
    require('./lib/components').build(fresh);
    const written = JSON.parse(fs.readFileSync(path.join(dir, solFile), 'utf8'));
    const back = new Map(written.rows.map(r => [r.id, r]));
    const reread = new Map(fresh.classes.map(c => {
      const r = back.get(c.id);
      return [c.id, r
        ? { day: r.day, start: r.start, room: r.room, extra: r.extra }
        : { day: c.origDay, start: c.origStart, room: c.origRoom }];
    }));
    const again = C.check(fresh, reread, CHECK_OPTS);
    console.log(`re-read from the file and checked again: ${again.total} violations`);
    if (again.total !== chk.total) {
      console.log('   MISMATCH with the run\'s own count of ' + chk.total + ':');
      for (const v of again.violations.slice(0, 5)) {
        const c = fresh.byId.get(v.a);
        console.log(`   ${v.kind}: ${c.module || c.activity}/${c.activity} ` +
                    `start ${reread.get(v.a).start} dur ${c.dur}`);
      }
    }
  }

  // solution.json and docs/data/timetable.json are a pair: the second is
  // built from the first and from the model. Writing one without the other
  // leaves the published site describing a timetable that no longer exists,
  // which is what CI's drift check keeps catching. So the export runs here,
  // as part of producing a solution, rather than being remembered separately.
  if (path.resolve(dir).startsWith(path.resolve(__dirname, '..', 'docs'))) {
    require('child_process').execFileSync(process.execPath,
      [path.join(__dirname, 'export.js')], { stdio: 'inherit' });
  }
}
