// The clean timetables for a rebuilt term, and the control that switches
// between them.
//
// A rebuilt term is not one answer. The search starts from a random shuffle,
// so thirty starting points give thirty different timetables, and several of
// them break no rule at all. Shipping the best one by the soft score and
// saying nothing about the others makes the result look like a discovery
// rather than what it is: one draw from a set, any of which would do.
//
// So every clean one is shipped, at three numbers per class, and the page lets
// a reader put them side by side. What differs between them is worth seeing —
// the same term with 400 early-and-late classes or 420, a module on Tuesday in
// one and Thursday in another — because it is the argument for the method
// rather than for any particular timetable.

(function () {
  'use strict';

  // The rebuilt terms, and the file holding their alternatives.
  var FILES = { springNew: 'data/seeds-spring.json', autumnNew: 'data/seeds-autumn.json' };
  var MOVED_DAY = 1, MOVED_TIME = 2, MOVED_ROOM = 4;

  var cache = {};

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function flags(bits) {
    return (bits & MOVED_DAY ? 'd' : '') + (bits & MOVED_TIME ? 't' : '') +
           (bits & MOVED_ROOM ? 'r' : '');
  }

  /**
   * The alternatives for one rebuilt term, fetched once. A term with no file
   * resolves to null rather than rejecting: the page must still work when
   * only the published timetable has been packed.
   */
  function load(termKey) {
    if (!FILES[termKey]) return Promise.resolve(null);
    if (cache[termKey]) return cache[termKey];
    cache[termKey] = fetch(FILES[termKey])
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (pack) {
        if (!pack || !pack.seeds || !pack.seeds.length) return null;
        return pack;
      })
      .catch(function () { return null; });
    return cache[termKey];
  }

  /**
   * Put one of the alternatives into a term's display rows, in place.
   *
   * The rows are in the order timetable/seeds.js wrote the arrays in, which is
   * the order export.js built them in. A length mismatch means the two files
   * were generated from different data, and rewriting anyway would silently
   * move every class to the wrong room — so it refuses instead.
   */
  function apply(H, termKey, seed, pack) {
    var term = H.terms[termKey];
    if (!term) return null;
    // The published timetable, kept so switching back is exact rather than a
    // re-derivation.
    if (!term.__published) {
      term.__published = term.rows.map(function (r) {
        return { day: r.day, start: r.start, room: r.room, changed: r.changed };
      });
    }
    var entry = null;
    if (pack) {
      for (var i = 0; i < pack.seeds.length; i++) {
        if (pack.seeds[i].seed === seed) { entry = pack.seeds[i]; break; }
      }
    }
    if (entry && entry.day.length !== term.rows.length) {
      throw new Error('seed ' + seed + ' has ' + entry.day.length + ' placements for ' +
                      term.rows.length + ' bookings — the data files disagree');
    }
    term.rows.forEach(function (r, i) {
      if (entry) {
        r.day = entry.day[i]; r.start = entry.start[i]; r.room = entry.room[i];
        r.changed = flags(entry.flags[i]);
      } else {
        var p = term.__published[i];
        r.day = p.day; r.start = p.start; r.room = p.room; r.changed = p.changed;
      }
    });
    term.seed = entry ? entry.seed : (pack ? pack.published : null);
    return entry;
  }

  /**
   * The chosen timetable as an assignment the checker can judge, for the term
   * whose model the page is carrying. Without this the verdict on screen would
   * keep describing the published timetable while the grid showed another.
   */
  function assignment(model, entry) {
    var a = new Map();
    model.classes.forEach(function (c, i) {
      a.set(c.id, entry
        ? { day: entry.day[i], start: entry.start[i], room: entry.room[i] }
        : { day: c.day, start: c.start, room: c.room });
    });
    return a;
  }

  /** "6 · 413 early or late · 265 gap-days · 1,278 moved" */
  function describe(s) {
    return [s.edge + ' early or late',
            s.gapDays != null ? s.gapDays + ' gap-days' : null,
            Number(s.moved).toLocaleString() + ' moved'].filter(Boolean).join(' · ');
  }

  /**
   * The picker. One button per clean timetable, plus a line saying what the
   * set means — without it a row of seed numbers is just noise.
   *
   * onPick is handed the seed, and is responsible for redrawing; this only
   * rewrites the rows.
   */
  function mount(el, H, termKey, seed, onPick) {
    if (!el) return Promise.resolve(null);
    return load(termKey).then(function (pack) {
      if (!pack) { el.hidden = true; el.innerHTML = ''; return null; }
      el.hidden = false;

      var chosen = seed == null ? pack.published : seed;
      // A term with a violation no arrangement can remove cannot be sold as
      // clean, so the line says what the floor is and names what forces it.
      var f0 = pack.floor && pack.seeds[0].forced || [];
      var forced = f0.map(function (f) { return f.what; }).join(', ');
      var head = pack.floor
        ? pack.seeds.length + ' different starting points that all got as close as this term ' +
          'allows: one session \u2014 ' + esc(forced) + ' \u2014 runs past the teaching day in ' +
          'every arrangement, and nothing else breaks a rule in any of them.'
        : pack.seeds.length + ' different starting points that all finished with every rule ' +
          'holding.';
      var html = '<div class="seedbar-head"><strong>Explore the clean sweeps</strong> ' +
        '<span class="small muted">' + head + ' They are not the same timetable \u2014 pick ' +
        'one to see it.</span></div><div class="chips seedbar-chips">';
      pack.seeds.forEach(function (s) {
        html += '<button class="chip seed" data-seed="' + s.seed + '" aria-pressed="' +
          (s.seed === chosen) + '" title="' + esc(describe(s)) + '">' +
          '<span class="ttl">Seed ' + s.seed +
          (s.seed === pack.published ? '<span class="tag">published</span>' : '') +
          '</span><span class="sub">' + esc(describe(s)) + '</span></button>';
      });
      html += '</div>';
      el.innerHTML = html;

      el.querySelectorAll('button.seed').forEach(function (b) {
        b.onclick = function () {
          var want = Number(b.dataset.seed);
          var entry = apply(H, termKey, want, pack);
          el.querySelectorAll('button.seed').forEach(function (o) {
            o.setAttribute('aria-pressed', String(Number(o.dataset.seed) === want));
          });
          if (onPick) onPick(want, entry, pack);
        };
      });
      return pack;
    });
  }

  window.TTSeeds = {
    FILES: FILES, load: load, apply: apply, assignment: assignment,
    describe: describe, mount: mount,
  };
})();
