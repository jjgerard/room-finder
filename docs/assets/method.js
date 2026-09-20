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

  /**
   * When classes actually run, hour by hour, before and after.
   *
   * Counted as classes OCCUPYING each hour rather than starting in it, so a
   * three-hour lecture is in all three of its bars — which is what somebody
   * asking "how busy is 2pm" means.
   */
  function hourChart(model, assign) {
    // The teaching day runs 09:15 to 17:15, so the bars are its eight slots
    // rather than clock hours: counting 9-to-10 and 17-to-18 as hours makes
    // the two ends look quiet when they are only partly inside the day.
    var SLOT0 = 9 * 60 + 15, n = 8;
    var now = new Array(n).fill(0), rebuilt = new Array(n).fill(0);
    model.classes.forEach(function (c) {
      if (!c.attended) return;
      for (var k = 0; k < 2; k++) {
        var p = k === 0 ? { start: c.origStart } : assign.get(c.id);
        if (!p) continue;
        var into = k === 0 ? now : rebuilt;
        for (var i = 0; i < n; i++) {
          var s = SLOT0 + i * 60, e = s + 60;
          if (p.start < e && s < p.start + c.dur) into[i]++;
        }
      }
    });
    var peak = Math.max.apply(null, now.concat(rebuilt)) || 1;
    var W = 620, chartH = 150, base = chartH + 26, colW = W / n;
    var bars = '', labels = '';
    for (var i = 0; i < n; i++) {
      var x = 44 + i * ((W - 60) / n);
      var bw = ((W - 60) / n - 10) / 2;
      var ha = Math.round(now[i] / peak * chartH), hb = Math.round(rebuilt[i] / peak * chartH);
      bars += '<rect x="' + x + '" y="' + (base - ha) + '" width="' + bw + '" height="' + ha +
        '" rx="2" class="g-barNow"/>';
      bars += '<rect x="' + (x + bw + 2) + '" y="' + (base - hb) + '" width="' + bw + '" height="' + hb +
        '" rx="2" class="g-barNew"/>';
      var edge = (i === 0 || i === n - 1);
      labels += '<text x="' + (x + bw) + '" y="' + (base + 14) + '" class="g-small ' +
        (edge ? 'g-badtext' : 'g-muted') + '" text-anchor="middle">' +
        (9 + i) + ':15</text>';
    }
    // A horizontal rule at the peak, so the bars have a scale.
    var grid = '<line x1="40" y1="' + base + '" x2="' + (W - 8) + '" y2="' + base +
      '" class="g-axis"/>' +
      '<line x1="40" y1="' + (base - chartH) + '" x2="' + (W - 8) + '" y2="' + (base - chartH) +
      '" class="g-axis g-faint"/>' +
      '<text x="36" y="' + (base - chartH + 4) + '" class="g-small g-muted" text-anchor="end">' +
      peak + '</text>' +
      '<text x="36" y="' + (base + 4) + '" class="g-small g-muted" text-anchor="end">0</text>';
    return [
      '<div class="algo-graphic"><div class="algo-inner" style="min-width:600px">',
      '<svg viewBox="0 0 ' + W + ' ' + (base + 46) + '" role="img" ',
      'aria-label="Classes running in each hour of the day, today against the rebuild. ',
      'The rebuild empties the 9am and 4pm ends and carries the middle of the day instead.">',
      '<text x="40" y="16" class="g-title">Classes running in each hour of the teaching day</text>',
      grid, bars, labels,
      '<rect x="44" y="' + (base + 26) + '" width="11" height="11" rx="2" class="g-barNow"/>',
      '<text x="62" y="' + (base + 36) + '" class="g-small g-muted">as it stands</text>',
      '<rect x="150" y="' + (base + 26) + '" width="11" height="11" rx="2" class="g-barNew"/>',
      '<text x="168" y="' + (base + 36) + '" class="g-small g-muted">rebuilt</text>',
      '<text x="250" y="' + (base + 36) + '" class="g-small g-badtext">the first and last ',
      'slots are the ones worth emptying</text>',
      '</svg></div></div>',
    ].join('');
  }

  /** Why a block session cannot find a room: the grid is cut vertically. */
  function stripeGraphic() {
    var cells = '';
    var WEEKS = 8, ROOMS = 4;
    // Rooms 1-3 carry an ordinary weekly class; room 4 is free but too small.
    for (var r = 0; r < ROOMS; r++) {
      for (var w = 0; w < WEEKS; w++) {
        var x = 60 + w * 34, y = 40 + r * 30;
        var busy = (r === 0) || (r === 1 && w !== 5) || (r === 2 && w % 3 !== 2);
        cells += '<rect x="' + x + '" y="' + y + '" width="30" height="26" rx="3" class="' +
          (busy ? 'g-fill' : 'g-empty') + '"/>';
      }
      cells += '<text x="52" y="' + (58 + r * 30) + '" class="g-small g-muted" ' +
        'text-anchor="end">room ' + (r + 1) + '</text>';
      // The last row is empty on purpose, and needs saying, or the picture
      // argues against itself: there IS a free room, it is just too small.
      if (r === ROOMS - 1)
        cells += '<text x="' + (60 + WEEKS * 34 + 8) + '" y="' + (58 + r * 30) +
          '" class="g-small g-badtext">too small</text>';
    }
    for (var w2 = 0; w2 < WEEKS; w2++)
      cells += '<text x="' + (75 + w2 * 34) + '" y="32" class="g-small g-muted" ' +
        'text-anchor="middle">' + (w2 + 1) + '</text>';
    return [
      '<div class="algo-graphic"><div class="algo-inner" style="min-width:560px">',
      '<svg viewBox="0 0 580 234" role="img" aria-label="A grid of rooms against weeks. ',
      'Ordinary weekly classes fill most cells, so no room is free in every week a block ',
      'session runs.">',
      '<text x="20" y="20" class="g-title">A block day needs one room free in every week it runs</text>',
      cells,
      '<rect x="56" y="' + (40 + 3 * 30 + 32) + '" width="276" height="26" rx="3" class="g-clash"/>',
      '<text x="194" y="' + (58 + 3 * 30 + 32) + '" class="g-label">a block day needs this whole row</text>',
      '<text x="350" y="' + (58 + 3 * 30 + 32) + '" class="g-small g-badtext">nowhere to put it</text>',
      // SVG text does not wrap, so the caption is set as three lines by hand.
      '<text x="20" y="196" class="g-small g-muted">Each cell is one room on one day in one week.</text>',
      '<text x="20" y="210" class="g-small g-muted">A two-hour class running twelve weeks colours a whole row,</text>',
      '<text x="20" y="224" class="g-small g-muted">so a block day has nowhere to land even when the building looks half empty.</text>',
      '</svg></div></div>',
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
    // Classes taught in more than one room, today and in the rebuild. An exam
    // legitimately fills several, so it is counted separately.
    var splitNow = 0, extraRooms = 0, worstRooms = 0;
    model.classes.forEach(function (c) {
      if (c.nRooms > 1 && c.activity !== 'EXM') { splitNow++; extraRooms += c.nRooms - 1; }
      if (c.nRooms > worstRooms) worstRooms = c.nRooms;
    });
    // In the rebuild a class holds exactly one room, so this is zero by
    // construction rather than by search — the model has nowhere to put a
    // second room for it. Counting rooms per booking TITLE instead gave 41,
    // which is wrong: a module's six separate sittings share a title and are
    // not one class split six ways.
    var splitNew = 0;

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

      '<h2 style="margin-top:0">Two ways to build a timetable</h2>',
      '<p class="lead">Spring 2026 is assembled one booking at a time. This rebuild places the ',
      'whole term at once and repairs what breaks.</p>',

      graphic(),

      '<div class="stats">',
      tile(splitNow + ' \u2192 ' + splitNew, 'classes taught in more than one room', 'good'),
      tile(String(worstRooms), 'rooms the worst one is split across today', 'warn'),
      tile(b2b + '/' + groups, 'lecture+seminar pairs back-to-back', b2b === groups ? 'good' : 'warn'),
      '</div>',
      '<p class="small muted">A class in two rooms is two rooms staffed, or a cohort divided ',
      'between them. Giving each one room returns ' + fmtN(extraRooms) + ' room-bookings to the ',
      'pool \u2014 exams aside, where several rooms are the point. The rebuild reaches zero here ',
      'by construction rather than by searching: a class simply has one room.</p>',

      // ------------------------------------------------ why it always clashes
      '<h2>The current method will always clash</h2>',
      '<ul>',
      '<li><strong>Order decides the outcome.</strong> The same set of classes gives a different ',
      'timetable depending on who books first \u2014 and whoever books last gets what is left.</li>',
      '<li><strong>A choice once made is never undone.</strong> One booking taking the last big ',
      'room at 11am can make a later lecture unplaceable, and by then the first one is fixed.</li>',
      '<li><strong>Nobody holds the whole picture.</strong> A school sees its own clashes. It ',
      'cannot see that its 2pm booking is what forces another school\u2019s cohort to 08:15.</li>',
      '<li><strong>So the rules bend instead of the calendar.</strong> When nothing fits, a class ',
      'is split across rooms (' + fmtN(TODAY.splitBookings) + ' of ' + fmtN(TODAY.bookings) +
      ' bookings, one across ' + TODAY.maxRooms + '), a room is double-booked (' +
      TODAY.doubleBooked + ' pairs), or a gap opens between a lecture and its seminar (' +
      gappy + ' of ' + groups + ').</li>',
      '<li><strong>And the day stretches.</strong> ' + fmtN(TODAY.outside) + ' of ' +
      fmtN(TODAY.outsideOf) + ' room-bookings fall outside 9\u20135; ' + fmtN(TODAY.at0815) +
      ' start at 08:15.</li>',
      '<li><strong>The rest is settled by hand</strong> in the weeks before term, one email at ',
      'a time. It recurs every year because the method produces it, not the term.</li>',
      '</ul>',

      hourChart(model, a.solved),

      stripeGraphic(),

      '<h3>The modules most exposed</h3>',
      '<p class="small muted">Scored from this term\u2019s own data: how few rooms can hold the ',
      'class, whether it is already split or running long, and how many other classes cannot run ',
      'alongside it.</p>',
      '<div class="scroll"><table><thead><tr><th>Module</th><th>Why it is exposed</th></tr></thead>',
      '<tbody>' + riskRows + '</tbody></table></div>',

      // ------------------------------------------------ the result
      '<h2>The rebuilt timetable</h2>',
      (fixed.total === 0
        ? '<div class="note good"><p style="margin:0"><strong>Every hard rule holds.</strong> ' +
          'Checked in your browser on load, by the same code that built it.</p></div>'
        : '<div class="note warn"><p style="margin:0"><strong>' + fixed.total +
          ' placement' + (fixed.total === 1 ? '' : 's') + ' could not be resolved</strong> \u2014 ' +
          breakdown(fixed.counts) + ', against ' + now.total + ' today. ' +
          (tight && tight.over > 0
            ? 'In week ' + tight.week + ', classes needing ' + tight.seats + '+ seats ask for ' +
              Math.round(tight.need) + ' room-hours and the ' + tight.rooms + ' rooms that size ' +
              'offer ' + tight.hours + '. '
            : 'No week is over capacity on paper, so this is the search rather than the building. ') +
          'Named, not hidden: it is on the rebuilt tab and on Explore moves.</p></div>'),

      '<div class="scroll"><table><thead><tr><th>Hard rule</th><th>Today</th><th>Rebuilt</th></tr></thead>',
      '<tbody>' + ruleRows + '</tbody></table></div>',
      '<p class="small muted">' + fmtN(mv.untouched) + ' of ' + fmtN(mv.total) + ' classes keep ',
      'their slot. ' + blocks + ' block sessions stay on campus. Gap days in cohorts\u2019 weeks: ' +
      (meta.gapDaysBefore != null ? meta.gapDaysBefore + ' \u2192 ' + meta.gapDays : 'n/a') + '.</p>',

      // ------------------------------------------------ caveats
      '<h2>Before you rely on it</h2>',
      '<div class="note warn"><p style="margin:0"><strong>The clash data is inferred.</strong> ',
      '"These two share students" was read off the current timetable, and the result is solved ',
      'against <strong>' + (meta.clashEdges || '?') + ' of ' + (meta.clashEdgesTotal || '?') +
      '</strong> inferred pairs \u2014 those it actually evidences. Real enrolment data would ',
      'settle it.</p></div>',
      '<div class="note warn"><p style="margin:0"><strong>Most class sizes are room capacities, ',
      'not headcounts.</strong> Where timetabling has confirmed a real number it is used exactly; ',
      'everywhere else the room a class sits in stands in for its cohort, give or take 12%.</p></div>',
      '<div class="note"><p style="margin:0"><strong>Exams and evenings are different.</strong> ',
      'A multi-room exam keeps its several rooms. Anything taught after 17:15 stays there \u2014 ',
      'nineteen modules are evening-only, nearly all part-time. One-off bookings are excluded.</p></div>',

      '<h2>Reproducing it</h2>',
      '<pre class="card pad mono small" style="overflow-x:auto"><code>node timetable/test.js\n',
      'node timetable/solve.js --seeds 30 --clashes evidenced --out docs/data</code></pre>',
      '<p class="small muted"><code>constraints.js</code> runs unchanged in node and the browser, ',
      'so this page checks the rules with the same code that enforced them. Data generated ' +
      (meta.generated || 'unknown') + '.</p>',

      '</div>',
    ].join('');
  }

  window.TTMethod = { html: html };
})();
