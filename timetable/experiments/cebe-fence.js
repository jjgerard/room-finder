'use strict';

// What does it cost to treat the CEBE labs as one school's property?
//
//   node timetable/experiments/cebe-fence.js spring 20
//
// Eight rooms carry "CEBE" or "MARCS" in their names, six of them "School of
// Computing" — and eight schools teach in them. This asks what the term costs
// if the name were taken literally: a class may use a CEBE lab only if it
// already sits in one. Everything else is untouched, so any difference is the
// ring-fence and nothing else.
//
// The numbers it produced on 28 Sep 2026 are recorded in timetable/labs.js and
// shown on docs/labs.html. Re-run it to check them; it takes about an hour.
//
// TWO THINGS THIS GOT WRONG FIRST, both worth keeping in view:
//
//   - The room pattern was /CEBE|MARCS|CAD/, which matches "BD ACADemy". The
//     first run ring-fenced the catering kitchens and gave a confident answer
//     to a question nobody asked. Word boundaries, and labs.test.js checks the
//     eight matched are the eight intended.
//   - It ran at five seeds, where the variance between runs is larger than the
//     difference between configurations. That version scored some releases as
//     WORSE than fencing everything, which is impossible — releasing a room
//     only ever adds options. That impossibility is the only thing that
//     revealed it was measuring noise, so the arms are compared on median and
//     mean as well as best, and twenty seeds is the floor.

//
// The five-seed leave-one-out could not answer this: its configurations
// disagreed by less than the seed-to-seed noise, and several scored better
// than physically possible (releasing a room cannot make a term harder). So
// this drops to three arms and spends the seeds on them instead.
//
//   none    nothing ring-fenced — the term as it is timetabled today
//   all8    every CEBE lab reserved for the classes already in them
//   but311  the same, except BC-03-311 stays open to everyone
//
// If but311 recovers most of the distance from all8 back to none, the ask is
// one room. If it does not, it is a policy argument about the whole set.
const { load } = require(require('path').join(__dirname, '..', 'lib', 'model'));
const { Solver } = require(require('path').join(__dirname, '..', 'lib', 'solver'));
const CEBE = /\bCEBE\b|\bMARCS\b|CAD Lab/i;
const TERM = process.argv[2] || 'spring';
const SEEDS = Number(process.argv[3] || 20);

function run(fenced) {
  const model = load(null, { clashes: 'evidenced', term: TERM });
  for (const c of model.classes) {
    const inside = (c.bookedRooms || []).some(b => fenced.has(b.room)) || fenced.has(c.origRoom);
    if (inside || !c.cand) continue;
    c.cand = c.cand.filter(r => !fenced.has(r));
  }
  const out = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = new Solver(model, { seed, start: 'current', noise: 0.03, maxIters: 200000 });
    s.run(); s.intensify(400); s.chainSweep(); s.homeSweep(2);
    if (s.totalHard()) s.splitRepair(3);
    out.push(s.totalHard());
    process.stderr.write('.');
  }
  return out;
}

const probe = load(null, { clashes: 'evidenced', term: TERM });
const labs = probe.rooms.filter(r => CEBE.test(r.name));
const all = new Set(labs.map(r => r.id));
const id311 = labs.find(r => /BC-03-311/.test(r.name)).id;
const but311 = new Set([...all].filter(id => id !== id311));

// Each arm prints as it finishes, not all three at the end: the last attempt
// was stopped at 10 of 60 solves and had written nothing, so the work was
// simply lost.
const arms = [];
for (const [name, fenced] of [['none  (today)', new Set()],
                              ['all8  (every CEBE lab fenced)', all],
                              ['but311 (all fenced except BC-03-311)', but311]]) {
  const v = run(fenced);
  arms.push([name, v]);
  console.log('\n[' + TERM + '] ' + name + ' -> ' + v.join(' ') +
              '   clean ' + v.filter(x => x === 0).length + '/' + SEEDS +
              '  best ' + Math.min(...v));
}

console.log('\n' + TERM.toUpperCase() + ' — ' + SEEDS + ' seeds per arm\n');
console.log('  ' + 'arm'.padEnd(38) + 'clean   best  median  mean');
for (const [name, v] of arms) {
  const s = [...v].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const mean = (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
  console.log('  ' + name.padEnd(38) + String(v.filter(x => x === 0).length + '/' + SEEDS).padEnd(8) +
              String(s[0]).padEnd(6) + String(med).padEnd(8) + mean);
}
console.log();
arms.forEach(([n, v]) => console.log('  ' + n.split(' ')[0].padEnd(8) + v.join(' ')));
