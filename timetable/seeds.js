'use strict';

// Packs several solved timetables for one term into a single small file, so
// the site can offer them as alternatives instead of shipping one and calling
// it the answer.
//
// The search starts from a random shuffle, so a term usually has more than one
// clean arrangement. Picking the best by the soft score and hiding the rest
// overstates how much any single one means: what a reader should be able to
// see is that several different starts all land on zero, and how differently
// they use the week.
//
// A solution file is ~500 KB; fourteen of them is not a download. What the
// site actually needs is three numbers per class, so this writes those as
// parallel arrays in the order timetable/export.js lays the display rows out
// (model.classes order), and the browser rewrites the rows in place.
//
//   node timetable/solve.js --term spring --seed0 6 --seeds 1 --out /tmp/s6
//   node timetable/seeds.js --term spring --in /tmp/s6 /tmp/s7 --out docs/data
//
// Every solution is re-checked here against a freshly loaded model before it
// goes in the file. A seed is offered as clean because it checks clean now,
// not because a log said so when it ran.

const fs = require('fs');
const path = require('path');
const { load } = require('./lib/model');
const C = require('./lib/constraints');
const components = require('./lib/components');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function argList(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) {
    out.push(process.argv[j]);
  }
  return out;
}

const TERM = arg('term', 'spring');
// A term may have a violation no arrangement can remove — autumn's COM772
// lecture is chained to a session pinned at 18:15, so it overflows the
// teaching day whatever else moves. Packing only zeros would leave that term
// with nothing to show. --floor says how many such violations to allow; the
// count is still checked exactly, and what they are is written into the file
// so the page can name them rather than round them away.
const FLOOR = Number(arg('floor', 0));
const OUT = arg('out', 'docs/data');
const IN = argList('in');
if (!IN.length) {
  console.error('nothing to pack: give --in <dir> [<dir> ...]');
  process.exit(1);
}

const SOL = TERM === 'spring' ? 'solution.json' : `solution-${TERM}.json`;
// The browser names the rebuilt terms this way; the file is read by key.
const TERM_KEY = TERM === 'spring' ? 'springNew' : 'autumnNew';

// One model for every seed. They were all solved from the same data, so a
// mismatch in class count means a solution is stale and must not be offered.
const model = load(null, { clashes: 'evidenced', term: TERM });
components.build(model);
console.log(`${TERM}: ${model.classes.length} classes`);

// d/t/r as bits, so the per-class flags cost one small integer rather than a
// quoted string each. docs/assets/seeds.js turns them back into the letters
// the timetable page already understands.
const MOVED_DAY = 1, MOVED_TIME = 2, MOVED_ROOM = 4;

const packed = [];
for (const dir of IN) {
  const file = path.join(path.resolve(dir), SOL);
  if (!fs.existsSync(file)) { console.log(`  skipped ${dir}: no ${SOL}`); continue; }
  const sol = JSON.parse(fs.readFileSync(file, 'utf8'));
  const by = new Map(sol.rows.map(r => [r.id, r]));
  if (by.size !== model.classes.length) {
    console.log(`  skipped ${file}: ${by.size} rows against ${model.classes.length} classes`);
    continue;
  }

  const assign = new Map();
  const day = [], start = [], room = [], flags = [];
  let missing = 0;
  for (const c of model.classes) {
    const r = by.get(c.id);
    if (!r) { missing++; continue; }
    assign.set(c.id, { day: r.day, start: r.start, room: r.room, extra: r.extra });
    day.push(r.day); start.push(r.start); room.push(r.room);
    flags.push((r.day !== c.origDay ? MOVED_DAY : 0) |
               (r.start !== c.origStart ? MOVED_TIME : 0) |
               (r.room !== c.origRoom ? MOVED_ROOM : 0));
  }
  if (missing) { console.log(`  skipped ${file}: ${missing} classes have no placement`); continue; }

  // The claim being published is "this one breaks no rule". Check it here
  // rather than trust the run that produced it.
  const chk = C.check(model, assign, {});
  if (chk.total !== FLOOR) {
    console.log(`  skipped seed ${sol.meta.seed}: ${chk.total} violations on re-check` +
                (FLOOR ? ` (the floor is ${FLOOR})` : ''));
    continue;
  }
  const forced = chk.violations.map(v => {
    const c = model.byId.get(v.a);
    return { kind: v.kind, what: `${c.module || c.activity}/${c.activity}` };
  });
  const soft = C.softScore(model, assign);
  const mv = C.movement(model, assign);
  packed.push({
    seed: sol.meta.seed,
    edge: soft.edge, wed: soft.wed,
    gapDays: sol.meta.gapDays, moved: mv.total - mv.untouched, untouched: mv.untouched,
    splitRooms: sol.meta.splitRooms || 0,
    violations: chk.total, forced: forced,
    day, start, room, flags,
  });
  console.log(`  seed ${String(sol.meta.seed).padStart(3)}  ${chk.total} violations  ` +
              `edge ${soft.edge}  gaps ${sol.meta.gapDays}  moved ${mv.total - mv.untouched}` +
              (forced.length ? '  forced: ' + forced.map(f => f.kind + ' ' + f.what).join(', ') : ''));
}

if (!packed.length) { console.error('nothing clean to pack'); process.exit(1); }
// Fewest classes in an early or late slot first: the list is a menu, and the
// one a reader would pick belongs at the top of it.
packed.sort((a, b) => a.edge - b.edge || a.moved - b.moved);

const outFile = path.join(path.resolve(OUT), `seeds-${TERM}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  term: TERM, termKey: TERM_KEY,
  classes: model.classes.length,
  // The best any arrangement of this term can do, and why.
  floor: FLOOR,
  generated: new Date().toISOString().slice(0, 10),
  // Which one the rest of the site is built from, so the page can mark it.
  published: JSON.parse(
    fs.readFileSync(path.join(path.resolve(OUT), SOL), 'utf8')).meta.seed,
  seeds: packed,
}));
const kb = Math.round(fs.statSync(outFile).size / 1024);
console.log(`\nwrote ${outFile} — ${packed.length} clean timetables, ${kb} KB`);
