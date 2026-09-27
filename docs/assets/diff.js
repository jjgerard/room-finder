// GENERATED — copied from timetable/lib by `node timetable/export.js`.
// Edit the original, not this copy.
;(function () {
'use strict';

// Comparing a Resource Booker snapshot with the timetable on file.
//
// This lives here, and is copied into docs/assets by export.js, because it has
// two callers: timetable/refresh.js, which writes the result, and the refresh
// page, which shows it before anything is written. Those two were written
// separately and drifted — the page went on reporting 377 changes and 232
// dropped rooms after the script had been fixed to report 197 and 13. A
// preview that disagrees with the thing it is previewing is worse than none.

// One-off room bookings: a named person booked a room on a date. They carry no
// module, no cohort and no place in the clash graph, and terms.json has never
// held them, so a snapshot that includes them reads as hundreds of new
// bookings every time.
const ONE_OFF = /\/BK\//i;

// Resource Booker and the handoff CSV render the same room differently, and
// not only in punctuation:
//
//   API  BC-08-104_104A (150)              csv  BC-08-104 / 104A (150)
//   API  BC-07-210_211 Comms Lab 1         csv  BC-07-210/211 Comms Lab 1
//   API  BA-03-024 - Central computing Lab csv  BA-03-024 - MAC Central computing Lab
//
// so matching on the whole name threw away every booking in 22 real rooms. The
// leading code is the stable part.
const strip = n => String(n).replace(/^[BCM]_/, '').trim();
function codeOf(name) {
  const m = strip(name).match(/^([A-Z]{2}-\d{2}-\d{3}[A-Z]?)(\s*[/_]\s*(\d{3}[A-Z]?))?/i);
  return m ? (m[1] + (m[3] ? '/' + m[3] : '')).toUpperCase() : null;
}

// The building a room name opens with: BA, BB, BC, BD, NP across the inventory,
// and every one of its 228 rooms yields one.
//
// This is what separates two very different reasons for a room not matching,
// which the report used to run together under "not in the inventory":
//
//   BC-08-104_104A (150)    a room in a building the site models, whose name
//                           is spelled differently here. A real gap: those
//                           bookings are teaching, and dropping them loses
//                           them.
//   JSV Reception Beacon 1  not in any building the site models at all. The
//                           inventory is the solver's list of rooms it may
//                           place classes into, so a reception area does not
//                           belong in it and never has — terms.json has never
//                           carried these either.
//
// Deliberately not "does the name have a room code", which looked like the
// same test and is not: eleven inventory rooms have no code, among them
// BC-LG-211, the 350-seat lecture theatre. A drifted spelling of that one
// would have been waved through as non-teaching space.
function buildingOf(name) {
  const m = strip(name).match(/^([A-Z]{2,3})[-_ ]/i);
  return m ? m[1].toUpperCase() : null;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' +
                  String(m % 60).padStart(2, '0');

// A snapshot that lost most of the term is a failed fetch, not a quiet week.
const KEEP_AT_LEAST = 0.8;

/**
 * @param snapRows    rows as the reader returns them, room as a NAME
 * @param beforeRows  the rows on file, room as an INDEX
 * @param roomNames   room names indexed by id
 */
function compare(snapRows, beforeRows, roomNames) {
  // Name -> id, and code -> id for the names that do not match outright. A
  // code naming two rooms is left out rather than guessed at.
  const byName = new Map();
  const byCode = new Map();
  roomNames.forEach((name, id) => {
    byName.set(String(name).trim(), id);
    const c = codeOf(name);
    if (!c) return;
    byCode.set(c, byCode.has(c) ? null : id);
  });
  const roomIdOf = name => {
    const exact = byName.get(strip(name));
    if (exact !== undefined) return exact;
    const c = codeOf(name);
    const byc = c == null ? null : byCode.get(c);
    return byc == null ? undefined : byc;
  };

  const buildings = new Set();
  roomNames.forEach(name => {
    const b = buildingOf(name);
    if (b) buildings.add(b);
  });

  const rows = [];
  const unknownRooms = new Map();   // a modelled building, but no matching room
  const unmodelled = new Map();     // not a building the site models at all
  let oneOff = 0, dropped = 0, unmodelledRows = 0;
  for (const r of snapRows) {
    if (ONE_OFF.test(r[2])) { oneOff++; continue; }
    const id = roomIdOf(r[6]);
    if (id === undefined) {
      const n = strip(r[6]);
      const b = buildingOf(n);
      if (b && buildings.has(b)) {
        unknownRooms.set(n, (unknownRooms.get(n) || 0) + 1);
        dropped++;
      } else {
        unmodelled.set(n, (unmodelled.get(n) || 0) + 1);
        unmodelledRows++;
      }
      continue;
    }
    rows.push([r[0], r[1], r[2], r[3], r[4], r[5], id, r[7], r[8]]);
  }

  // A booking that has moved an hour and a booking that never existed need
  // different judgements, so they are counted separately. Grouping by title is
  // what separates them.
  const sig = r => [r[2], r[3], r[4], r[5], r[6], r[8]].join('|');
  const group = list => {
    const m = new Map();
    for (const r of list) {
      if (!m.has(r[2])) m.set(r[2], []);
      m.get(r[2]).push(r);
    }
    return m;
  };
  const was = group(beforeRows), now = group(rows);
  const roomName = id => roomNames[id] || ('#' + id);

  const moved = [], fresh = [], gone = [];
  for (const [title, list] of now) {
    if (!was.has(title)) { fresh.push(...list); continue; }
    const old = was.get(title);
    const oldSigs = new Set(old.map(sig)), newSigs = new Set(list.map(sig));
    const addedHere = list.filter(r => !oldSigs.has(sig(r)));
    const goneHere = old.filter(r => !newSigs.has(sig(r)));
    if (!addedHere.length && !goneHere.length) continue;
    if (addedHere.length === 1 && goneHere.length === 1) {
      const a = goneHere[0], b = addedHere[0], parts = [];
      if (a[3] !== b[3]) parts.push(DAYS[a[3]] + ' → ' + DAYS[b[3]]);
      if (a[4] !== b[4]) parts.push(hhmm(a[4]) + ' → ' + hhmm(b[4]));
      if (a[5] !== b[5]) parts.push(a[5] + 'min → ' + b[5] + 'min');
      if (a[6] !== b[6]) parts.push(roomName(a[6]) + ' → ' + roomName(b[6]));
      if (a[8] !== b[8]) parts.push('weeks ' + a[8] + ' → ' + b[8]);
      moved.push({ title, what: parts.join(', ') });
    } else {
      moved.push({ title, what: old.length + ' room-booking' + (old.length === 1 ? '' : 's') +
                                ' → ' + list.length });
    }
  }
  for (const [title, list] of was) if (!now.has(title)) gone.push(...list);

  return {
    rows, moved, fresh, gone, oneOff, dropped, unmodelledRows,
    unknownRooms: [...unknownRooms.entries()].sort((a, b) => b[1] - a[1]),
    unmodelled: [...unmodelled.entries()].sort((a, b) => b[1] - a[1]),
    before: beforeRows.length,
    after: rows.length,
    refused: rows.length < beforeRows.length * KEEP_AT_LEAST,
    roomName, DAYS, hhmm,
  };
}

const api = { compare, codeOf, buildingOf, strip, DAYS, hhmm, KEEP_AT_LEAST };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
// export.js copies this into docs/assets, wrapped, so the refresh page runs the
// same comparison the script does rather than its own copy of it.
if (typeof window !== 'undefined') window.TTDiff = api;

})();
