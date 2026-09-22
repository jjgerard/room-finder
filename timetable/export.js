'use strict';

// Pack everything the site loads, and copy the shared pure modules into
// docs/assets so the browser runs the same constraint and suggestion code the
// solver did.
//
//   node timetable/export.js
//
// Three timetables go out:
//   autumn      — Autumn 2026 as it stands (display only)
//   springNow   — Spring 2026 as it stands, one row per class-room booking, so
//                 a class split across rooms shows up once per room
//   springNew   — the rebuilt Spring 2026, with the full model behind it so the
//                 browser can re-check the rules and suggest moves
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

const solPath = path.join(DATA, 'solution.json');
if (!fs.existsSync(solPath)) {
  console.error('No solution.json — run:  node timetable/solve.js --out docs/data');
  process.exit(1);
}
const solution = JSON.parse(fs.readFileSync(solPath, 'utf8'));
const solved = new Map(solution.rows.map(r => [r.id, r]));

// Load the model exactly as the solve did. If the solution was produced
// against a pruned clash graph and the site shipped the full one, the page
// would report violations of rules the solver was never given.
const model = load(null, { clashes: solution.meta.clashMode || 'all' });
const { components } = build(model);
const terms = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'terms.json'), 'utf8'));

// ---- one programme vocabulary across every term -----------------------------
// The two sources agree on names, so they merge cleanly: the class file carries
// programmes per class, while the older term data carries them per module.
const progIdx = new Map();
const progName = [];
function progId(name) {
  if (!progIdx.has(name)) { progIdx.set(name, progName.length); progName.push(name); }
  return progIdx.get(name);
}
for (const d of terms.degrees) progId(d);
for (const c of model.classes) for (const p of c.programmes) progId(p);

// module code → programme ids, from the older data's module map
const modProgs = new Map();
const modTitle = new Map();
for (const [code, entry] of Object.entries(terms.mod)) {
  modProgs.set(code, (entry[0] || []).map(i => progId(terms.degrees[i])).filter(x => x >= 0));
  if (entry[1]) modTitle.set(code, entry[1]);
}

// A display row: [module, activity, title, day, start, dur, room, nWeeks,
//                 weeks, progIds, changed]
function displayRow(r, progs, changed) {
  return [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], progs, changed || ''];
}

// Facts about a term AS IT STANDS, for the About page's comparisons.
//
// These used to be a block of numbers typed into docs/assets/method.js, taken
// once from the source bookings. That was fine while the bookings never
// changed; it stopped being fine the moment timetable/refresh.js could pull a
// new snapshot from Resource Booker, because the page would go on quoting the
// old term with no way to tell. Computing them here means a refresh updates
// them, and the definitions live next to the data they are taken from rather
// than in a comment beside a literal.
//
// Every definition below reproduces the figure it replaced, exactly.
// How many corrections timetabling has supplied, by kind. The About page says
// what it took to get a term clean — "sixty-two confirmed cohort sizes, two
// classes told what kind of room they need" — and those were counted by hand
// into the prose. They are rows in files right here, so count them: the next
// correction should move the sentence without anybody remembering to.
function correctionCounts() {
  const rows = file => {
    const p = path.join(__dirname, 'data', file);
    if (!fs.existsSync(p)) return 0;
    return fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).slice(1)
      .filter(l => l.trim()).length;
  };
  return {
    sizes: rows('class_sizes.csv'),
    roomTypes: rows('room_types.csv'),
    keepSlot: rows('keep_slot.csv'),
    mayShare: rows('may_share_room.csv'),
    roomReqs: rows('room_requirements.csv'),
    notShared: rows('not_shared.csv'),
  };
}

function todayStats(rows) {
  const R = { title: 2, day: 3, start: 4, dur: 5, room: 6, weeks: 8 };
  const DAY_START = 9 * 60 + 15, DAY_END = 17 * 60 + 15;

  // A "booking" is a timetable code. The same code appearing against three
  // rooms is one booking in three rooms, not three bookings — which is the
  // whole point of the comparison, so it has to be counted that way.
  const roomsOf = new Map();
  for (const r of rows) {
    const k = r[R.title];
    if (!roomsOf.has(k)) roomsOf.set(k, new Set());
    roomsOf.get(k).add(r[R.room]);
  }
  const counts = [...roomsOf.values()].map(s => s.size);
  const split = counts.filter(n => n > 1);

  // Two different bookings holding one room at the same moment in a week they
  // share. Every one of these in spring is shared teaching — studios, the
  // hospitality kitchen, a joint physiology lab — which the rebuild keeps, so
  // the page quotes it to show the room rule already holds rather than as a
  // fault. Weeks matter: two bookings in one room in weeks 1-6 and 7-12 never
  // meet, and counting them as a clash was what once made the site report 288
  // room clashes that do not happen.
  let sharedRoomPairs = 0;
  const byRoomDay = new Map();
  for (const r of rows) {
    const k = r[R.room] + '|' + r[R.day];
    if (!byRoomDay.has(k)) byRoomDay.set(k, []);
    byRoomDay.get(k).push(r);
  }
  for (const list of byRoomDay.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a[R.title] === b[R.title]) continue;
        if (!(a[R.start] < b[R.start] + b[R.dur] && b[R.start] < a[R.start] + a[R.dur])) continue;
        if (!(weekMask(a[R.weeks]) & weekMask(b[R.weeks]))) continue;
        sharedRoomPairs++;
      }
    }
  }

  return {
    roomBookings: rows.length,          // one row per class-room booking
    bookings: roomsOf.size,             // distinct timetable codes
    splitBookings: split.length,        // codes using more than one room
    maxRooms: counts.length ? Math.max(...counts) : 0,
    splitExtra: split.reduce((n, x) => n + x - 1, 0),
    sharedRoomPairs,
    at0915: rows.filter(r => r[R.start] === DAY_START).length,
    at0815: rows.filter(r => r[R.start] === DAY_START - 60).length,
    outside: rows.filter(r => r[R.start] < DAY_START ||
                              r[R.start] + r[R.dur] > DAY_END).length,
  };
}

/** "1-6,8" -> bitmask. The week text is all the display rows carry. */
function weekMask(pattern) {
  let mask = 0;
  String(pattern == null ? '' : pattern).split(',').forEach(part => {
    part = part.trim().replace(/\u2013/g, '-');
    if (!part) return;
    const dash = part.indexOf('-', 1);
    if (dash > 0) {
      const a = parseInt(part.slice(0, dash), 10), b = parseInt(part.slice(dash + 1), 10);
      if (isNaN(a) || isNaN(b)) return;
      for (let w = Math.max(1, a); w <= Math.min(16, b); w++) mask |= 1 << (w - 1);
    } else {
      const v = parseInt(part, 10);
      if (!isNaN(v) && v >= 1 && v <= 16) mask |= 1 << (v - 1);
    }
  });
  return mask;
}

const autumnRows = terms.autumn.rows.map(r =>
  displayRow(r, modProgs.get(r[0]) || []));

const springNowRows = terms.springCurrent.rows.map(r =>
  displayRow(r, modProgs.get(r[0]) || []));

// Autumn rebuilt, when a solution for it exists. Display only, like autumn as
// it stands: the checkable model the browser carries is the spring one, and
// shipping a second whole model would double the download for a tab that only
// needs to be read.
let autumnNewRows = null, autumnNewUnresolved = 0;
let autumnPack = null;   // the autumn model, written beside the main file
let autumnScore = null;  // its rule counts, for the About page
const autumnSolPath = path.join(DATA, 'solution-autumn.json');
if (fs.existsSync(autumnSolPath)) {
  const autumnSol = JSON.parse(fs.readFileSync(autumnSolPath, 'utf8'));
  const autumnModel = load(null, { clashes: autumnSol.meta.clashMode || 'all', term: 'autumn' });
  const placed = new Map(autumnSol.rows.map(r => [r.id, r]));
  autumnNewRows = autumnModel.classes.map(c => {
    const a = placed.get(c.id);
    const progs = c.programmes.length
      ? c.programmes.map(x => progId(x))
      : (modProgs.get(c.module) || []);
    return displayRow(
      [c.module, c.activity, c.title,
        a ? a.day : c.origDay, a ? a.start : c.origStart, c.dur,
        a ? a.room : c.origRoom, c.nWeeks, c.weeksText],
      progs, a ? a.changed : '');
  });
  // Set below, from the score computed against the site's teaching day —
  // never from the solution file's own count.
  autumnNewUnresolved = 0;
  // The same shape the spring model is packed in, so the browser can hydrate
  // it with the same code. It goes in its own file: Fix a clash needs it and
  // nothing else does, so the pages that only show a timetable should not pay
  // for it on load.
  const autumnComps = build(autumnModel).components;
  // Autumn's own scorecard. AFTER build(), which marks the components too
  // wide for a teaching day: a chain longer than the day may overflow its
  // end, and scoring before that flag is set reports those as violations
  // the solver never saw. Computed here because the browser is never given
  // autumn's model: the numbers on the About page would otherwise be spring's
  // with an autumn label.
  {
    const C = require('./lib/constraints');
    const opts = { dayStart: C.DAY_START, dayEnd: C.DAY_END };
    const baseline = new Map(autumnModel.classes.map(c =>
      [c.id, { day: c.origDay, start: c.origStart, room: c.origRoom, weeks: c.origRoomWeeks }]));
    const solvedAssign = new Map(autumnModel.classes.map(c => {
      const a = placed.get(c.id);
      return [c.id, { day: a ? a.day : c.origDay, start: a ? a.start : c.origStart,
                      room: a ? a.room : c.origRoom, extra: a && a.extra }];
    }));
    const fixedChk = C.check(autumnModel, solvedAssign, opts);
    autumnScore = {
      now: C.check(autumnModel, baseline,
        Object.assign({ occupancy: autumnModel.currentOccupancy }, opts)).counts,
      fixed: fixedChk.counts,
      // What is still broken, by name. The solution file's own count came
      // from a run that graded itself against a widened teaching day and
      // said 0; this one uses the day the site enforces.
      left: fixedChk.violations.map(v => {
        const c = autumnModel.byId.get(v.a);
        return { kind: v.kind, what: `${c.module || c.activity}/${c.activity}` };
      }),
      classes: autumnModel.classes.length,
      groups: autumnModel.linkedGroups.length,
      // Sessions that finish after 17:15. The rule excuses them, for one of
      // two reasons, and the page should say which: a linked chain longer than
      // a teaching day, or a session pinned in the evening dragging the class
      // chained in front of it past the end. Reporting both as chain length
      // was wrong for COM772, whose chain is 300 minutes.
      overflow: (() => {
        const out = { chain: 0, pinned: 0 };
        for (const c of autumnModel.classes) {
          const a = solvedAssign.get(c.id);
          if (!a || c.isFixed || a.start + c.dur <= C.DAY_END) continue;
          const comp = autumnComps[c.component];
          if (comp && comp.span > C.DAY_WIDTH) out.chain++; else out.pinned++;
        }
        out.total = out.chain + out.pinned;
        return out;
      })(),
    };
  }


  autumnPack = {
    meta: autumnSol.meta,
    classes: packClasses(autumnModel, placed, c => c.programmes.map(x => progId(x))),
    cand: autumnModel.classes.map(c => c.cand),
    candType: autumnModel.classes.map(c => c.candType || c.cand),
    sharePairs: flat([...autumnModel.mayShareRoom].map(k => k.split(':').map(Number))),
    timePairs: flat(autumnModel.cannotShareTime),
    dayPairs: flat(autumnModel.cannotShareDay),
    adjPairs: flat(autumnModel.preservedAdjacency),
    slotPairs: flat(autumnModel.preservedSlot),
    groups: autumnModel.linkedGroups.map(g => [g.key, ...g.members.map(m => m.id)]),
    comps: autumnComps.map(c => c.members.map(m => [m.cls.id, m.off])),
  };
  // The solution file's own count, not the site's: it came from a run that
  // graded itself against a widened teaching day. The real figure is printed
  // with the term list below, from autumnScore.
  console.log(`  autumn rebuilt: ${autumnNewRows.length} rows, ` +
              `${Object.values(autumnScore.fixed).reduce((n, v) => n + v, 0)} hard violations` +
              (autumnScore.left.length
                ? ` (${autumnScore.left.map(x => x.kind + ' ' + x.what).join(', ')})` : ''));
}

// The rebuilt term comes from the solver, so its programmes are per class.
const springNewRows = model.classes.map(c => {
  const s = solved.get(c.id);
  const progs = c.programmes.map(p => progId(p));
  return displayRow(
    [c.module, c.activity, c.title,
      s ? s.day : c.origDay, s ? s.start : c.origStart, c.dur,
      s ? s.room : c.origRoom, c.nWeeks, c.weeksText],
    progs, s ? s.changed : '');
});

// ---- the model behind the rebuilt term, for checking and suggestions --------
const packed = {
  meta: solution.meta,
  // When this file was built. meta.generated is the day SPRING was solved, so
  // it said 2026-09-21 on a file whose autumn term had been re-solved since.
  generated: new Date().toISOString().slice(0, 10),
  rooms: model.rooms.map(r => [r.name, r.type, r.capacity]),
  programmes: progName,
  modTitles: Object.fromEntries(modTitle),
  terms: {
    autumn: { label: 'Autumn 2026', sub: 'as it stands', rows: autumnRows, checkable: 0,
              today: todayStats(autumnRows) },
    springNow: { label: 'Spring 2026', sub: 'as it stands', rows: springNowRows, checkable: 0,
                 today: todayStats(springNowRows) },
    springNew: { label: 'Spring 2026', sub: 'rebuilt', rows: springNewRows, checkable: 1 },
  },
  // What timetabling has corrected, for the About page's account of how a term
  // got clean.
  corrections: correctionCounts(),
  classes: packClasses(model, solved, c => c.programmes.map(p => progId(p))),
  cand: model.classes.map(c => c.cand),
  // Rooms of a kind each class can use, whatever their size: what a
  // split across two rooms is judged against.
  candType: model.classes.map(c => c.candType || c.cand),  // The room-type overrides as they stand, so the page that edits them starts
  // from what the solver is actually using rather than from an empty form.
  roomTypes: (() => {
    const file = path.join(__dirname, 'data', 'room_types.csv');
    if (!fs.existsSync(file)) return [];
    const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const cols = head.split(',');
    return lines.filter(Boolean).map(l => {
      const v = l.split(',');
      const row = {};
      cols.forEach((c, i) => { row[c] = (v[i] || '').trim(); });
      return [row.module || '', row.activity || '', row.type || '', row.source || ''];
    });
  })(),
  // Pairs already sharing a room today, which may keep doing so. Without
  // these the browser counts all 160 of them as double-bookings and reports a
  // timetable as far worse than the checker that produced it found it: the
  // site said 29 violations where the solver said 9.
  sharePairs: flat([...model.mayShareRoom].map(k => k.split(':').map(Number))),
  timePairs: flat(model.cannotShareTime),
  dayPairs: flat(model.cannotShareDay),
  adjPairs: flat(model.preservedAdjacency),
  slotPairs: flat(model.preservedSlot),
  groups: model.linkedGroups.map(g => [g.key, ...g.members.map(m => m.id)]),
  comps: components.map(c => c.members.map(m => [m.cls.id, m.off])),
};

if (autumnNewRows && autumnScore) {
  autumnNewUnresolved = Object.values(autumnScore.fixed).reduce((n, v) => n + v, 0);
}

if (autumnNewRows) {
  // Say so while it is not clean. The tab is display-only, so a visitor has no
  // way to check it for themselves the way the spring rebuild can be checked.
  const left = autumnNewUnresolved;
  packed.terms.autumnNew = {
    label: 'Autumn 2026', checkable: 0, rows: autumnNewRows,
    sub: left ? 'rebuilt \u2014 ' + left + ' unresolved' : 'rebuilt',
    score: autumnScore,
  };
}


/** One term's classes, in the row shape docs/assets/model.js reads. */
function packClasses(model, solved, progsOf) {
  return model.classes.map(c => {
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
      progsOf(c),
    ];
  });
}

function flat(pairs) {
  const out = new Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) { out[2 * i] = pairs[i][0]; out[2 * i + 1] = pairs[i][1]; }
  return out;
}

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });
if (autumnPack) {
  const autumnFile = path.join(DATA, 'autumn.json');
  fs.writeFileSync(autumnFile, JSON.stringify(autumnPack));
  console.log(`wrote ${path.relative(ROOT, autumnFile)} ` +
              `(${(fs.statSync(autumnFile).size / 1024).toFixed(0)} KB, ` +
              `${autumnPack.classes.length} classes)`);
}

const outFile = path.join(DATA, 'timetable.json');
fs.writeFileSync(outFile, JSON.stringify(packed));
console.log(`wrote ${path.relative(ROOT, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
console.log(`  autumn ${autumnRows.length} rows · spring now ${springNowRows.length} · ` +
            `spring rebuilt ${springNewRows.length} · ${progName.length} programmes`);

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

// The snapshot script, served so docs/admin.html can hand it over with the
// dates already filled in. Copied verbatim rather than wrapped: it is pasted
// into another site's console, not loaded as a script here.
{
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'term-snapshot.js'), 'utf8');
  fs.writeFileSync(path.join(ASSETS, 'term-snapshot.js'),
    '// GENERATED — copied from tools/term-snapshot.js by `node timetable/export.js`.\n' +
    '// Edit the original, not this copy.\n' + src);
  console.log('copied tools/term-snapshot.js -> docs/assets/term-snapshot.js');
}
