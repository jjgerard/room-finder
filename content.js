/* Ulster Room Finder — runs inside a Resource Booker tab you are already signed in to.
 *
 * It reuses the headers the booking app itself sends, so it never sees, stores, or
 * transmits a password, and never reads the bearer token's value. Every request it
 * makes is one the app's own front end could make, against the same API, from the
 * same origin.
 *
 * Read-only: it lists resources and reads busy times. It never submits a booking.
 */
(function () {
  'use strict';
  if (window.__urfLoaded) return;
  window.__urfLoaded = true;

  // ---------------------------------------------------------------- constants

  // The Capacity property on the resource list endpoint. Confirmed for Ulster;
  // a different Scientia tenant may use a different GUID. To re-derive it: set the
  // capacity "Minimum" field in the app's own UI and read the request it sends.
  var CAPACITY_PROPERTY = '71bd4589-a1ca-49fa-b902-f2a6bf013769';

  // Fallback only — the API base is normally learned from the app's own traffic.
  var API_FALLBACK = 'https://scientia-eu-v4-api-d6-01.azurewebsites.net/api/';

  // Records that look like rooms but are not bookable teaching space. "BT Room …"
  // entries are the dangerous ones: they mirror real Belfast rooms but carry zero
  // events, so they look gloriously free.
  var JUNK = /^(DNU_|z_|BT[ _]?Room|Online -|QR Code Check-in)|virtual room|\btest\b/i;

  // Labs, studios and specialist space. Applied only when "ordinary teaching rooms
  // only" is ticked, and every room it removes is listed back to you.
  var SPECIALIST = /lab\b|labs|studio|workshop|comp\b|computing|CEBE|MARCS|CNC|ceramic|print|knit|weave|dye|fashion|embroider|animation|photograph|illustration|graphic|foundation|media|game|interaction|hub|bloomberg|clinic|comms|academy|virtual|beacon|engineering|arc |urban planning|practical|hydraulic|soils|polymer|metal|sculpt|paint|silversmith|life model|nursing|health|kitchen|reception|_SS|\(SS\)|physiolog|linguistic|authorised/i;

  var CAMPUS = { B_: 'Belfast', C_: 'Coleraine', M_: 'Derry/Londonderry' };

  // ------------------------------------------------------- auth-header capture

  // The app attaches an Authorization header to its own XHRs. We keep a reference to
  // the header bag so we can replay it. We never read, log or display its value.
  var auth = { headers: null, version: 0, apiBase: null };

  function noteApiBase(url) {
    try {
      var abs = new URL(url, location.href).href;
      var cut = abs.indexOf('/api/');
      if (cut === -1) return null;
      return abs.slice(0, cut + 5);
    } catch (e) { return null; }
  }

  function adopt(url, bag) {
    var base = noteApiBase(url);
    if (!base) return;
    auth.apiBase = base;
    auth.headers = bag;
    auth.version++;
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSet = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__urfUrl = url;
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this.__urfBag) this.__urfBag = {};
    this.__urfBag[name] = value;
    if (/^authorization$/i.test(name) && this.__urfUrl) adopt(this.__urfUrl, this.__urfBag);
    return xhrSet.apply(this, arguments);
  };

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url);
      var h = (init && init.headers) || (input && input.headers);
      if (url && h && !url.__urfSelf) {
        var bag = {};
        if (typeof h.forEach === 'function' && !Array.isArray(h)) {
          h.forEach(function (v, k) { bag[k] = v; });
        } else {
          Object.keys(h).forEach(function (k) { bag[k] = h[k]; });
        }
        if (Object.keys(bag).some(function (k) { return /^authorization$/i.test(k); })) adopt(url, bag);
      }
    } catch (e) { /* never break the host app */ }
    return nativeFetch.apply(this, arguments);
  };

  // ------------------------------------------------------------- API plumbing

  var run = { cancelled: false, status: function () {} };

  function bookingTypeId() {
    var m = location.pathname.match(/booking-types\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  }

  function headerCopy() {
    var out = {};
    var src = auth.headers || {};
    Object.keys(src).forEach(function (k) {
      if (/^content-type$/i.test(k)) return;   // set per-request
      if (/^content-length$/i.test(k)) return; // forbidden header, browser sets it
      out[k] = src[k];
    });
    return out;
  }

  function call(path, body) {
    var h = headerCopy();
    var opts = { headers: h };
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      opts.method = 'POST';
      opts.body = JSON.stringify(body);
    }
    return nativeFetch((auth.apiBase || API_FALLBACK) + path, opts).then(function (r) {
      if (r.status === 401) return { status: 401, data: null };
      return r.text().then(function (t) {
        var data = null;
        try { data = JSON.parse(t); } catch (e) {}
        return { status: r.status, data: data };
      });
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(test, ms) {
    var until = Date.now() + ms;
    return (function loop() {
      if (test()) return Promise.resolve(true);
      if (Date.now() > until) return Promise.resolve(false);
      return sleep(150).then(loop);
    })();
  }

  function setNative(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Tokens expire after a few minutes of bulk fetching. We cannot mint one — but the
  // app can, and will, the moment it makes a request of its own. So we nudge its UI
  // and wait for a fresh Authorization header to land in our bag.
  var nudgeFlip = 49;
  var POKES = [
    function () {
      var el = document.querySelector('input[type=number]');
      if (!el) return false;
      nudgeFlip = nudgeFlip === 49 ? 50 : 49;
      setNative(el, String(nudgeFlip));
      return true;
    },
    function () {
      var el = document.querySelector('input[type=search]') ||
        document.querySelector('input[type=text]');
      if (!el) return false;
      setNative(el, el.value);
      return true;
    },
    function () {
      var btn = Array.prototype.find.call(
        document.querySelectorAll('button,[role=button]'),
        function (b) { return /next|forward/i.test(b.getAttribute('aria-label') || b.title || ''); }
      );
      if (!btn) return false;
      btn.click();
      setTimeout(function () {
        var back = Array.prototype.find.call(
          document.querySelectorAll('button,[role=button]'),
          function (b) { return /prev|back/i.test(b.getAttribute('aria-label') || b.title || ''); }
        );
        if (back) back.click();
      }, 800);
      return true;
    }
  ];

  function refreshSession() {
    var before = auth.version;
    run.status('Session expired — refreshing…');
    return (function next(i) {
      if (i >= POKES.length) {
        run.status('Session expired. Click something in the booking app (a calendar arrow will do) to refresh it.');
        return waitFor(function () { return auth.version > before; }, 120000);
      }
      try { POKES[i](); } catch (e) {}
      return waitFor(function () { return auth.version > before; }, 4500).then(function (ok) {
        return ok ? true : next(i + 1);
      });
    })(0);
  }

  function callRetry(path, body) {
    return (function attempt(n) {
      if (run.cancelled) return Promise.resolve({ status: 0, data: null });
      return call(path, body).then(function (r) {
        if (r.status !== 401) return r;
        if (n >= 3) return r;
        return refreshSession().then(function () { return attempt(n + 1); });
      });
    })(0);
  }

  function pool(items, limit, fn, onProgress) {
    var i = 0, done = 0;
    var out = new Array(items.length);
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var w = 0; w < n; w++) {
      workers.push((function worker() {
        if (run.cancelled) return Promise.resolve();
        var idx = i++;
        if (idx >= items.length) return Promise.resolve();
        return Promise.resolve(fn(items[idx], idx)).then(function (v) {
          out[idx] = v;
          done++;
          if (onProgress) onProgress(done, items.length);
          return worker();
        });
      })());
    }
    return Promise.all(workers).then(function () { return out; });
  }

  // ---------------------------------------------------------------- date/time

  // StartDateTime comes back as true UTC even though it is serialised with a +00:00
  // offset. During BST that is an hour behind what the UI shows, and a Sept–Dec term
  // crosses the clock change — so every instant goes through Europe/London.
  var LONDON = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });

  function toLondon(date) {
    var p = {};
    LONDON.formatToParts(date).forEach(function (x) { if (x.type !== 'literal') p[x.type] = x.value; });
    var hour = p.hour === '24' ? 0 : +p.hour; // ICU renders midnight as 24 in some builds
    return { date: p.year + '-' + p.month + '-' + p.day, minutes: hour * 60 + (+p.minute) };
  }

  function hhmm(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function parseHHMM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Calendar dates only — noon UTC keeps us clear of both DST edges.
  function datesInRange(from, to, weekdays) {
    var out = [];
    var d = new Date(from + 'T12:00:00Z');
    var end = new Date(to + 'T12:00:00Z');
    var guard = 0;
    while (d <= end && guard++ < 500) {
      if (weekdays.indexOf(d.getUTCDay()) !== -1) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  // A busy item becomes one or two local-time intervals (two only if it runs past
  // midnight, which teaching slots do not, but bookings occasionally do).
  function intervals(item) {
    var start = new Date(item.StartDateTime);
    if (isNaN(start)) return [];
    var end = new Date(start.getTime() + (+item.Duration || 0) * 60000);
    var ls = toLondon(start), le = toLondon(end);
    if (ls.date === le.date) return [{ date: ls.date, from: ls.minutes, to: le.minutes, name: item.Name }];
    return [
      { date: ls.date, from: ls.minutes, to: 1440, name: item.Name },
      { date: le.date, from: 0, to: le.minutes, name: item.Name }
    ];
  }

  function overlaps(iv, from, to) { return iv.from < to && iv.to > from; }


  // ------------------------------------------------------------------ search

  function listResources(btid, query, minCapacity) {
    var properties = [];
    if (minCapacity) {
      // Shape copied from the app's own request, trailing empty object included.
      properties = [{ Identity: CAPACITY_PROPERTY, Value: { Min: minCapacity } }, {}];
    }
    return callRetry('BookingTypes/' + btid + '/BookableResourceGroupsAndResources', {
      Query: query || '',
      ItemsPerPage: 800,
      Properties: properties,
      ResourceGroupIdentities: [],
      LoadedIdentities: []
    });
  }

  function busyTimes(btid, id, from, to) {
    // Widened by a day either side, then filtered locally, so nothing is lost to the
    // UTC/local boundary.
    var qs = '?StartDate=' + encodeURIComponent(addDays(from, -1) + 'T00:00:00.000Z') +
      '&EndDate=' + encodeURIComponent(addDays(to, 1) + 'T23:59:59.999Z') +
      '&ExcludeExamEvents=false';
    return callRetry('BookingTypes/' + btid + '/Resources/' + id + '/BusyTimes' + qs);
  }

  function pendingRequests(id, from, to) {
    var qs = '?StartDate=' + encodeURIComponent(addDays(from, -1) + 'T00:00:00.000Z') +
      '&EndDate=' + encodeURIComponent(addDays(to, 1) + 'T23:59:59.999Z') +
      '&CheckSplitPermissions=true';
    return callRetry('Resources/' + id + '/BookingRequests' + qs);
  }

  function capacityOf(btid, id) {
    return callRetry('BookingTypes/' + btid + '/Resources/' + id).then(function (r) {
      var props = (r.data && r.data.Properties) || [];
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (p.Identity === CAPACITY_PROPERTY || /^capacity$/i.test(p.Name || '')) {
          var v = p.Value;
          if (v && typeof v === 'object') v = v.Value !== undefined ? v.Value : v.Min;
          if (v !== undefined && v !== null && v !== '') return +v;
        }
      }
      return null;
    }).catch(function () { return null; });
  }

  function poolFor(btid, opts) {
    return listResources(btid, opts.query, opts.minCapacity).then(function (r) {
      if (r.status !== 200 || !r.data) throw new Error('Could not list rooms (HTTP ' + r.status + ').');
      var all = r.data.Resources || [];
      var dropped = { junk: [], specialist: [], building: [] };
      var rooms = all.filter(function (x) {
        var name = x.Name || '';
        if (JUNK.test(name)) { dropped.junk.push(name); return false; }
        if (opts.buildings.length) {
          var ok = opts.buildings.some(function (b) {
            var u = name.toUpperCase(), c = b.toUpperCase();
            return u.indexOf('_' + c) !== -1 || u.indexOf(c + '-') !== -1;
          });
          if (!ok) { dropped.building.push(name); return false; }
        }
        if (opts.ordinaryOnly && SPECIALIST.test(name)) { dropped.specialist.push(name); return false; }
        return true;
      });
      if (!rooms.length) throw new Error('No rooms left after filtering (' + all.length + ' returned by the API).');
      return { rooms: rooms, dropped: dropped, returned: all.length };
    });
  }

  // Keeps every busy interval that lands on a date we care about, so alternatives can
  // be recomputed (a shifted slot, a looser clash budget) without fetching again.
  function collect(room, items, extra, keep) {
    var byDate = {};
    items.concat(extra).forEach(function (it) {
      intervals(it).forEach(function (iv) {
        if (!keep[iv.date]) return;
        (byDate[iv.date] = byDate[iv.date] || []).push(iv);
      });
    });
    return { name: room.Name, identity: room.Identity, totalEvents: items.length, byDate: byDate, capacity: null };
  }

  function fetchBusy(btid, rooms, opts, keep) {
    return pool(rooms, 4, function (room) {
      return busyTimes(btid, room.Identity, opts.from, opts.to).then(function (b) {
        var items = Array.isArray(b.data) ? b.data : [];
        if (!opts.includePending) return collect(room, items, [], keep);
        return pendingRequests(room.Identity, opts.from, opts.to).then(function (p) {
          var raw = Array.isArray(p.data) ? p.data : (p.data && p.data.BookingRequests) || [];
          var extra = [];
          raw.forEach(function (x) {
            if (x && x.StartDateTime) extra.push({ StartDateTime: x.StartDateTime, Duration: x.Duration, Name: '(pending request)' });
          });
          return collect(room, items, extra, keep);
        }).catch(function () { return collect(room, items, [], keep); });
      });
    }, function (done, total) {
      run.status('Reading rooms… ' + done + '/' + total);
    });
  }

  function keySet(list) {
    var o = {};
    list.forEach(function (d) { o[d] = true; });
    return o;
  }

  function search(opts) {
    var btid = bookingTypeId();
    if (!btid) return Promise.reject(new Error('No booking type in the URL. Open a /app/booking-types/<id> page first.'));
    if (!auth.headers) return Promise.reject(new Error('No API session captured yet. Click something in the booking app — a calendar arrow, or the search box — then try again.'));

    var dates = datesInRange(opts.from, opts.to, opts.weekdays);
    if (!dates.length) return Promise.reject(new Error('That date range contains none of the selected weekdays.'));

    run.status('Listing rooms…');
    return poolFor(btid, opts).then(function (p) {
      run.status('Reading ' + p.rooms.length + ' rooms across ' + dates.length + ' dates…');
      return fetchBusy(btid, p.rooms, opts, keySet(dates)).then(function (results) {
        var found = results.filter(Boolean);
        // A room with no events at all across the whole term is a shell record, not an
        // opportunity — the real timetable lives on another resource.
        var shells = found.filter(function (x) { return x.totalEvents === 0; });
        var real = found.filter(function (x) { return x.totalEvents > 0; });

        real.forEach(function (r) { r.clashes = URF.analyse.clashesAt(r, dates, opts.slotFrom, opts.slotTo); });
        real.sort(function (a, b) {
          if (a.clashes.length !== b.clashes.length) return a.clashes.length - b.clashes.length;
          return a.name.localeCompare(b.name);
        });

        var report = real.filter(function (x) { return x.clashes.length <= opts.maxClashes; }).slice(0, 40);
        run.status('Fetching capacities…');
        return pool(report, 4, function (x) {
          return capacityOf(btid, x.identity).then(function (c) { x.capacity = c; return x; });
        }).then(function () {
          return {
            mode: 'availability', dates: dates, rooms: real, report: report, shells: shells,
            dropped: p.dropped, scanned: p.rooms.length, returned: p.returned,
            campusName: opts.campusName || 'this campus'
          };
        });
      });
    });
  }

  function searchModule(opts) {
    var btid = bookingTypeId();
    if (!btid) return Promise.reject(new Error('No booking type in the URL. Open a /app/booking-types/<id> page first.'));
    if (!auth.headers) return Promise.reject(new Error('No API session captured yet. Click something in the booking app first, then try again.'));

    var allDates = datesInRange(opts.from, opts.to, [0, 1, 2, 3, 4, 5, 6]);
    var code = opts.module.toUpperCase();

    run.status('Listing rooms…');
    return poolFor(btid, { query: opts.query, minCapacity: 0, buildings: opts.buildings, ordinaryOnly: false })
      .then(function (p) {
        run.status('Searching ' + p.rooms.length + ' rooms for ' + code + '…');
        return fetchBusy(btid, p.rooms, opts, keySet(allDates)).then(function (results) {
          var found = results.filter(Boolean);
          var byId = {}, events = [];
          found.forEach(function (r) {
            byId[r.identity] = r;
            Object.keys(r.byDate).forEach(function (d) {
              r.byDate[d].forEach(function (iv) {
                if ((iv.name || '').toUpperCase().indexOf(code) !== -1) {
                  events.push({ date: d, from: iv.from, to: iv.to, name: iv.name, roomId: r.identity, roomName: r.name });
                }
              });
            });
          });
          var patterns = URF.analyse.modulePattern(events, byId, allDates);
          return { mode: 'module', module: code, patterns: patterns, events: events, scanned: p.rooms.length, allDates: allDates };
        });
      });
  }

  // ---------------------------------------------------------------------- UI

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.panel{position:fixed;top:16px;right:16px;width:470px;max-height:calc(100vh - 32px);',
    'display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #c8ccd4;',
    'border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.22);z-index:2147483647;font-size:13px}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e6e8ec;',
    'background:#f6f7f9;border-radius:10px 10px 0 0}',
    '.head h1{margin:0;font-size:13px;font-weight:600;flex:1}',
    '.head button{border:0;background:transparent;font-size:16px;cursor:pointer;color:#666;padding:2px 6px}',
    '.body{padding:12px;overflow:auto}',
    'textarea{width:100%;min-height:58px;padding:7px 9px;border:1px solid #c8ccd4;border-radius:6px;',
    'font-size:13px;resize:vertical;background:#fff;color:#111;line-height:1.45}',
    '.row{display:flex;gap:8px;margin-bottom:8px;align-items:center}',
    '.row label{width:104px;flex:none;color:#444}',
    'input[type=text],input[type=number],input[type=date]{flex:1;min-width:0;padding:5px 7px;',
    'border:1px solid #c8ccd4;border-radius:5px;font-size:13px;background:#fff;color:#111}',
    '.days{display:flex;gap:3px;flex:1}',
    '.days button{flex:1;padding:5px 0;border:1px solid #c8ccd4;background:#fff;border-radius:5px;',
    'cursor:pointer;font-size:12px;color:#444}',
    '.days button.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}',
    '.check{display:flex;align-items:center;gap:6px;margin-bottom:6px;color:#444}',
    '.go{width:100%;padding:8px;border:0;border-radius:6px;background:#1d4ed8;color:#fff;',
    'font-size:13px;font-weight:600;cursor:pointer;margin-top:8px}',
    '.go[disabled]{background:#94a3b8;cursor:default}',
    'details{margin-top:10px}',
    'summary{cursor:pointer;color:#667;font-size:12px;padding:3px 0}',
    '.status{margin-top:10px;padding:7px 9px;background:#f1f5f9;border-radius:5px;color:#334155;font-size:12px}',
    '.status.err{background:#fee2e2;color:#991b1b}',
    '.read{margin-top:10px;padding:8px 10px;background:#eff6ff;border-left:3px solid #1d4ed8;',
    'border-radius:0 5px 5px 0;font-size:12px;color:#1e3a5f;line-height:1.55}',
    '.read b{display:block;margin-bottom:2px}',
    '.read .warn{color:#92400e;margin-top:4px}',
    '.summary{margin-top:12px;font-size:13px;line-height:1.6;color:#1f2430}',
    '.summary p{margin:0 0 7px}',
    '.summary p:first-child{font-weight:600}',
    '.alts{margin-top:12px;border-top:1px solid #e6e8ec;padding-top:9px}',
    '.alts h2{margin:0 0 6px;font-size:11px;text-transform:uppercase;color:#667;font-weight:600}',
    '.alt{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;font-size:12px;line-height:1.5}',
    '.alt span{flex:1;color:#333}',
    '.alt button{flex:none;padding:3px 9px;border:1px solid #1d4ed8;background:#fff;color:#1d4ed8;',
    'border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap}',
    'table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}',
    'th,td{text-align:left;padding:5px 4px;border-bottom:1px solid #eceef1;vertical-align:top}',
    'th{color:#667;font-weight:600;font-size:11px;text-transform:uppercase}',
    'td a{color:#1d4ed8}',
    '.free td:first-child{font-weight:600}',
    '.note{margin-top:10px;font-size:11px;color:#667;line-height:1.5}',
    '.launch{position:fixed;bottom:18px;right:18px;z-index:2147483647;padding:9px 14px;border:0;',
    'border-radius:20px;background:#1d4ed8;color:#fff;font-size:13px;font-weight:600;cursor:pointer;',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)}',
    '@media (prefers-color-scheme:dark){',
    '.panel{background:#161a20;color:#e6e8ec;border-color:#2c313a}',
    '.head{background:#1d222a;border-color:#2c313a}',
    '.row label,.check,th,summary{color:#98a2b3}',
    'textarea,input[type=text],input[type=number],input[type=date]{background:#0f1319;color:#e6e8ec;border-color:#2c313a}',
    '.days button{background:#0f1319;color:#98a2b3;border-color:#2c313a}',
    '.status{background:#1d222a;color:#c3c9d4}',
    '.status.err{background:#3b1215;color:#fca5a5}',
    '.read{background:#13233d;color:#cbd9ee}',
    '.read .warn{color:#fcd34d}',
    '.summary{color:#e6e8ec}',
    '.alt span{color:#c3c9d4}',
    '.alt button{background:#0f1319;border-color:#3b82f6;color:#93c5fd}',
    '.alts{border-color:#2c313a}',
    'th,td{border-color:#2c313a}',
    '.note{color:#7d8797}}'
  ].join('');

  var DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var EXAMPLE = 'rooms seating 45+ in BC or BD free 12:15–13:15 every Monday from 28 Sep to 7 Dec';

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function build() {
    var host = el('div', { id: 'ulster-room-finder-host' });
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', { text: CSS }));

    var launcher = el('button', { class: 'launch', text: 'Find rooms' });
    var panel = el('div', { class: 'panel' });
    panel.style.display = 'none';
    root.appendChild(launcher);
    root.appendChild(panel);

    var today = new Date().toISOString().slice(0, 10);
    var selected = [1];

    var fPrompt = el('textarea', { placeholder: 'e.g. ' + EXAMPLE });
    var fQuery = el('input', { type: 'text', value: 'B_' });
    var fBuildings = el('input', { type: 'text', placeholder: 'e.g. BC, BD — blank for all' });
    var fCapacity = el('input', { type: 'number', min: '0', placeholder: 'e.g. 45' });
    var fFrom = el('input', { type: 'date', value: today });
    var fTo = el('input', { type: 'date', value: addDays(today, 70) });
    var fSlotFrom = el('input', { type: 'text', value: '12:15' });
    var fSlotTo = el('input', { type: 'text', value: '13:15' });
    var fMiss = el('input', { type: 'number', min: '0', value: '2' });
    var fModule = el('input', { type: 'text', placeholder: 'blank unless looking one up' });
    var fOrdinary = el('input', { type: 'checkbox' });
    fOrdinary.checked = true;
    var fPending = el('input', { type: 'checkbox' });
    fPending.checked = true;

    var dayButtons = [];
    var dayBox = el('div', { class: 'days' });
    DAY_NAMES.forEach(function (n, i) {
      var b = el('button', { text: n });
      if (selected.indexOf(i) !== -1) b.className = 'on';
      b.addEventListener('click', function () {
        var at = selected.indexOf(i);
        if (at === -1) { selected.push(i); b.className = 'on'; }
        else { selected.splice(at, 1); b.className = ''; }
      });
      dayButtons.push(b);
      dayBox.appendChild(b);
    });
    function setDays(days) {
      selected = days.slice();
      dayButtons.forEach(function (b, i) { b.className = days.indexOf(i) !== -1 ? 'on' : ''; });
    }

    function row(label, node) { return el('div', { class: 'row' }, [el('label', { text: label }), node]); }
    function pairRow(label, a, b) {
      return el('div', { class: 'row' }, [el('label', { text: label }), a, el('span', { text: 'to' }), b]);
    }

    var form = el('div', {}, [
      row('Campus prefix', fQuery),
      row('Buildings', fBuildings),
      row('Min capacity', fCapacity),
      pairRow('Dates', fFrom, fTo),
      row('Weekdays', dayBox),
      pairRow('Time', fSlotFrom, fSlotTo),
      row('Max clashes', fMiss),
      row('Module code', fModule),
      el('div', { class: 'check' }, [fOrdinary, el('span', { text: 'Ordinary teaching rooms only (exclude labs/studios)' })]),
      el('div', { class: 'check' }, [fPending, el('span', { text: 'Count pending booking requests as busy' })])
    ]);
    var refine = el('details');
    refine.appendChild(el('summary', { text: 'Refine by hand' }));
    refine.appendChild(form);

    var go = el('button', { class: 'go', text: 'Search' });
    var readBack = el('div');
    var status = el('div', { class: 'status', text: 'Ask in your own words, or open "Refine by hand".' });
    var out = el('div');

    var body = el('div', { class: 'body' }, [fPrompt, go, readBack, refine, status, out]);
    var close = el('button', { text: '×', title: 'Close' });
    panel.appendChild(el('div', { class: 'head' }, [el('h1', { text: 'Ulster Room Finder' }), close]));
    panel.appendChild(body);

    close.addEventListener('click', function () { panel.style.display = 'none'; launcher.style.display = ''; });
    launcher.addEventListener('click', function () { panel.style.display = ''; launcher.style.display = 'none'; });

    run.status = function (msg) { status.className = 'status'; status.textContent = msg; };
    function fail(msg) { status.className = 'status err'; status.textContent = msg; }

    function toForm(q) {
      fQuery.value = q.query;
      fBuildings.value = q.buildings.join(', ');
      fCapacity.value = q.minCapacity || '';
      fFrom.value = q.from;
      fTo.value = q.to;
      setDays(q.weekdays);
      fSlotFrom.value = hhmm(q.slotFrom);
      fSlotTo.value = hhmm(q.slotTo);
      fMiss.value = q.maxClashes;
      fModule.value = q.module || '';
      fOrdinary.checked = q.ordinaryOnly;
      fPending.checked = q.includePending;
    }

    function fromForm() {
      var a = parseHHMM(fSlotFrom.value), b = parseHHMM(fSlotTo.value);
      if (a === null || b === null || b <= a) throw new Error('Give times as HH:MM, with the end after the start.');
      if (!selected.length) throw new Error('Pick at least one weekday.');
      var campus = { 'B_': 'Belfast', 'C_': 'Coleraine', 'M_': 'Derry/Londonderry' }[fQuery.value.trim().toUpperCase()];
      return {
        mode: fModule.value.trim() ? 'module' : 'availability',
        module: fModule.value.trim().toUpperCase(),
        query: fQuery.value.trim(),
        campusName: campus || 'this campus',
        buildings: fBuildings.value.split(/[,\s]+/).filter(Boolean),
        minCapacity: +fCapacity.value || 0,
        from: fFrom.value, to: fTo.value,
        weekdays: selected.slice(),
        slotFrom: a, slotTo: b,
        maxClashes: Math.max(0, +fMiss.value || 0),
        ordinaryOnly: fOrdinary.checked,
        includePending: fPending.checked
      };
    }

    // The parser is rule-based, so it will sometimes read a question wrongly. Showing
    // its reading back, in words, is what makes that visible instead of silent.
    function showReading(q) {
      readBack.innerHTML = '';
      if (!q) return;
      var box = el('div', { class: 'read' }, [el('b', { text: 'Read as:' })]);
      var bits = q.read.slice();
      if (q.campusAssumed) bits.push('Belfast assumed — no campus named');
      box.appendChild(el('div', { text: bits.join(' · ') }));
      if (q.leftover) {
        box.appendChild(el('div', { class: 'warn', text: 'Ignored: "' + q.leftover + '" — check the fields below if that mattered.' }));
      }
      readBack.appendChild(box);
    }

    var busy = false, lastOpts = null;

    function start(opts) {
      out.innerHTML = '';
      lastOpts = opts;
      busy = true;
      run.cancelled = false;
      go.textContent = 'Stop';
      var job = opts.mode === 'module' ? searchModule(opts) : search(opts);
      job.then(function (res) {
        if (res.mode === 'module') renderModule(out, res, opts, rerun);
        else {
          render(out, res, opts, rerun);
          run.status('Done — ' + res.scanned + ' rooms checked across ' + res.dates.length + ' dates.');
        }
      }).catch(function (e) {
        fail(e && e.message ? e.message : String(e));
      }).then(function () {
        busy = false;
        go.textContent = 'Search';
      });
    }

    function rerun(apply) {
      var opts = Object.assign({}, lastOpts, apply);
      toForm(Object.assign({}, opts, { module: opts.module || '' }));
      start(opts);
    }

    go.addEventListener('click', function () {
      if (busy) { run.cancelled = true; return; }
      try {
        var text = fPrompt.value.trim();
        var opts;
        if (text) {
          var q = URF.parse(text, new Date().toISOString().slice(0, 10));
          if (q.mode === 'module') q.weekdays = [0, 1, 2, 3, 4, 5, 6];
          showReading(q);
          toForm(q);
          opts = fromForm();
          opts.mode = q.mode;
          opts.module = q.module || '';
          opts.campusName = q.campusName;
        } else {
          showReading(null);
          opts = fromForm();
        }
        start(opts);
      } catch (e) {
        fail(e.message);
      }
    });

    fPrompt.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go.click();
    });

    return root;
  }

  // ------------------------------------------------------------------ render

  function roomLink(room, btid, date) {
    var a = el('a', { text: room.name, target: '_blank' });
    a.href = location.origin + '/app/booking-types/' + btid + '/resources/' + room.identity + '?date=' + date;
    return a;
  }

  function renderAlternatives(out, alts, rerun) {
    if (!alts.length) return;
    var box = el('div', { class: 'alts' }, [el('h2', { text: 'What would open it up' })]);
    alts.forEach(function (a) {
      var line = el('div', { class: 'alt' }, [el('span', { text: a.text + (a.needsRefetch ? ' (searches again)' : '') })]);
      if (a.apply) {
        var b = el('button', { text: a.needsRefetch ? 'Search' : 'Use it' });
        b.addEventListener('click', function () { rerun(a.apply); });
        line.appendChild(b);
      }
      box.appendChild(line);
    });
    out.appendChild(box);
  }

  function render(out, res, opts, rerun) {
    out.innerHTML = '';
    var btid = bookingTypeId();
    var alts = URF.analyse.alternatives(res, opts);

    var summary = el('div', { class: 'summary' });
    URF.analyse.summarise(res, opts, alts).forEach(function (line) {
      summary.appendChild(el('p', { text: line }));
    });
    out.appendChild(summary);

    var clean = res.report.filter(function (x) { return x.clashes.length === 0; });
    var near = res.report.filter(function (x) { return x.clashes.length > 0; });

    function table(title, rows) {
      if (!rows.length) return;
      out.appendChild(el('div', { class: 'note', html: '<b>' + title + '</b>' }));
      var t = el('table'), tb = el('tbody');
      t.appendChild(tb);
      tb.appendChild(el('tr', {}, [el('th', { text: 'Room' }), el('th', { text: 'Seats' }), el('th', { text: 'Pattern' })]));
      rows.forEach(function (x) {
        var shape = URF.analyse.clashShape(x.clashes, res.dates);
        var detail = shape.text;
        if (x.clashes.length) {
          detail += ' — ' + x.clashes.map(function (c) {
            return URF.analyse.nice(c.date) + ': ' + c.what + ' ' + c.when;
          }).join('; ');
          var runInfo = URF.analyse.longestFreeRun(x.clashes, res.dates);
          if (runInfo && runInfo.length > 1) detail += '. Longest clear stretch: ' + runInfo.text;
        }
        var tr = el('tr', { class: x.clashes.length ? '' : 'free' });
        tr.appendChild(el('td', {}, [roomLink(x, btid, res.dates[0])]));
        tr.appendChild(el('td', { text: x.capacity == null ? '?' : String(x.capacity) }));
        tr.appendChild(el('td', { text: detail }));
        tb.appendChild(tr);
      });
      out.appendChild(t);
    }

    table('Free on every date', clean);
    table('Near misses', near);
    renderAlternatives(out, alts, rerun);

    var notes = el('div', { class: 'note' }, [el('div', {
      text: 'Times are Europe/London. Spot-check two rooms in the app before relying on this — ' +
        'one date in BST and one after the October clock change.'
    })]);
    function disclosure(label, names) {
      if (!names.length) return;
      var d = el('details');
      d.appendChild(el('summary', { text: label + ' (' + names.length + ')' }));
      d.appendChild(el('div', { text: names.slice(0, 80).join(', ') }));
      notes.appendChild(d);
    }
    disclosure('Excluded as labs/studios/specialist', res.dropped.specialist);
    disclosure('Excluded as shells, duplicates or out of service', res.dropped.junk);
    disclosure('Skipped: no events at all, so probably shell records', res.shells.map(function (x) { return x.name; }));
    out.appendChild(notes);

    var copy = el('button', { class: 'go', text: 'Copy as text' });
    copy.addEventListener('click', function () {
      var lines = URF.analyse.summarise(res, opts, alts).slice();
      lines.push('');
      clean.forEach(function (x) { lines.push('* ' + x.name + ' (' + (x.capacity == null ? '?' : x.capacity) + ') — free on all ' + res.dates.length); });
      if (near.length) lines.push('', 'Near misses:');
      near.forEach(function (x) {
        lines.push('* ' + x.name + ' (' + (x.capacity == null ? '?' : x.capacity) + ') — ' +
          URF.analyse.clashShape(x.clashes, res.dates).text);
      });
      if (alts.length) {
        lines.push('', 'Alternatives:');
        alts.forEach(function (a) { lines.push('* ' + a.text); });
      }
      navigator.clipboard.writeText(lines.join('\n')).then(function () { copy.textContent = 'Copied'; });
    });
    out.appendChild(copy);
  }

  function renderModule(out, res, opts, rerun) {
    out.innerHTML = '';
    var btid = bookingTypeId();
    var summary = el('div', { class: 'summary' });
    URF.analyse.summariseModule(res.module, res.patterns).forEach(function (line) {
      summary.appendChild(el('p', { text: line }));
    });
    out.appendChild(summary);

    (res.patterns || []).slice(0, 3).forEach(function (p) {
      var t = el('table'), tb = el('tbody');
      t.appendChild(tb);
      tb.appendChild(el('tr', {}, [el('th', { text: 'Date' }), el('th', { text: 'Status' })]));
      var present = {};
      p.occurrences.forEach(function (d) { present[d] = true; });
      p.candidates.forEach(function (d, i) {
        var gap = p.gaps.filter(function (g) { return g.date === d; })[0];
        var status = present[d] ? 'scheduled here'
          : gap && gap.free ? 'NOT scheduled — room is free (pattern gap)'
            : 'NOT scheduled — room taken by ' + (gap ? gap.blockedBy + ' ' + gap.when : '?');
        var tr = el('tr', { class: present[d] ? '' : 'free' });
        var cell = el('td');
        cell.appendChild(el('span', { text: URF.analyse.nice(d) + ' ' }));
        var a = el('a', { text: '(open)', target: '_blank' });
        a.href = location.origin + '/app/booking-types/' + btid + '/resources/' + p.roomId + '?date=' + d;
        cell.appendChild(a);
        tr.appendChild(cell);
        tr.appendChild(el('td', { text: status }));
        tb.appendChild(tr);
      });
      out.appendChild(el('div', { class: 'note', html: '<b>' + p.roomName + '</b>' }));
      out.appendChild(t);
    });

    out.appendChild(el('div', {
      class: 'note',
      text: 'Week numbers are deliberately not shown: these are counted from the dates in ' +
        'range, not from any institutional calendar. Match them to your own numbering. ' +
        res.scanned + ' rooms searched.'
    }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
