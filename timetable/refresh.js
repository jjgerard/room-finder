'use strict';

// Folds a snapshot taken from Resource Booker back into timetable/data/terms.json,
// so the two "as it stands" timetables show what the timetabling team has actually
// booked rather than a frozen extract.
//
//   1. open Resource Booker, sign in, open a booking-type page
//   2. paste tools/term-snapshot.js into the console
//   3. snapshotTerm({ term: 'autumn', from: '2026-09-21', to: '2026-12-18',
//                     weekOneMonday: '2026-09-21' })
//   4. node timetable/refresh.js --in ~/Downloads/snapshot-autumn.json
//   5. node timetable/export.js
//
// WHAT IT DOES NOT REFRESH, and this matters:
//
//   - The clash graph. "These two share students" was inferred from the
//     timetable as it stood, and the API does not carry enrolment. A refreshed
//     current timetable is therefore solved against clash data derived from an
//     older one. The further the two drift apart, the weaker the inference.
//   - Programme links (`degrees`, `mod`). Those come from the handoff CSVs.
//   - The rebuilt terms. They are solutions to the old snapshot: their
//     "moved from today" and "untouched" counts are measured against a
//     timetable that has since changed. Re-solve after a refresh that moves
//     anything substantial.
//
// So this keeps the current timetables honest. It does not keep the rebuild
// honest, and it says so rather than letting the dates quietly diverge.

const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// Either `--in <file>` or just the path. Typing `node timetable/refresh.js `
// and dragging the downloaded file onto the terminal window is the shortest
// route on both Windows and macOS, and neither pastes a `--in` for you.
const loose = process.argv.slice(2).find((a, i) =>
  !a.startsWith('--') && /\.json$/i.test(a) &&
  process.argv[i + 1] !== '--in' && process.argv[i + 1] !== '--out');
const IN = arg('in', loose || '');
const DATA = path.join(__dirname, 'data');
const TERMS = path.join(DATA, 'terms.json');
const DRY = process.argv.includes('--dry-run');

if (!IN) {
  console.error('usage: node timetable/refresh.js <snapshot.json> [--dry-run]\n' +
                '   or: type the command, then drag the downloaded file onto this window');
  process.exit(1);
}

const snap = JSON.parse(fs.readFileSync(path.resolve(IN), 'utf8'));
// The snapshot names the term the way the site does; terms.json keys the
// current spring timetable as springCurrent.
const KEY = { autumn: 'autumn', spring: 'springCurrent', springCurrent: 'springCurrent' }[snap.term];
if (!KEY) {
  console.error(`the snapshot's term is "${snap.term}" — expected autumn or spring`);
  process.exit(1);
}

// ---- rooms -----------------------------------------------------------------
// terms.json stores a room INDEX into belfast_rooms.csv. The API returns names
// with a campus prefix (B_BA-00-008 (35)); the csv has them without.
const roomCsv = fs.readFileSync(path.join(DATA, 'belfast_rooms.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1);
// Two room names contain commas and are quoted for it, so splitting on commas
// truncated them — and left the quote on the front, which is enough to stop
// the code below recognising the room code too.
function csvCells(line) {
  const out = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cell); cell = ''; }
    else cell += c;
  }
  out.push(cell);
  return out;
}

const roomId = new Map();
for (const line of roomCsv) {
  const [id, name] = csvCells(line);
  roomId.set(name.trim(), Number(id));
}
const strip = n => String(n).replace(/^[BCM]_/, '').trim();

// Resource Booker and the handoff CSV render the same room differently, and
// not only in punctuation:
//
//   API  BC-08-104_104A (150)              csv  BC-08-104 / 104A (150)
//   API  BC-07-210_211 Comms Lab 1         csv  BC-07-210/211 Comms Lab 1
//   API  BA-03-024 - Central computing Lab csv  BA-03-024 - MAC Central computing Lab
//
// so matching on the whole name dropped 232 bookings as "rooms not in the
// inventory" when every one of them was there. The leading code is the stable
// part: 215 of the 228 rooms have one and only BC-02-404 is shared, so a code
// naming two rooms is left unmatched rather than guessed at.
const codeOf = n => {
  const m = strip(n).match(/^([A-Z]{2}-\d{2}-\d{3}[A-Z]?)(\s*[/_]\s*(\d{3}[A-Z]?))?/i);
  return m ? (m[1] + (m[3] ? '/' + m[3] : '')).toUpperCase() : null;
};
const byCode = new Map();
for (const [name, id] of roomId) {
  const c = codeOf(name);
  if (!c) continue;
  if (byCode.has(c)) byCode.set(c, null);      // shared: never guess
  else byCode.set(c, id);
}
/** The inventory id for a room as the API names it, or undefined. */
function roomIdOf(name) {
  const exact = roomId.get(strip(name));
  if (exact !== undefined) return exact;
  const c = codeOf(name);
  const byc = c && byCode.get(c);
  return byc == null ? undefined : byc;
}

const terms = JSON.parse(fs.readFileSync(TERMS, 'utf8'));
const before = terms[KEY].rows;

const unknownRooms = new Map();
const rows = [];
let dropped = 0, oneOff = 0;
for (const r of snap.rows) {
  const [module, activity, title, day, start, dur, room, nWeeks, weeksText] = r;
  // One-off room bookings: a named person booked a room on a date. They carry
  // no module, no cohort and no place in the clash graph, and terms.json has
  // never held them — so a snapshot that includes them reads as hundreds of
  // new bookings every time.
  if (/\/BK\//i.test(title)) { oneOff++; continue; }
  const id = roomIdOf(room);
  if (id === undefined) {
    unknownRooms.set(strip(room), (unknownRooms.get(strip(room)) || 0) + 1);
    dropped++;
    continue;
  }
  // Weekend bookings are kept. The site's week grid draws Monday to Friday, but
  // the term genuinely has Saturday teaching — IRS149 and IRS151 run Saturday
  // mornings — and a refresh that quietly dropped them would be losing data the
  // file it replaces already holds.
  rows.push([module, activity, title, day, start, dur, id, nWeeks, weeksText]);
}

// ---- what changed ----------------------------------------------------------
// A refresh that silently replaces 3,000 rows is not a refresh, it is a
// migration. Print the difference so a person can decide whether to keep it.
const sig = row => [row[2], row[3], row[4], row[5], row[6], row[8]].join('|');
const was = new Set(before.map(sig));
const now = new Set(rows.map(sig));
const added = rows.filter(r => !was.has(sig(r)));
const gone = before.filter(r => !now.has(sig(r)));

console.log(`snapshot: ${snap.term}, taken ${String(snap.takenAt).slice(0, 10)}, ` +
            `${snap.from} to ${snap.to}`);
console.log(`bookings: ${before.length} on file → ${rows.length} in the snapshot`);
console.log(`          ${added.length} new or moved, ${gone.length} no longer there`);
if (oneOff) console.log(`          ${oneOff} one-off BK bookings left out, as the data always has`);
if (dropped) console.log(`          ${dropped} rows dropped — the room is not in the inventory`);
if (unknownRooms.size) {
  console.log(`rooms not in belfast_rooms.csv (${unknownRooms.size}):`);
  [...unknownRooms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([n, c]) => console.log(`   ${n} (${c} bookings)`));
}
for (const r of added.slice(0, 10)) {
  console.log(`   + ${r[2]} day ${r[3]} ${String(r[4])} weeks ${r[8]}`);
}
if (added.length > 10) console.log(`   … and ${added.length - 10} more`);

// A snapshot that lost most of the term is a failed fetch, not a quiet week.
// Refusing is the only safe default: the file it would overwrite is the only
// record of the timetable this site was built from.
if (rows.length < before.length * 0.8) {
  console.error(`\nREFUSED: the snapshot has ${rows.length} bookings against ${before.length} ` +
                `on file. That is too large a drop to be a real change — check the date range ` +
                `and that every room was read. Pass --force if it really is right.`);
  if (!process.argv.includes('--force')) process.exit(1);
}

if (DRY) { console.log('\n--dry-run: nothing written'); process.exit(0); }

terms[KEY].rows = rows;
terms.note = `Autumn 2026 and the current Spring 2026 timetable. Room indices match ` +
  `belfast_rooms.csv. One row per class-room booking, so a class split across rooms ` +
  `appears once per room. ${KEY} refreshed from Resource Booker on ` +
  `${String(snap.takenAt).slice(0, 10)}.`;
fs.writeFileSync(TERMS, JSON.stringify(terms));
console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), TERMS)}`);

// Run the export too. terms.json and docs/data are a pair — a refreshed first
// one with a stale second publishes a timetable that no longer exists, and
// leaving that as a second command somebody has to remember is how it would
// happen. --no-export is for anybody assembling several changes first.
if (process.argv.includes('--no-export')) {
  console.log('next: node timetable/export.js');
} else {
  console.log('packing the site data\u2026\n');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'export.js')],
                      { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('\nthe export failed — terms.json is updated, docs/data is not.');
    process.exit(1);
  }
}

console.log('\nDone. Commit the changes to publish them.');
if (added.length || gone.length) {
  console.log('The rebuilt terms are still solutions to the timetable as it was; if much');
  console.log('has moved, re-solve them:');
  console.log('  node timetable/solve.js --term autumn --seeds 30 --clashes evidenced ' +
              '--out docs/data');
}
