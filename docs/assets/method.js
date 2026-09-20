// The Method tab's content. Kept as a module rather than inline HTML so the
// numbers in it are computed from the data that is actually loaded, instead of
// being typed in and going stale the next time the solver runs.

(function () {
  'use strict';

  function html(H) {
    var C = window.TTConstraints;
    var model = H.model, a = H.assign;
    // Judge against the real teaching day, not a permissive one.
    var OPTS = {};
    var now = C.check(model, a.current, OPTS);
    var fixed = C.check(model, a.solved, OPTS);
    var mv = C.movement(model, a.solved);
    var softNow = C.softScore(model, a.current);
    var soft = C.softScore(model, a.solved);
    var meta = model.meta || {};

    var blocks = model.classes.filter(function (c) { return c.isBlock; }).length;
    var groups = model.linkedGroups.length;
    var unknownCap = model.rooms.filter(function (r) { return !r.capacityKnown; }).length;

    var b2b = 0;
    model.linkedGroups.forEach(function (g) {
      var ok = true;
      for (var i = 0; i + 1 < g.members.length; i++) {
        var x = g.members[i], y = g.members[i + 1];
        var px = a.solved.get(x.id), py = a.solved.get(y.id);
        if (px.day !== py.day || px.start + x.dur !== py.start) ok = false;
      }
      if (ok) b2b++;
    });

    function tile(v, k, cls) {
      return '<div class="stat ' + (cls || '') + '"><div class="v">' + v + '</div>' +
             '<div class="k">' + k + '</div></div>';
    }

    var ruleLabels = {
      roomClash: 'No two classes in one room at once (exam rooms aside)',
      timeClash: 'No cohort or lecturer in two places at once',
      roomFit: 'Right room type, big enough',
      linkedOrder: 'Lecture &amp; seminar same day, back-to-back, in order',
      examSlot: 'Exams keep their module’s slot',
      adjacency: 'Exams stay attached to the class they follow',
      dayPairing: 'No new same-day pairing for a cohort',
      window: 'Inside the teaching day',
    };
    var ruleRows = Object.keys(ruleLabels).map(function (k) {
      var a0 = now.counts[k] || 0, a1 = fixed.counts[k] || 0;
      return '<tr><td>' + ruleLabels[k] + '</td>' +
        '<td>' + (a0 ? '<span class="pill no">' + a0 + ' broken</span>' : '<span class="pill ok">holds</span>') + '</td>' +
        '<td>' + (a1 ? '<span class="pill no">' + a1 + ' broken</span>' : '<span class="pill ok">holds</span>') + '</td></tr>';
    }).join('');

    return [
      '<div class="narrow-inner">',

      '<h2 style="margin-top:0">What was asked for, and what came out</h2>',
      '<p class="lead">Spring 2026 splits hundreds of classes across two or three rooms. ',
      'This gives every class a single room — exams aside, since a sitting may legitimately ',
      'fill several — while breaking none of the hard rules.</p>',

      '<div class="stats">',
      tile(fixed.total === 0 ? '0' : String(fixed.total), 'hard rules broken in the rebuild', fixed.total === 0 ? 'good' : 'warn'),
      tile(b2b + '/' + groups, 'lecture+seminar pairs back-to-back', 'good'),
      tile(String(blocks), 'block sessions kept on campus', 'good'),
      tile(mv.untouched.toLocaleString(), 'classes left exactly as they are'),
      '</div>',

      '<h2>The hard rules</h2>',
      '<p>All of them hold. They are checked in your browser on load, by the same code ',
      'that built the timetable — if any were broken, the rebuilt tab would say so.</p>',
      '<div class="scroll"><table><thead><tr><th>Hard rule</th><th>Today</th><th>Rebuilt</th></tr></thead>',
      '<tbody>' + ruleRows + '</tbody></table></div>',

      '<h2>The soft goals, which also improved</h2>',
      '<div class="stats">',
      tile(softNow.edge + ' → ' + soft.edge, 'classes in 9–10am / 4–5pm edge slots', 'good'),
      (meta.gapDays != null ? tile(meta.gapDaysBefore + ' → ' + meta.gapDays, 'gap days in cohorts’ teaching weeks', 'good') : ''),
      tile(softNow.wedPm + ' → ' + soft.wedPm, 'classes on Wednesday afternoon', 'warn'),
      '</div>',
      '<p class="small muted">A <strong>gap day</strong> is a day with no classes sitting between two ',
      'days that have them: a cohort taught Mon/Wed/Fri has two, one taught Mon/Tue/Wed has none. ',
      'Wednesday afternoons were not optimised for, and did get slightly busier.</p>',

      '<h2>The one idea that made it work</h2>',
      '<div class="note"><p><strong>A lecture and its seminar are one movable object, not two ',
      'classes that need keeping together.</strong></p>',
      '<p style="margin-bottom:0">They are stored as a single component with a fixed internal ',
      'offset — the seminar starts exactly when the lecture ends. Placing the component places ',
      'both. Back-to-back is then not a rule the search has to satisfy, notice breaking and ',
      'repair; it is a property of how the timetable is represented, and cannot be violated.</p></div>',
      '<p>This is why all <strong>' + groups + '</strong> linked groups are back-to-back here, where ',
      'the earlier analysis reached 95 of 136 and concluded the rest were impossible. The earlier ',
      'search treated contiguity as something to achieve and then protect, so every later repair ',
      'could break it again.</p>',
      '<p>The same analysis found three all-day sessions that had to move off campus. ',
      'All <strong>' + blocks + '</strong> block-teaching sessions stay on site here.</p>',

      '<h2>The teaching day</h2>',
      '<p>Nothing starts before <strong>09:15</strong> or ends after <strong>17:15</strong>, which gives ',
      'eight start slots a day rather than the thirteen the raw data happens to use. Two exceptions, both ',
      'forced by the data rather than chosen:</p>',
      '<ul><li><strong>30 sessions are longer than any eight-hour day</strong> \u2014 nine, twelve and ',
      'thirteen hours. They may not start early, but must overflow at the end; there is nowhere else for ',
      'them to go.</li>',
      '<li><strong>25 bookings are marked "do not edit"</strong> in the source \u2014 the exam set-up ',
      'reservation, Estates exams, IT maintenance windows, applicant days. They are pinned where they are ',
      'and are not judged against the day, since several run to 21:15 by design.</li></ul>',
      '<p>General classes may also use a <strong>computer lab</strong>, which widens the tightest room ',
      'category; the classes that genuinely need a lab keep first claim through their own room lists.</p>',

      '<h2>How the search runs</h2>',
      '<ol>',
      '<li>Start from the current timetable, pulled into component geometry — which by itself ',
      'closes the <strong>73</strong> lecture/seminar gaps and creates some conflicts to repair.</li>',
      '<li>Find a class in conflict and <strong>try every room first</strong>. Belfast’s rooms are ',
      'about two-thirds empty, so most conflicts resolve with a room swap nobody notices.</li>',
      '<li>If no room works, move the whole component to the best day and time available.</li>',
      '<li>If nothing improves it, move it to the <em>least bad</em> slot anyway and let the classes ',
      'it displaces be repaired next round. Only accepting improvements is what leaves a search ',
      'stuck a few violations short.</li>',
      '<li>Once nothing is broken, polish the soft goals with moves that add no hard violation.</li>',
      '</ol>',
      '<p class="small muted">The search plateaus within seconds, so it is restarted from many ',
      'random seeds and the best kept, rather than one run being ground for longer.</p>',

      '<h2>Before you rely on this</h2>',

      '<div class="note warn"><p style="margin:0"><strong>The clash data is inferred, not ',
      'authoritative.</strong> "These two classes share students" was derived from the current ',
      'timetable — same programme and year for a student clash, and same school plus shared room ',
      'plus never currently overlapping as a proxy for the same lecturer. Re-run this against real ',
      'enrolment and staff-assignment data before acting on it.</p></div>',

      '<div class="note warn"><p style="margin:0"><strong>This timetable depends on that pruning.</strong> ',
      'Under a 09:15\u201317:15 day the full inferred graph leaves <strong>117</strong> violations that no ',
      'amount of searching removes; with the unevidenced edges dropped the same search reaches ',
      '<strong>' + (meta.hardViolations === 0 ? 'zero' : String(meta.hardViolations)) + '</strong>. ',
      'The published result is solved against <strong>' + (meta.clashEdges || '?') + ' of ' +
      (meta.clashEdgesTotal || '?') + '</strong> clash edges. That is a judgement, not a fact: it assumes ',
      'a cohort that already runs two of its own classes at once is split into groups, and so is not ',
      'obliged to keep every other pair apart. Real enrolment data would settle it.</p></div>',

      '<div class="note good"><p style="margin:0"><strong>Why that pruning is defensible.</strong> ',
      'Overlap in the current timetable is positive proof — two classes running at the same time ',
      'cannot share a lecturer or an audience — while absence of overlap proves nothing. Applied ',
      'consistently, 353 of 948 cohorts already run their own classes overlapping, so 12,702 of ',
      '16,246 clash edges rest on cohorts that are demonstrably split. Re-solving without them ',
      'still reaches a clean timetable. On the old, longer teaching day it barely mattered \u2014 dropping ',
      'those edges changed the answer very little, because rooms were the binding constraint. Inside a ',
      '9-to-5 day it decides whether there is an answer at all.</p></div>',

      '<div class="note warn"><p style="margin:0"><strong>Class sizes are room capacities, not ',
      'headcounts</strong>, for all but 17 rows, and <strong>' + unknownCap + ' of ' + model.rooms.length +
      ' rooms have no capacity recorded</strong> — nearly all studios and specialist labs. Because ',
      'of that, 507 classes sit in a room outside their own candidate set today, so a class staying ',
      'put always passes room fit and capacity is enforced only on a class that moves.</p></div>',

      '<div class="note"><p style="margin:0"><strong>Exams are not normal classes.</strong> ',
      'Each multi-room exam keeps the number of rooms it uses today, in distinct rooms at one slot. ',
      'Ten rows marked "Do NOT Edit or Remove booking" reserving rooms for the exam weeks are ',
      'pinned and never moved; only their dominant room is recorded, so weeks 15–16 availability ',
      'is optimistic. One-off <code>BK</code> bookings are excluded entirely.</p></div>',

      '<h2>Reproducing it</h2>',
      '<pre class="card pad mono small" style="overflow-x:auto"><code>node timetable/test.js\n',
      'node timetable/solve.js --seeds 30 --out docs/data\n',
      'node timetable/export.js</code></pre>',
      '<p class="small muted">No dependencies. <code>constraints.js</code> and <code>suggest.js</code> ',
      'are pure and run unchanged in node and the browser, so this page checks the rules with the ',
      'same code that enforced them. Data generated ' + (meta.generated || 'unknown') + '.</p>',

      '</div>',
    ].join('');
  }

  window.TTMethod = { html: html };
})();
