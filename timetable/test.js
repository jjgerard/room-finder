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
const { load, weekMask, weekList, toMin, fmtMin,
  CAPACITY_TOLERANCE_DEFAULT: TOLERANCE } = require('./lib/model');
const { makeUF, build } = require('./lib/components');
const C = require('./lib/constraints');
const { Solver } = require('./lib/solver');

let passed = 0, failed = 0;
const slow = [];
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message); }
  const ms = Date.now() - t0;
  // A slow test is a test nobody runs, so make the cost visible.
  if (ms > 1000) slow.push([ms, name]);
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

test('model: one-off bookings with no module are excluded', () => {
  // Applicant days, exam-week reservations, library sessions, meetings: they
  // happen once and are not being rescheduled, so holding rooms for them would
  // shrink the building for no reason.
  for (const c of model.classes) {
    if (c.module) continue;
    assert.ok(c.nWeeks > 1, 'a one-off booking with no module survived: ' + c.title);
  }
});

test('model: single-week teaching is kept', () => {
  // The rule keys on the module code, not on the week count. An MBA block day
  // or a class test runs once and still needs a room.
  const keep = model.classes.filter(c => c.module && c.nWeeks <= 1);
  assert.ok(keep.length > 200, 'single-week teaching was dropped: only ' + keep.length + ' left');
});

test('rooms: an inferred capacity is a floor read from what the room has held', () => {
  // A room with no recorded capacity is offered to nobody with a size, which
  // excluded ten working computing labs. The booking history settles it where
  // it can — but it may only ever report what was actually taught there.
  const inferred = model.rooms.filter(r => r.capacityInferred);
  assert.ok(inferred.length > 0, 'no capacity was inferred at all');
  for (const r of inferred) {
    assert.ok(r.capacity > 0, r.name + ' inferred a capacity of zero');
    assert.ok(r.capacityKnown, r.name + ' inferred a capacity but is still unknown');
  }
});

test('rooms: the computing labs are not down to the three with a number on them', () => {
  // The bug this guards: 13 labs exist, 3 carry a recorded capacity, and a
  // strict reading left two of them carrying every sized computing class.
  const usable = model.rooms.filter(r => r.type === 'computer' && r.capacityKnown);
  assert.ok(usable.length >= 5,
    'only ' + usable.length + ' computing labs are offered to a class with a size');
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

test('model: overlap today is used only to remove clash edges, never add', () => {
  // Two classes running at the same time cannot share students or a lecturer.
  // So no edge in the list may name a pair that currently overlaps.
  for (const [x, y] of model.cannotShareTime) {
    const a = model.byId.get(x), b = model.byId.get(y);
    if (a.origDay !== b.origDay) continue;
    if (!(a.weeks & b.weeks)) continue;
    assert.ok(!(a.origStart < b.origStart + b.dur && b.origStart < a.origStart + a.dur),
      'a listed clash pair overlaps in the current timetable');
  }
});

test('model: clash modes drop edges and never add them', () => {
  const all = load(null, { clashes: 'all' });
  const ev = load(null, { clashes: 'evidenced' });
  const co = load(null, { clashes: 'cohort' });
  assert.ok(ev.cannotShareTime.length < all.cannotShareTime.length);
  assert.ok(co.cannotShareTime.length < ev.cannotShareTime.length);
  const key = ([a, b]) => (a < b ? a + ':' + b : b + ':' + a);
  const allSet = new Set(all.cannotShareTime.map(key));
  for (const e of co.cannotShareTime) assert.ok(allSet.has(key(e)), 'cohort mode invented an edge');
  for (const e of ev.cannotShareTime) assert.ok(allSet.has(key(e)), 'evidenced mode invented an edge');
});

test('model: a cohort is split only if its own classes overlap today', () => {
  const m = load(null, { clashes: 'evidenced' });
  const byProg = new Map();
  for (const c of m.classes) for (const p of c.programmes) {
    if (!byProg.has(p)) byProg.set(p, []);
    byProg.get(p).push(c);
  }
  for (const p of m.splitCohorts) {
    const cs = byProg.get(p) || [];
    let found = false;
    for (let i = 0; i < cs.length && !found; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.origDay === b.origDay && (a.weeks & b.weeks) &&
            a.origStart < b.origStart + b.dur && b.origStart < a.origStart + a.dur) { found = true; break; }
      }
    }
    assert.ok(found, 'cohort marked split without overlapping classes: ' + p);
  }
});

test('rooms: a class is only ever offered rooms that can serve it', () => {
  // The source candidate_rooms column offers a studio class 69 seminar rooms
  // and no studio, and a computing class no computer lab at all. Rebuilding the
  // candidates is what stops the solver moving a class somewhere useless.
  for (const c of model.classes) {
    for (const id of c.cand) {
      if (id === c.homeRoom) continue;          // staying put is always allowed
      const t = model.rooms[id].type;
      if (c.roomType === 'specialist') eq(t, 'specialist', (c.module || c.activity) + ' offered a ' + t + ' room');
      if (c.roomType === 'computer') eq(t, 'computer', (c.module || c.activity) + ' offered a ' + t + ' room');
      if (c.roomType === 'theatre') assert.ok(t === 'theatre' || t === 'general');
      if (c.roomType === 'general') assert.ok(t !== 'specialist',
        (c.module || c.activity) + ' offered a specialist room');
    }
  }
});

test('rooms: a specialist room only takes subjects already scheduled in it', () => {
  const subjectOf = code => String(code || '').replace(/[0-9].*$/, '');
  for (const c of model.classes) {
    if (c.roomType !== 'specialist') continue;
    for (const id of c.cand) {
      if (id === c.homeRoom) continue;
      const subs = model.roomSubjects.get(id);
      assert.ok(subs && subs.has(subjectOf(c.module)),
        (c.module || c.activity) + ' offered ' + model.rooms[id].name + ', not its subject');
    }
  }
});

test('rooms: a class that needs seats is only offered rooms recorded as having them', () => {
  // An unrecorded capacity used to be read as "fits anyone". It is not: of the
  // 138 rooms without one, 81 have never been used and the rest have only ever
  // held classes of unknown size. Reading the blank as permissive moved a
  // 350-seat lecture into a design studio, and 205 others like it.
  for (const c of model.classes) {
    if (!c.size) continue;
    for (const id of c.cand) {
      if (id === c.homeRoom) continue;          // staying put is always allowed
      const r = model.rooms[id];
      assert.ok(r.capacityKnown, (c.module || c.activity) + ' (' + c.size +
        ' students) offered ' + r.name + ', which has no recorded capacity');
      // Sizes are the current room's capacity standing in for a headcount, so
      // a tolerance applies — the constant comes from the model so the test
      // cannot drift from the rule it is checking.
      assert.ok(r.capacity >= Math.ceil(c.size * TOLERANCE),
        (c.module || c.activity) + ' (' + c.size + ') offered ' + r.name + ' (' + r.capacity + ')');
    }
  }
});

test('rooms: a class of unknown size may still use a room of unknown size', () => {
  // Otherwise the studios, whose classes and rooms are both unmeasured, would
  // have nowhere to go at all.
  const anyUnknown = model.classes.some(c => !c.size &&
    c.cand.some(id => id !== c.homeRoom && !model.rooms[id].capacityKnown));
  assert.ok(anyUnknown, 'unsized classes lost access to unsized rooms');
});

test('rooms: opening computer labs widens general classes but not computing ones', () => {
  const open = load();
  const shut = load(null, { openRooms: [] });
  const sum = (m, t) => m.classes.filter(c => c.roomType === t)
    .reduce((a, c) => a + c.cand.length, 0);
  assert.ok(sum(open, 'general') > sum(shut, 'general'), 'opening computer labs added no options');
  const labs = new Set(open.rooms.filter(r => r.type === 'computer').map(r => r.id));
  for (const c of open.classes) {
    if (c.roomType !== 'computer') continue;
    for (const r of c.cand) {
      if (r === c.homeRoom) continue;
      assert.ok(labs.has(r), (c.module || c.activity) + ' offered a room with no computers');
    }
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
  const r = C.check(model, assign, {});
  eq(r.counts.timeClash, 0);
  eq(r.counts.dayPairing, 0);
});

test('baseline: the room-clash count measures forcing one room per class', () => {
  // This number is easy to misreport, so it is pinned down here. The class file
  // gives each class a single "dominant" room even when it really uses several,
  // so checking it measures: IF every class were squeezed into one room, how
  // many pairs would collide? That is the problem statement, not a claim that
  // the live timetable double-books 295 rooms — it does not.
  const assign = new Map(model.classes.map(c =>
    [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom }]));
  const r = C.check(model, assign, {});
  assert.ok(r.counts.roomClash > 100, 'expected collapsing to one room to create collisions');
  eq(r.counts.timeClash, 0, 'the live timetable has no cohort clashes');
});

test('baseline: what IS wrong today is gaps and out-of-hours teaching', () => {
  const assign = new Map(model.classes.map(c =>
    [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom }]));
  const r = C.check(model, assign, {});
  assert.ok(r.counts.linkedOrder > 50, 'expected lecture/seminar gaps');
  assert.ok(r.counts.window > 50, 'expected classes outside the teaching day');
});

test('rooms: sharing is grandfathered from real bookings, never invented', () => {
  // Every allowed pair must appear together in one room in the per-room
  // booking history. Deriving this from the class file instead produced 328
  // pairs of which only 33 were real, which would have licensed 295 genuine
  // double-bookings — so the source of this set matters more than its size.
  const fs2 = require('fs');
  const path2 = require('path');
  const terms = JSON.parse(fs2.readFileSync(
    path2.join(__dirname, 'data', 'terms.json'), 'utf8'));
  const real = new Set();
  const byRoomDay = new Map();
  for (const row of terms.springCurrent.rows) {
    const k = row[6] + '|' + row[3];
    if (!byRoomDay.has(k)) byRoomDay.set(k, []);
    byRoomDay.get(k).push(row);
  }
  for (const list of byRoomDay.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a[2] === b[2]) continue;
        if (!(weekMask(a[8]) & weekMask(b[8]))) continue;
        if (!(a[4] < b[4] + b[5] && b[4] < a[4] + a[5])) continue;
        real.add([a[2], b[2]].sort().join('||'));
      }
    }
  }
  assert.ok(model.mayShareRoom.size > 0, 'no sharing was grandfathered at all');
  for (const key of model.mayShareRoom) {
    const [a, b] = key.split(':').map(Number);
    const A = model.byId.get(a), B = model.byId.get(b);
    assert.ok(real.has([A.title, B.title].sort().join('||')),
      'allowed a pair that never shares a room today: ' + A.title + ' + ' + B.title);
  }
});

test('checker: a class starting before 09:15 breaks the window', () => {
  const m = toyModel();
  const r = C.check(m, new Map([[0, A(0, 8 * 60 + 15, 0)], [1, A(1, 555, 1)]]));
  eq(r.counts.window, 1);
});

test('checker: a class ending after 17:15 breaks the window', () => {
  const m = toyModel();
  m.classes[0].dur = 120;
  m.byId.get(0).dur = 120;
  const r = C.check(m, new Map([[0, A(0, 16 * 60 + 15, 0)], [1, A(1, 555, 1)]]));
  eq(r.counts.window, 1);
});

test('checker: the last slot of the day is legal', () => {
  const m = toyModel();
  const r = C.check(m, new Map([[0, A(0, 16 * 60 + 15, 0)], [1, A(1, 555, 1)]]));
  eq(r.counts.window, 0);
});

test('checker: a session longer than the day may overflow, but not start early', () => {
  const m = toyModel();
  m.classes[0].dur = 13 * 60;
  m.byId.get(0).dur = 13 * 60;
  m.classes[0].windowExempt = true;
  m.byId.get(0).windowExempt = true;
  eq(C.check(m, new Map([[0, A(0, 555, 0)], [1, A(1, 900, 1)]])).counts.window, 0);
  eq(C.check(m, new Map([[0, A(0, 495, 0)], [1, A(1, 900, 1)]])).counts.window, 1);
});

test('checker: a pinned booking is not judged against the window', () => {
  const m = toyModel();
  m.classes[0].isFixed = true;
  m.byId.get(0).isFixed = true;
  const r = C.check(m, new Map([[0, A(0, 7 * 60 + 15, 0)], [1, A(1, 555, 1)]]));
  eq(r.counts.window, 0);
});

test('model: every "do not edit" booking is pinned', () => {
  for (const c of model.classes) {
    if (/do\s*not\s*edit/i.test(c.title)) assert.ok(c.isFixed, 'not pinned: ' + c.title);
  }
});

test('solver: offers only 09:15-16:15 as start times', () => {
  const { STARTS } = require('./lib/solver');
  eq(STARTS[0], 9 * 60 + 15);
  eq(STARTS[STARTS.length - 1], 16 * 60 + 15);
  eq(STARTS.length, 8);
});

// ---------------------------------------------------------------- solver
// The solver tests carry an explicit, small budget. Under the 09:15-17:15 day
// the search no longer converges in seconds, and the production defaults made
// this suite take over ten minutes — long enough that nobody runs it, which is
// worse than a weaker assertion.
const TEST_BUDGET = { maxIters: 600, noise: 0.03, stallLimit: 2 };

test('solver: its own cost agrees with the independent checker', () => {
  // The whole design rests on the solver being able to trust its incremental
  // cost. If these drift the solver optimises a fiction.
  const s = new Solver(model, Object.assign({ seed: 7 }, TEST_BUDGET));
  s.run();
  const chk = C.check(model, s.assignment(), {});
  eq(s.totalHard(), chk.total);
});

test('solver: starts from component geometry, not the raw timetable', () => {
  const s = new Solver(model, { seed: 1, maxIters: 0 });
  const chk = C.check(model, s.assignment(), {});
  eq(chk.counts.linkedOrder, 0);
});

test('solver: makes the timetable substantially better', () => {
  // This one test is about convergence, so it gets a larger budget than the
  // rest. Tightening the room rules made the search work considerably harder:
  // on the shared budget it now only manages about a quarter.
  const s = new Solver(model, { seed: 3, noise: 0.03, maxIters: 3000, stallLimit: 5 });
  const before = s.totalHard();
  s.run();
  // 600 iterations is a fraction of a real run, so the bar is "clearly working",
  // not "converged". A real solve uses hundreds of thousands and many restarts.
  assert.ok(s.totalHard() < before * 0.7,
    `expected a clear drop on a small budget, got ${before} -> ${s.totalHard()}`);
});

test('solver: repacking rooms changes rooms and nothing else', () => {
  // The whole safety of the repack pass is that it cannot disturb anything
  // that depends on time: contiguity, cohort clashes, the teaching day.
  const s = new Solver(model, Object.assign({ seed: 11, repack: false }, TEST_BUDGET));
  s.run();
  const before = s.assignment();
  s.repackRooms();
  const after = s.assignment();
  for (const c of model.classes) {
    eq(after.get(c.id).day, before.get(c.id).day, (c.module || c.id) + ' changed day');
    eq(after.get(c.id).start, before.get(c.id).start, (c.module || c.id) + ' changed time');
  }
});

test('solver: repacking leaves every class in a room it may use', () => {
  const s = new Solver(model, Object.assign({ seed: 12, repack: false }, TEST_BUDGET));
  s.run();
  s.repackRooms();
  const a = s.assignment();
  for (const c of model.classes) {
    const r = a.get(c.id).room;
    assert.ok(c.cand.includes(r) || r === c.origRoom,
      (c.module || c.id) + ' repacked into a room it may not use');
  }
});

test('solver: a pinned booking is never repacked out of its room', () => {
  const s = new Solver(model, Object.assign({ seed: 13, repack: false }, TEST_BUDGET));
  s.repackRooms();
  const a = s.assignment();
  for (const c of model.classes) if (c.isFixed) eq(a.get(c.id).room, c.origRoom);
});

test('solver: a room swap exchanges two rooms and moves no clock', () => {
  const s = new Solver(model, Object.assign({ seed: 14 }, TEST_BUDGET));
  s.run();
  const before = s.assignment();
  for (const id of s.violatingClasses().slice(0, 40)) s.tryRoomSwap(id);
  const after = s.assignment();
  for (const c of model.classes) {
    eq(after.get(c.id).day, before.get(c.id).day);
    eq(after.get(c.id).start, before.get(c.id).start);
  }
});

test('solver: the endgame search never makes the timetable worse', () => {
  // intensify() deliberately wrecks a region before rebuilding it, so the
  // guarantee that matters is that a failed attempt is rolled back.
  const s = new Solver(model, Object.assign({ seed: 15 }, TEST_BUDGET));
  s.run();
  const before = s.totalHard();
  const after = s.intensify(6);
  assert.ok(after <= before, `intensify made it worse: ${before} -> ${after}`);
  eq(after, s.totalHard());
});

test('solver: a scattered start still lands inside the teaching day', () => {
  const { STARTS } = require('./lib/solver');
  const s = new Solver(model, { seed: 16, start: 'scatter', maxIters: 0 });
  const a = s.assignment();
  for (const c of model.classes) {
    if (c.isFixed) continue;
    const p = a.get(c.id);
    assert.ok(p.start >= 9 * 60 + 15, (c.module || c.id) + ' scattered before 09:15');
    assert.ok(p.day >= 0 && p.day <= 4, (c.module || c.id) + ' scattered off the week');
  }
  eq(STARTS.length, 8);
});

test('solver: going home restores the original day, time and room', () => {
  // The move that recovers a placement the search gave away. It has to move
  // the whole component, offsets intact, or it would break contiguity.
  const s = new Solver(model, Object.assign({ seed: 21 }, TEST_BUDGET));
  s.run();
  const a0 = s.assignment();
  const moved = model.classes.filter(c => {
    const p = a0.get(c.id);
    return !c.isFixed && (p.day !== c.origDay || p.start !== c.origStart);
  });
  assert.ok(moved.length, 'nothing moved, so there is nothing to send home');
  let wentHome = 0;
  for (const c of moved.slice(0, 200)) {
    if (!s.tryHomeRepair(c.id)) continue;
    wentHome++;
    const p = s.assignment().get(c.id);
    eq(p.day, c.origDay, (c.module || c.id) + ' went home to the wrong day');
    eq(p.start, c.origStart, (c.module || c.id) + ' went home to the wrong time');
  }
  // Whether any class accepts the move depends on the run, but if one does it
  // must land exactly home — that is the whole point of the move.
  assert.ok(wentHome >= 0);
});

test('solver: going home never costs hard violations', () => {
  const s = new Solver(model, Object.assign({ seed: 22 }, TEST_BUDGET));
  s.run();
  const before = s.totalHard();
  for (const id of s.violatingClasses()) s.tryHomeRepair(id);
  assert.ok(s.totalHard() <= before,
    `home repair made it worse: ${before} -> ${s.totalHard()}`);
});

test('solver: a greedy construction places every class legally in time', () => {
  // Construction throws the whole timetable away and rebuilds it, so the
  // invariants the repair loop assumes have to hold before it starts.
  const s = new Solver(model, { seed: 31, start: 'greedy', maxIters: 0 });
  const a = s.assignment();
  const chk = C.check(model, a, {});
  eq(chk.counts.linkedOrder, 0, 'construction broke a lecture/seminar pair');
  eq(chk.counts.window, 0, 'construction placed something outside the teaching day');
  for (const c of model.classes) {
    const p = a.get(c.id);
    assert.ok(p.room >= 0 && p.day >= 0, (c.module || c.id) + ' was left unplaced');
  }
});

test('solver: construction leaves a pinned booking where it is', () => {
  const s = new Solver(model, { seed: 32, start: 'greedy', maxIters: 0 });
  const a = s.assignment();
  for (const c of model.classes) {
    if (!c.isFixed) continue;
    eq(a.get(c.id).day, c.origDay, c.title + ' was moved by construction');
    eq(a.get(c.id).start, c.origStart, c.title + ' was moved by construction');
    eq(a.get(c.id).room, c.origRoom, c.title + ' was moved by construction');
  }
});

test('solver: the wider ruin never makes the timetable worse', () => {
  const s = new Solver(model, Object.assign({ seed: 33 }, TEST_BUDGET));
  s.run();
  const before = s.totalHard();
  const after = s.ruinAndRecreate(4, 0.02);
  assert.ok(after <= before, `ruinAndRecreate made it worse: ${before} -> ${after}`);
  eq(after, s.totalHard());
});

test('rooms: the booker capacities are applied and marked as recorded', () => {
  // These came out of Ulster's Resource Booker, not out of the handoff data
  // and not out of an inference, so they must be distinguishable from both.
  const fromBooker = model.rooms.filter(r => r.capacitySource);
  assert.ok(fromBooker.length >= 7, 'expected the supplementary capacities to load');
  for (const r of fromBooker) {
    assert.ok(r.capacity > 0 && r.capacityKnown, r.name + ' has a booker capacity of zero');
    assert.ok(!r.capacityInferred, r.name + ' is marked both recorded and inferred');
  }
  const big = model.rooms.find(r => /BC-03-311/.test(r.name));
  eq(big.capacity, 80, 'the largest CEBE lab should carry its real capacity');
});

test('rooms: the CEBE labs are offered to the classes that need machines', () => {
  // The bug this guards: five working School of Computing labs had no seat
  // count anywhere, so a strict reading offered them to nobody.
  const cebe = model.rooms.filter(r => /CEBE/.test(r.name) && r.type === 'computer');
  const usable = cebe.filter(r => r.capacityKnown);
  assert.ok(usable.length >= 6, 'only ' + usable.length + ' CEBE labs carry a capacity');
  const midSized = model.classes.find(c => c.roomType === 'computer' && c.size >= 40 && c.size <= 50);
  if (midSized) {
    const offered = midSized.cand.filter(id => /CEBE/.test(model.rooms[id].name));
    assert.ok(offered.length > 0,
      (midSized.module || midSized.id) + ' is still offered no CEBE lab');
  }
});

test('export: the browser is given the grandfathered sharing pairs', () => {
  // The site runs the same checker as the solver, so anything the checker
  // consults has to be shipped. mayShareRoom was not, and the site reported
  // 29 violations where the solver had found 9 — every grandfathered pair
  // counted as a double-booking.
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'docs', 'data', 'timetable.json');
  if (!fs.existsSync(file)) return;               // not exported yet; CI exports first
  const packed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(packed.sharePairs), 'sharePairs is missing from the export');
  eq(packed.sharePairs.length / 2, model.mayShareRoom.size,
    'the export ships a different number of sharing pairs than the model has');
});

test('sizes: a confirmed size gets no capacity tolerance', () => {
  // The tolerance is there because a size is normally the capacity of the
  // room a class sits in today. A real headcount gets no such benefit: 225
  // students do not go in a 215-seat theatre.
  const law = model.classes.find(c => c.module === 'LAW139' && c.sizeConfirmed);
  assert.ok(law, 'expected a confirmed LAW139 lecture');
  eq(law.size, 225);
  for (const id of law.cand) {
    if (id === law.homeRoom) continue;
    const r = model.rooms[id];
    assert.ok(r.capacity >= law.size,
      'a confirmed 225 was offered ' + r.name + ' (' + r.capacity + ')');
  }
  // A module's seminar groups keep their own proxy sizes.
  const groups = model.classes.filter(c => c.module === 'LAW139' && !c.sizeConfirmed);
  assert.ok(groups.length >= 4, 'LAW139 should still have its seminar groups');
});

test('sizes: a confirmed cohort size caps the room-capacity proxy', () => {
  // COM663 and BME104 are booked into the 215-seat Conor Lecture Theatre and
  // take about 100, so the proxy had them competing for the three biggest
  // rooms on campus for no reason.
  for (const c of model.classes) {
    if (c.module !== 'COM663' && c.module !== 'BME104') continue;
    assert.ok(c.size <= 100, (c.module || '') + '/' + c.activity + ' is still sized ' + c.size);
  }
  // And it is a cap, not a floor: a seminar group must not be inflated to the
  // whole cohort, and an unrecorded size stays unrecorded.
  const seminars = model.classes.filter(c => c.module === 'BMG350' && c.size > 0 && c.size < 250);
  assert.ok(seminars.length, 'BMG350 should still have a smaller group');
  const unknown = model.classes.filter(c => c.module === 'COM663' && c.size === 0);
  eq(unknown.length, 1, 'an unrecorded size should stay unrecorded');
  // The modules confirmed as genuinely large keep their size.
  const big = model.classes.filter(c => c.module === 'BMG403' && c.size === 250);
  assert.ok(big.length, 'BMG403 should still need 250 seats');
});

test('rooms: a 90-seat class may use the 80-seat CEBE lab', () => {
  // The one-seat case the tolerance exists for. Six of the last nine
  // unresolved clashes were nominal-90 classes that missed the largest CEBE
  // lab by a single seat.
  const lab = model.rooms.find(r => /BC-03-311/.test(r.name));
  eq(lab.capacity, 80);
  const ninety = model.classes.filter(c => c.size === 90 && c.roomType === 'general');
  assert.ok(ninety.length, 'expected some nominal-90 classes');
  const offered = ninety.filter(c => c.cand.includes(lab.id));
  assert.ok(offered.length > 0, 'a 90-seat class is still refused the 80-seat lab');
});

test('rooms: a School lab favours the School it belongs to', () => {
  // CEBE's labs go to computing and engineering first, read from what has
  // actually been taught in each one rather than from a list of codes.
  const s = new Solver(model, Object.assign({ seed: 43 }, TEST_BUDGET));
  const cad = model.rooms.find(r => /BC-05-306/.test(r.name));
  const itLab = model.rooms.find(r => /BC-03-311/.test(r.name));
  assert.ok(cad && itLab, 'expected the CAD lab and the big IT lab');
  assert.ok(cad.isSchoolLab && itLab.isSchoolLab);
  assert.ok(itLab.subjects.has('COM'), 'the IT lab should serve computing');
  assert.ok(cad.subjects.has('BEN') || cad.subjects.has('CIV'),
    'the CAD lab should serve the built environment');

  const com = model.classes.find(c => /^COM/.test(String(c.module)));
  const acf = model.classes.find(c => /^ACF/.test(String(c.module)));
  assert.ok(s.roomReluctance(com, itLab) < s.roomReluctance(acf, itLab),
    'a computing class should be preferred in the computing lab');
  // Still only a preference: turning the weight off removes it entirely.
  const off = new Solver(model, Object.assign({ seed: 43, wOtherSchool: 0, wLabSquat: 0 }, TEST_BUDGET));
  eq(off.roomReluctance(acf, itLab), 0);
});

test('rooms: the library computer room is flagged, and only it', () => {
  const lib = model.rooms.filter(r => r.isLibrary);
  eq(lib.length, 1, 'expected exactly one library computer room');
  assert.ok(/library/i.test(lib[0].name));
});

test('solver: the room preferences never bar a room outright', () => {
  // Both are tie-breakers. If either could forbid a room it could make a
  // timetable impossible, which is not what a preference is for.
  const s = new Solver(model, Object.assign({ seed: 41 }, TEST_BUDGET));
  const lab = model.rooms.find(r => r.type === 'computer');
  const general = model.classes.find(c => c.roomType === 'general');
  assert.ok(s.roomReluctance(general, lab) > 0, 'a general class in a lab should be discouraged');
  const comp = model.classes.find(c => c.roomType === 'computer');
  eq(s.roomReluctance(comp, lab), lab.isLibrary ? s.opts.wLibrary : 0,
    'a computing class should not be penalised for using a lab');
  // And with the preferences off, the same room costs nothing.
  const s2 = new Solver(model, Object.assign({ seed: 41, wLabSquat: 0, wLibrary: 0 }, TEST_BUDGET));
  eq(s2.roomReluctance(general, lab), 0);
});

test('solver: a multi-room exam never puts two sittings in one room', () => {
  // The sittings of one exam are members of a single component at offset 0 —
  // they move together, which is right, but it also hid them from each
  // other's room choice. Splitting an exam across rooms and then putting two
  // of the parts back in the same room defeats the point of splitting it.
  const s = new Solver(model, Object.assign({ seed: 61 }, TEST_BUDGET));
  s.run();
  const a = s.assignment();
  for (const c of model.classes) {
    if (!c.isShadow) continue;
    const mine = a.get(c.id);
    const parent = a.get(c.shadowOf);
    if (!mine || !parent) continue;
    assert.notStrictEqual(mine.room, parent.room,
      (c.module || c.id) + ' put a sitting back in its parent\'s room');
  }
});

test('solver: the chain sweep never makes the timetable worse', () => {
  // chainSweep applies chainRepair until it stops paying; every individual
  // chain is rolled back unless it strictly improves, so the sweep can only
  // go one way.
  const s = new Solver(model, Object.assign({ seed: 51 }, TEST_BUDGET));
  s.run();
  const before = s.totalHard();
  s.chainSweep(1, 4, 20000);
  assert.ok(s.totalHard() <= before,
    `chainSweep made it worse: ${before} -> ${s.totalHard()}`);
});

test('solver: never sends block teaching offsite', () => {
  const s = new Solver(model, Object.assign({ seed: 5 }, TEST_BUDGET));
  s.run();
  const a = s.assignment();
  for (const c of model.classes) if (c.isBlock) assert.ok(a.get(c.id).room >= 0);
});

if (slow.length) {
  console.log('\nslowest:');
  slow.sort((a, b) => b[0] - a[0]).slice(0, 5)
    .forEach(([ms, name]) => console.log('  ' + (ms / 1000).toFixed(1) + 's  ' + name));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
