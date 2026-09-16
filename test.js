/* Tests for the date/time core — run with `node test.js` from this folder.
 *
 * The extension has no build step and no dependencies, so rather than splitting the
 * helpers into a module, this pulls the date/time section straight out of content.js
 * between its two banner comments and evaluates it. If you move that section, move the
 * banners with it.
 *
 * Only this section is covered, deliberately: everything else needs a signed-in
 * Resource Booker session, but the timezone handling is the part that fails silently
 * and wrongly rather than loudly, so it is the part worth pinning down.
 */
'use strict';
var fs = require('fs');

var src = fs.readFileSync(__dirname + '/content.js', 'utf8');
var from = src.search(/^\s*\/\/ -+ date\/time$/m);
var to = src.search(/^\s*\/\/ -+ search$/m);
if (from === -1 || to === -1) {
  console.error('Could not find the date/time section in content.js — banners moved?');
  process.exit(2);
}
var core = new Function(src.slice(from, to) +
  '\nreturn {toLondon,hhmm,parseHHMM,addDays,datesInRange,intervals,overlaps};')();

var fails = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL ' + label + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else { console.log('ok   ' + label); }
}

// The API hands back true UTC. A 12:15 London class is 11:15 UTC during BST and 12:15
// UTC after the October change. Reporting the first as 11:15 is *the* bug here.
eq('12:15 during BST', core.toLondon(new Date('2025-10-06T11:15:00+00:00')), { date: '2025-10-06', minutes: 735 });
eq('12:15 after the clock change', core.toLondon(new Date('2025-11-03T12:15:00+00:00')), { date: '2025-11-03', minutes: 735 });
eq('midnight is 0, not 24', core.toLondon(new Date('2025-11-03T00:00:00+00:00')), { date: '2025-11-03', minutes: 0 });

eq('one-hour event in BST', core.intervals({ StartDateTime: '2025-10-06T11:15:00+00:00', Duration: 60, Name: 'CMM125' }),
  [{ date: '2025-10-06', from: 735, to: 795, name: 'CMM125' }]);
eq('event past midnight splits', core.intervals({ StartDateTime: '2025-11-03T23:30:00+00:00', Duration: 60, Name: 'X' }),
  [{ date: '2025-11-03', from: 1410, to: 1440, name: 'X' }, { date: '2025-11-04', from: 0, to: 30, name: 'X' }]);

// Half-open: a class ending exactly when yours starts is not a clash.
eq('abuts before is free', core.overlaps({ from: 660, to: 735 }, 735, 795), false);
eq('abuts after is free', core.overlaps({ from: 795, to: 855 }, 735, 795), false);
eq('straddles is a clash', core.overlaps({ from: 700, to: 740 }, 735, 795), true);
eq('contained is a clash', core.overlaps({ from: 740, to: 750 }, 735, 795), true);

var mondays = core.datesInRange('2025-09-29', '2025-12-08', [1]);
eq('11 Mondays in the term', mondays.length, 11);
eq('range is inclusive at both ends', [mondays[0], mondays[10]], ['2025-09-29', '2025-12-08']);
eq('covers both sides of the clock change', [mondays.indexOf('2025-10-20') > -1, mondays.indexOf('2025-10-27') > -1], [true, true]);
eq('no weekday drift across DST', mondays.every(function (d) { return new Date(d + 'T12:00:00Z').getUTCDay() === 1; }), true);

eq('addDays across the clock change', core.addDays('2025-10-26', -1), '2025-10-25');
eq('hhmm', [core.hhmm(735), core.hhmm(0), core.hhmm(1410)], ['12:15', '00:00', '23:30']);
eq('parseHHMM', [core.parseHHMM('12:15'), core.parseHHMM('9:05'), core.parseHHMM('boom')], [735, 545, null]);

console.log(fails ? '\n' + fails + ' failure(s)' : '\nall passed');
process.exit(fails ? 1 : 0);
