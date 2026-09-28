'use strict';

// The CEBE labs: which of the eight is load-bearing, and what the answer rests
// on. Writes docs/data/labs.json, which docs/labs.html renders.
//
//   node timetable/labs.js
//
// The structural figures below are computed here, from the same model the
// solver uses, so they cannot drift from the timetable the site ships. The
// solver figures are not — they come from 60 runs of
// timetable/experiments/cebe-fence.js and are recorded, with the date and the
// command, because re-deriving them takes an hour.
//
// WHAT "CEBE" MEANS HERE, and why the pattern is fussier than it looks: the
// first version of this analysis used /CEBE|MARCS|CAD/, which matches
// "BD ACADemy" on the substring CAD. It duly ring-fenced the catering kitchens
// along with the labs and produced a confident, wrong answer. The word
// boundaries are the fix, and labs.test.js checks the eight rooms matched are
// the eight rooms named.
const fs = require('fs');
const path = require('path');
const { load } = require('./lib/model');

const CEBE = /\bCEBE\b|\bMARCS\b|CAD Lab/i;

// Recorded, not computed. Regenerate with:
//   node timetable/experiments/cebe-fence.js spring 20
const EXPERIMENT = {
  ran: '2026-09-28',
  term: 'spring',
  seeds: 20,
  command: 'node timetable/experiments/cebe-fence.js spring 20',
  arms: {
    none:   [2,5,4,2,2,0,0,0,2,2,3,2,3,3,0,1,1,4,1,2],
    all8:   [6,6,4,10,7,6,7,4,11,4,7,3,4,3,8,4,2,8,4,10],
    but311: [5,4,6,6,2,4,3,3,4,0,5,4,3,1,3,7,4,3,1,3],
  },
};

function analyse(term) {
  const model = load(null, { clashes: 'evidenced', term });
  const labs = model.rooms.filter(r => CEBE.test(r.name));
  const ids = new Set(labs.map(r => r.id));

  // A class is "inside the fence" if it already teaches in a CEBE lab — by any
  // room it books, not just its dominant one, because a class split across
  // rooms is in all of them.
  const teaching = model.classes.filter(c => c.isTeaching && c.cand && c.cand.length);
  const inside = c => (c.bookedRooms || []).some(b => ids.has(b.room)) || ids.has(c.origRoom);
  const outside = teaching.filter(c => !inside(c));

  const rooms = labs.map(r => {
    const uses = outside.filter(c => c.cand.includes(r.id));
    // The number that decides the argument: classes for which this is the ONLY
    // CEBE room that fits. Every lab but the largest scores zero, because the
    // capacities nest — anything that fits a 50-seat lab fits the 80.
    const sole = uses.filter(c => c.cand.filter(x => ids.has(x)).length === 1);
    const sizes = sole.map(c => c.size).filter(s => s > 0).sort((a, b) => a - b);
    return {
      code: (r.name.match(/^[A-Z]{2}-\d{2}-\d{3}/) || [r.name])[0],
      name: r.name,
      capacity: r.capacity,
      demand: uses.length,
      sole: sole.length,
      soleSizes: sizes.length ? [sizes[0], sizes[sizes.length - 1]] : null,
    };
  }).sort((a, b) => b.capacity - a.capacity);

  return {
    labs: labs.length,
    keep: teaching.length - outside.length,
    lose: outside.length,
    slots: outside.reduce((n, c) => n + c.cand.filter(r => ids.has(r)).length, 0),
    // Nobody is stranded: the cost is lost flexibility, not impossibility, and
    // the page says so rather than letting the reader assume the stronger claim.
    stranded: outside.filter(c => c.cand.filter(r => !ids.has(r)).length === 0).length,
    rooms,
  };
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  spring: analyse(undefined),
  autumn: analyse('autumn'),
  experiment: EXPERIMENT,
};

const file = path.join(__dirname, '..', 'docs', 'data', 'labs.json');
fs.writeFileSync(file, JSON.stringify(out));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)}`);
for (const t of ['spring', 'autumn']) {
  const a = out[t];
  console.log(`  ${t}: ${a.labs} labs | ${a.keep} classes keep access, ${a.lose} lose it | ` +
              `${a.slots} candidate slots removed | ${a.stranded} stranded`);
  a.rooms.filter(r => r.sole).forEach(r =>
    console.log(`     sole option: ${r.code} (${r.capacity}) for ${r.sole} classes, ` +
                `sizes ${r.soleSizes[0]}–${r.soleSizes[1]}`));
}
console.log(`  experiment (${EXPERIMENT.ran}): ` +
  Object.entries(EXPERIMENT.arms).map(([k, v]) =>
    `${k} best ${Math.min(...v)} mean ${mean(v).toFixed(1)}`).join(' | '));
