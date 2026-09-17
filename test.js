/* Tests — run with `node test.js` from this folder. No dependencies.
 *
 * parse.js and analyse.js are pure modules and are tested directly. content.js needs a
 * signed-in Resource Booker session, so only its date/time core is covered, by pulling
 * that section out of the file between its banner comments; if you move the section,
 * move the banners with it.
 */
'use strict';
var fs = require('fs');
var parse = require('./parse.js').parse;
var A = require('./analyse.js');

var fails = 0, ran = 0;
function eq(label, got, want) {
  ran++;
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL ' + label + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else console.log('ok   ' + label);
}
function has(label, haystack, needle) {
  ran++;
  var ok = String(haystack).indexOf(needle) !== -1;
  if (!ok) { fails++; console.log('FAIL ' + label + '\n  ' + JSON.stringify(String(haystack)) + '\n  should contain ' + JSON.stringify(needle)); }
  else console.log('ok   ' + label);
}
function section(name) { console.log('\n--- ' + name + ' ---'); }

// =============================================================== date/time core
section('content.js date/time core');

var src = fs.readFileSync(__dirname + '/content.js', 'utf8');
var from = src.search(/^\s*\/\/ -+ date\/time$/m);
var to = src.search(/^\s*\/\/ -+ search$/m);
if (from === -1 || to === -1) { console.error('Banners moved in content.js'); process.exit(2); }
var core = new Function(src.slice(from, to) +
  '\nreturn {toLondon,hhmm,parseHHMM,addDays,datesInRange,intervals,overlaps};')();

// The API hands back true UTC. A 12:15 London class is 11:15 UTC during BST and 12:15
// UTC after the October change. Reporting the first as 11:15 is *the* bug here.
eq('12:15 during BST', core.toLondon(new Date('2025-10-06T11:15:00+00:00')), { date: '2025-10-06', minutes: 735 });
eq('12:15 after the clock change', core.toLondon(new Date('2025-11-03T12:15:00+00:00')), { date: '2025-11-03', minutes: 735 });
eq('midnight is 0, not 24', core.toLondon(new Date('2025-11-03T00:00:00+00:00')), { date: '2025-11-03', minutes: 0 });
eq('one-hour event in BST', core.intervals({ StartDateTime: '2025-10-06T11:15:00+00:00', Duration: 60, Name: 'CMM125' }),
  [{ date: '2025-10-06', from: 735, to: 795, name: 'CMM125' }]);
eq('event past midnight splits', core.intervals({ StartDateTime: '2025-11-03T23:30:00+00:00', Duration: 60, Name: 'X' }),
  [{ date: '2025-11-03', from: 1410, to: 1440, name: 'X' }, { date: '2025-11-04', from: 0, to: 30, name: 'X' }]);
eq('abuts before is free', core.overlaps({ from: 660, to: 735 }, 735, 795), false);
eq('abuts after is free', core.overlaps({ from: 795, to: 855 }, 735, 795), false);
eq('straddles is a clash', core.overlaps({ from: 700, to: 740 }, 735, 795), true);

var mondays = core.datesInRange('2025-09-29', '2025-12-08', [1]);
eq('11 Mondays in the term', mondays.length, 11);
eq('range inclusive at both ends', [mondays[0], mondays[10]], ['2025-09-29', '2025-12-08']);
eq('no weekday drift across DST', mondays.every(function (d) { return new Date(d + 'T12:00:00Z').getUTCDay() === 1; }), true);
eq('addDays across the clock change', core.addDays('2025-10-26', -1), '2025-10-25');
eq('hhmm', [core.hhmm(735), core.hhmm(0), core.hhmm(1410)], ['12:15', '00:00', '23:30']);
eq('parseHHMM', [core.parseHHMM('12:15'), core.parseHHMM('9:05'), core.parseHHMM('boom')], [735, 545, null]);

// ==================================================================== parsing
section('prompt parsing');
var TODAY = '2026-09-17';
function p(text) { return parse(text, TODAY); }

var q = p('which rooms seating 45+ in BC or BD are free 12:15-13:15 every Monday from 28 Sep to 7 Dec?');
eq('full question: dates', [q.from, q.to], ['2026-09-28', '2026-12-07']);
eq('full question: slot', [q.slotFrom, q.slotTo], [735, 795]);
eq('full question: weekday', q.weekdays, [1]);
eq('full question: capacity', q.minCapacity, 45);
eq('full question: buildings', q.buildings, ['BC', 'BD']);
eq('full question: nothing unparsed', q.leftover, '');

eq('en-dash time range', p('free 12:15–13:15 Mondays').slotFrom, 735);
eq('dotted times', p('rooms 9.30 to 11.00 on Fridays').slotTo, 660);
eq('bare 24h range', p('free 9-11 Tuesdays').slotFrom, 540);
eq('pm carried to both ends', [p('2pm-4pm Mondays').slotFrom, p('2pm-4pm Mondays').slotTo], [840, 960]);
eq('pm on second half only', p('free 2-4pm Mondays').slotFrom, 840);
eq('bare afternoon range assumed pm', p('free 2-4 Mondays').slotFrom, 840);
eq('afternoon band', [p('Wednesday afternoons').slotFrom, p('Wednesday afternoons').slotTo], [780, 1020]);
eq('at X for N hours', [p('at 10 for 2 hours on Mondays').slotFrom, p('at 10 for 2 hours on Mondays').slotTo], [600, 720]);

eq('multiple weekdays', p('Tuesdays and Thursdays 9-11').weekdays, [2, 4]);
eq('weekdays keyword', p('weekdays 9-11').weekdays, [1, 2, 3, 4, 5]);
eq('Mon-Fri range', p('Mon-Fri 9-11').weekdays, [1, 2, 3, 4, 5]);

eq('next N weeks', [p('Mondays 1-2, next 10 weeks').from, p('Mondays 1-2, next 10 weeks').to], ['2026-09-17', '2026-11-26']);
eq('until a date', p('Mondays 1-2 until 7 Dec').to, '2026-12-07');
eq('slash dates are day/month', [p('Mondays 1-2 from 28/09 to 07/12').from, p('Mondays 1-2 from 28/09 to 07/12').to], ['2026-09-28', '2026-12-07']);
eq('bare month rolls forward, never back', p('Mondays 1-2 from 5 Jan').from, '2027-01-05');
eq('dates flagged when assumed', p('a room for 40 on Mondays at 1pm').datesAssumed, true);

eq('capacity: for N people', p('room for 50 people Mondays 9-10').minCapacity, 50);
eq('capacity: at least N', p('at least 20 seats Mondays 9-10').minCapacity, 20);
eq('capacity: seating N', p('seating 30 Mondays 9-10').minCapacity, 30);
eq('capacity not stolen from the time', p('free 12:15-13:15 Mondays').minCapacity, 0);
eq('capacity not stolen from the date', p('Mondays 9-10 from 28 Sep to 7 Dec').minCapacity, 0);

eq('Coleraine', p('room in Coleraine Mondays 9-10').query, 'C_');
eq('Magee maps to M_', p('room in Magee Mondays 9-10').query, 'M_');
eq('Derry maps to M_', p('room in Derry Mondays 9-10').query, 'M_');
eq('campus flagged when assumed', p('room in BC Mondays 9-10').campusAssumed, true);
eq('"in Belfast" is not a building code', p('room in Belfast Mondays 9-10').buildings, []);
eq('block cue, lowercase', p('blocks bc and bd, Mondays 9-10').buildings, ['BC', 'BD']);

eq('labs included on request', p('any room including labs Mondays 9-10').ordinaryOnly, false);
eq('labs excluded by default', p('room Mondays 9-10').ordinaryOnly, true);
eq('allow N clashes', p('Mondays 9-10, allow 1 clash').maxClashes, 1);
eq('every week means zero tolerance', p('free every week Mondays 9-10').maxClashes, 0);
eq('ignore pending', p('Mondays 9-10 ignore pending').includePending, false);

eq('module lookup mode', [p('where is CMM125 this term').mode, p('where is CMM125 this term').module], ['module', 'CMM125']);
eq('module with full code', p('why isnt CMM125_S1/LEC/01 in its usual room').module, 'CMM125_S1/LEC/01');
eq('availability wins when asking for free rooms', p('free rooms like CMM125 uses, Mondays 9-10').mode, 'availability');
has('read-back is human', p('seating 45+ Mondays 12:15-13:15').read.join(' | '), 'seating 45 or more');

// =================================================================== analysis
section('analysis');

var DATES = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
function room(name, cap, busy) {
  var byDate = {};
  Object.keys(busy || {}).forEach(function (d) { byDate[d] = busy[d]; });
  var r = { name: name, identity: name, capacity: cap, totalEvents: 5, byDate: byDate };
  r.clashes = A.clashesAt(r, DATES, 735, 795);
  return r;
}
var SLOT = { from: 735, to: 795 };
var freeRoom = room('B_BC-01-001', 50, {});
var oneClash = room('B_BC-01-002', 48, { '2026-11-02': [{ from: 720, to: 840, name: 'CMM125/LEC' }] });
var blockClash = room('B_BC-01-003', 60, {
  '2026-10-05': [{ from: 735, to: 795, name: 'X' }],
  '2026-10-12': [{ from: 735, to: 795, name: 'X' }],
  '2026-10-19': [{ from: 735, to: 795, name: 'X' }]
});
var scattered = room('B_BC-01-004', 45, {
  '2026-09-28': [{ from: 700, to: 760, name: 'A' }],
  '2026-10-12': [{ from: 700, to: 760, name: 'B' }],
  '2026-11-02': [{ from: 700, to: 760, name: 'C' }]
});
// Busy at 12:15 but free an hour later — the case a time shift is meant to surface.
var shiftable = room('B_BC-01-005', 55, {
  '2026-09-28': [{ from: 720, to: 780, name: 'Y' }],
  '2026-10-05': [{ from: 720, to: 780, name: 'Y' }],
  '2026-10-12': [{ from: 720, to: 780, name: 'Y' }],
  '2026-10-19': [{ from: 720, to: 780, name: 'Y' }],
  '2026-10-26': [{ from: 720, to: 780, name: 'Y' }],
  '2026-11-02': [{ from: 720, to: 780, name: 'Y' }]
});

eq('free room has no clashes', freeRoom.clashes.length, 0);
eq('touching-but-not-overlapping is free', room('t', 1, { '2026-09-28': [{ from: 675, to: 735, name: 'Z' }] }).clashes.length, 0);
eq('one clash counted once', oneClash.clashes.length, 1);
eq('clash carries what and when', [oneClash.clashes[0].what, oneClash.clashes[0].when], ['CMM125/LEC', '12:00–14:00']);

eq('runs groups consecutives', A.runs([0, 1, 2, 5, 7, 8]), [[0, 2], [5, 5], [7, 8]]);
eq('clear shape', A.clashShape(freeRoom.clashes, DATES).kind, 'clear');
eq('single miss shape', A.clashShape(oneClash.clashes, DATES).kind, 'single');
eq('consecutive block detected', A.clashShape(blockClash.clashes, DATES).kind, 'block');
has('block says where and when', A.clashShape(blockClash.clashes, DATES).text, '5 Oct–19 Oct');
eq('scattered detected', A.clashShape(scattered.clashes, DATES).kind, 'scattered');
eq('never free detected', A.clashShape(shiftable.clashes, DATES).kind, 'never');

eq('longest run after a block', A.longestFreeRun(blockClash.clashes, DATES).length, 2);
has('longest run names dates', A.longestFreeRun(blockClash.clashes, DATES).text, '26 Oct–2 Nov');
eq('no run when never free', A.longestFreeRun(shiftable.clashes, DATES), null);

var pool = [freeRoom, oneClash, blockClash, scattered, shiftable];
var shifts = A.timeShifts(pool, DATES, SLOT.from, SLOT.to, [45, -60]);
eq('shifting 45 min frees the blocked room', shifts[0].offset, 45);
eq('shift count includes the freed room', shifts[0].count, 3);
eq('shifts stay inside the working day', A.timeShifts(pool, DATES, 8 * 60, 9 * 60, [-120]).length, 0);

var res = {
  dates: DATES, rooms: pool, campusName: 'Belfast',
  shells: [{ name: 'BT Room 1' }],
  dropped: { specialist: ['B_BC-02-LAB'], junk: [], building: [] }
};
var qFull = { slotFrom: 735, slotTo: 795, maxClashes: 2, minCapacity: 45, buildings: ['BC'], ordinaryOnly: true };
var alts = A.alternatives(res, qFull);
has('alternatives offer a time shift', alts.map(function (a) { return a.kind; }).join(','), 'shift');
has('alternatives offer capacity drop', alts.map(function (a) { return a.kind; }).join(','), 'capacity');
has('alternatives offer widening', alts.map(function (a) { return a.kind; }).join(','), 'buildings');
has('alternatives offer the filtered labs', alts.map(function (a) { return a.kind; }).join(','), 'specialist');
eq('refetch options are marked honestly',
  alts.filter(function (a) { return a.kind === 'capacity'; })[0].needsRefetch, true);

eq('only the smallest shift per distinct gain is offered',
  alts.filter(function (a) { return a.kind === 'shift'; }).map(function (a) { return a.count; })
    .filter(function (v, i, arr) { return arr.indexOf(v) !== i; }), []);
has('clash tolerance reads as English',
  A.alternatives(
    { dates: DATES, rooms: [oneClash], campusName: 'Belfast', shells: [], dropped: { specialist: [], junk: [], building: [] } },
    { slotFrom: 735, slotTo: 795, maxClashes: 0, minCapacity: 0, buildings: [], ordinaryOnly: false }
  ).map(function (a) { return a.text; }).join(' | '), '1 room qualifies');

var sum = A.summarise(res, qFull, alts).join(' ');
has('summary leads with what fits', sum, 'B_BC-01-001 (50)');
has('summary names the closest miss', sum, 'Closest miss is B_BC-01-002');
has('summary explains the miss', sum, 'CMM125/LEC');
// The shape clause already names the date; the detail clause must not repeat it.
var missLine = A.summarise(res, qFull, alts).filter(function (l) { return l.indexOf('Closest miss') === 0; })[0];
eq('single-date miss names the date once', (missLine.match(/2 Nov/g) || []).length, 1);
has('single-date miss still names the blocker', missLine, 'taken by CMM125/LEC 12:00–14:00');
has('summary warns about shells', sum, 'shells');

// With nothing clean, the summary must say so rather than imply success.
var bleak = { dates: DATES, rooms: [blockClash, shiftable], campusName: 'Belfast', shells: [], dropped: { specialist: [], junk: [], building: [] } };
var bleakAlts = A.alternatives(bleak, qFull);
has('bleak summary is explicit', A.summarise(bleak, qFull, bleakAlts).join(' '), 'Nothing in the 2 rooms searched is free');
has('bleak case offers clash tolerance', bleakAlts.map(function (a) { return a.kind; }).join(','), 'clashes');

// ---- module lookup: the gap that is free vs the gap that is booked
section('module lookup');
var ALL = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
var host = room('B_BC-03-104', 60, { '2026-10-19': [{ from: 735, to: 795, name: 'OTHER/LEC/01' }] });
var events = ['2026-09-28', '2026-10-05', '2026-10-26', '2026-11-02'].map(function (d) {
  return { date: d, from: 735, to: 795, name: 'CMM125_S1/LEC/01', roomId: 'B_BC-03-104', roomName: 'B_BC-03-104' };
});
var pats = A.modulePattern(events, { 'B_BC-03-104': host }, ALL);
eq('one pattern found', pats.length, 1);
eq('pattern is Mondays', pats[0].weekday, 1);
eq('four occurrences', pats[0].occurrences.length, 4);
eq('two gaps', pats[0].gaps.length, 2);
eq('12 Oct gap is free', pats[0].gaps.filter(function (g) { return g.date === '2026-10-12'; })[0].free, true);
eq('19 Oct gap is blocked', pats[0].gaps.filter(function (g) { return g.date === '2026-10-19'; })[0].free, false);
eq('blocker is named', pats[0].gaps.filter(function (g) { return g.date === '2026-10-19'; })[0].blockedBy, 'OTHER/LEC/01');

var ms = A.summariseModule('CMM125', pats).join(' ');
has('module summary states the slot', ms, 'B_BC-03-104 on Mondays at 12:15–13:15');
has('free gap explained as a pattern gap', ms, 'week pattern just does not cover');
has('booked gap explained as a clash', ms, 'Missing and the room is taken');
eq('no module found is handled', A.summariseModule('ZZZ999', null).length, 1);

console.log('\n' + ran + ' checks, ' + (fails ? fails + ' FAILED' : 'all passed'));
process.exit(fails ? 1 : 0);
