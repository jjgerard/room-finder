'use strict';

// Pack the model and the solved timetable into what the site loads, and copy
// the shared pure modules into docs/assets so the browser runs the same
// constraint and suggestion code the solver did.
//
//   node timetable/export.js
//
// Arrays rather than objects throughout: the same data as named fields is
// roughly three times the bytes, and this file is downloaded by every visitor.

const fs = require('fs');
const path = require('path');
const { load } = require('./lib/model');
const { build } = require('./lib/components');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data');
const ASSETS = path.join(DOCS, 'assets');

const model = load();
const { components } = build(model);

const solPath = path.join(DATA, 'solution.json');
if (!fs.existsSync(solPath)) {
  console.error('No solution.json — run:  node timetable/solve.js --out docs/data');
  process.exit(1);
}
const solution = JSON.parse(fs.readFileSync(solPath, 'utf8'));
const solved = new Map(solution.rows.map(r => [r.id, r]));

const packed = {
  meta: solution.meta,
  rooms: model.rooms.map(r => [r.name, r.type, r.capacity]),
  classes: model.classes.map(c => {
    const s = solved.get(c.id);
    return [
      c.id, c.module, c.activity, c.title,
      c.dur, c.weeks, c.weeksText,
      c.isTeaching ? 1 : 0, c.isBlock ? 1 : 0, c.isMultiRoom ? 1 : 0, c.nRooms,
      c.roomType, c.size,
      c.origDay, c.origStart, c.origRoom,          // where it sits today
      s ? s.day : c.origDay,                        // where the solver put it
      s ? s.start : c.origStart,
      s ? s.room : c.origRoom,
      s ? s.changed : '',
      // `attended` drives the soft-goal counts, and is NOT is_teaching: all 66
      // exams and 136 lectures are flagged non-teaching yet carry a cohort.
      c.attended ? 1 : 0,
      c.isShadow ? c.shadowOf : -1,
      c.isFixed ? 1 : 0,
    ];
  }),
  cand: model.classes.map(c => c.cand),
  timePairs: flat(model.cannotShareTime),
  dayPairs: flat(model.cannotShareDay),
  adjPairs: flat(model.preservedAdjacency),
  slotPairs: flat(model.preservedSlot),
  groups: model.linkedGroups.map(g => [g.key, ...g.members.map(m => m.id)]),
  comps: components.map(c => c.members.map(m => [m.cls.id, m.off])),
};

function flat(pairs) {
  const out = new Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) { out[2 * i] = pairs[i][0]; out[2 * i + 1] = pairs[i][1]; }
  return out;
}

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });
const outFile = path.join(DATA, 'timetable.json');
fs.writeFileSync(outFile, JSON.stringify(packed));
console.log(`wrote ${path.relative(ROOT, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);

// One source of truth: these are copied, never hand-edited in docs/assets.
//
// Wrapped in an IIFE on the way out. In node each file has its own module
// scope, but a <script> tag shares one global scope, so two files that both
// declare `const api` collide and the second one silently fails to define its
// global. The wrapper gives each the private scope it had in node.
const banner = '// GENERATED — copied from timetable/lib by `node timetable/export.js`.\n' +
               '// Edit the original, not this copy.\n';
for (const f of ['constraints.js', 'suggest.js']) {
  const src = fs.readFileSync(path.join(__dirname, 'lib', f), 'utf8');
  fs.writeFileSync(path.join(ASSETS, f), banner + ';(function () {\n' + src + '\n})();\n');
  console.log(`copied lib/${f} -> docs/assets/${f}`);
}
