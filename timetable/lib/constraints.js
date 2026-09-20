'use strict';

// Pure constraint checking, shared by the solver (node) and the explore page
// (browser). No I/O, no DOM, no node builtins — so the browser can tell a user
// whether a move they are considering is legal using the same code that
// produced the timetable, rather than a second implementation that drifts.

// An `assignment` is a Map (or array) from class id → {day, start, room}.
// The model supplies everything that does not change: duration, weeks,
// candidate rooms, and the pair lists.

// The teaching day. Nothing may start before this or end after it — 09:15 to
// 17:15 is the 9-to-5 the data's :15 grid actually uses. The first and last
// hours are the unpopular "edge" slots the soft goals try to empty.
const DAY_START = 9 * 60 + 15;
const DAY_END = 17 * 60 + 15;
const DAY_WIDTH = DAY_END - DAY_START;

const HARD = [
  'roomClash',      // two classes in one room at once in a shared week
  'timeClash',      // same cohort or staff in two places at once
  'roomFit',        // wrong room type, or too small
  'linkedOrder',    // lecture+seminar same day, contiguous, in order
  'adjacency',      // same-module pairs that are adjacent today stay adjacent
  'examSlot',       // an exam in its module's usual slot stays in it
  'dayPairing',     // no NEW same-day pairing for a cohort
  'window',         // inside the teaching day
];

// Half-open intervals: a class ending at 11:15 and one starting at 11:15 are
// back-to-back, not overlapping. The linked-group rule depends on this.
function overlaps(aStart, aDur, bStart, bDur) {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}

function sharesWeek(a, b) {
  return (a.weeks & b.weeks) !== 0;
}

function placementOf(assignment, id) {
  return Array.isArray(assignment) ? assignment[id] : assignment.get(id);
}

/**
 * Full violation report for an assignment.
 * @param model   from model.load()
 * @param assign  Map|array of class id → {day, start, room}
 * @param opts    {dayStart, dayEnd, strictBackToBack, strictRoomFit}
 * @returns {counts, violations[]}
 */
function check(model, assign, opts) {
  opts = opts || {};
  const dayStart = opts.dayStart == null ? DAY_START : opts.dayStart;
  const dayEnd = opts.dayEnd == null ? DAY_END : opts.dayEnd;
  const strictBackToBack = opts.strictBackToBack !== false;
  const strictRoomFit = opts.strictRoomFit === true;

  const violations = [];
  const counts = Object.create(null);
  for (const k of HARD) counts[k] = 0;
  const add = (kind, detail) => { counts[kind]++; violations.push(Object.assign({ kind }, detail)); };

  const at = id => placementOf(assign, id);

  // ---- window + room fit (per class) ----
  for (const c of model.classes) {
    const p = at(c.id);
    if (!p) continue;
    // A handful of sessions are longer than the teaching day — 9, 12 and 13
    // hours — so they cannot both start after 09:15 and finish by 17:15. They
    // still may not start early; they overflow at the end, because there is no
    // other option. `windowExempt` is set by components.js on the whole
    // component, since a linked group can be too wide even when its members
    // are not.
    var tooLongToFit = c.windowExempt || c.dur > DAY_WIDTH;
    // Pinned bookings are not ours to move, so the window is not held against
    // them — several institutional reservations run to 21:15 by design.
    if (!c.isFixed &&
        (p.day < 0 || p.day > 4 || p.start < dayStart ||
        (!tooLongToFit && p.start + c.dur > dayEnd))) {
      add('window', { a: c.id, start: p.start, day: p.day, tooLong: !!tooLongToFit });
    }
    // Staying in the room a class already occupies is always legal: 507 classes
    // (24%) sit in a room outside their own candidate set today, almost always
    // because the room's capacity is unrecorded. Enforcing fit literally would
    // move hundreds of classes for a data artefact. `strictRoomFit` opts in.
    const stayingPut = p.room === c.origRoom;
    if (!(stayingPut && !strictRoomFit)) {
      if (!c.cand.includes(p.room)) add('roomFit', { a: c.id, room: p.room });
    }
  }

  // ---- room double-booking ----
  // Bucket by (room, day) so this stays near-linear instead of 2,072².
  const buckets = new Map();
  for (const c of model.classes) {
    const p = at(c.id);
    if (!p) continue;
    const key = p.room + ':' + p.day;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((x, y) => at(x.id).start - at(y.id).start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const pa = at(a.id), pb = at(b.id);
        if (pb.start >= pa.start + a.dur) break; // sorted: nothing later overlaps
        if (!overlaps(pa.start, a.dur, pb.start, b.dur)) continue;
        if (!sharesWeek(a, b)) continue;
        // A pair that already shares a room today may keep sharing one.
        if (model.mayShareRoom &&
            model.mayShareRoom.has(a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id)) continue;
        add('roomClash', { a: a.id, b: b.id, room: pa.room, day: pa.day });
      }
    }
  }

  // ---- cohort / staff clash ----
  for (const [ida, idb] of model.cannotShareTime) {
    const a = model.byId.get(ida), b = model.byId.get(idb);
    const pa = at(ida), pb = at(idb);
    if (!pa || !pb) continue;
    if (pa.day !== pb.day) continue;
    if (!overlaps(pa.start, a.dur, pb.start, b.dur)) continue;
    if (!sharesWeek(a, b)) continue;
    add('timeClash', { a: ida, b: idb, day: pa.day });
  }

  // ---- linked groups: same day, contiguous, in group_order ----
  for (const g of model.linkedGroups) {
    const ms = g.members;
    for (let i = 0; i + 1 < ms.length; i++) {
      const a = ms[i], b = ms[i + 1];
      const pa = at(a.id), pb = at(b.id);
      if (!pa || !pb) continue;
      if (pa.day !== pb.day) { add('linkedOrder', { a: a.id, b: b.id, why: 'different days', group: g.key }); continue; }
      if (strictBackToBack && pa.start + a.dur !== pb.start) {
        add('linkedOrder', {
          a: a.id, b: b.id, group: g.key,
          why: pb.start < pa.start + a.dur ? 'out of order or overlapping' : 'gap between them',
          gap: pb.start - (pa.start + a.dur),
        });
      } else if (!strictBackToBack && pb.start < pa.start + a.dur) {
        add('linkedOrder', { a: a.id, b: b.id, group: g.key, why: 'out of order or overlapping' });
      }
    }
  }

  // ---- preserved same-module adjacency (covers exams after lectures) ----
  for (const [ida, idb] of model.preservedAdjacency) {
    const a = model.byId.get(ida);
    const pa = at(ida), pb = at(idb);
    if (!pa || !pb) continue;
    if (pa.day !== pb.day || pa.start + a.dur !== pb.start) {
      add('adjacency', { a: ida, b: idb, why: 'no longer back-to-back' });
    }
  }

  // ---- exams that sit in their module's usual slot stay in it ----
  for (const [ida, idb] of model.preservedSlot) {
    const pa = at(ida), pb = at(idb);
    if (!pa || !pb) continue;
    if (pa.day !== pb.day || pa.start !== pb.start) {
      add('examSlot', { a: ida, b: idb, why: 'exam left its module\'s usual slot' });
    }
  }

  // ---- no new same-day cohort pairings ----
  for (const [ida, idb] of model.cannotShareDay) {
    const pa = at(ida), pb = at(idb);
    if (!pa || !pb) continue;
    if (pa.day === pb.day) add('dayPairing', { a: ida, b: idb, day: pa.day });
  }

  let total = 0;
  for (const k of HARD) total += counts[k];
  return { counts, total, violations };
}

/** Movement cost against the timetable as it stands today. */
function movement(model, assign) {
  let movedDay = 0, movedTime = 0, movedRoom = 0, untouched = 0;
  for (const c of model.classes) {
    const p = placementOf(assign, c.id);
    if (!p) continue;
    const d = p.day !== c.origDay, t = p.start !== c.origStart, r = p.room !== c.origRoom;
    if (d) movedDay++;
    if (t) movedTime++;
    if (r) movedRoom++;
    if (!d && !t && !r) untouched++;
  }
  return { movedDay, movedTime, movedRoom, untouched, total: model.classes.length };
}

/** Soft-goal scoring: edge slots and Wednesday afternoon load. */
function softScore(model, assign) {
  let edge = 0, wedPm = 0;
  for (const c of model.classes) {
    const p = placementOf(assign, c.id);
    // Counts every class a cohort attends, not just the is_teaching ones —
    // otherwise exams and 136 non-flagged lectures are invisible here.
    if (!p || !(c.attended === undefined ? c.isTeaching : c.attended)) continue;
    if (p.start < 10 * 60 || p.start >= 16 * 60) edge++;
    if (p.day === 2 && p.start >= 13 * 60) wedPm++;
  }
  return { edge, wedPm };
}

const api = { HARD, check, movement, softScore, overlaps, sharesWeek,
  DAY_START, DAY_END, DAY_WIDTH };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.TTConstraints = api;
