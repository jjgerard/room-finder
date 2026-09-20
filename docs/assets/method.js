// The Method tab's content. Kept as a module rather than inline HTML so the
// numbers in it are computed from the data that is actually loaded, instead of
// being typed in and going stale the next time the solver runs.
//
// Four questions, in order: how today's timetable is made, why that method
// clashes, how this one is made, why it does not.

(function () {
  'use strict';

  // Facts about the CURRENT spring timetable that the packed data does not
  // carry directly. Measured once from the source bookings, quoted here so the
  // prose cannot drift from them; see scratchpad notes in the repo history.
  var TODAY = {
    bookings: 2095,          // distinct bookings in spring 2026
    splitBookings: 215,      // of those, using two or more rooms
    maxRooms: 31,            // the worst one, an exam
    doubleBooked: 114,       // pairs of different classes in one room at once
    at0915: 862,             // bookings starting at 09:15
    at0815: 397,             // bookings starting at 08:15
    outside: 560,            // room-bookings outside 09:15-17:15
    outsideOf: 3302,
  };

  function fmtN(n) { return Number(n).toLocaleString(); }

  /** Modules most exposed to a last-minute scramble, and why. */
  function atRisk(model) {
    var deg = {};
    (model.cannotShareTime || []).forEach(function (p) {
      deg[p[0]] = (deg[p[0]] || 0) + 1;
      deg[p[1]] = (deg[p[1]] || 0) + 1;
    });
    var mods = {};
    model.classes.forEach(function (c) {
      if (!c.module) return;
      var x = mods[c.module] || (mods[c.module] =
        { code: c.module, n: 0, split: 0, scarce: 0, block: 0, outside: 0, deg: 0, size: 0, rooms: 999 });
      x.n++;
      if (c.nRooms > 1) x.split++;
      if ((c.cand || []).length <= 3) x.scarce++;
      if (c.dur >= 300) x.block++;
      if (c.origStart < 9 * 60 + 15 || c.origStart + c.dur > 17 * 60 + 15) x.outside++;
      x.deg = Math.max(x.deg, deg[c.id] || 0);
      x.size = Math.max(x.size, c.size || 0);
      x.rooms = Math.min(x.rooms, (c.cand || []).length);
    });
    var list = Object.keys(mods).map(function (k) {
      var x = mods[k];
      x.score = x.split * 3 + x.scarce * 4 + x.block * 2 + x.outside * 2 + Math.min(x.deg / 20, 4);
      // The reason to print is whichever signal contributes most.
      var parts = [
        [x.scarce * 4, x.size
          ? 'needs about ' + x.size + ' seats, and only ' + x.rooms + ' room' + (x.rooms === 1 ? '' : 's') + ' can hold it'
          : 'needs a specialist room only a few classes may use'],
        [x.split * 3, 'already split across ' + (x.split === 1 ? 'two rooms' : x.split + ' sittings in several rooms')],
        [x.block * 2, x.block + ' session' + (x.block === 1 ? '' : 's') + ' of five hours or more'],
        [x.outside * 2, x.outside + ' session' + (x.outside === 1 ? '' : 's') + ' already outside 9–5'],
        [Math.min(x.deg / 20, 4), 'shared with ' + x.deg + ' classes that cannot run alongside it'],
      ].sort(function (a, b) { return b[0] - a[0]; });
      x.why = parts[0][1];
      return x;
    });
    list.sort(function (a, b) { return b.score - a.score; });
    return list.slice(0, 8);
  }

  /**
   * The tightest point in the term: the week and room-size band where the
   * classes that need a room that big ask for more hours than exist.
   *
   * This is what decides whether a clean timetable is possible at all. It is
   * plain arithmetic — total hours wanted against total hours available — so a
   * band over 100% cannot be fixed by any amount of searching, and a band
   * under it says any clash there is a search result, not a fact.
   */
  function tightest(model) {
    var caps = [];
    model.rooms.forEach(function (r) {
      if (r.capacityKnown && caps.indexOf(r.capacity) < 0) caps.push(r.capacity);
    });
    caps.sort(function (x, y) { return x - y; });
    var worst = null;
    for (var w = 0; w < 16; w++) {
      for (var i = 0; i < caps.length; i++) {
        var t = caps[i], below = i ? caps[i - 1] : 0;
        var have = 0;
        model.rooms.forEach(function (r) { if (r.capacityKnown && r.capacity >= t) have++; });
        if (!have) continue;
        var need = 0;
        model.classes.forEach(function (c) {
          if (!(c.weeks & (1 << w)) || !c.size) return;
          if (Math.ceil(c.size * 0.9) <= below) return;   // a smaller room would do
          need += c.dur / 60;
        });
        var hours = have * 8 * 5;
        if (!worst || need - hours > worst.over) {
          worst = { week: w + 1, seats: t, rooms: have, need: need, hours: hours, over: need - hours };
        }
      }
    }
    return worst;
  }

  /** "28 room clashes and 2 cohort clashes", from a counts object. */
  function breakdown(counts) {
    var names = {
      roomClash: ['room clash', 'room clashes'],
      timeClash: ['cohort or lecturer clash', 'cohort or lecturer clashes'],
      roomFit: ['class in a room that cannot serve it', 'classes in rooms that cannot serve them'],
      linkedOrder: ['broken lecture/seminar pair', 'broken lecture/seminar pairs'],
      adjacency: ['detached exam', 'detached exams'],
      examSlot: ['exam out of its slot', 'exams out of their slots'],
      dayPairing: ['new same-day pairing', 'new same-day pairings'],
      window: ['session outside the teaching day', 'sessions outside the teaching day'],
    };
    var parts = Object.keys(names).filter(function (k) { return counts[k]; })
      .map(function (k) { return counts[k] + ' ' + names[k][counts[k] === 1 ? 0 : 1]; });
    if (!parts.length) return 'none';
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  function graphic() {
    // Two algorithms side by side. Plain SVG, themed from the page's own
    // variables, sized by viewBox so it holds up at phone width.
    return [
      '<div class="algo-graphic"><div class="algo-inner">',
      '<svg viewBox="0 0 760 430" role="img" ',
      'aria-label="Left: today’s method places one booking at a time and never revisits ',
      'an earlier one, so the last bookings get whatever is left. Right: the rebuild places ',
      'every class at once and repairs broken rules in a loop, moving earlier classes when needed.">',

      '<defs>',
      '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">',
      '<path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker>',
      '</defs>',

      // ---- left: one at a time ----
      '<g class="g-old">',
      '<text x="20" y="26" class="g-title">Today: one booking at a time</text>',
      '<text x="20" y="46" class="g-sub">each request is placed once, and never looked at again</text>',

      '<rect x="20" y="66" width="120" height="34" rx="6" class="g-box"/>',
      '<text x="80" y="88" class="g-label">School A books</text>',
      '<path d="M80 100 L80 124" class="g-arrow" marker-end="url(#ar)"/>',

      '<rect x="20" y="126" width="120" height="34" rx="6" class="g-box"/>',
      '<text x="80" y="148" class="g-label">School B books</text>',
      '<path d="M80 160 L80 184" class="g-arrow" marker-end="url(#ar)"/>',

      '<rect x="20" y="186" width="120" height="34" rx="6" class="g-box"/>',
      '<text x="80" y="208" class="g-label">School C books</text>',
      '<path d="M80 220 L80 244" class="g-arrow" marker-end="url(#ar)"/>',

      '<rect x="20" y="246" width="120" height="34" rx="6" class="g-box g-late"/>',
      '<text x="80" y="268" class="g-label">School D books</text>',

      // the grid filling up
      '<rect x="170" y="66" width="150" height="214" rx="8" class="g-grid"/>',
      '<text x="245" y="86" class="g-label g-muted">rooms &amp; hours</text>',
      '<rect x="182" y="96" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="248" y="96" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="182" y="128" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="248" y="128" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="182" y="160" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="248" y="160" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="182" y="192" width="60" height="26" rx="4" class="g-fill"/>',
      '<rect x="248" y="192" width="60" height="26" rx="4" class="g-empty"/>',
      '<rect x="182" y="224" width="60" height="26" rx="4" class="g-empty"/>',
      '<rect x="248" y="224" width="60" height="26" rx="4" class="g-empty"/>',
      '<text x="245" y="270" class="g-label g-muted">no going back</text>',

      '<path d="M140 83 C 160 83, 158 100, 176 100" class="g-arrow" marker-end="url(#ar)"/>',
      '<path d="M140 143 C 160 143, 158 132, 176 132" class="g-arrow" marker-end="url(#ar)"/>',
      '<path d="M140 203 C 160 203, 158 166, 176 166" class="g-arrow" marker-end="url(#ar)"/>',
      '<path d="M80 280 L80 296" class="g-arrow g-bad" marker-end="url(#ar)"/>',

      '<rect x="20" y="300" width="300" height="106" rx="8" class="g-leftover"/>',
      '<text x="36" y="322" class="g-label g-badtext">what is left for whoever books last</text>',
      '<text x="36" y="344" class="g-small">• an 08:15 start, or a 17:15 finish</text>',
      '<text x="36" y="364" class="g-small">• the class split across two or three rooms</text>',
      '<text x="36" y="384" class="g-small">• a gap between the lecture and its seminar</text>',
      '</g>',

      // ---- right: all at once ----
      '<g class="g-new">',
      '<text x="420" y="26" class="g-title">Rebuild: the whole term at once</text>',
      '<text x="420" y="46" class="g-sub">every class placed, then broken rules repaired until none are left</text>',

      '<rect x="420" y="66" width="320" height="120" rx="8" class="g-grid"/>',
      '<text x="580" y="86" class="g-label g-muted">every class on the board together</text>',
      '<rect x="432" y="96" width="70" height="26" rx="4" class="g-fill"/>',
      '<rect x="508" y="96" width="70" height="26" rx="4" class="g-fill"/>',
      '<rect x="584" y="96" width="70" height="26" rx="4" class="g-clash"/>',
      '<rect x="660" y="96" width="70" height="26" rx="4" class="g-fill"/>',
      '<rect x="432" y="128" width="70" height="26" rx="4" class="g-clash"/>',
      '<rect x="508" y="128" width="70" height="26" rx="4" class="g-fill"/>',
      '<rect x="584" y="128" width="70" height="26" rx="4" class="g-fill"/>',
      '<rect x="660" y="128" width="70" height="26" rx="4" class="g-fill"/>',
      '<text x="432" y="174" class="g-small g-muted">red = a rule broken</text>',

      '<path d="M580 186 L580 210" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="212" width="320" height="34" rx="6" class="g-box"/>',
      '<text x="580" y="234" class="g-label">pick a class that breaks a rule</text>',
      '<path d="M580 246 L580 266" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="268" width="320" height="34" rx="6" class="g-box"/>',
      '<text x="580" y="290" class="g-label">move it — room first, then day and time</text>',
      '<path d="M580 302 L580 322" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="324" width="320" height="34" rx="6" class="g-box g-okbox"/>',
      '<text x="580" y="346" class="g-label">it may displace others — they get repaired too</text>',

      // the loop back
      '<path d="M740 341 C 756 341, 756 130, 744 130" class="g-arrow g-loop" marker-end="url(#ar)"/>',
      '<text x="420" y="382" class="g-small g-oktext">repeat until nothing is broken, then improve the soft goals</text>',
      '<text x="420" y="402" class="g-small g-muted">restart from many random beginnings; keep the best</text>',
      '</g>',
      '</svg>',
      '</div><p class="small muted algo-hint">Scroll sideways to see both sides.</p></div>',
    ].join('');
  }

  function html(H) {
    var C = window.TTConstraints;
    var model = H.model, a = H.assign;
    var now = C.check(model, a.current, {});
    var fixed = C.check(model, a.solved, {});
    var mv = C.movement(model, a.solved);
    var softNow = C.softScore(model, a.current);
    var soft = C.softScore(model, a.solved);
    var meta = model.meta || {};

    var blocks = model.classes.filter(function (c) { return c.isBlock; }).length;
    var groups = model.linkedGroups.length;

    // Linked groups: how many run back-to-back in the rebuild, and how many
    // have a gap between lecture and seminar today.
    var gappy = 0, b2b = 0;
    model.linkedGroups.forEach(function (g) {
      var hadGap = false, joined = true;
      for (var i = 0; i + 1 < g.members.length; i++) {
        var x = g.members[i], y = g.members[i + 1];
        if (x.origDay !== y.origDay || x.origStart + x.dur !== y.origStart) hadGap = true;
        var px = a.solved.get(x.id), py = a.solved.get(y.id);
        if (px.day !== py.day || px.start + x.dur !== py.start) joined = false;
      }
      if (hadGap) gappy++;
      if (joined) b2b++;
    });

    // How much of the week the biggest rooms are already committed to — the
    // number behind "there is nowhere else to put a 200-seat lecture".
    var bigRooms = model.rooms.filter(function (r) { return r.capacity >= 150; });
    var risky = atRisk(model);
    var tight = tightest(model);

    function tile(v, k, cls) {
      return '<div class="stat ' + (cls || '') + '"><div class="v">' + v + '</div>' +
             '<div class="k">' + k + '</div></div>';
    }

    var riskRows = risky.map(function (x) {
      var name = (model.modTitles || {})[x.code] || '';
      return '<tr><td><strong>' + x.code + '</strong>' +
        (name ? '<br><span class="small muted">' + name + '</span>' : '') + '</td>' +
        '<td>' + x.why + '</td></tr>';
    }).join('');

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
        '<td>' + (a0 ? '<span class="pill no">' + a0 + '</span>' : '<span class="pill ok">holds</span>') + '</td>' +
        '<td>' + (a1 ? '<span class="pill no">' + a1 + '</span>' : '<span class="pill ok">holds</span>') + '</td></tr>';
    }).join('');

    return [
      '<div class="narrow-inner">',

      '<h2 style="margin-top:0">How the two timetables are built</h2>',
      '<p class="lead">Spring 2026 is assembled request by request. This rebuild places the ',
      'whole term at once and repairs what breaks. That one difference is where the clashes go.</p>',

      '<div class="stats">',
      tile(fixed.total === 0 ? '0' : String(fixed.total), 'hard rules broken in the rebuild',
        fixed.total === 0 ? 'good' : 'warn'),
      tile(b2b + '/' + groups, 'lecture+seminar pairs back-to-back', b2b === groups ? 'good' : 'warn'),
      tile(String(blocks), 'block sessions kept on campus', 'good'),
      tile(fmtN(mv.untouched), 'classes left exactly as they are'),
      '</div>',

      (fixed.total === 0 ? '' :
        '<div class="note warn"><p><strong>What is still broken, and why.</strong> ' +
        fixed.total + ' hard rule' + (fixed.total === 1 ? '' : 's') + ' remain' +
        (fixed.total === 1 ? 's' : '') + ' broken \u2014 ' + breakdown(fixed.counts) +
        ' \u2014 against ' + now.total + ' in the current timetable. ' +
        'They land where the building is tightest: ' +
        (tight && tight.over > 0
          ? 'in week ' + tight.week + ', classes needing ' + tight.seats + ' seats or more ask ' +
            'for ' + Math.round(tight.need) + ' room-hours and Belfast has ' + tight.rooms +
            ' rooms that size, which is ' + tight.hours + '. No search can place ' +
            Math.round(tight.over) + ' hours that do not exist \u2014 the rest is search, and more ' +
            'restarts keep chipping at it.'
          : 'no week is over capacity on paper, so these are a limit of the search rather ' +
            'than of the building \u2014 more restarts keep chipping at them.') +
        '</p><p style="margin-bottom:0">Either way they are <strong>named</strong>, not hidden: ' +
        'every one is visible on the rebuilt tab and on Explore moves, which is the difference ' +
        'from finding out in week one.</p></div>'),

      // ---------------------------------------------------------------- 1
      '<h2>1. How the current timetable is built</h2>',
      '<p class="small muted">Not documented anywhere we have — but a process leaves ',
      'fingerprints, and these are the ones in the spring 2026 data.</p>',
      '<ul>',
      '<li><strong>One booking at a time.</strong> Each school books its own modules into ',
      'whatever is still free.</li>',
      '<li><strong>Last year’s slot is the starting point.</strong> Modules keep the day and ',
      'hour they had, so the calendar is inherited rather than chosen.</li>',
      '<li><strong>Rooms are attached per booking, not per class.</strong> ' +
      fmtN(TODAY.splitBookings) + ' of ' + fmtN(TODAY.bookings) + ' bookings sit in two or more ',
      'rooms — one in ' + TODAY.maxRooms + ' — because no single room was free.</li>',
      '<li><strong>Nothing already placed is moved.</strong> A conflict is resolved by finding ',
      'somewhere else for the <em>new</em> booking, never by relocating the one in the way.</li>',
      '<li><strong>The day stretches to absorb the overflow.</strong> ' + fmtN(TODAY.outside) +
      ' of ' + fmtN(TODAY.outsideOf) + ' room-bookings fall outside 9–5, and ' +
      fmtN(TODAY.at0815) + ' start at 08:15.</li>',
      '<li><strong>Whatever is still broken is settled by hand,</strong> in the weeks before ',
      'term, one email at a time.</li>',
      '</ul>',

      // ---------------------------------------------------------------- 2
      '<h2>2. Why that will always clash</h2>',
      '<ul>',
      '<li><strong>Order decides outcome.</strong> The same set of classes produces a different ',
      'timetable depending on who books first — and whoever books last gets what is left.</li>',
      '<li><strong>A first-fit choice cannot be undone.</strong> One booking taking the last big ',
      'room at 11am can make a later lecture unplaceable, and by then the first one is fixed.</li>',
      '<li><strong>Nobody holds the whole picture.</strong> A school can see its own clashes. ',
      'It cannot see that its 2pm booking is what forces another school’s cohort into an ',
      '08:15 start.</li>',
      '<li><strong>Pressure lands on the scarcest rooms.</strong> Belfast has ' + bigRooms.length +
      ' rooms seating 150 or more and one seating over 250. A mid-sized class parked in a big ',
      'theatre is not a waste of space — it is the reason the big lecture has nowhere to go.</li>',
      '<li><strong>The rules bend before the calendar does.</strong> When nothing fits, the ',
      'timetable splits a class across rooms (' + fmtN(TODAY.splitBookings) + ' bookings), ',
      'double-books a room (' + TODAY.doubleBooked + ' pairs), or opens a gap between a lecture ',
      'and its seminar (' + gappy + ' of ' + groups + ' linked pairs).</li>',
      '<li><strong>So the scramble is structural, not bad luck.</strong> It recurs every year ',
      'because the method, not the term, produces it.</li>',
      '</ul>',

      '<h3>The modules most exposed</h3>',
      '<p class="small muted">Scored from this term’s own data: how few rooms can hold the ',
      'class, whether it is already split or running long, and how many other classes cannot ',
      'run alongside it. These are the ones a late change is most likely to break.</p>',
      '<div class="scroll"><table><thead><tr><th>Module</th><th>Why it is exposed</th></tr></thead>',
      '<tbody>' + riskRows + '</tbody></table></div>',

      // ---------------------------------------------------------------- graphic
      graphic(),

      // ---------------------------------------------------------------- 3
      '<h2>3. How the rebuilt timetable is built</h2>',
      '<ul>',
      '<li><strong>A lecture and its seminar are one object.</strong> They are stored with a ',
      'fixed offset — the seminar starts exactly when the lecture ends — so placing one ',
      'places both. Back-to-back is not a rule to satisfy; it is a property of the ',
      'representation, and cannot be broken.</li>',
      '<li><strong>Every class starts on the board at once,</strong> at the slot it holds today, ',
      'so the rebuild begins from a real timetable rather than an empty grid. Nothing is ',
      'pinned there: keeping today’s time is the lowest priority in the whole model, below ',
      'every hard rule and every soft goal.</li>',
      '<li><strong>Find a class breaking a rule, and try rooms first.</strong> Belfast’s rooms ',
      'are about two-thirds empty, so most conflicts clear with a room swap nobody notices.</li>',
      '<li><strong>Take the smallest room that fits.</strong> Big rooms are rationed to the ',
      'classes that cannot go anywhere else.</li>',
      '<li><strong>If no room works, move the whole group</strong> to the best day and time — ',
      'and if nothing is better, to the least bad one anyway, displacing other classes.</li>',
      '<li><strong>The displaced classes are then repaired in turn.</strong> Being allowed to ',
      'move something already placed is the step the current method does not have.</li>',
      '<li><strong>Every room is re-allocated from scratch when the search sticks.</strong> ',
      'Hardest class first, smallest room that fits — the way a timetabler would do it by ',
      'hand, and the step that keeps the big theatres free for the lectures with nowhere ',
      'else to go.</li>',
      '<li><strong>At the end, the region around each surviving clash is torn up and rebuilt.</strong> ',
      'Some knots need four classes moved together; no search that moves one at a time can ',
      'untie them.</li>',
      '<li><strong>Repeat until nothing is broken,</strong> then polish the soft goals — ',
      'emptying 9–10am and 4–5pm, and closing gap days in a cohort’s week — with ',
      'moves that break nothing.</li>',
      '<li><strong>Restart from many beginnings and keep the best.</strong> The search settles ',
      'within seconds, so trying many starting points beats grinding one.</li>',
      '</ul>',

      // ---------------------------------------------------------------- 4
      '<h2>4. Why that removes the clashes</h2>',
      '<ul>',
      '<li><strong>No booking order to be unlucky in.</strong> Every class is placed against ',
      'every other, so no school is penalised for booking late.</li>',
      '<li><strong>Early decisions are reversible.</strong> A class that took the last big room ',
      'can be moved when a class that needs it more turns up — the move the current process ',
      'cannot make.</li>',
      '<li><strong>The rules are checked, not hoped for.</strong> All eight hard rules are ',
      're-checked in your browser on load, by the same code that built the timetable.</li>',
      '<li><strong>Splitting is no longer the escape hatch.</strong> Every class gets one room ',
      '— exams aside, where several rooms are legitimate — so a shortage shows up as a ',
      'move to make, not as a class quietly cut in two.</li>',
      '<li><strong>The day no longer absorbs the overflow.</strong> Nothing starts before 09:15 ',
      'or ends after 17:15, so pressure surfaces as a conflict to resolve instead of an 08:15 ',
      'start for somebody’s first years.</li>',
      '<li><strong>Nothing is left for the scramble.</strong> The exposed modules above are ',
      'placed under the same rules as everything else, in advance, rather than negotiated in ',
      'the last fortnight.</li>',
      '</ul>',

      '<h3>The hard rules, today and rebuilt</h3>',
      '<div class="scroll"><table><thead><tr><th>Hard rule</th><th>Today</th><th>Rebuilt</th></tr></thead>',
      '<tbody>' + ruleRows + '</tbody></table></div>',
      '<p class="small muted">Counts are broken rules, judged against a 09:15–17:15 day. ',
      'Today’s column reads high partly because this model gives each class a single room, ',
      'while the current timetable splits ' + fmtN(TODAY.splitBookings) + ' bookings across ',
      'several — a split class and the class next to it both want the same room here.</p>',

      '<h3>The soft goals</h3>',
      '<div class="stats">',
      tile(softNow.edge + ' → ' + soft.edge, 'classes in 9–10am / 4–5pm edge slots', 'good'),
      (meta.gapDays != null ? tile(meta.gapDaysBefore + ' → ' + meta.gapDays,
        'gap days in cohorts’ teaching weeks', 'good') : ''),
      tile(softNow.wedPm + ' → ' + soft.wedPm, 'classes on Wednesday afternoon', 'warn'),
      '</div>',
      '<p class="small muted">A <strong>gap day</strong> is an empty day sitting between two ',
      'teaching days: a cohort taught Mon/Wed/Fri has two, one taught Mon/Tue/Wed has none. ',
      'Wednesday afternoons were not optimised for, and did get slightly busier.</p>',

      // ---------------------------------------------------------------- caveats
      '<h2>Before you rely on this</h2>',

      '<div class="note warn"><p style="margin:0"><strong>The clash data is inferred, not ',
      'authoritative.</strong> "These two classes share students" was derived from the current ',
      'timetable — same programme and year for a student clash, and same school plus shared ',
      'room plus never currently overlapping as a proxy for the same lecturer. Re-run this ',
      'against real enrolment and staff-assignment data before acting on it.</p></div>',

      '<div class="note warn"><p style="margin:0"><strong>This timetable depends on that ',
      'pruning.</strong> Under a 09:15–17:15 day the full inferred graph leaves ',
      '<strong>117</strong> violations that no amount of searching removes; with the unevidenced ',
      'edges dropped the same search reaches <strong>' +
      (meta.hardViolations === 0 ? 'zero' : String(meta.hardViolations)) + '</strong>. ',
      'The published result is solved against <strong>' + (meta.clashEdges || '?') + ' of ' +
      (meta.clashEdgesTotal || '?') + '</strong> clash edges: it assumes a cohort that already ',
      'runs two of its own classes at once is split into groups, and so is not obliged to keep ',
      'every other pair apart. Real enrolment data would settle it.</p></div>',

      '<div class="note warn"><p style="margin:0"><strong>Class sizes are room capacities, not ',
      'headcounts.</strong> Only 17 of ' + fmtN(model.classes.length) + ' rows carry a real ',
      'number, so the room a class sits in today is taken as a fair estimate of its cohort, ',
      'give or take 10%. A room with no capacity recorded is treated as unknown, not as ',
      'unlimited — which is what stops a 350-seat lecture being offered a design studio.</p></div>',

      '<div class="note"><p style="margin:0"><strong>Exams are not normal classes.</strong> ',
      'Each multi-room exam keeps the number of rooms it uses today, in distinct rooms at one ',
      'slot. Bookings marked "do NOT edit or remove" — exam set-up, Estates, IT maintenance, ',
      'applicant days — are pinned where they are. One-off <code>BK</code> bookings are ',
      'excluded entirely.</p></div>',

      '<h2>Reproducing it</h2>',
      '<pre class="card pad mono small" style="overflow-x:auto"><code>node timetable/test.js\n',
      'node timetable/solve.js --seeds 30 --clashes evidenced --out docs/data\n',
      'node timetable/export.js</code></pre>',
      '<p class="small muted">No dependencies. <code>constraints.js</code> and ',
      '<code>suggest.js</code> are pure and run unchanged in node and the browser, so this page ',
      'checks the rules with the same code that enforced them. Data generated ' +
      (meta.generated || 'unknown') + '.</p>',

      '</div>',
    ].join('');
  }

  window.TTMethod = { html: html };
})();
