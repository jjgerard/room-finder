// GENERATED — copied from tools/term-snapshot.js by `node timetable/export.js`.
// Edit the original, not this copy.
/* Ulster term snapshot — paste into the console of a Resource Booker tab you
 * are already signed in to, then call  snapshotTerm({...}).
 *
 * What it is for: the two "as it stands" timetables on this site come from a
 * snapshot in timetable/data/terms.json. When the timetabling team moves a
 * class, the site does not know. This pulls the current bookings straight from
 * the app's own API so timetable/refresh.js can rebuild that snapshot.
 *
 * Why it runs here rather than on the site: the API takes a bearer token
 * issued through Microsoft SSO inside this app. A page on github.io has no way
 * to obtain one, and an embedded token would be a credential leak that expired
 * within minutes anyway. So the refresh runs where a person is already signed
 * in, and the result is a file.
 *
 * It reuses the headers the app itself sends. It never sees, reads, logs or
 * transmits a password or the token's value, and every request it makes is one
 * the app's own front end could make, from the same origin. Read-only: it
 * lists resources and reads busy times, and never submits a booking.
 *
 *   snapshotTerm({
 *     term: 'autumn',
 *     from: '2026-09-21', to: '2026-12-18',   // first Monday to last Friday
 *     weekOneMonday: '2026-09-21',
 *   })
 *
 * It downloads snapshot-<term>.json. Then, in the repo:
 *   node timetable/refresh.js --in ~/Downloads/snapshot-autumn.json
 */
(function () {
  'use strict';

  var API_FALLBACK = 'https://scientia-eu-v4-api-d6-01.azurewebsites.net/api/';

  // Records that look like rooms but are not bookable teaching space. The
  // "BT Room …" entries matter most: they mirror real Belfast rooms and carry
  // no events at all, so a term built from them would look gloriously empty.
  var JUNK = /^(DNU_|z_|BT[ _]?Room|Online -|QR Code Check-in)|virtual room|\btest\b/i;

  // ------------------------------------------------------ auth-header capture

  // We keep a reference to the header bag the app fills in, and replay it. The
  // token's value is never read out of it.
  var auth = { headers: null, apiBase: null };

  function noteBase(url) {
    var m = String(url || '').match(/^(https:\/\/[^/]*scientia[^/]*\/api\/)/i);
    if (m) auth.apiBase = m[1];
  }

  if (!window.__snapPatched) {
    window.__snapPatched = true;
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__snapUrl = url;
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      this.__snapH = this.__snapH || {};
      this.__snapH[k] = v;
      if (/authorization/i.test(k)) { auth.headers = this.__snapH; noteBase(this.__snapUrl); }
      return xhrSet.apply(this, arguments);
    };
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var h = (init && init.headers) || (input && input.headers);
        if (h) {
          var bag = {};
          if (typeof h.forEach === 'function') h.forEach(function (v, k) { bag[k] = v; });
          else Object.keys(h).forEach(function (k) { bag[k] = h[k]; });
          if (Object.keys(bag).some(function (k) { return /authorization/i.test(k); })) {
            auth.headers = bag;
            noteBase(typeof input === 'string' ? input : (input && input.url));
          }
        }
      } catch (e) { /* never break the app's own traffic */ }
      return nativeFetch.apply(this, arguments);
    };
  }

  /** Whether the app has been seen making a request this can replay. */
  function ready() { return !!auth.headers; }

  function headerCopy() {
    var out = {};
    Object.keys(auth.headers || {}).forEach(function (k) {
      if (!/^content-type$/i.test(k)) out[k] = auth.headers[k];
    });
    return out;
  }

  // ------------------------------------------------------------------ calling

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function call(path, body) {
    var base = auth.apiBase || API_FALLBACK;
    var opts = { headers: headerCopy() };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(base + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
      });
    });
  }

  // The token expires after a few minutes of bulk fetching. Recovering means
  // getting the app to make a request of its own; there is no way to renew it
  // from here, and no reason to want one.
  function nudge() {
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.type === 'hidden' || el.disabled) continue;
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      var was = el.value;
      setter.call(el, was ? was.slice(0, -1) : 'a');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, was);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return sleep(2500);
    }
    return sleep(2500);
  }

  function callRetry(path, body, tries) {
    tries = tries == null ? 3 : tries;
    return call(path, body).then(function (r) {
      if (r.status !== 401 || tries <= 0) return r;
      console.log('  session expired, asking the app to refresh it…');
      return nudge().then(function () { return callRetry(path, body, tries - 1); });
    });
  }

  function pool(items, limit, fn, onProgress) {
    var out = new Array(items.length), i = 0, done = 0;
    function next() {
      if (i >= items.length) return Promise.resolve();
      var k = i++;
      return Promise.resolve(fn(items[k], k)).then(function (v) {
        out[k] = v;
        if (onProgress) onProgress(++done, items.length);
        return next();
      });
    }
    var runners = [];
    for (var n = 0; n < Math.min(limit, items.length); n++) runners.push(next());
    return Promise.all(runners).then(function () { return out; });
  }

  // ------------------------------------------------------------------- time
  //
  // StartDateTime comes back as true UTC even though it is serialised with a
  // +00:00 offset, so during BST it is an hour behind what the UI shows. A term
  // running September to December crosses the clock change, which means naive
  // wall-clock arithmetic corrupts half the rows and looks fine in the other
  // half. Everything below goes through Europe/London.
  var LONDON = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  function toLondon(iso) {
    var p = {};
    LONDON.formatToParts(new Date(iso)).forEach(function (x) {
      if (x.type !== 'literal') p[x.type] = x.value;
    });
    var hour = p.hour === '24' ? '00' : p.hour;
    return { date: p.year + '-' + p.month + '-' + p.day, mins: +hour * 60 + +p.minute };
  }

  function dayIndex(isoDate) {
    // getUTCDay on a date-only string: Sunday 0 … Saturday 6, wanted Monday 0.
    return (new Date(isoDate + 'T00:00:00Z').getUTCDay() + 6) % 7;
  }

  function weekOf(isoDate, weekOneMonday) {
    var a = Date.UTC.apply(null, isoDate.split('-').map(Number).map(function (v, i) {
      return i === 1 ? v - 1 : v;
    }));
    var b = Date.UTC.apply(null, weekOneMonday.split('-').map(Number).map(function (v, i) {
      return i === 1 ? v - 1 : v;
    }));
    return Math.floor((a - b) / 604800000) + 1;
  }

  /** [1,2,3,5,6,12] -> "1–3,5–6,12", the form terms.json already uses. */
  function weeksText(list) {
    var ws = list.slice().sort(function (x, y) { return x - y; });
    var out = [], i = 0;
    while (i < ws.length) {
      var a = ws[i], b = a;
      while (i + 1 < ws.length && ws[i + 1] === b + 1) { b = ws[++i]; }
      out.push(a === b ? String(a) : a + '–' + b);
      i++;
    }
    // ", " — the separator terms.json already uses. A bare comma made 89
    // untouched bookings read as moved when the two were compared.
    return out.join(', ');
  }

  // ------------------------------------------------------------------ naming
  //
  // An event name is the timetable code: CMM125_S1/LEC/01, BMG715/S2/LEC/SEM/HLA*.
  // The module is the leading code; the activity is the first segment that is
  // one of the codes the data uses.
  // Worked out from the 5,637 bookings already in the data: the activity is
  // the first title segment that starts with one of these, and the longest
  // form has to be tried first or PRAC is eaten by PRA. Matching whole
  // segments against a flat list got a third of them wrong — SEM2+ and PRAC
  // both fell through to OTH.
  var CODES = [
    ['LECTURE', 'LEC'], ['LEC', 'LEC'],
    ['SEMINAR', 'SEM'], ['SEM', 'SEM'],
    ['TUTORIAL', 'TUT'], ['TUT', 'TUT'],
    ['LABS', 'LAB'], ['LAB', 'LAB'],
    ['PRACTICAL', 'PRA'], ['PRAC', 'PRA'], ['PRA', 'PRA'],
    ['WORKSHOP', 'WOR'], ['WORK', 'WOR'], ['WOR', 'WOR'],
    ['COMPUTING', 'COM'], ['COMP', 'COM'],
    ['CLASS TEST', 'EXM'], ['EXAM', 'EXM'], ['EXM', 'EXM'],
    ['STUDIO', 'OTH'], ['OTH', 'OTH'],
  ];
  // An exam is usually named rather than coded, and the estates bookings that
  // hold a room for an exam week are named only.
  var EXAMISH = /\bexam|\bclass test|\bassessment\b|\bresit\b|\bmoot\b/i;

  function parseName(name) {
    var s = String(name || '');
    var module = (s.match(/^([A-Z]{2,4}\d{3,4})/) || [])[1] || '';
    var activity = '';
    var segs = s.split('/');
    for (var i = 0; i < segs.length && !activity; i++) {
      var seg = segs[i].trim();
      // The first segment is the module code, not an activity.
      if (i === 0 && /^[A-Z]{2,4}\d{3,4}/i.test(seg)) continue;
      var up = seg.toUpperCase();
      for (var j = 0; j < CODES.length; j++) {
        if (up.indexOf(CODES[j][0]) === 0) { activity = CODES[j][1]; break; }
      }
    }
    // Only when no segment carries a code: a lecture whose title mentions a
    // class test is still a lecture.
    if (!activity && EXAMISH.test(s)) activity = 'EXM';
    return { module: module, activity: activity || 'OTH', title: s };
  }

  // ------------------------------------------------------------------- main

  function snapshotTerm(opts) {
    opts = opts || {};
    var missing = ['term', 'from', 'to', 'weekOneMonday'].filter(function (k) {
      return !opts[k];
    });
    if (missing.length) {
      return Promise.reject(new Error('snapshotTerm needs ' + missing.join(', ')));
    }
    var btid = (location.pathname.match(/booking-types\/([0-9a-f-]{36})/i) || [])[1];
    if (!btid) return Promise.reject(new Error('Open a booking-type page first (.../app/booking-types/<id>).'));

    // Pasted into a console, this runs long after the app has made the
    // requests it makes on load, so there is nothing to have captured yet.
    // Telling the person to "do something in the page first" put the burden in
    // the wrong place, and was the usual reason a run went nowhere. Provoke a
    // request instead, and give up only when the app will not make one.
    var wait = Promise.resolve();
    if (!ready()) {
      console.log('Waiting for the app to make a request this can replay\u2026');
      wait = nudge()
        .then(function () { return ready() ? null : nudge(); })
        .then(function () {
          if (!ready()) {
            throw new Error('The app has not sent a request this script can replay. Click ' +
              'something in the page \u2014 the room search box, or the calendar\u2019s next ' +
              'arrow \u2014 and run it again.');
          }
        });
    }

    return wait.then(function () {
    console.log('Listing Belfast rooms\u2026');
    return callRetry('BookingTypes/' + btid + '/BookableResourceGroupsAndResources', {
      Query: 'B_', ItemsPerPage: 800, Properties: [], ResourceGroupIdentities: [], LoadedIdentities: [],
    }).then(function (r) {
      if (r.status !== 200 || !r.data) throw new Error('Could not list rooms (HTTP ' + r.status + ').');
      var rooms = (r.data.Resources || []).filter(function (x) { return !JUNK.test(x.Name || ''); });
      console.log(rooms.length + ' rooms, reading ' + opts.from + ' to ' + opts.to + '…');

      var from = opts.from, to = opts.to;
      return pool(rooms, 4, function (room) {
        var qs = '?StartDate=' + encodeURIComponent(from + 'T00:00:00.000Z') +
                 '&EndDate=' + encodeURIComponent(to + 'T23:59:59.999Z') +
                 '&ExcludeExamEvents=false';
        return callRetry('BookingTypes/' + btid + '/Resources/' + room.Identity + '/BusyTimes' + qs)
          .then(function (b) {
            return { room: room, items: Array.isArray(b.data) ? b.data : [] };
          });
      }, function (done, total) {
        if (done % 25 === 0 || done === total) console.log('  ' + done + '/' + total);
      }).then(function (all) {
        // One row per booking of one class in one room at one weekly slot; the
        // dates it happens on become the week list. This is the shape
        // terms.json uses, so refresh.js only has to map room names to ids.
        var by = {};
        var events = 0, outside = 0;
        all.forEach(function (rec) {
          rec.items.forEach(function (it) {
            if (!it.StartDateTime) return;
            events++;
            var t = toLondon(it.StartDateTime);
            if (t.date < from || t.date > to) { outside++; return; }
            var w = weekOf(t.date, opts.weekOneMonday);
            var n = parseName(it.Name);
            var key = [it.Name, rec.room.Name, dayIndex(t.date), t.mins, it.Duration].join('|');
            if (!by[key]) {
              by[key] = { module: n.module, activity: n.activity, title: n.title,
                          room: rec.room.Name, day: dayIndex(t.date), start: t.mins,
                          dur: it.Duration, weeks: {} };
            }
            by[key].weeks[w] = true;
          });
        });
        var rows = Object.keys(by).map(function (k) {
          var r = by[k];
          var ws = Object.keys(r.weeks).map(Number);
          return [r.module, r.activity, r.title, r.day, r.start, r.dur, r.room,
                  ws.length, weeksText(ws)];
        });
        var out = {
          term: opts.term, from: from, to: to, weekOneMonday: opts.weekOneMonday,
          takenAt: new Date().toISOString(),
          rooms: all.map(function (rec) { return rec.room.Name; }),
          rows: rows,
        };
        console.log(rows.length + ' bookings from ' + events + ' events (' + outside +
                    ' outside the range, dropped).');
        // The automated runner takes the value back through the driver and
        // writes the file itself, so it asks for no download.
        if (opts.download !== false) {
          var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'snapshot-' + opts.term + '.json';
          a.click();
        }
        return out;
      });
    });
    });
  }

  window.snapshotTerm = snapshotTerm;
  window.snapshotReady = ready;
  console.log('snapshotTerm ready \u2014 call it with the term and its dates; see the comment',
              'at the top of this file.');
})();
