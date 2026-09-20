'use strict';

const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_WEEK = 16;

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtMin(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// "1-6,8,10–12" → bitmask. Both hyphen and en-dash appear in the data.
function weekMask(pattern) {
  let mask = 0;
  if (pattern == null) return mask;
  for (let part of String(pattern).split(',')) {
    part = part.trim().replace(/–/g, '-');
    if (!part) continue;
    const dash = part.indexOf('-', 1);
    if (dash > 0) {
      const a = parseInt(part.slice(0, dash), 10);
      const b = parseInt(part.slice(dash + 1), 10);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      for (let w = Math.max(1, a); w <= Math.min(MAX_WEEK, b); w++) mask |= 1 << (w - 1);
    } else {
      const w = parseInt(part, 10);
      if (!Number.isNaN(w) && w >= 1 && w <= MAX_WEEK) mask |= 1 << (w - 1);
    }
  }
  return mask;
}

function weekList(mask) {
  const out = [];
  for (let w = 1; w <= MAX_WEEK; w++) if (mask & (1 << (w - 1))) out.push(w);
  return out;
}

function splitList(s) {
  return String(s || '').split(';').map(x => x.trim()).filter(Boolean);
}

/**
 * @param opts.clashes  which cannot_share_time edges to trust:
 *   'all'      — every edge as given (the default).
 *   'evidenced'— drop edges whose only shared cohorts are ones already proven
 *                to run overlapping classes today. A cohort that overlaps
 *                itself is split into groups, so "same cohort, so they cannot
 *                overlap" is not supported by that cohort's own behaviour.
 *   'cohort'   — 'evidenced', and also drop the staff-room proxy edges.
 */
function load(dir, opts) {
  opts = opts || {};
  dir = dir || path.join(__dirname, '..', 'data');
  const rd = f => readCsv(fs.readFileSync(path.join(dir, f), 'utf8'));

  const roomRows = rd('belfast_rooms.csv');
  const rooms = roomRows.map(r => ({
    id: Number(r.room_id),
    name: r.room_name,
    type: r.type,
    // capacity 0 means "not recorded", not "no seats" — 138 of 228 rooms.
    capacity: Number(r.capacity) || 0,
    capacityKnown: Number(r.capacity) > 0,
  }));
  // Capacities the room inventory does not carry, read out of Ulster's own
  // Resource Booker. Five CEBE IT labs, the CAD lab and the two MARCS rooms
  // are in daily teaching use and have no seat count anywhere in the handoff
  // data, which meant the model offered them to nobody and left two central
  // labs carrying what twelve carry in practice.
  //
  // These are recorded numbers, not inferences, so they override a blank and
  // are marked as coming from the booker rather than from the class data.
  try {
    for (const row of rd('room_capacities.csv')) {
      const room = rooms.find(r => r.name === row.room_name);
      if (!room) continue;
      const cap = Number(row.capacity);
      if (!(cap > 0)) continue;
      room.capacity = cap;
      room.capacityKnown = true;
      room.capacitySource = row.source || 'resource booker';
    }
  } catch (e) { /* no supplementary capacities available */ }

  // The room inventory mistypes a number of art and design spaces as general.
  // BB-05-011 "MFA Fine Art Space", BA-03-007 "Interaction Design" and
  // BB-05-008 "Fine Art AV Edit Suite" are all typed general with no capacity,
  // which is how a 350-seat lecture came to be offered a design studio.
  //
  // Two patterns separate them from real teaching rooms:
  //   * everything in block BB is specialist;
  //   * in block BA, an ordinary room is named by its code alone —
  //     "BA-00-008 (35)" — while a specialist one carries a description:
  //     "BA-01-002_TADF", "BA-05-005-Media".
  //
  // Only rooms currently typed general are reclassified, so theatres and
  // computer labs keep their type. Once specialist, a room may only take
  // subjects already scheduled in it, so a reclassified room with no history
  // is offered to nobody — which is the intended effect.
  const bareCode = /^B[A-Z]-\d{2}-[\dA-Za-z.]+\s*(\([\d]+\))?\s*$/;
  let retyped = 0;
  for (const r of rooms) {
    if (r.type !== 'general') continue;
    const isBB = /^BB-/.test(r.name);
    const isDescribedBA = /^BA-/.test(r.name) && !bareCode.test(r.name);
    if (isBB || isDescribedBA) { r.type = 'specialist'; r.retyped = true; retyped++; }
  }

  const roomByName = new Map(rooms.map(r => [r.name, r.id]));

  // One-off bookings are excluded from the problem rather than solved around.
  // They were specific to spring 2026 and are not being rescheduled, so holding
  // rooms for them would shrink the building for no reason.
  //
  // Two kinds:
  //   * BK rows — one-off room bookings by a named person ("260220/BK/A
  //     Gribben"): no module, no programmes, no linked group, not teaching, and
  //     absent from the conflict graph entirely;
  //   * anything else carrying no module code and running in a single week:
  //     applicant days and their set-up, the exam-week room reservations,
  //     library sessions, course inductions, school meetings, and bookings
  //     named after a person. 48 of them, 388 room-hours.
  //
  // A module code is what separates these from teaching. A single-week booking
  // WITH one — an MBA block day, a presentation, a class test — is real
  // teaching that needs a room, and 275 of those are kept. So is a recurring
  // booking without a module code, such as the fortnightly IT maintenance
  // window, which is a standing reservation rather than a one-off.
  const oneOffBooking = r =>
    !String(r.module || '').trim() && (Number(r.n_weeks) || 0) <= 1;
  const classRows = rd('belfast_classes.csv')
    .filter(r => r.activity !== 'BK' && !oneOffBooking(r));
  const classes = classRows.map(r => {
    const start = toMin(r.current_start);
    const dur = Number(r.duration_min);
    const cand = [];
    for (const nm of splitList(r.candidate_rooms)) {
      const id = roomByName.get(nm);
      if (id !== undefined) cand.push(id);
    }
    const homeRoom = roomByName.get(r.current_room);
    return {
      id: Number(r.class_id),
      module: r.module || '',
      activity: r.activity || '',
      title: r.title || '',
      programmes: splitList(r.programmes),
      yearLevel: r.year_level,
      size: Number(r.size_estimate) || 0,
      sizeKnown: r.size_basis === 'known_headcount',
      day: DAYS.indexOf(r.current_day),
      start,
      dur,
      end: start + dur,
      roomType: r.current_room_type,
      // The room the class sits in today. For a multi-room class this is its
      // dominant room; `nRooms > 1` is the split we are trying to remove.
      homeRoom: homeRoom === undefined ? null : homeRoom,
      homeRoomName: r.current_room,
      nRooms: Number(r.n_current_rooms) || 1,
      isMultiRoom: r.is_multi_room === '1',
      weeks: weekMask(r.weeks),
      weeksText: r.weeks,
      nWeeks: Number(r.n_weeks) || 0,
      isTeaching: r.is_teaching === '1',
      // is_teaching=0 does not mean nobody attends. All 66 exams are flagged 0,
      // as are 136 lectures, yet 281 such rows carry a cohort. Soft goals key on
      // this instead, or exams get pushed into Friday evening for free.
      attended: r.is_teaching === '1' || splitList(r.programmes).length > 0,
      isBlock: r.is_block_teaching === '1',
      recommendOffsite: r.recommend_offsite === '1',
      // The data marks some bookings as not to be touched: the semester exam
      // set-up reservation, Estates exams, IT maintenance windows and applicant
      // days. They carry no module, cohort or clash edge, and the title says so
      // outright. Matching the phrase loosely catches all five wordings —
      // "Do NOT Edit or Remove booking", "- do Not Edit", "*do Not edit*".
      isFixed: /do\s*not\s*edit/i.test(r.title || ''),
      isShadow: false,
      linked: r.linked_group || '',
      order: r.group_order === '' ? null : Number(r.group_order),
      cand,
      // Baseline placement, kept so movement can be measured and reverted.
      origDay: DAYS.indexOf(r.current_day),
      origStart: start,
      origRoom: homeRoom === undefined ? null : homeRoom,
    };
  });

  // An exam is not a normal class: it may legitimately occupy several rooms at
  // once, so the one-room-per-class rule does not apply to it. It is modelled as
  // several sub-classes pinned to the same slot, which reuses the component
  // machinery — they move together, and the ordinary room-clash rule already
  // stops two of them landing in the same room.
  //
  // Pinned bookings are left alone: their room list is not in the data (only the
  // dominant room is), so inventing 25 more rooms for the exam set-up
  // reservation would be fabricating occupancy rather than modelling it.
  const shadows = [];
  let nextShadowId = 10000;
  for (const c of classes) {
    if (c.activity !== 'EXM' || c.nRooms < 2 || c.isFixed) continue;
    const taken = new Set([c.homeRoom]);
    for (let k = 1; k < c.nRooms; k++) {
      const room = c.cand.find(r => !taken.has(r));
      if (room === undefined) break; // not enough candidate rooms to go round
      taken.add(room);
      shadows.push(Object.assign({}, c, {
        id: nextShadowId++,
        isShadow: true,
        shadowOf: c.id,
        roomIndex: k,
        homeRoom: room,
        homeRoomName: rooms[room].name,
        origRoom: room,
        nRooms: 1,
        isMultiRoom: false,
      }));
    }
    c.roomsNeeded = c.nRooms;
  }
  classes.push(...shadows);

  // ---- room candidates, rebuilt ------------------------------------------
  //
  // The `candidate_rooms` column cannot be used as given. It offers a class
  // only rooms of a type it does not need: a studio class in the Illustration
  // Space is offered 69 seminar rooms and no studio at all, and a computing
  // class is offered no computer lab. Room fit therefore never failed, because
  // the list it checked against was wrong — and 70 classes in an earlier solve
  // were moved into rooms that cannot serve them.
  //
  // So the candidate set is derived here instead:
  //
  //   * a class may use rooms of its own type;
  //   * a specialist room may only take classes from a subject already
  //     scheduled in it. Averaged over both terms a specialist room serves 1.6
  //     subjects against 15.3 for a general room, so they are dedicated spaces
  //     and the booking history is the only record of to what. A specialist
  //     room with no history is offered to nobody;
  //   * computer labs are shared space in practice (9.8 subjects each), so
  //     general classes may borrow them — but a computing class may NOT be put
  //     in a room without computers;
  //   * a lecture may use a theatre, and a theatre class may use a general room
  //     big enough to hold it;
  //   * a recorded capacity must be big enough; an unrecorded one is unknown,
  //     not zero, so it does not disqualify the room;
  //   * a class may always stay where it already is.
  const subjectOf = code => String(code || '').replace(/[0-9].*$/, '');
  const roomSubjects = new Map();
  // A room that has demonstrably held a class of N students seats at least N.
  //
  // 138 rooms carry no capacity, and treating that as "seats nobody" excluded
  // ten working computing labs — every CEBE IT lab, the MAC lab, the CAD lab —
  // leaving two labs to carry what twelve carry in practice, and no clean
  // timetable for the classes that need one. The booking history settles it
  // where it can: if a class of known size was taught in a room, the room holds
  // that many. It is a floor read off observation, not an estimate, so it can
  // only ever understate a room. Rooms with no such evidence stay unknown and
  // are still offered to nobody with a size.
  const observedCapacity = new Map();
  try {
    const terms = JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8'));
    const sizeByTitle = new Map();
    for (const c of classes) {
      if (!(c.size > 0)) continue;
      sizeByTitle.set(c.title, Math.max(sizeByTitle.get(c.title) || 0, c.size));
    }
    for (const key of ['autumn', 'springCurrent']) {
      for (const row of (terms[key] || {}).rows || []) {
        const subj = subjectOf(row[0]);
        if (subj) {
          if (!roomSubjects.has(row[6])) roomSubjects.set(row[6], new Set());
          roomSubjects.get(row[6]).add(subj);
        }
        const seen = sizeByTitle.get(row[2]);
        if (seen) observedCapacity.set(row[6], Math.max(observedCapacity.get(row[6]) || 0, seen));
      }
    }
  } catch (e) { /* no history available */ }
  let inferredRooms = 0;
  for (const room of rooms) {
    if (room.capacityKnown) continue;
    const seen = observedCapacity.get(room.id);
    if (!seen) continue;
    room.capacity = seen;
    room.capacityKnown = true;
    room.capacityInferred = true;
    inferredRooms++;
  }
  for (const c of classes) {
    const subj = subjectOf(c.module);
    if (!subj || c.homeRoom == null) continue;
    if (!roomSubjects.has(c.homeRoom)) roomSubjects.set(c.homeRoom, new Set());
    roomSubjects.get(c.homeRoom).add(subj);
  }
  // Which subjects each room has actually served, kept on the room so the
  // solver can prefer a School's own lab for that School's classes. For a
  // specialist room this is already a hard restriction; for a lab it is only
  // a preference, since a lab is shared space in practice.
  for (const room of rooms) room.subjects = roomSubjects.get(room.id) || new Set();
  // A School's own lab, as opposed to the central ones anybody books. The
  // booking history says plainly who they belong to: the five "IT Lab -
  // School of Computing" rooms are 90% COM and CMP, and the CAD lab is BEN,
  // ENE, ARC, CIV and BLD — computing and engineering, exactly as the name
  // (Computing, Engineering and the Built Environment) suggests.
  for (const room of rooms) room.isSchoolLab = /CEBE|MARCS/.test(room.name);

  // A class's "size" is the capacity of the room it sits in today, not a real
  // headcount (only 17 of 1,556 rows carry one). Timetabling's working
  // assumption is that rooms are generally matched to their cohorts, so the
  // number is usable — but it is an estimate, so a 10% tolerance applies. A
  // class nominally of 90 may use an 81-seat room. Without that, sizes are
  // quantised to the capacity ladder (90, 158, 215, 250, 350) and every class
  // on a rung competes for exactly the rooms on that rung and above.
  const CAPACITY_TOLERANCE = 0.9;
  const needSeats = size => Math.ceil(size * CAPACITY_TOLERANCE);

  // Two rooms-preferences that are about the building, not the rules.
  //
  //   * the Library computer room is a student resource first. Teaching may go
  //     in it, but should prefer a School lab where one is free;
  //   * a class that does not need machines should not sit in a lab at all
  //     while computing classes are short of them. In the last rebuild 24
  //     non-computing classes held 460 lab-hours across the term, one of them
  //     a nine-hour session in a 66-seat central lab every week.
  //
  // Neither is a hard rule: both only ever break a tie between rooms that are
  // otherwise legal, so they cannot make a timetable impossible.
  for (const room of rooms) {
    room.isLibrary = /library\s*comp/i.test(room.name);
  }

  const openRooms = opts.openRooms === undefined ? ['computer'] : opts.openRooms;
  const rebuild = opts.rebuildCandidates !== false;
  const sourceCand = new Map(classes.map(c => [c.id, c.cand.slice()]));

  if (rebuild) {
    for (const c of classes) {
      const subj = subjectOf(c.module);
      const allowed = [];
      for (const room of rooms) {
        let ok = false;
        if (room.type === c.roomType) {
          ok = room.type !== 'specialist'
            ? true
            : !!(subj && roomSubjects.get(room.id) && roomSubjects.get(room.id).has(subj));
        } else if (c.roomType === 'general') {
          // A lecture is content with a theatre, and with a lab if labs are open.
          ok = room.type === 'theatre' || openRooms.includes(room.type);
        } else if (c.roomType === 'theatre') {
          ok = room.type === 'general';
        }
        if (!ok) continue;
        // Capacity. An unrecorded capacity is NOT "fits anyone": of the 138
        // rooms without one, 81 have never been used and the other 57 have only
        // ever held classes of unknown size, so nothing suggests they seat a
        // soul. Treating the blank as permissive moved a 350-seat lecture into
        // a design studio and 205 others like it. A class that needs seats
        // therefore needs a room recorded as having them — give or take the
        // tolerance below, since the number is an estimate of a headcount, not
        // a headcount.
        if (c.size > 0 && !(room.capacityKnown && room.capacity >= needSeats(c.size))) continue;
        allowed.push(room.id);
      }
      if (c.homeRoom != null && !allowed.includes(c.homeRoom)) allowed.push(c.homeRoom);
      c.cand = allowed;
    }
  }

  const byId = new Map(classes.map(c => [c.id, c]));

  const pairFile = f => rd(f)
    .map(r => [Number(r.class_id_a), Number(r.class_id_b)])
    .filter(([a, b]) => byId.has(a) && byId.has(b));

  let cannotShareTime = pairFile('conflicts_cannot_share_time.csv');
  const cannotShareDayRaw = pairFile('cannot_share_day.csv');

  // Overlap in the current timetable is positive proof: two classes running at
  // the same time cannot share a lecturer, and cannot be attended by the same
  // students. Absence of overlap proves nothing — with 5 days and 13 slots most
  // pairs miss each other by coincidence. So overlap is used to REMOVE edges,
  // never to add them.
  const overlapsToday = (a, b) =>
    a.origDay === b.origDay &&
    a.origStart < b.origStart + b.dur &&
    b.origStart < a.origStart + a.dur &&
    (a.weeks & b.weeks) !== 0;

  const splitCohorts = new Set();
  const byProgramme = new Map();
  for (const c of classes) {
    for (const p of c.programmes) {
      if (!byProgramme.has(p)) byProgramme.set(p, []);
      byProgramme.get(p).push(c);
    }
  }
  for (const [p, cs] of byProgramme) {
    outer: for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        if (overlapsToday(cs[i], cs[j])) { splitCohorts.add(p); break outer; }
      }
    }
  }

  const clashMode = opts.clashes || 'all';
  const edgeStats = { total: cannotShareTime.length, dropped: 0, staffDropped: 0 };
  if (clashMode !== 'all') {
    cannotShareTime = cannotShareTime.filter(([x, y]) => {
      const a = byId.get(x), b = byId.get(y);
      const shared = a.programmes.filter(p => b.programmes.includes(p));
      if (!shared.length) {
        // No shared cohort: this edge exists only because of the same-school,
        // shared-room staff proxy, which rests entirely on never overlapping.
        if (clashMode === 'cohort') { edgeStats.staffDropped++; return false; }
        return true;
      }
      if (shared.every(p => splitCohorts.has(p))) { edgeStats.dropped++; return false; }
      return true;
    });
  }

  // Some rooms hold several cohorts at once, on purpose. The architecture
  // studio runs five or six year groups together every Tuesday and Thursday,
  // staff circulating between them; ceramics and fine art do the same.
  // Treating that as a double-booking would call studio teaching an error, so
  // pairs that already share a room may go on sharing one.
  //
  // This MUST be read from the per-room booking history, not from this class
  // file. A class here carries only its dominant room, so two classes whose
  // dominant room happens to coincide look like room-mates when they are not:
  // deriving it from the class file gave 328 pairs of which only 33 were real,
  // which would have licensed 295 genuine double-bookings.
  const mayShareRoom = new Set();
  const shareKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  {
    const idsByTitle = new Map();
    for (const c of classes) {
      if (!idsByTitle.has(c.title)) idsByTitle.set(c.title, []);
      idsByTitle.get(c.title).push(c.id);
    }
    try {
      const terms = JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8'));
      const rows = (terms.springCurrent || {}).rows || [];
      const byRoomDay = new Map();
      for (const row of rows) {
        const k = row[6] + '|' + row[3];
        if (!byRoomDay.has(k)) byRoomDay.set(k, []);
        byRoomDay.get(k).push({ title: row[2], start: row[4], dur: row[5], weeks: weekMask(row[8]) });
      }
      for (const list of byRoomDay.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (a.title === b.title) continue;               // one booking, two rooms
            if (!(a.weeks & b.weeks)) continue;              // different weeks
            if (!(a.start < b.start + b.dur && b.start < a.start + a.dur)) continue;
            for (const x of idsByTitle.get(a.title) || []) {
              for (const y of idsByTitle.get(b.title) || []) {
                if (x !== y) mayShareRoom.add(shareKey(x, y));
              }
            }
          }
        }
      }
    } catch (e) { /* no booking history; no sharing is granted */ }
  }

  // Rule 5 is "no NEW same-day pairings" — a pair already sharing a day today
  // is grandfathered. 2,469 of 12,854 are, so this matters a lot.
  const cannotShareDay = cannotShareDayRaw.filter(([a, b]) =>
    byId.get(a).origDay !== byId.get(b).origDay);

  const byModule = new Map();
  for (const c of classes) {
    if (!c.module) continue;
    if (!byModule.has(c.module)) byModule.set(c.module, []);
    byModule.get(c.module).push(c);
  }

  // An exam that currently runs straight after one of its module's classes
  // keeps doing so, since linked_group never covers exams.
  //
  // Deliberately narrow: only EXM rows, and only one partner each. A general
  // "same module, currently adjacent" rule looks reasonable and is not — modules
  // run parallel tutorial groups, so group 1 ending as group 2 begins is a
  // densely packed day, not a relationship. Chaining those transitively welds
  // half a module's Monday into one rigid train that cannot move at all.
  const preservedAdjacency = [];
  const takenExam = new Set();
  for (const group of byModule.values()) {
    for (const e of group) {
      if (e.activity !== 'EXM' || takenExam.has(e.id)) continue;
      // Prefer the class this exam follows; fall back to the one it precedes.
      let before = null, after = null;
      for (const o of group) {
        if (o === e || o.activity === 'EXM') continue;
        if (!(o.weeks & e.weeks)) continue;
        if (o.origDay !== e.origDay) continue;
        if (o.origStart + o.dur === e.origStart && !before) before = o;
        else if (e.origStart + e.dur === o.origStart && !after) after = o;
      }
      if (before) { preservedAdjacency.push([before.id, e.id]); takenExam.add(e.id); }
      else if (after) { preservedAdjacency.push([e.id, after.id]); takenExam.add(e.id); }
    }
  }

  // Exams sit in their module's usual slot only 12 times in 51 — 20 are same-day
  // at another time and 14 are on a different day. Rather than impose a
  // convention the timetable does not follow, each exam keeps the relationship
  // it already has: one that shares a day and start time with a sibling class
  // today keeps sharing them, so it follows the lecture if the lecture moves.
  const preservedSlot = [];
  for (const group of byModule.values()) {
    for (const e of group) {
      // An exam already tied by adjacency cannot also be tied to a start time.
      if (e.activity !== 'EXM' || takenExam.has(e.id)) continue;
      for (const o of group) {
        if (o === e || o.activity === 'EXM') continue;
        if (o.origDay === e.origDay && o.origStart === e.origStart) {
          preservedSlot.push([o.id, e.id]);
          break;
        }
      }
    }
  }

  // Each sub-class of a multi-room exam starts exactly when its parent does.
  const examRooms = shadows.map(sh => [sh.shadowOf, sh.id]);

  // Linked groups, ordered by group_order: same day, contiguous, in order.
  const linkedGroups = new Map();
  for (const c of classes) {
    if (!c.linked) continue;
    if (!linkedGroups.has(c.linked)) linkedGroups.set(c.linked, []);
    linkedGroups.get(c.linked).push(c);
  }
  for (const g of linkedGroups.values()) g.sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    rooms, roomByName, classes, byId,
    cannotShareTime, cannotShareDay, cannotShareDayRaw,
    preservedAdjacency, preservedSlot, examRooms,
    openRooms, roomSubjects, sourceCand, rebuiltCandidates: rebuild, retypedRooms: retyped,
    mayShareRoom, shareKey,
    clashMode, edgeStats, splitCohorts,
    shadowCount: shadows.length,
    linkedGroups: [...linkedGroups.entries()].map(([key, members]) => ({ key, members })),
  };
}

module.exports = { load, DAYS, MAX_WEEK, toMin, fmtMin, weekMask, weekList, splitList };
