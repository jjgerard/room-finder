/* Turns a typed question into a search. Deliberately local: no API key, no network,
 * nothing leaves the browser. It handles the phrasings people actually use for this
 * job and reports, in words, how it read the question — so when it reads it wrongly
 * you can see that immediately and fix it in the form rather than wonder.
 *
 * Everything here is pure. test.js exercises it directly.
 */
(function () {
  'use strict';

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  var DAY_WORDS = [
    ['sun', 0], ['mon', 1], ['tue', 2], ['tues', 2], ['wed', 3], ['thu', 4], ['thur', 4],
    ['thurs', 4], ['fri', 5], ['sat', 6]
  ];
  var DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var CAMPUSES = [
    [/\bbelfast\b/i, 'B_', 'Belfast'],
    [/\bcoleraine\b/i, 'C_', 'Coleraine'],
    [/\b(?:magee|derry|londonderry)\b/i, 'M_', 'Derry/Londonderry']
  ];
  // Two-letter tokens that turn up in these sentences and are not building codes.
  var NOT_A_BUILDING = /^(?:or|an|at|in|of|to|is|it|on|be|by|do|if|no|so|up|we|me|my|am|pm)$/i;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function isoOf(dt) { return iso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); }
  function dayOf(isoStr) { return new Date(isoStr + 'T12:00:00Z'); }
  function shift(isoStr, days) {
    var d = dayOf(isoStr);
    d.setUTCDate(d.getUTCDate() + days);
    return isoOf(d);
  }

  // A bare "28 Sep" means the next 28 September, not one in the past.
  function inferYear(month, day, today) {
    var y = dayOf(today).getUTCFullYear();
    if (iso(y, month, day) < shift(today, -45)) y += 1;
    return y;
  }

  function Work(text) {
    this.s = ' ' + String(text || '') + ' ';
    this.orig = this.s;
  }
  Work.prototype.blank = function (index, length) {
    this.s = this.s.slice(0, index) + new Array(length + 1).join(' ') + this.s.slice(index + length);
  };
  Work.prototype.take = function (re) {
    var m = new RegExp(re.source, re.flags.replace('g', '')).exec(this.s);
    if (!m) return null;
    this.blank(m.index, m[0].length);
    return m;
  };
  Work.prototype.takeAll = function (re, fn) {
    var out = [], m;
    var rx = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
    var found = [];
    while ((m = rx.exec(this.s)) !== null) {
      found.push({ m: m, index: m.index });
      if (m[0].length === 0) rx.lastIndex++;
    }
    found.forEach(function (f) {
      var v = fn(f.m, this.orig.slice(Math.max(0, f.index - 14), f.index));
      if (v !== null && v !== undefined) { out.push({ value: v, index: f.index }); this.blank(f.index, f.m[0].length); }
    }, this);
    return out;
  };
  // Filler that carries no search meaning, so "leftover" only shows words that were
  // genuinely not understood.
  var FILLER = /^(?:which|what|where|any|a|an|the|is|are|was|be|can|could|would|do|does|i|me|my|we|you|please|find|show|get|need|want|looking|look|for|to|in|on|at|of|and|or|with|that|there|room|rooms|space|spaces|free|available|empty|spare|vacant|book|booking|seat|seats|seating|capacity|people|students|every|each|all|week|weeks|slot|time|times|date|dates|day|days|during|between|from|until|till|term|semester|campus|block|blocks|building|buildings|about|got|have|has|will|its|it|so|but|if|as|by|up|out|new|one|some|only|just|also|than|then|other|else|something|anything)$/i;

  Work.prototype.rest = function () {
    return this.s.replace(/[^a-z0-9]+/gi, ' ').trim().split(/\s+/)
      .filter(function (t) { return t && !FILLER.test(t); }).join(' ');
  };

  // ------------------------------------------------------------------- dates

  function findDates(w, today) {
    var hits = [];
    function collect(re, build) {
      w.takeAll(re, function (m, before) {
        var d = build(m);
        if (!d) return null;
        hits.push({ date: d, before: before });
        return d;
      });
    }
    collect(/\b(\d{4})-(\d{2})-(\d{2})\b/g, function (m) {
      return iso(+m[1], +m[2] - 1, +m[3]);
    });
    collect(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MON_RE + ')[a-z]*\\.?(?:\\s+(\\d{4}))?\\b', 'gi'), function (m) {
      var mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
      var y = m[3] ? +m[3] : inferYear(mo, +m[1], today);
      return iso(y, mo, +m[1]);
    });
    collect(new RegExp('\\b(' + MON_RE + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b', 'gi'), function (m) {
      var mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
      var y = m[3] ? +m[3] : inferYear(mo, +m[2], today);
      return iso(y, mo, +m[2]);
    });
    collect(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, function (m) {
      var day = +m[1], mo = +m[2] - 1;                      // day/month, as written here
      if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
      var y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : inferYear(mo, day, today);
      return iso(y, mo, day);
    });
    hits.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return hits;
  }

  function resolveRange(w, today, read) {
    var weeks = w.take(/\b(?:for\s+the\s+)?(?:next|following|coming)\s+(\d{1,2})\s+weeks?\b/i);
    var dates = findDates(w, today);
    var termish = w.take(/\b(?:this|the|rest of (?:the|this))\s+(?:term|semester)\b|\bthis\s+semester\b|\brest of term\b/i);

    if (dates.length >= 2) {
      read.push('from ' + dates[0].date + ' to ' + dates[dates.length - 1].date);
      return { from: dates[0].date, to: dates[dates.length - 1].date };
    }
    if (dates.length === 1) {
      var one = dates[0];
      if (/\b(?:until|till|to|through|up to|before|by)\s*$/i.test(one.before)) {
        read.push('from today until ' + one.date);
        return { from: today, to: one.date };
      }
      var span = weeks ? +weeks[1] * 7 : 84;
      read.push('starting ' + one.date + ', running ' + (weeks ? weeks[1] + ' weeks' : '12 weeks') +
        ' — no end date given, so I assumed one');
      return { from: one.date, to: shift(one.date, span) };
    }
    if (weeks) {
      read.push('the next ' + weeks[1] + ' weeks from today');
      return { from: today, to: shift(today, +weeks[1] * 7) };
    }
    if (termish) {
      read.push('"this term" read as the next 12 weeks from today — set the dates yourself if your term differs');
      return { from: today, to: shift(today, 84) };
    }
    read.push('no dates given, so the next 12 weeks');
    return { from: today, to: shift(today, 84), assumed: true };
  }

  // ------------------------------------------------------------------- times

  function mins(h, m, ampm) {
    h = +h; m = m ? +m : 0;
    if (ampm) {
      var p = ampm.toLowerCase();
      if (p === 'pm' && h < 12) h += 12;
      if (p === 'am' && h === 12) h = 0;
    }
    return h * 60 + m;
  }
  function hhmm(t) { return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }

  var T = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?';

  function resolveSlot(w, read) {
    var range = w.take(new RegExp('\\b' + T + '\\s*(?:-|\u2013|\u2014|to|until|till)\\s*' + T + '\\b', 'i'));
    if (range) {
      var a = mins(range[1], range[2], range[3]);
      var b = mins(range[4], range[5], range[6]);
      // "2-4pm" puts the pm on both ends; a bare "2-4" in a teaching timetable means the
      // afternoon, while a bare "9-11" means the morning; "12-1" crosses midday.
      if (range[6] && !range[3]) {
        var lifted = mins(range[1], range[2], range[6]);
        if (lifted < b) a = lifted;
      }
      if (!range[3] && !range[6]) {
        if (a < 8 * 60 && b < 8 * 60) { a += 12 * 60; b += 12 * 60; }
        else if (b <= a && b + 12 * 60 > a) b += 12 * 60;
      }
      if (b <= a) b = a + 60;
      read.push('between ' + hhmm(a) + ' and ' + hhmm(b));
      return { from: a, to: b };
    }
    var forDur = w.take(new RegExp('\\bat\\s+' + T + '\\s+for\\s+(\\d+)\\s*(hours?|hrs?|minutes?|mins?)\\b', 'i'));
    if (forDur) {
      var start = mins(forDur[1], forDur[2], forDur[3]);
      var n = +forDur[4];
      var len = /^h/i.test(forDur[5]) ? n * 60 : n;
      read.push('from ' + hhmm(start) + ' for ' + n + ' ' + forDur[5]);
      return { from: start, to: start + len };
    }
    var named = w.take(/\b(mornings?|afternoons?|evenings?|lunchtimes?)\b/i);
    if (named) {
      var word = named[1].toLowerCase();
      var band = word.indexOf('morning') === 0 ? { from: 9 * 60, to: 13 * 60 }
        : word.indexOf('afternoon') === 0 ? { from: 13 * 60, to: 17 * 60 }
          : word.indexOf('lunch') === 0 ? { from: 12 * 60, to: 14 * 60 }
            : { from: 17 * 60, to: 21 * 60 };
      read.push(word + ' read as ' + hhmm(band.from) + '\u2013' + hhmm(band.to));
      return band;
    }
    var at = w.take(new RegExp('\\b(?:at|from)\\s+' + T + '\\b', 'i'));
    if (at) {
      var s = mins(at[1], at[2], at[3]);
      read.push('from ' + hhmm(s) + ' for an hour — no end time given');
      return { from: s, to: s + 60 };
    }
    read.push('no time given, so 09:00\u201317:00 — narrow this or everything will look busy');
    return { from: 9 * 60, to: 17 * 60, assumed: true };
  }

  // ---------------------------------------------------------------- weekdays

  function resolveWeekdays(w, read) {
    if (w.take(/\bweek\s?days?\b|\bmon(?:day)?\s*(?:-|\u2013|to)\s*fri(?:day)?\b/i)) {
      read.push('Monday to Friday');
      return [1, 2, 3, 4, 5];
    }
    var found = {};
    DAY_WORDS.forEach(function (pair) {
      var re = new RegExp('\\b' + pair[0] + '(?:[a-z]*)?s?\\b', 'gi');
      if (new RegExp(re.source, 'i').test(w.s)) { w.takeAll(re, function () { return true; }); found[pair[1]] = true; }
    });
    var days = Object.keys(found).map(Number).sort();
    if (days.length) {
      read.push(days.map(function (d) { return DAY_FULL[d] + 's'; }).join(' and '));
      return days;
    }
    read.push('no weekday given, so every weekday');
    return [1, 2, 3, 4, 5];
  }

  // ---------------------------------------------------------- rooms and size

  function resolveCapacity(w, read) {
    var m = w.take(/\b(\d{1,4})\s*\+/) ||
      w.take(/\b(?:at least|minimum(?: of)?|min(?: of)?|no fewer than|over)\s*(\d{1,4})\b/i) ||
      w.take(/\b(?:seat(?:s|ing)?|capacity(?: of)?|holds?|fits?|takes?)\s*(?:of\s*|at least\s*)?(\d{1,4})\b/i) ||
      w.take(/\bfor\s*(\d{1,4})\s*(?:people|students|staff|seats)?\b/i) ||
      w.take(/\b(\d{1,4})\s*(?:people|students|seats)\b/i);
    if (!m) return 0;
    read.push('seating ' + m[1] + ' or more');
    return +m[1];
  }

  function resolveCampus(w, read) {
    for (var i = 0; i < CAMPUSES.length; i++) {
      if (w.take(CAMPUSES[i][0])) {
        read.push(CAMPUSES[i][2] + ' campus');
        return { query: CAMPUSES[i][1], name: CAMPUSES[i][2] };
      }
    }
    var pref = w.take(/\b([BCM])_\w*/);
    if (pref) {
      var q = pref[1].toUpperCase() + '_';
      var name = q === 'B_' ? 'Belfast' : q === 'C_' ? 'Coleraine' : 'Derry/Londonderry';
      read.push(name + ' campus');
      return { query: q, name: name };
    }
    return null;
  }

  function resolveBuildings(w, read) {
    var list = [];
    var cued = w.take(/\b(?:blocks?|buildings?)\s+([a-z]{2}(?:\s*(?:,|\/|or|and|&)\s*[a-z]{2})*)\b/i);
    if (cued) {
      list = cued[1].split(/[^a-z]+/i).filter(Boolean);
    } else {
      var inCaps = w.take(/\bin\s+([A-Z]{2}(?:\s*(?:,|\/|or|and|&)\s*[A-Z]{2})*)\b/);
      if (inCaps) list = inCaps[1].split(/[^A-Za-z]+/).filter(Boolean);
    }
    list = list.filter(function (b) { return b.length === 2 && !NOT_A_BUILDING.test(b); })
      .map(function (b) { return b.toUpperCase(); });
    if (list.length) read.push('block' + (list.length > 1 ? 's ' : ' ') + list.join(' or '));
    return list;
  }

  // ------------------------------------------------------------------- parse

  function parse(text, today) {
    today = today || isoOf(new Date());
    var read = [], w = new Work(text);

    var mod = w.take(/\b([A-Z]{2,4}\s?\d{3}[A-Z]?)(_[A-Z0-9]+(?:\/[A-Z0-9]+)*)?\b/i);
    var moduleCode = mod ? (mod[1].replace(/\s+/g, '') + (mod[2] || '')).toUpperCase() : null;
    var asksWhere = /\b(where|why|which room|scheduled|timetabled|usual room|missing|normally)\b/i.test(text);
    var asksFree = /\b(free|available|empty|spare|vacant)\b/i.test(text);
    var mode = moduleCode && (asksWhere || !asksFree) ? 'module' : 'availability';

    var range = resolveRange(w, today, read);
    var slot = resolveSlot(w, read);
    var weekdays = resolveWeekdays(w, read);
    var capacity = resolveCapacity(w, read);
    var campus = resolveCampus(w, read);
    var buildings = resolveBuildings(w, read);

    var ordinaryOnly = true;
    if (w.take(/\b(?:includ\w*|with|any|all)\s+(?:the\s+)?(?:labs?|studios?|specialist)\b|\banywhere\b|\bany room\b/i)) {
      ordinaryOnly = false;
      read.push('labs and studios included');
    } else {
      w.take(/\b(?:no|not?|exclud\w*|without)\s+(?:the\s+)?labs?\b|\b(?:ordinary|normal|teaching)\s+rooms?(?:\s+only)?\b/i);
    }

    var includePending = !w.take(/\b(?:ignor\w*|exclud\w*|without|skip)\s+pending\b/i);
    if (!includePending) read.push('pending requests ignored');

    var maxClashes = 2;
    var allow = w.take(/\ballow(?:ing)?\s+(?:up to\s+)?(\d+)\s+clash(?:es)?\b/i);
    if (allow) { maxClashes = +allow[1]; read.push('tolerating up to ' + allow[1] + ' clashes'); }
    else if (w.take(/\b(?:every|all|each)\s+(?:single\s+)?(?:week|date|time)\b|\bno clashes\b|\bcompletely free\b/i)) {
      maxClashes = 0;
      read.push('free on every date, no exceptions');
    }

    if (moduleCode) read.unshift(mode === 'module' ? 'looking up module ' + moduleCode : 'module ' + moduleCode);
    if (campus) read.unshift(campus.name + ' campus');

    return {
      mode: mode,
      module: moduleCode,
      query: campus ? campus.query : 'B_',
      campusName: campus ? campus.name : 'Belfast',
      campusAssumed: !campus,
      buildings: buildings,
      minCapacity: capacity,
      from: range.from,
      to: range.to,
      datesAssumed: !!range.assumed,
      weekdays: weekdays,
      slotFrom: slot.from,
      slotTo: slot.to,
      slotAssumed: !!slot.assumed,
      maxClashes: maxClashes,
      ordinaryOnly: ordinaryOnly,
      includePending: includePending,
      read: read,
      leftover: w.rest()
    };
  }

  var api = { parse: parse, hhmm: hhmm, shift: shift, isoOf: isoOf, DAY_FULL: DAY_FULL };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.URF = Object.assign(window.URF || {}, { parse: parse, parseApi: api });
})();
