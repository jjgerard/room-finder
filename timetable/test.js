'use strict';

// node timetable/test.js — no dependencies, same style as the extension's tests.
//
// The parts worth testing are the ones that go wrong quietly: week-pattern
// parsing, half-open overlap, the offset algebra that makes linked groups
// contiguous by construction, and the constraint checker itself. A solver bug
// shows up as a plausible-looking timetable that is actually illegal, so the
// checker is verified against hand-built cases rather than against the solver.

const assert = require('assert');
const { readCsv } = require('./lib/csv');
const { load, weekMask, weekList, toMin, fmtMin } = require('./lib/model');
const { makeUF, build } = require('./lib/components');
const C = require('./lib/constraints');
const { Solver } = require('./lib/solver');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message); }
}
const eq = assert.strictEqual;

// ---------------------------------------------------------------- csv
test('csv: keeps commas inside quoted fields', () => {
  const rows = readCsv('a,b\n1,"x, y"\n');
  eq(rows.length, 1);
  eq(rows[0].b, 'x, y');
});

test('csv: doubled quotes become one quote', () => {
  eq(readCsv('a\n"say ""hi"""\n')[0].a, 'say "hi"');
});

test('csv: ignores a trailing newline', () => {
  eq(readCsv('a,b\n1,2\n').length, 1);
});

test('csv: strips a BOM from the first header', () => {
  eq(Object.keys(readCsv('﻿a,b\n1,2\n')[0])[0], 'a');
});

// ---------------------------------------------------------------- weeks
test('weeks: a single week', () => { assert.deepStrictEqual(weekList(weekMask('5')), [5]); });

test('weeks: a range', () => {
  assert.deepStrictEqual(weekList(weekMask('1-4')), [1, 2, 3, 4]);
});

test('weeks: en-dash reads the same as a hyphen', () => {
  eq(weekMask('1–4'), weekMask('1-4'));
});

test('weeks: mixed list and ranges', () => {
  assert.deepStrictEqual(weekList(weekMask('1,3-5,9')), [1, 3, 4, 5, 9]);
});

test('weeks: disjoint patterns do not share a week', () => {
  eq(weekMask('1-4') & weekMask('5-8'), 0);
});

test('weeks: overlapping patterns do share a week', () => {
  assert.ok(weekMask('1-6') & weekMask('6,8'));
});

// ---------------------------------------------------------------- time
test('time: parses HH:MM', () => { eq(toMin('09:15'), 555); });
test('time: formats back', () => { eq(fmtMin(555), '09:15'); });

test('overlap: back-to-back does not overlap', () => {
  // The linked-group rule depends on this: a class ending at 11:15 and one
  // starting at 11:15 are adjacent, not clashing.
  eq(C.overlaps(555, 60, 615, 60), false);
});

test('overlap: a shared minute does overlap', () => {
  eq(C.overlaps(555, 120, 615, 60), true);
});

test('overlap: containment counts', () => {
  eq(C.overlaps(555, 480, 615, 60), true);
});

// ---------------------------------------------------------------- union-find
test('offsets: a chain composes', () => {
  const uf = makeUF(3);
  assert.ok(uf.union(0, 1, 60));   // start[1] = start[0] + 60
  assert.ok(uf.union(1, 2, 120));  // start[2] = start[1] + 120
  const f0 = uf.find(0), f2 = uf.find(2);
  eq(f0.root, f2.root);
  eq(f2.off - f0.off, 180);
});

test('offsets: a contradictory cycle is rejected', () => {
  const uf = makeUF(3);
  uf.union(0, 1, 60);
  uf.union(1, 2, 60);
  eq(uf.union(0, 2, 999), false); // must be 120
});

test('offsets: a consistent cycle is accepted', () => {
  const uf = makeUF(3);
  uf.union(0, 1, 60);
  uf.union(1, 2, 60);
  eq(uf.union(0, 2, 120), true);
});

// ---------------------------------------------------------------- model
const model = load();

test('model: BK bookings are excluded', () => {
  eq(model.classes.filter(c => c.activity === 'BK').length, 0);
});

test('model: every class resolved a home room', () => {
  eq(model.classes.filter(c => c.origRoom === null).length, 0);
});

test('model: same-day pairs already sharing a day are grandfathered', () => {
  assert.ok(model.cannotShareDay.length < model.cannotShareDayRaw.length);
  for (const [a, b] of model.cannotShareDay) {
    assert.notStrictEqual(model.byId.get(a).origDay, model.byId.get(b).origDay);
  }
});

test('model: preserved adjacency is exams only, one partner each', () => {
  const seen = new Set();
  for (const [a, b] of model.preservedAdjacency) {
    const isExam = model.byId.get(a).activity === 'EXM' || model.byId.get(b).activity === 'EXM';
    assert.ok(isExam, 'adjacency pair without an exam');
    const exam = model.byId.get(a).activity === 'EXM' ? a : b;
    assert.ok(!seen.has(exam), 'exam tied twice');
    seen.add(exam);
  }
});

test('model: an exam is never both slot-tied and adjacency-tied', () => {
  const adj = new Set();
  for (const [a, b] of model.preservedAdjacency) { adj.add(a); adj.add(b); }
  for (const [, e] of model.preservedSlot) assert.ok(!adj.has(e));
});

test('model: preserved pairs really are adjacent today', () => {
  for (const [a, b] of model.preservedAdjacency) {
    const A = model.byId.get(a), B = model.byId.get(b);
    eq(A.origDay, B.origDay);
    eq(A.origStart + A.dur, B.origStart);
  }
});

// ---------------------------------------------------------------- components
const { components, conflicts } = build(model);

test('components: the couplings are internally consistent', () => {
  eq(conflicts.length, 0);
});

test('components: cover every class exactly once', () => {
  const ids = new Set();
  for (const comp of components) for (const m of comp.members) {
    assert.ok(!ids.has(m.cls.id), 'class in two components');
    ids.add(m.cls.id);
  }
  eq(ids.size, model.classes.length);
});

test('components: each starts at offset zero', () => {
  for (const comp of components) eq(comp.members[0].off, 0);
});

test('components: a linked group is contiguous by construction', () => {
  for (const g of model.linkedGroups) {
    const comp = components[g.members[0].component];
    const offs = new Map(comp.members.map(m => [m.cls.id, m.off]));
    for (let i = 0; i + 1 < g.members.length; i++) {
      const a = g.members[i], b = g.members[i + 1];
      eq(offs.get(b.id) - offs.get(a.id), a.dur,
        'linked group ' + g.key + ' is not contiguous in its component');
    }
  }
});

// ---------------------------------------------------------------- checker
// A tiny hand-built model, so the checker is tested against known answers
// rather than against whatever the solver happens to produce.
function toyModel() {
  const mk = (id, over) => Object.assign({
    id, module: 'X' + id, activity: 'LEC', dur: 60, weeks: weekMask('1-4'),
    cand: [0, 1], origRoom: 0, origDay: 0, origStart: 555, isTeaching: true,
  }, over);
  const classes = [mk(0), mk(1)];
  return {
    classes, byId: new Map(classes.map(c => [c.id, c])),
    rooms: [{ id: 0 }, { id: 1 }],
    cannotShareTime: [], cannotShareDay: [],
    preservedAdjacency: [], preservedSlot: [], linkedGroups: [],
  };
}
const A = (d, s, r) => ({ day: d, start: s, room: r });

test('checker: same room, same time, shared weeks is a clash', () => {
  const m = toyModel();
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 0)]]));
  eq(r.counts.roomClash, 1);
});

test('checker: same room, same time, different weeks is fine', () => {
  const m = toyModel();
  m.classes[1].weeks = weekMask('5-8');
  m.byId.get(1).weeks = m.classes[1].weeks;
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 0)]]));
  eq(r.counts.roomClash, 0);
});

test('checker: same room, back-to-back is fine', () => {
  const m = toyModel();
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 615, 0)]]));
  eq(r.counts.roomClash, 0);
});

test('checker: different rooms at the same time is fine', () => {
  const m = toyModel();
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 1)]]));
  eq(r.counts.roomClash, 0);
});

test('checker: a cohort clash is caught regardless of room', () => {
  const m = toyModel();
  m.cannotShareTime = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 1)]]));
  eq(r.counts.timeClash, 1);
});

test('checker: a cohort pair may be back-to-back', () => {
  const m = toyModel();
  m.cannotShareTime = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 615, 1)]]));
  eq(r.counts.timeClash, 0);
});

test('checker: a same-day pair on one day is caught', () => {
  const m = toyModel();
  m.cannotShareDay = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 900, 1)]]));
  eq(r.counts.dayPairing, 1);
});

test('checker: a same-day pair split across days is fine', () => {
  const m = toyModel();
  m.cannotShareDay = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(1, 900, 1)]]));
  eq(r.counts.dayPairing, 0);
});

test('checker: staying in your current room never fails room fit', () => {
  const m = toyModel();
  m.classes[0].cand = [1];          // room 0 is not a candidate…
  m.byId.get(0).cand = [1];
  m.classes[0].origRoom = 0;        // …but it is where the class already is
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 1)]]));
  eq(r.counts.roomFit, 0);
});

test('checker: moving into a non-candidate room fails room fit', () => {
  const m = toyModel();
  m.classes[0].cand = [1];
  m.byId.get(0).cand = [1];
  m.classes[0].origRoom = 1;
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 900, 1)]]));
  eq(r.counts.roomFit, 1);
});

test('checker: strictRoomFit removes the stay-put exemption', () => {
  const m = toyModel();
  m.classes[0].cand = [1];
  m.byId.get(0).cand = [1];
  m.classes[0].origRoom = 0;
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 900, 1)]]), { strictRoomFit: true });
  eq(r.counts.roomFit, 1);
});

test('checker: a gap between a linked lecture and seminar is caught', () => {
  const m = toyModel();
  m.linkedGroups = [{ key: 'g', members: [m.classes[0], m.classes[1]] }];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 735, 1)]]));
  eq(r.counts.linkedOrder, 1);
  eq(r.violations.find(v => v.kind === 'linkedOrder').why, 'gap between them');
});

test('checker: a linked pair on different days is caught', () => {
  const m = toyModel();
  m.linkedGroups = [{ key: 'g', members: [m.classes[0], m.classes[1]] }];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(1, 615, 1)]]));
  eq(r.counts.linkedOrder, 1);
});

test('checker: a contiguous linked pair passes', () => {
  const m = toyModel();
  m.linkedGroups = [{ key: 'g', members: [m.classes[0], m.classes[1]] }];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 615, 1)]]));
  eq(r.counts.linkedOrder, 0);
});

test('checker: reversed order is caught even when contiguous', () => {
  const m = toyModel();
  m.linkedGroups = [{ key: 'g', members: [m.classes[0], m.classes[1]] }];
  // class 1 placed before class 0, so the group runs out of order
  const r = C.check(m, new Map([[0, A(0, 615, 0)], [1, A(0, 555, 1)]]));
  eq(r.counts.linkedOrder, 1);
});

test('checker: relaxed back-to-back accepts a same-day gap', () => {
  const m = toyModel();
  m.linkedGroups = [{ key: 'g', members: [m.classes[0], m.classes[1]] }];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 735, 1)]]),
    { strictBackToBack: false });
  eq(r.counts.linkedOrder, 0);
});

test('checker: an exam leaving its module slot is caught', () => {
  const m = toyModel();
  m.preservedSlot = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 615, 1)]]));
  eq(r.counts.examSlot, 1);
});

test('checker: an exam kept in its module slot passes', () => {
  const m = toyModel();
  m.preservedSlot = [[0, 1]];
  const r = C.check(m, new Map([[0, A(0, 555, 0)], [1, A(0, 555, 1)]]));
  eq(r.counts.examSlot, 0);
});

test('checker: movement counts day, time and room separately', () => {
  const m = toyModel();
  const mv = C.movement(m, new Map([[0, A(1, 555, 0)], [1, A(0, 615, 1)]]));
  eq(mv.movedDay, 1);
  eq(mv.movedTime, 1);
  eq(mv.movedRoom, 1);
  eq(mv.untouched, 0);
});

// ---------------------------------------------------------------- baseline
test('baseline: today has no cohort or staff clashes', () => {
  // The conflict graph was inferred from this timetable, so anything else
  // would mean the model contradicts its own source.
  const assign = new Map(model.classes.map(c =>
    [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom }]));
  const r = C.check(model, assign, { dayStart: 7 * 60 + 15, dayEnd: 23 * 60 + 15 });
  eq(r.counts.timeClash, 0);
  eq(r.counts.dayPairing, 0);
});

test('baseline: today has room clashes, which is the problem to solve', () => {
  const assign = new Map(model.classes.map(c =>
    [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom }]));
  const r = C.check(model, assign, { dayStart: 7 * 60 + 15, dayEnd: 23 * 60 + 15 });
  assert.ok(r.counts.roomClash > 100, 'expected the multi-room splits to show up');
});

// ---------------------------------------------------------------- solver
test('solver: its own cost agrees with the independent checker', () => {
  // The whole design rests on the solver being able to trust its incremental
  // cost. If these drift the solver optimises a fiction.
  const s = new Solver(model, { seed: 7, maxIters: 1500, noise: 0.03 });
  s.run();
  const chk = C.check(model, s.assignment(), { dayStart: 7 * 60 + 15, dayEnd: 23 * 60 + 15 });
  eq(s.totalHard(), chk.total);
});

test('solver: starts from component geometry, not the raw timetable', () => {
  const s = new Solver(model, { seed: 1, maxIters: 0 });
  const chk = C.check(model, s.assignment(), { dayStart: 7 * 60 + 15, dayEnd: 23 * 60 + 15 });
  eq(chk.counts.linkedOrder, 0);
});

test('solver: makes the timetable substantially better', () => {
  const s = new Solver(model, { seed: 3, maxIters: 60000, noise: 0.03 });
  const before = s.totalHard();
  s.run();
  assert.ok(s.totalHard() < before / 10, `expected a big drop, got ${before} -> ${s.totalHard()}`);
});

test('solver: never sends block teaching offsite', () => {
  const s = new Solver(model, { seed: 5, maxIters: 20000, noise: 0.03 });
  s.run();
  const a = s.assignment();
  for (const c of model.classes) if (c.isBlock) assert.ok(a.get(c.id).room >= 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
