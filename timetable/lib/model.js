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
  // Real cohort sizes, where somebody has told us one.
  //
  // Every other size in this model is the capacity of the room the class sits
  // in today, which is only as good as the original room choice. COM663 and
  // BME104 are booked into the 215-seat Conor Lecture Theatre and take about
  // 100 students, so the proxy had them competing for the three biggest rooms
  // on campus for no reason. PPD428, BMG350 and BMG403 really do need 250.
  //
  // Applied as a cap, never a floor: a module's seminar groups are
  // subdivisions of its cohort, so a figure for the module must not inflate
  // them. A size of 0 means "not recorded" and stays that way.
  const trueSizes = new Map();
  try {
    for (const row of rd('class_sizes.csv')) {
      const n = Number(row.size);
      if (row.module && n > 0) trueSizes.set(row.module.trim(), n);
    }
  } catch (e) { /* no confirmed sizes available */ }

  // Deciding what a module's cohort figure means for one of its classes.
  //
  // Capping is the safe default and was the original rule: a class is never
  // inflated, because a seminar group is a subdivision and cannot be larger
  // than the whole. But capping alone cannot correct a proxy that is too
  // SMALL — BMG632 teaches 100 in a room of 90 — so a class that is plainly
  // the whole cohort takes the figure exactly, up or down.
  //
  // "Plainly the whole cohort" is drawn narrowly: a lecture or an exam whose
  // title carries no group marker. Everything else caps. Getting that wrong in
  // the cautious direction only means keeping a proxy; getting it wrong the
  // other way would inflate ECO109's "SEM Group C" to all 220 students, which
  // is how the first version of this went astray.
  const isGroup = title => /\b(gp|grp|group)\s*[0-9a-z]?/i.test(String(title || ''));
  const wholeCohort = r =>
    (r.activity === 'LEC' || r.activity === 'EXM') && !isGroup(r.title);
  const sizeFor = r => {
    const proxy = Number(r.size_estimate) || 0;
    const cohort = trueSizes.get(String(r.module || '').trim());
    if (cohort == null) return proxy;
    if (proxy === 0) return 0;                       // unrecorded stays unrecorded
    if (wholeCohort(r)) return cohort;
    return Math.min(proxy, cohort);
  };
  const sizeConfirmedFor = r => {
    const cohort = trueSizes.get(String(r.module || '').trim());
    if (cohort == null || !(Number(r.size_estimate) > 0)) return false;
    return wholeCohort(r);
  };

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
  const classRows = (opts.term === 'autumn'
    ? require('./autumn').autumnRows(
        JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8')), rooms)
    : rd('belfast_classes.csv'))
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
      // A confirmed figure is the module's COHORT. What that means for a
      // given class depends on whether the class is the whole cohort or one
      // group of it, and the title says which: PUP531 teaches "LEC Gp1" and
      // "SEM Gp2", BMG632 teaches "LEC/SEM" to everyone.
      //
      //   * a whole-cohort class takes the figure exactly, up or down —
      //     BMG632 is 100 where its room implied 90, and a 100-person class
      //     does not go in a 90-seat room;
      //   * a group keeps its own proxy, capped by the cohort, since a group
      //     is a subdivision and cannot be larger than the whole.
      size: sizeFor(r),
      sizeConfirmed: sizeConfirmedFor(r),
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
      // Pinned: not ours to move, and not judged against the teaching day.
      //
      // Bookings marked "do not edit" in the source — exam set-up, Estates, IT
      // maintenance — and anything already taught in the evening.
      //
      // The 9-to-5 day was meant for daytime provision, and applying it to
      // everything moved 42 evening classes into the middle of the working
      // day. Nineteen modules are taught wholly in the evening, and the
      // programme names say why: BA Hons Modern Irish PT, Dip in Irish
      // Language PT, MSc Human Resource Management PT, MSc FinTech Management
      // PT, MBA (Executive) PT. Part-time and executive students are taught
      // after work; a 10:15 Tuesday slot is not an inconvenience to them, it
      // is an impossibility. The society bookings — the Christian Union, a law
      // event, the K-pop society — are the same story without a cohort.
      //
      // So an evening booking stays exactly where it is. All 45 of them sit
      // together today without a single room or cohort collision, and pinning
      // them hands 886 room-hours back to the daytime timetable.
      //
      // Only the evening. A class starting before 09:15 is still moved into
      // the day, which is what was asked for.
      isFixed: /do\s*not\s*edit/i.test(r.title || '') || start >= 17 * 60 + 15,
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

  // ---- what each class actually occupies, room by room --------------------
  //
  // belfast_classes.csv gives a class ONE dominant room and one week list
  // covering every room it uses. That is lossy in a way that invents clashes:
  // ENE806 is in BA-00-008 in weeks 7-8 and 12-14 and elsewhere in weeks 1-5,
  // but the class file says "BA-00-008, weeks 1,2,4,5,7,8,12,13,14", so BMG715
  // holding that room in week 1 looks like a double-booking. Checked this way,
  // today's timetable scored 288 room clashes, none of them real.
  //
  // terms.json has the truth: one row per class-room booking, each with its
  // own weeks. Join on the booking title and keep, per class, the weeks it is
  // in its dominant room and the other rooms it uses.
  const bookingsByTitle = new Map();
  try {
    const terms = JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8'));
    const rows = ((opts.term === 'autumn' ? terms.autumn : terms.springCurrent) || {}).rows || [];
    for (const row of rows) {
      const t = row[2];
      if (!bookingsByTitle.has(t)) bookingsByTitle.set(t, []);
      bookingsByTitle.get(t).push({ room: row[6], day: row[3], start: row[4], dur: row[5],
                                    weeks: weekMask(row[8]) });
    }
  } catch (e) { /* no booking history: every class keeps its full week mask */ }

  for (const c of classes) {
    // Rows under this title, the ones in the same slot first: a title can
    // cover two sittings, and the class file sometimes merges them.
    const rows = (bookingsByTitle.get(c.title) || []);
    const here = rows.filter(r => r.day === c.origDay && r.start === c.origStart);
    const use = here.length ? here : rows;
    c.bookedRooms = use.map(r => ({ room: r.room, weeks: r.weeks }));
    const mine = use.filter(r => r.room === c.origRoom);
    if (mine.length) {
      c.origRoomWeeks = mine.reduce((m, r) => m | r.weeks, 0);
    } else if (here.length) {
      // The class file's dominant room is not one this booking uses. That
      // happens where it merged two sittings under one title — BME104's class
      // test and its resit are different rooms in different weeks, and the
      // class file carries the test's room with both sets of weeks. A row
      // matching on title, day and start is the better witness, so take its
      // room; otherwise the baseline puts the class in a room it never had.
      c.origRoom = here[0].room;
      c.homeRoom = here[0].room;
      c.homeRoomName = rooms[here[0].room] ? rooms[here[0].room].name : c.homeRoomName;
      c.origRoomWeeks = here.filter(r => r.room === here[0].room)
                            .reduce((m, r) => m | r.weeks, 0);
    } else {
      // No witness at all: the full mask over-reserves rather than under-
      // reserving, which is the safe direction.
      c.origRoomWeeks = c.weeks;
    }

    // How many rooms the class holds AT ONCE, which is not how many it uses.
    // A class that moves from one room to another mid-term uses two and holds
    // one; MEC114's tutorial holds eight in the same hour, because the 350
    // students are taught in eight parallel groups under a single booking
    // title. The first is a split the rebuild can close by giving the class
    // one room. The second is not: those rooms are the teaching.
    let par = c.bookedRooms.length ? 1 : 1;
    for (let w = 0; w < MAX_WEEK; w++) {
      const inWeek = new Set();
      for (const b of c.bookedRooms) if (b.weeks & (1 << w)) inWeek.add(b.room);
      if (inWeek.size > par) par = inWeek.size;
    }
    c.parallelRooms = par;
    c.wanders = par === 1 && new Set(c.bookedRooms.map(b => b.room)).size > 1;

    // A class that moves between rooms has to fit in every one of them, so
    // the largest is the better proxy for its size. Taking the dominant room
    // instead sized SOP543 at 12 when it also meets in rooms for 24, and the
    // rebuild duly offered it the 12. A confirmed cohort still wins, and
    // still caps this.
    if (c.wanders) {
      let widest = 0, widestRoom = null;
      for (const b of c.bookedRooms) {
        const r = rooms[b.room];
        if (r && r.capacityKnown && r.capacity > widest) { widest = r.capacity; widestRoom = b.room; }
      }
      if (!c.sizeConfirmed && widest > c.size) {
        const cohort = trueSizes.get(String(c.module || '').trim());
        c.size = cohort == null ? widest : Math.min(widest, cohort);
      }
      // And its baseline room is that one, not whichever the class file called
      // dominant. A class with no single room today has no true "where it is";
      // the widest is the only one of its rooms that holds it all term, and
      // staying put is always legal, so starting from a room too small left
      // SOP543 in a room for 12 when it also meets in one for 24.
      if (widestRoom !== null && widest >= c.size) {
        c.origRoom = widestRoom;
        c.homeRoom = widestRoom;
        c.homeRoomName = rooms[widestRoom].name;
        c.origRoomWeeks = c.bookedRooms.filter(b => b.room === widestRoom)
                                       .reduce((m, b) => m | b.weeks, 0) || c.weeks;
      }
    }
  }

  // ---- classes told to stay exactly where they are ------------------------
  //
  // The pinning rule catches the evening by the clock — anything from 17:15 —
  // but a class can run past the teaching day without starting after it.
  // POL310 goes Monday 15:15 to 18:15, immediately after PUP318's lecture,
  // and the two share four cohorts: stacked end to end they never collide,
  // and the only way to fit both inside 09:15-17:15 is to move one to another
  // day. Where that trade has already been made, saying so here keeps it.
  try {
    for (const row of rd('keep_slot.csv')) {
      const mod = String(row.module || '').trim();
      const act = String(row.activity || '').trim();
      if (!mod) continue;
      for (const c of classes) {
        if (c.module !== mod) continue;
        if (act && c.activity !== act) continue;
        c.isFixed = true;
        c.keptSlot = true;
      }
    }
  } catch (e) { /* nothing pinned by hand */ }

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
    if (c.isFixed) continue;
    // Exams fall back to the class file's room count, because the booking
    // history names only one room for some of them (BEN140 books four and
    // appears once) and an exam's sittings are real either way.
    const want = Math.max(c.parallelRooms || 1, c.activity === 'EXM' ? c.nRooms : 1);
    if (want < 2) continue;
    const taken = new Set([c.homeRoom]);
    // The other rooms the exam really used, from the booking history. Taking
    // them from the candidate list instead put sittings in rooms the exam
    // never touched — BME104's resit landed in BC-02-308, which is CMM170's
    // lecture room, and the baseline check duly reported a clash that has
    // never happened. Candidates are still the fallback where the history
    // does not reach, because a sitting has to be somewhere.
    const booked = (c.bookedRooms || []).map(b => b.room).filter(r => r !== c.homeRoom);
    for (let k = 1; k < want; k++) {
      let room = booked.find(r => !taken.has(r));
      let weeks = null;
      if (room === undefined) room = c.cand.find(r => !taken.has(r));
      else weeks = (c.bookedRooms.filter(b => b.room === room)
                     .reduce((m, b) => m | b.weeks, 0)) || null;
      if (room === undefined) break; // not enough rooms to go round
      taken.add(room);
      shadows.push(Object.assign({}, c, {
        id: nextShadowId++,
        isShadow: true,
        shadowOf: c.id,
        roomIndex: k,
        homeRoom: room,
        homeRoomName: rooms[room].name,
        origRoom: room,
        origRoomWeeks: weeks == null ? c.weeks : weeks,
        // Sized by the room it is booked into, capped by the class itself.
        // Copying the parent's size would say each of MEC114's seven tutorial
        // rooms holds the same 50 its dominant room does, and the cohort is
        // 350; taking the room's capacity alone would put BME104's exam at
        // 158 when timetabling has confirmed the cohort is 100.
        size: Math.min(c.size,
          rooms[room] && rooms[room].capacityKnown ? rooms[room].capacity : c.size),
        sizeConfirmed: false,
        nRooms: 1,
        isMultiRoom: false,
        parallelRooms: 1,
        wanders: false,
      }));
    }
    c.roomsNeeded = want;
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
  // number is usable — but it is an estimate, so a tolerance applies. Without
  // one, sizes are quantised to the capacity ladder (90, 158, 215, 250, 350)
  // and every class on a rung competes for exactly the rooms on that rung and
  // above.
  //
  // 12%, not 10%, for a specific reason. Six of the last nine unresolved
  // clashes were 90-seat classes, and the largest CEBE lab seats 80 — at 10%
  // they needed 81 and missed it by a single seat. Widening to 12% costs
  // little and is bounded: it adds 662 (class, room) options across 327
  // classes, and the tightest squeeze it permits anywhere is exactly that
  // case, a nominal 90 in a room of 80.
  const CAPACITY_TOLERANCE = opts.capacityTolerance == null ? 0.88 : opts.capacityTolerance;
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

  // Rooms a class must be in, whatever else would fit.
  //
  // Some classes belong to a particular room for reasons the booking data does
  // not carry — the software licensed on its machines, a piece of equipment,
  // an access arrangement. Timetabling names them; the model obeys. A
  // requirement narrows the candidate list to that one room, so the search has
  // to move whatever is in the way rather than move this class.
  //
  // The activity column is optional: blank means every class of the module.
  const roomRequirements = [];
  try {
    for (const row of rd('room_requirements.csv')) {
      const room = rooms.find(r => r.name === row.room_name);
      if (!room || !row.module) continue;
      roomRequirements.push({
        module: row.module.trim(),
        activity: String(row.activity || '').trim(),
        roomId: room.id,
      });
    }
  } catch (e) { /* no room requirements */ }
  const requiredRoom = c => {
    for (const req of roomRequirements) {
      if (req.module !== c.module) continue;
      if (req.activity && req.activity !== c.activity) continue;
      return req.roomId;
    }
    return null;
  };

  // The kind of room a class needs is read off the kind it sits in today,
  // which is right until it is not: CMM350's seminar meets in a Central
  // Computing Lab and so is offered only the seven computer rooms, when it
  // wants an ordinary seminar room and the lab could go back to the classes
  // that need one. This file overrides the inference, by module and
  // optionally by activity.
  const typeOverrides = [];
  try {
    for (const row of rd('room_types.csv')) {
      if (!row.module || !row.type) continue;
      typeOverrides.push({
        module: row.module.trim(),
        activity: String(row.activity || '').trim(),
        type: row.type.trim(),
      });
    }
  } catch (e) { /* no overrides */ }
  for (const c of classes) {
    for (const o of typeOverrides) {
      if (o.module !== c.module) continue;
      if (o.activity && o.activity !== c.activity) continue;
      c.roomType = o.type;
      c.roomTypeOverridden = true;
      break;
    }
  }

  const openRooms = opts.openRooms === undefined ? ['computer'] : opts.openRooms;
  const rebuild = opts.rebuildCandidates !== false;
  const sourceCand = new Map(classes.map(c => [c.id, c.cand.slice()]));

  if (rebuild) {
    for (const c of classes) {
      const subj = subjectOf(c.module);
      const allowed = [], allowedByType = [];
      for (const room of rooms) {
        let ok = false;
        if (c.roomType === 'seminar') {
          // Not a room type in the data: a request for an ordinary teaching
          // room with tables that can be pushed together. A theatre is raked
          // and a lab is full of machines, so neither will do — CMM378 needs
          // group tables and meets in a Central Computing Lab today.
          ok = room.type === 'general';
        } else if (room.type === c.roomType) {
          ok = room.type !== 'specialist'
            ? true
            : !!(subj && roomSubjects.get(room.id) && roomSubjects.get(room.id).has(subj));
        } else if (c.roomType === 'general') {
          // A lecture is content with a theatre, and with a lab if labs are
          // open — unless it was moved to 'general' on purpose, which says it
          // wants an ordinary room rather than that it will tolerate one.
          ok = room.type === 'theatre' ||
               (!c.roomTypeOverridden && openRooms.includes(room.type));
        } else if (c.roomType === 'theatre') {
          ok = room.type === 'general';
        }
        if (!ok) continue;
        allowedByType.push(room.id);
        // Capacity. An unrecorded capacity is NOT "fits anyone": of the 138
        // rooms without one, 81 have never been used and the other 57 have only
        // ever held classes of unknown size, so nothing suggests they seat a
        // soul. Treating the blank as permissive moved a 350-seat lecture into
        // a design studio and 205 others like it. A class that needs seats
        // therefore needs a room recorded as having them — give or take the
        // tolerance below, since the number is an estimate of a headcount, not
        // a headcount.
        // The tolerance exists because a size is usually the capacity of the
        // room the class sits in today, not a headcount. Where somebody has
        // told us the real number it gets no such benefit of the doubt: 225
        // students do not go in a 215-seat theatre.
        const needs = c.sizeConfirmed ? c.size : needSeats(c.size);
        if (c.size > 0 && !(room.capacityKnown && room.capacity >= needs)) continue;
        allowed.push(room.id);
      }
      // Staying put is normally allowed whatever the room, because a class
      // sitting somewhere unexpected is usually a gap in the data rather than
      // a mistake. An overridden type is the exception: the point of saying a
      // seminar does not belong in a computer lab is that it must leave one.
      if (c.homeRoom != null && !allowed.includes(c.homeRoom) && !c.roomTypeOverridden) {
        allowed.push(c.homeRoom);
      }
      // The same list without the capacity test: rooms of a kind this class
      // could use, whatever their size. A class split across two rooms is in
      // neither of them whole, so capacity is a question about the pair, not
      // about each one, but the KIND of room still has to be right.
      c.candType = allowedByType;
      const must = requiredRoom(c);
      if (must !== null) { c.cand = [must]; c.roomRequired = must; continue; }
      c.cand = allowed;
    }
  }

  const byId = new Map(classes.map(c => [c.id, c]));

  const pairFile = f => rd(f)
    .map(r => [Number(r.class_id_a), Number(r.class_id_b)])
    .filter(([a, b]) => byId.has(a) && byId.has(b));

  // Spring's conflict pairs arrive as files keyed to its own class ids. Autumn
  // has none, so they are derived from the same thing those files encode: two
  // classes cannot share a time if a cohort attends both, and two DIFFERENT
  // modules of one cohort should not land on the same day. Deriving them here
  // rather than shipping another file keeps the two terms on one definition.
  let cannotShareTime, cannotShareDayRaw;
  if (opts.term === 'autumn') {
    const pairs = [], dayPairs = [];
    const byProgramme = new Map();
    for (const c of classes) {
      for (const p of c.programmes) {
        if (!byProgramme.has(p)) byProgramme.set(p, []);
        byProgramme.get(p).push(c);
      }
    }
    const seenTime = new Set(), seenDay = new Set();
    const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
    for (const [, cs] of byProgramme) {
      // A cohort of 400 classes would be 80,000 pairs on its own; the cap is
      // what stops one enormous programme dominating the graph, and it is the
      // same shape of judgement the spring files already embody.
      if (cs.length > 120) continue;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const a = cs[i], b = cs[j];
          const k = key(a.id, b.id);
          if (!seenTime.has(k)) { seenTime.add(k); pairs.push([a.id, b.id]); }
          if (a.module && b.module && a.module !== b.module && !seenDay.has(k)) {
            seenDay.add(k); dayPairs.push([a.id, b.id]);
          }
        }
      }
    }
    cannotShareTime = pairs;
    cannotShareDayRaw = dayPairs;
  } else {
    cannotShareTime = pairFile('conflicts_cannot_share_time.csv');
    cannotShareDayRaw = pairFile('cannot_share_day.csv');
  }

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

  // Modules that share no students, whatever the programme lists say.
  //
  // A programme-year is treated as a cohort that must never be double-booked,
  // which is right for a full-time year and wrong for a part-time one, where
  // the list is what a student MAY take rather than what they all do. POL310
  // and POL507 are linked only through "BSc Hons Politics and IntStds PT
  // (8525) Y4", a part-time year with three modules between them; the other
  // two programmes linking those modules already overlap themselves eleven
  // times in the current timetable, so the model correctly ignores those.
  // Where somebody knows the two are never taken together, saying so here
  // beats waiting for the timetable to evidence it.
  const notShared = new Set();
  let dropsNotShared = 0;
  try {
    for (const row of rd('not_shared.csv')) {
      const a = String(row.module_a || '').trim(), b = String(row.module_b || '').trim();
      if (a && b) notShared.add(a < b ? a + '|' + b : b + '|' + a);
    }
  } catch (e) { /* no exclusions */ }
  if (notShared.size) {
    const before = cannotShareTime.length;
    const unrelated = (x, y) => {
      const a = String(x.module || ''), b = String(y.module || '');
      return notShared.has(a < b ? a + '|' + b : b + '|' + a);
    };
    cannotShareTime = cannotShareTime.filter(([x, y]) => !unrelated(byId.get(x), byId.get(y)));
    cannotShareDayRaw = cannotShareDayRaw.filter(([x, y]) => !unrelated(byId.get(x), byId.get(y)));
    dropsNotShared = before - cannotShareTime.length;
  }

  const clashMode = opts.clashes || 'all';
  const edgeStats = { total: cannotShareTime.length + dropsNotShared, dropped: 0,
                      staffDropped: 0, notShared: dropsNotShared };
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

  // Measured and rejected: stating up front that a module's own sessions
  // cannot overlap when their shared pool of rooms is too small for both.
  // CMM111 teaches its labs in parallel groups across the eight comms labs
  // and one booking fills all eight, so a second CMM111 lab in the same hour
  // needs a ninth room that does not exist — true, and the search meets it
  // only as a room clash, late. Stated as a clash edge it made things worse:
  // 865 edges across the timetable took autumn's best seed from 6 violations
  // to 9, and narrowing it to one module's own sessions (258 edges) gave 11
  // and 9 against 6 and 4. The freedom to try the overlap and back out of it
  // is worth more than the warning.

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
  const currentOccupancy = [];
  const shareKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  {
    const idsByTitle = new Map();
    for (const c of classes) {
      if (!idsByTitle.has(c.title)) idsByTitle.set(c.title, []);
      idsByTitle.get(c.title).push(c.id);
    }
    try {
      const terms = JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8'));
      const rows = ((opts.term === 'autumn' ? terms.autumn : terms.springCurrent) || {}).rows || [];
      const byRoomDay = new Map();
      for (const row of rows) {
        const k = row[6] + '|' + row[3];
        if (!byRoomDay.has(k)) byRoomDay.set(k, []);
        byRoomDay.get(k).push({ title: row[2], start: row[4], dur: row[5], weeks: weekMask(row[8]) });
        // Today's room usage as booked: room, day, slot and weeks all per
        // booking. The class file cannot express this — it gives a class one
        // room, one slot and one week list covering everything it does — so
        // the current timetable is judged against the rule from here instead.
        currentOccupancy.push({
          title: row[2], module: row[0], room: row[6], day: row[3],
          start: row[4], dur: row[5], weeks: weekMask(row[8]),
          ids: idsByTitle.get(row[2]) || [],
        });
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
    mayShareRoom, shareKey, currentOccupancy,
    clashMode, edgeStats, splitCohorts,
    shadowCount: shadows.length,
    linkedGroups: [...linkedGroups.entries()].map(([key, members]) => ({ key, members })),
  };
}

module.exports = {
  CAPACITY_TOLERANCE_DEFAULT: 0.88,
  load, DAYS, MAX_WEEK, toMin, fmtMin, weekMask, weekList, splitList,
};
