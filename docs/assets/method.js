// The Method tab's content. Kept as a module rather than inline HTML so the
// numbers in it are computed from the data that is actually loaded, instead of
// being typed in and going stale the next time the solver runs.
//
// Four questions, in order: how today's timetable is made, why that method
// clashes, how this one is made, why it does not.

(function () {
  'use strict';

  /**
   * Facts about a term AS IT STANDS, computed in timetable/export.js from the
   * term's own bookings and shipped beside them.
   *
   * These used to be a block of literals here, measured once. That held only
   * while the bookings never changed — and timetable/refresh.js can now pull a
   * fresh snapshot from Resource Booker, after which typed-in numbers would go
   * on describing a term that no longer exists, with nothing on the page to
   * say so. Reading them from the data means a refresh moves them.
   *
   * A term whose file predates this returns null, and the caller leaves the
   * sentence out rather than quoting a figure it cannot stand behind.
   */
  function todayOf(H, key) {
    var t = H.terms && H.terms[key];
    return (t && t.today) || null;
  }

  // Every seed of a 30-seed sweep per term, run against the rules and data the
  // site ships: `node timetable/solve.js --term <t> --seeds 30 --clashes
  // evidenced`. The point is not the best seed — that one is published — but
  // how many starts reach zero at all, which is what says the result is the
  // search working rather than one lucky draw. `zero` counts the seeds that
  // finished with no hard violation; `dist` is how many seeds ended on 0, 1,
  // 2 ... violations; `published` is the seed the shipped file came from.
  //
  // A seed names a search, not a timetable, and only for one version of the
  // rules: the solver's own cost reads windowExempt, so the pin exemption
  // moved every autumn seed onto a different path. These were measured after
  // that change, and the packed timetables were regenerated from them, so a
  // seed named here is one the command above reproduces. Re-measure both if
  // the rules change again — a stale list would read as reproducible and not
  // be, which is worse than no list.
  //
  // Unlike the figures computed above, these cannot be worked out in the
  // browser: it holds one timetable per term, not thirty.
  var SWEEP = {
    seeds: 30,
    spring: { zero: 6, dist: [6, 9, 6, 7, 1, 1], published: 7,
              clean: [6, 7, 8, 15, 21, 28] },
    autumn: { zero: 10, dist: [10, 16, 4], published: 24,
              clean: [1, 5, 9, 13, 14, 17, 23, 24, 28, 29] },
  };

  function fmtN(n) { return Number(n).toLocaleString(); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // The hard rules, in one place: the checker's key, a short form for the
  // tiles and the rebuild graphic, and the full sentence for the table. They
  // are listed in the order the checker reports them.
  var RULES = [
    ['roomClash',   'Two different classes in one room at the same time',
                    'No two classes in one room at once (exam rooms aside)'],
    ['timeClash',   'A cohort or lecturer in two places',
                    'No cohort or lecturer in two places at once'],
    ['roomFit',     'A room that cannot hold the class',
                    'Right room type, big enough'],
    ['linkedOrder', 'Lecture and seminar pulled apart',
                    'Lecture &amp; seminar same day, back-to-back, in order'],
    // Enforced exactly like the rest, but left out of the graphic's list:
    // the two exam rules are detail the diagram does not need to carry.
    ['examSlot',    'An exam out of its module\u2019s slot',
                    'Exams keep their module\u2019s slot', false],
    ['adjacency',   'An exam detached from its class',
                    'Exams stay attached to the class they follow', false],
    ['dayPairing',  'A cohort given a new same-day pairing',
                    'No new same-day pairing for a cohort'],
    ['window',      'A session outside the teaching day',
                    'Inside the teaching day'],
  ];
  var RULE_ORDER = RULES.map(function (r) { return r[0]; });
  // The subset the algorithm graphic lists; every rule is still checked.
  var DRAWN_RULES = RULES.filter(function (r) { return r[3] !== false; });
  var TILE_LABELS = {};
  RULES.forEach(function (r) { TILE_LABELS[r[0]] = r[1]; });

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

  /**
   * Classes that move between rooms during the term without ever holding two
   * at once — and the single room the rebuild gives them.
   *
   * This is the split the rebuild can actually close. A class that holds
   * several rooms in the same hour is a different thing: MEC114's tutorial
   * teaches 350 students in seven rooms at once, and the rebuild keeps all
   * seven. Mixing the two would count studio teaching and parallel groups as
   * faults being fixed.
   */
  function wanderers(H) {
    var t = H.terms && H.terms.springNow;
    if (!t) return [];
    var byTitle = {};
    H.model.classes.forEach(function (c) {
      if (!c.shadowOf || c.shadowOf < 0) (byTitle[c.title] || (byTitle[c.title] = [])).push(c);
    });
    // Every wandering class, including the ones the model cannot be matched
    // back to. Looking each one up and dropping the misses counted 32 where
    // the timetable page counted 35, and the three missing were not a
    // category — two were title lookups that failed and one was pinned. A
    // count that quietly depends on a lookup succeeding is not a count.
    // The class is still looked up, but only to name the room the rebuild
    // gives it, which is detail the list can do without.
    return window.TTModel.wanderingSlots(t.rows).map(function (slot) {
      var cands = byTitle[slot.title] || [];
      var cls = null;
      for (var i = 0; i < cands.length; i++) {
        if (cands[i].origDay === slot.day && cands[i].origStart === slot.start) {
          cls = cands[i]; break;
        }
      }
      return { module: slot.module, title: slot.title, rooms: slot.rooms,
               cls: cls || cands[0] || null };
    }).sort(function (a, b) { return b.rooms.length - a.rooms.length; });
  }

  /** "BC-03-102 (66)" without the parenthesised capacity. */
  function roomLabel(model, id) {
    var r = model.rooms[id];
    return r ? r.name : '?';
  }

  /**
   * Autumn, built the same way and worth reading beside spring.
   *
   * It is display-only: the browser carries the spring model and checks it on
   * load, and autumn's is fetched only by Fix a clash. So the count here is
   * the solver's, stated as such, rather than something the page proves.
   */
  function autumnSection(H) {
    var t = H.terms && H.terms.autumnNew;
    if (!t) return '';
    // From the scorecard, which is computed against the site's own teaching
    // day, rather than parsed back out of the label.
    var left = t.score && t.score.left ? t.score.left.length
      : Number((t.sub.match(/(\d+) unresolved/) || [])[1] || 0);
    var rows = (H.terms.autumn || {}).rows || [];
    return [
      '<h2>Autumn 2026, the same way</h2>',
      '<p>The autumn term went through the same pipeline: ' + fmtN(rows.length) + ' room-bookings, ',
      'the same eight rules, the same search. Judged from its own bookings it breaks ' +
      (t.score ? fmtN(nowTotal(t.score)) + ' of them as it stands' : 'some of them as it stands') +
      (t.score ? ' \u2014 ' + breakdown(t.score.now) + '.' : '.') + '</p>',
      (left
        ? '<div class="note warn"><p style="margin:0"><strong>The rebuild leaves ' + left +
          ' unresolved.</strong> Named on its tab rather than hidden. Autumn is shown for ' +
          'reading, not checked in your browser the way spring is, so this count is the ' +
          'solver\u2019s own.</p></div>'
        : '<div class="note good"><p style="margin:0"><strong>Every hard rule holds in the ' +
          'autumn rebuild too.</strong> It is shown for reading rather than re-checked here, ' +
          'so this count is the solver\u2019s own.</p></div>'),
      corrections(H, left),
    ].join('');
  }

  /**
   * What it took to get the term clean, counted from the correction files
   * themselves. Written into the prose these went stale the moment anybody
   * added a row, and there was nothing on the page to say they had.
   */
  function corrections(H, left) {
    var c = H.corrections;
    var parts = [];
    if (c) {
      if (c.sizes) parts.push(fmtN(c.sizes) + ' confirmed cohort size' + (c.sizes === 1 ? '' : 's'));
      if (c.roomTypes) parts.push(c.roomTypes + ' class' + (c.roomTypes === 1 ? '' : 'es') +
        ' told what kind of room they need');
      if (c.roomReqs) parts.push(c.roomReqs + ' told which room');
      if (c.keepSlot) parts.push(c.keepSlot + ' told to keep the slot it has');
      if (c.mayShare) parts.push(c.mayShare + ' allowed to share a room');
    }
    return '<p class="small muted">Getting there took corrections rather than a better search, ' +
      'and the corrections came from timetabling' +
      (parts.length ? ': ' + parts.join(', ') + '. ' : '. ') +
      'Five modules were each believed to need all 350 seats of Lecture Theatre 1 because that ' +
      'is the room they sit in \u2014 only one of them does. ENH315 needs forty. Every such ' +
      'correction hands a room back to the classes that were queueing for it, and the count ' +
      'fell with each one, to ' + (left ? left : 'none') + '.</p>';
  }

  function nowTotal(score) {
    return RULE_ORDER.reduce(function (n, k) { return n + (score.now[k] || 0); }, 0);
  }

  /**
   * One class using several rooms through the term, counted from display
   * rows: a term whose model the browser never loads still has its bookings.
   * Rooms held in the SAME week are parallel teaching and are not counted —
   * only a class taught in one room and then another.
   */
  function wanderingRows(rows) {
    return window.TTModel.wanderingSlots(rows).length;
  }

  /** Autumn's rule counts, tile for tile with spring's. */
  function autumnTiles(t, heading, H) {
    var sc = t.score;
    if (!sc) return '';
    function tile(v, k, sub, cls) {
      return '<div class="stat ' + cls + '"><div class="t">today</div><div class="v">' + v +
        '</div><div class="k">' + k + '</div><div class="r">' + sub + '</div></div>';
    }
    // The same three cards spring shows, so the two terms read alike: the two
    // rules it breaks, and the classes taught in one room and then another.
    var shown = ['linkedOrder', 'window'];
    var cards = shown.map(function (k) {
      return tile(fmtN(sc.now[k] || 0), TILE_LABELS[k],
                  'rebuilt: ' + fmtN(sc.fixed[k] || 0), sc.now[k] ? 'warn' : 'good');
    }).join('');
    var movedRooms = wanderingRows((H.terms.autumn || {}).rows || []);
    var movedAfter = wanderingRows((H.terms.autumnNew || {}).rows || []);
    cards += tile(fmtN(movedRooms), 'One class using several rooms through the term',
                  'rebuilt: ' + fmtN(movedAfter), movedRooms ? 'warn' : 'good');
    return '<h4 class="term-sub">' + heading + '</h4><div class="stats">' + cards + '</div>' +
      (sc.now.linkedOrder === 0
        ? '<p class="small muted">Autumn has no declared lecture and seminar pairs, so the ' +
          'rebuild infers them from the sessions that already run back-to-back \u2014 which is ' +
          'why today breaks none of them. The rebuild keeps all ' + fmtN(sc.groups) + '.</p>'
        : '') +
      (sc.overflow
        ? '<p class="small muted">' + sc.overflow + ' sessions in the rebuild still finish after ' +
          '17:15, because the chain of classes they belong to is longer than a teaching day. The ' +
          'rule excuses those; it does not pretend they are inside it.</p>'
        : '');
  }

  /**
   * The same hour-by-hour picture as spring's, for a term whose model the
   * browser never loads: counted from the display rows instead, which carry
   * the day, the hour and the length of every booking.
   */
  function hourChartRows(H, nowKey, newKey, title) {
    var A = (H.terms[nowKey] || {}).rows, B = (H.terms[newKey] || {}).rows;
    if (!A || !B) return '';
    var SLOT0 = 9 * 60 + 15, n = 8;
    var now = new Array(n).fill(0), rebuilt = new Array(n).fill(0);
    [[A, now], [B, rebuilt]].forEach(function (pair) {
      pair[0].forEach(function (r) {
        for (var i = 0; i < n; i++) {
          var s = SLOT0 + i * 60, e = s + 60;
          if (r.start < e && s < r.start + r.dur) pair[1][i]++;
        }
      });
    });
    return barChart(now, rebuilt, title,
      'Room-bookings running in each hour of the teaching day, as autumn stands and rebuilt.');
  }

  function graphic() {
    // Two algorithms side by side. Plain SVG, themed from the page's own
    // variables, sized by viewBox so it holds up at phone width.
    return [
      '<div class="algo-graphic"><div class="algo-inner">',
      '<svg viewBox="0 0 760 ' + (420 + DRAWN_RULES.length * 18) + '" role="img" ',
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

      '<rect x="420" y="66" width="320" height="100" rx="8" class="g-grid"/>',
      '<text x="580" y="84" class="g-label g-muted">every class on the board together</text>',
      '<rect x="432" y="94" width="70" height="24" rx="4" class="g-fill"/>',
      '<rect x="508" y="94" width="70" height="24" rx="4" class="g-fill"/>',
      '<rect x="584" y="94" width="70" height="24" rx="4" class="g-clash"/>',
      '<rect x="660" y="94" width="70" height="24" rx="4" class="g-fill"/>',
      '<rect x="432" y="122" width="70" height="24" rx="4" class="g-clash"/>',
      '<rect x="508" y="122" width="70" height="24" rx="4" class="g-fill"/>',
      '<rect x="584" y="122" width="70" height="24" rx="4" class="g-fill"/>',
      '<rect x="660" y="122" width="70" height="24" rx="4" class="g-fill"/>',
      '<text x="432" y="160" class="g-small g-muted">red = a rule broken</text>',

      '<path d="M580 166 L580 184" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="186" width="320" height="30" rx="6" class="g-box"/>',
      '<text x="580" y="206" class="g-label">pick a class that breaks a rule</text>',
      '<path d="M580 216 L580 232" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="234" width="320" height="30" rx="6" class="g-box"/>',
      '<text x="580" y="254" class="g-label">move it \u2014 room first, then day and time</text>',
      '<path d="M580 264 L580 280" class="g-arrow" marker-end="url(#ar)"/>',
      '<rect x="420" y="282" width="320" height="30" rx="6" class="g-box g-okbox"/>',
      '<text x="580" y="302" class="g-label">it may displace others \u2014 they get repaired too</text>',

      // the loop back
      '<path d="M740 297 C 758 297, 758 128, 744 128" class="g-arrow g-loop" marker-end="url(#ar)"/>',
      '<text x="420" y="330" class="g-small g-oktext">repeat until nothing is broken, then improve the soft goals</text>',
      '<text x="420" y="348" class="g-small g-muted">restart from many random beginnings; keep the best</text>',

      // the rules it repairs against, listed in full
      '<rect x="420" y="364" width="320" height="' + (40 + DRAWN_RULES.length * 18) + '" rx="8" ',
      'class="g-rules"/>',
      '<text x="436" y="386" class="g-label g-start g-oktext">the rules it repairs against</text>',
      DRAWN_RULES.map(function (r, i) {
        return '<text x="436" y="' + (408 + i * 18) + '" class="g-small">\u2022 ' + r[2] + '</text>';
      }).join(''),
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
  /**
   * Two bars an hour: how it stands, and how it is rebuilt. Kept apart from
   * the counting so a term whose model the browser never loads can draw the
   * same picture from its display rows.
   */
  function barChart(now, rebuilt, title, aria) {
    var n = now.length;
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
      'aria-label="' + aria + '">',
      '<text x="40" y="16" class="g-title">' + title + '</text>',
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

  /**
   * How many of 30 starting points reached each violation count, one row per
   * term. Two rows rather than paired bars with a legend: the question the
   * chart answers is how the two terms differ, and a reader should not have to
   * match a colour to a key to see it. Each row carries its own name, and the
   * column a reader cares about is the first one.
   */
  function sweepChart() {
    var TERMS = [
      { key: 'spring', name: 'Spring 2026', cls: 'g-barNow' },
      { key: 'autumn', name: 'Autumn 2026', cls: 'g-barAut' },
    ];
    var n = Math.max(SWEEP.spring.dist.length, SWEEP.autumn.dist.length);
    var peak = 1;
    TERMS.forEach(function (t) {
      t.dist = [];
      for (var i = 0; i < n; i++) {
        var v = SWEEP[t.key].dist[i] || 0;
        t.dist.push(v);
        if (v > peak) peak = v;
      }
    });

    var W = 620, GUT = 104, barH = 62, rowH = 88, top = 30;
    var colW = (W - GUT - 16) / n;
    var bw = Math.min(46, colW - 12);
    var body = '';

    TERMS.forEach(function (t, ri) {
      var base = top + ri * rowH + barH + 6;
      // The term's name sits against its own bars, so the row needs no key.
      body += '<text x="' + (GUT - 12) + '" y="' + (base - barH / 2 + 4) + '" ' +
        'class="g-small g-rowname" text-anchor="end">' + t.name + '</text>';
      body += '<line x1="' + GUT + '" y1="' + base + '" x2="' + (W - 12) + '" y2="' + base +
        '" class="g-axis"/>';
      for (var j = 0; j < n; j++) {
        var v = t.dist[j];
        var h = Math.round(v / peak * barH);
        var x = GUT + j * colW + (colW - bw) / 2;
        // The zero column is the one the chart exists to show, in both rows.
        var cls = j === 0 ? 'g-barGood' : t.cls;
        body += '<rect x="' + x + '" y="' + (base - h) + '" width="' + bw + '" height="' + h +
          '" rx="2" class="' + cls + '"/>';
        var inside = h >= 20;
        body += '<text x="' + (x + bw / 2) + '" y="' + (base - h + (inside ? 14 : -4)) + '" ' +
          'class="g-small ' + (inside ? 'g-barText' : 'g-muted') + '" text-anchor="middle">' +
          v + '</text>';
      }
    });

    // One shared x axis, under the lower row.
    var axisY = top + TERMS.length * rowH + 2;
    var labels = '';
    for (var j2 = 0; j2 < n; j2++) {
      labels += '<text x="' + (GUT + j2 * colW + colW / 2) + '" y="' + axisY + '" ' +
        'class="g-small ' + (j2 === 0 ? 'g-oktext' : 'g-muted') + '" text-anchor="middle">' +
        j2 + '</text>';
    }
    labels += '<text x="' + (GUT + (W - GUT - 16) / 2) + '" y="' + (axisY + 18) + '" ' +
      'class="g-small g-muted" text-anchor="middle">hard violations left at the end of the ' +
      'run \u2014 <tspan class="g-oktext">0 means every rule holds</tspan></text>';

    return [
      '<div class="algo-graphic"><div class="algo-inner" style="min-width:600px">',
      '<svg viewBox="0 0 ' + W + ' ' + (axisY + 30) + '" role="img" aria-label="',
      'Of ' + SWEEP.seeds + ' starting points per term, ' + SWEEP.spring.zero +
      ' reached zero violations in spring and ' + SWEEP.autumn.zero + ' in autumn.">',
      '<text x="40" y="16" class="g-title">Seeds by the number of violations they ended on</text>',
      body, labels,
      '</svg></div></div>',
    ].join('');
  }

  /**
   * The sweep in words: the headline per term, and which seeds were clean, so
   * anyone can re-run a named one rather than take the count on trust.
   */
  function sweepSection() {
    // Every clean one is shipped, so each seed is a link to the timetable
    // itself rather than a number to take on trust.
    var TAB = { spring: 'springNew', autumn: 'autumnNew' };
    function line(key, label) {
      var t = SWEEP[key];
      var links = t.clean.map(function (n) {
        return '<a href="?t=' + TAB[key] + '&seed=' + n + '">' + n + '</a>' +
               (n === t.published ? ' <span class="small muted">(published)</span>' : '');
      }).join(', ');
      // A term with an unavoidable violation has no clean seeds to claim, so
      // it says what the floor is and which seeds reach it instead.
      return t.floor
        ? '<li><strong>' + label + ': ' + t.zero + ' of ' + SWEEP.seeds +
          '</strong> starting points got as close as the term allows \u2014 ' + links +
          '. None reaches zero, and none can: ' + t.forced + ', so it runs an hour past ' +
          'the teaching day whatever else moves. That one overflow is the only rule any of ' +
          'them breaks.</li>'
        : '<li><strong>' + label + ': ' + t.zero + ' of ' + SWEEP.seeds +
          '</strong> starting points finished with every rule holding \u2014 ' + links +
          '. Each one opens as a timetable you can read.</li>';
    }
    return [
      '<h2>It is not one lucky starting point</h2>',
      '<p class="small muted">The search starts from a random shuffle, so a single clean run ',
      'proves less than it looks. Both terms were therefore run from ' + SWEEP.seeds +
      ' different starting points, against the same rules and the same data this page checks ',
      'with.</p>',
      '<ul>',
      line('spring', 'Spring 2026'),
      line('autumn', 'Autumn 2026'),
      '<li>No clean run had to <strong>split a class across two rooms</strong>. Six spring ',
      'starts did fall back to splitting, and every one of them still ended with violations ',
      'left — so splitting never bought a clean term.</li>',
      '</ul>',
      sweepChart(),
      '<p class="small muted">All ' + (SWEEP.spring.zero + SWEEP.autumn.zero) + ' of them are ',
      'published, not just the two the rest of the site is built from. The picker at the top of ',
      'either rebuilt timetable switches between them, and the Rooms calendar takes the same ',
      'picker \u2014 which rooms a term leans on is the thing that differs most between two ',
      'arrangements that are equally correct.</p>',
      '<p class="small muted">The tail is short in both terms: no autumn start ended worse ' +
      'than ' + (SWEEP.autumn.dist.length - 1) + ', and ' +
      (SWEEP.autumn.dist[1] + SWEEP.autumn.dist[2]) + ' of ' + SWEEP.seeds +
      ' ended at the floor or one above it. That is a reversal: under the room sizes first ',
      'read off the booking data, autumn could not get near this at all. What changed was the ',
      'data, not the search \u2014 the confirmed cohort sizes, the room types a module actually ',
      'needs, and the rooms a module is pinned to.</p>',
    ].join('');
  }

  function hourChart(model, assign, title) {
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
    return barChart(now, rebuilt, title || 'Classes running in each hour of the teaching day',
      'Classes running in each hour of the day, today against the rebuild.');

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
    var C = window.TTConstraints, M = window.TTModel;
    var model = H.model, a = H.assign;
    // Today's timetable is judged from its own bookings, each with the room,
    // slot and weeks it was actually booked for. Judging it through the
    // rebuilt term's model instead — one room and one week list per class —
    // reported 288 room clashes, and the per-room data shows none of them
    // happen.
    var occ = M.currentOccupancy ? M.currentOccupancy(H) : null;
    var now = C.check(model, a.current, occ ? { occupancy: occ } : {});
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

    // The term as it stands, from its own bookings. Spring, because that is
    // the term these sentences are about; autumn's own figures are on its card.
    var TODAY = todayOf(H, 'springNow');
    var bigRooms = model.rooms.filter(function (r) { return r.capacity >= 150; });
    var risky = atRisk(model);
    var tight = tightest(model);

    // A tile per hard rule: how often today's timetable breaks it, and the
    // same count in the rebuild. Both numbers come from the checker running in
    // this browser, not from anything typed in here.
    function tile(v, k, sub, cls, list) {
      return '<div class="stat ' + (cls || '') + '">' +
             (sub ? '<div class="t">today</div>' : '') +
             '<div class="v">' + v + '</div>' +
             '<div class="k">' + k + '</div>' +
             (sub ? '<div class="r">' + sub + '</div>' : '') +
             (list ? '<details class="stat-list"><summary>which ones</summary>' + list +
                     '</details>' : '') +
             '</div>';
    }

    /** A short list inside a tile: the first dozen, then how many are left. */
    function few(items) {
      if (!items.length) return '';
      var head = items.slice(0, 12).map(function (x) { return '<li>' + x + '</li>'; }).join('');
      return '<ul>' + head + '</ul>' +
        (items.length > 12
          ? '<p class="small muted">and ' + fmtN(items.length - 12) + ' more</p>' : '');
    }

    function named(id) {
      var c = model.byId.get(id);
      if (!c) return '?';
      return '<strong>' + esc(c.module || c.activity) + '</strong> ' +
             esc(String(c.title || '').slice(0, 30));
    }

    // What each tile is counting, class by class.
    var lists = {};
    (now.violations || []).forEach(function (v) {
      if (v.kind !== 'linkedOrder' && v.kind !== 'window') return;
      (lists[v.kind] || (lists[v.kind] = [])).push(
        v.kind === 'linkedOrder'
          ? named(v.a) + ' <span class="muted">and its ' +
            esc((model.byId.get(v.b) || {}).activity || 'pair') + '</span>'
          : named(v.a) + ' <span class="muted">' +
            M.DAYS[(a.current.get(v.a) || {}).day] + ' ' +
            M.fmt((a.current.get(v.a) || {}).start) + '</span>');
    });
    // Only the rules today's timetable actually breaks get a tile. The full
    // set is in the rebuild graphic above, so nothing is hidden by leaving the
    // ones that already hold off the row.
    //
    var brokenNow = RULE_ORDER.filter(function (k) { return now.counts[k]; });
    var ruleTiles = brokenNow.map(function (k) {
      return tile(fmtN(now.counts[k]), TILE_LABELS[k],
                  'rebuilt: ' + fmtN(fixed.counts[k] || 0), 'warn', few(lists[k] || []));
    }).join('');
    // The room fault the rebuild does close. Not a hard rule, and not every
    // class with several rooms: a class holding several at once is parallel
    // teaching and keeps them. These are the ones taught in one room and then
    // another, which the rebuild gives a single room for the whole term.
    var moved = wanderers(H);
    // Counted in the rebuilt term rather than asserted to be zero. It is zero
    // by construction — a class holds one room — but a tile that prints a
    // constant proves nothing, and would go on printing it if that changed.
    var movedAfter = wanderingRows((H.terms.springNew || {}).rows || []);
    if (moved.length) {
      ruleTiles += tile(fmtN(moved.length), 'One class using several rooms through the term',
        'rebuilt: ' + fmtN(movedAfter), 'warn',
        few(moved.map(function (x) {
          return '<strong>' + esc(x.module) + '</strong> <span class="muted">' +
            x.rooms.length + ' rooms' +
            (x.cls ? ' \u2192 ' + esc(roomLabel(model, x.cls.room)) : '') + '</span>';
        })));
    }

    var riskRows = risky.map(function (x) {
      var name = (model.modTitles || {})[x.code] || '';
      return '<tr><td><strong>' + x.code + '</strong>' +
        (name ? '<br><span class="small muted">' + name + '</span>' : '') + '</td>' +
        '<td>' + x.why + '</td></tr>';
    }).join('');

    return [
      '<div class="narrow-inner">',

      '<h2 style="margin-top:0">Two ways to build a timetable</h2>',
      '<p class="lead">Both terms are assembled one booking at a time. These rebuilds place a ',
      'whole term at once and repair what breaks \u2014 Spring 2026 first, then Autumn 2026 the ',
      'same way.</p>',

      graphic(),

      '<h3>Differences between the current approach and the rebuild</h3>',
      '<p class="small muted">The large number is how often the timetable as it stands breaks ',
      'that rule, counted from the bookings themselves; underneath it, the same count in the ',
      'rebuild. Rules that already hold today, and still do, are left out.</p>',
      '<h4 class="term-sub">Spring 2026</h4>',
      '<div class="stats">',
      ruleTiles,
      '</div>',
      autumnTiles(H.terms.autumnNew, 'Autumn 2026', H),
      TODAY
        ? '<p class="small muted">The room rule itself already holds today: ' +
          TODAY.sharedRoomPairs + ' pairs of bookings do hold one room at the same time, and ' +
          'every one of them is shared teaching \u2014 architecture and art studios, the ' +
          'hospitality kitchen, a joint sports physiology lab \u2014 which the rebuild keeps. ' +
          'What the term does have is splitting: ' + fmtN(TODAY.splitBookings) + ' of ' +
          fmtN(TODAY.bookings) + ' bookings use more than one room, one of them ' +
          TODAY.maxRooms + ', which is ' + fmtN(TODAY.splitExtra) + ' of the term\u2019s ' +
          fmtN(TODAY.roomBookings) + ' room-bookings. All ' + b2b + ' of ' + groups +
          ' lecture+seminar pairs run back-to-back.</p>'
        : '<p class="small muted">All ' + b2b + ' of ' + groups + ' lecture+seminar pairs run ' +
          'back-to-back.</p>',

      hourChart(model, a.solved, 'Spring 2026: classes running in each hour'),
      hourChartRows(H, 'autumn', 'autumnNew', 'Autumn 2026: bookings running in each hour'),

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
      'is split across rooms' +
      (TODAY ? ' (' + fmtN(TODAY.splitBookings) + ' of ' + fmtN(TODAY.bookings) +
               ' bookings, one across ' + TODAY.maxRooms + ')' : '') +
      ', or a gap opens between a lecture and its seminar (' + gappy + ' of ' + groups + ').</li>',
      TODAY
        ? '<li><strong>And the day stretches.</strong> ' + fmtN(TODAY.outside) + ' of ' +
          fmtN(TODAY.roomBookings) + ' room-bookings fall outside 9\u20135; ' +
          fmtN(TODAY.at0815) + ' start at 08:15.</li>'
        : '',
      '<li><strong>The rest is settled by hand</strong> in the weeks before term, one email at ',
      'a time. It recurs every year because the method produces it, not the term.</li>',
      '</ul>',

      sweepSection(),

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
          breakdown(fixed.counts) + ', against ' + (now.total - now.counts.roomClash) +
          ' today. ' +
          (tight && tight.over > 0
            ? 'In week ' + tight.week + ', classes needing ' + tight.seats + '+ seats ask for ' +
              Math.round(tight.need) + ' room-hours and the ' + tight.rooms + ' rooms that size ' +
              'offer ' + tight.hours + '. '
            : 'No week is over capacity on paper, so this is the search rather than the building. ') +
          'Named, not hidden: it is on the rebuilt tab and on Explore moves.</p></div>'),

      '<p class="small muted">' + fmtN(mv.untouched) + ' of ' + fmtN(mv.total) + ' classes keep ',
      'their slot. ' + blocks + ' block sessions stay on campus. Gap days in cohorts\u2019 weeks: ' +
      (meta.gapDaysBefore != null ? meta.gapDaysBefore + ' \u2192 ' + meta.gapDays : 'n/a') + '.</p>',

      autumnSection(H),

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
      '<div class="note"><p style="margin:0"><strong>Rooms held at once are kept.</strong> ',
      'A booking that holds several rooms in the same hour is parallel teaching, not a fault: ',
      'MEC114\u2019s tutorial teaches 350 students in seven rooms and the rebuild books seven, ',
      'and the fine art studios keep their fourteen. Each of those rooms is sized by its own ',
      'capacity, so a group is never assumed larger than the room it meets in. What the rebuild ',
      'removes is a class wandering between rooms across the term.</p></div>',
      '<div class="note"><p style="margin:0"><strong>Exams and evenings are different.</strong> ',
      'A multi-room exam keeps its several rooms. Anything taught after 17:15 stays there \u2014 ',
      'nineteen modules are evening-only, nearly all part-time. One-off bookings are excluded.</p></div>',

      '<h2>Reproducing it</h2>',
      '<pre class="card pad mono small" style="overflow-x:auto"><code>node timetable/test.js\n',
      'node timetable/solve.js --term spring --seeds 30 --clashes evidenced --out docs/data\n',
      'node timetable/solve.js --term autumn --seeds 30 --clashes evidenced --out docs/data</code></pre>',
      '<p class="small muted"><code>constraints.js</code> runs unchanged in node and the browser, ',
      'so this page checks the rules with the same code that enforced them. Data generated ' +
      (meta.generated || 'unknown') + '.</p>',

      '</div>',
    ].join('');
  }

  window.TTMethod = { html: html };
})();
