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

// ---- compare ---------------------------------------------------------------
// The comparison itself is in lib/diff.js, because the refresh page runs it
// too and the two had already drifted apart once.
const { compare, DAYS, hhmm } = require('./lib/diff');

// Two room names contain commas and are quoted for it, so splitting on commas
// truncated them — and left the quote on the front, which is enough to stop
// the room code being recognised as well as the name.
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

const roomCsv = fs.readFileSync(path.join(DATA, 'belfast_rooms.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const roomNames = [];
for (const line of roomCsv) {
  const [id, name] = csvCells(line);
  roomNames[Number(id)] = name.trim();
}

const terms = JSON.parse(fs.readFileSync(TERMS, 'utf8'));
const before = terms[KEY].rows;

const d = compare(snap.rows, before, roomNames);
const rows = d.rows;

console.log(`snapshot: ${snap.term}, taken ${String(snap.takenAt).slice(0, 10)}, ` +
            `${snap.from} to ${snap.to}`);
console.log(`bookings: ${d.before} \u2192 ${d.after} in the snapshot`);
if (d.oneOff) console.log(`          ${d.oneOff} one-off BK bookings left out, as the data always has`);
if (d.dropped) console.log(`          ${d.dropped} rows dropped \u2014 the room is not in the inventory`);
if (d.unknownRooms.length) {
  console.log(`rooms not in belfast_rooms.csv (${d.unknownRooms.length}):`);
  d.unknownRooms.slice(0, 10).forEach(([n, c]) => console.log(`   ${n} (${c} bookings)`));
}

const show = (list, mark, fmt, head) => {
  if (!list.length) return;
  console.log(`\n${head}`);
  list.slice(0, 12).forEach(x => console.log('   ' + mark + ' ' + fmt(x)));
  if (list.length > 12) console.log(`   \u2026 and ${list.length - 12} more`);
};
const slot = r => `${r[2]}  ${DAYS[r[3]]} ${hhmm(r[4])} \u00b7 ${d.roomName(r[6])} ` +
                  `\u00b7 weeks ${r[8]}`;
show(d.moved, '~', x => `${x.title}  ${x.what}`,
     `${d.moved.length} booking${d.moved.length === 1 ? '' : 's'} moved:`);
show(d.fresh, '+', slot, `${d.fresh.length} new booking${d.fresh.length === 1 ? '' : 's'}:`);
show(d.gone, '-', slot,
     `${d.gone.length} booking${d.gone.length === 1 ? '' : 's'} no longer in the term:`);
if (!d.moved.length && !d.fresh.length && !d.gone.length) console.log('\nNothing has changed.');

// A snapshot that lost most of the term is a failed fetch, not a quiet week.
// Refusing is the only safe default: the file it would overwrite is the only
// record of the timetable this site was built from.
if (d.refused) {
  console.error(`\nREFUSED: the snapshot has ${d.after} bookings against ${d.before} on file. ` +
                `That is too large a drop to be a real change \u2014 check the date range and ` +
                `that every room was read. Pass --force if it really is right.`);
  if (!process.argv.includes('--force')) process.exit(1);
}

if (DRY) { console.log('\n--dry-run: nothing written'); process.exit(0); }

terms[KEY].rows = rows;
// When each term as it stands was last refreshed. The rebuilt terms are
// solutions to the timetable as it was, and their "moved from today" figures
// compare against it — so once a refresh is newer than a solution, those
// figures are measuring against a timetable that no longer exists. Recording
// the date is what lets the site say so instead of quietly being wrong.
terms.refreshed = terms.refreshed || {};
terms.refreshed[KEY] = String(snap.takenAt).slice(0, 10);
terms.note = `Autumn 2026 and the current Spring 2026 timetable. Room indices match ` +
  `belfast_rooms.csv. One row per class-room booking, so a class split across rooms ` +
  `appears once per room. ${KEY} refreshed from Resource Booker on ` +
  `${String(snap.takenAt).slice(0, 10)}.`;
fs.writeFileSync(TERMS, JSON.stringify(terms));
console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), TERMS)}`);

// terms.json and docs/data are a pair, and the rebuilt term is a solution to
// the timetable as it stood — so a refresh that changes anything leaves it
// repairing something that has moved. Do all of it here.
//
// The repair comes BEFORE the export, not after. Exporting first publishes a
// rebuilt term full of violations and relies on somebody running a second
// command to clear them; the first time that was tried the second command
// never ran, and docs/data was left with 155 of them.
const { spawnSync } = require('child_process');
const run = (args, what) => {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nthe ${what} failed \u2014 terms.json is updated, docs/data is not.`);
    process.exit(1);
  }
};

const TERM = snap.term === 'spring' || snap.term === 'springCurrent' ? 'spring' : snap.term;
const SOL = path.join(__dirname, '..', 'docs', 'data',
                      TERM === 'spring' ? 'solution.json' : `solution-${TERM}.json`);
const changed = d.moved.length || d.fresh.length || d.gone.length;

if (process.argv.includes('--no-export')) {
  console.log('\nnext: node timetable/export.js');
} else if (changed && !process.argv.includes('--no-repair') && fs.existsSync(SOL)) {
  // Repair, not re-solve: the rebuilt term is still a valid arrangement of
  // everything that did not move, so the solver only has to place what did.
  // Seconds rather than an hour, and it keeps the timetable people may
  // already have looked at. It packs the site data itself.
  console.log('\nrepairing the rebuilt term for what moved\u2026\n');
  run([path.join(__dirname, 'solve.js'), '--term', TERM, '--from', SOL,
       '--seeds', '1', '--clashes', 'evidenced', '--out',
       path.join(__dirname, '..', 'docs', 'data')], 'repair');
} else {
  console.log('\npacking the site data\u2026\n');
  run([path.join(__dirname, 'export.js')], 'export');
}

console.log('\nDone. Commit the changes to publish them.');
