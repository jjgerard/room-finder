/* Turns raw busy-time data into the things the booking UI cannot tell you: what fits,
 * what nearly fits and in what shape, what you would have to give up to make something
 * fit, and where a module actually sits across a term.
 *
 * Pure. No DOM, no network. test.js exercises it directly.
 *
 * A room record looks like:
 *   { name, identity, capacity, totalEvents, byDate: { '2026-09-28': [{from,to,name}] } }
 * where from/to are minutes past local midnight.
 */
(function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
  function nice(isoStr) {
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = isoStr.split('-');
    return (+p[2]) + ' ' + M[+p[1] - 1];
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function list(items, join) {
    join = join || 'and';
    if (items.length <= 1) return items[0] || '';
    if (items.length === 2) return items[0] + ' ' + join + ' ' + items[1];
    return items.slice(0, -1).join(', ') + ' ' + join + ' ' + items[items.length - 1];
  }

  // ------------------------------------------------------------- clash logic

  function clashesAt(room, dates, from, to) {
    var out = [];
    dates.forEach(function (d, i) {
      var hits = (room.byDate[d] || []).filter(function (iv) { return iv.from < to && iv.to > from; });
      if (hits.length) {
        out.push({
          date: d, index: i,
          what: hits.map(function (h) { return h.name || 'busy'; }).join(', '),
          when: hits.map(function (h) { return hhmm(h.from) + '–' + hhmm(h.to); }).join(', ')
        });
      }
    });
    return out;
  }

  // Consecutive stretches within a list of indices.
  function runs(indices) {
    var out = [];
    indices.slice().sort(function (a, b) { return a - b; }).forEach(function (i) {
      var last = out[out.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else out.push([i, i]);
    });
    return out;
  }

  // The shape of the misses matters: one bad fortnight is a different problem from a
  // room that is taken every other week.
  function clashShape(clashes, dates) {
    var n = dates.length, k = clashes.length;
    if (!k) return { kind: 'clear', text: 'free on all ' + plural(n, 'date') };
    var idx = clashes.map(function (c) { return c.index; });
    var r = runs(idx);
    var span = function (run) {
      return run[0] === run[1] ? nice(dates[run[0]])
        : nice(dates[run[0]]) + '–' + nice(dates[run[1]]);
    };
    if (k === n) return { kind: 'never', text: 'taken on every date' };
    if (r.length === 1 && r[0][1] - r[0][0] + 1 === k && k > 1) {
      var where = r[0][0] === 0 ? 'at the start' : r[0][1] === n - 1 ? 'at the end' : 'in the middle';
      return { kind: 'block', runs: r, text: 'busy for ' + plural(k, 'date') + ' in a row ' + where + ' (' + span(r[0]) + ')' };
    }
    if (k === 1) return { kind: 'single', runs: r, text: 'busy on one date only (' + nice(dates[idx[0]]) + ')' };
    if (r.length === k) return { kind: 'scattered', runs: r, text: 'busy on ' + plural(k, 'scattered date') + ' (' + list(idx.map(function (i) { return nice(dates[i]); })) + ')' };
    return { kind: 'mixed', runs: r, text: 'busy across ' + plural(r.length, 'stretch') + ' (' + r.map(span).join(', ') + ')' };
  }

  // The longest unbroken run of usable dates — the answer to "can I at least start it?"
  function longestFreeRun(clashes, dates) {
    var busy = {};
    clashes.forEach(function (c) { busy[c.index] = true; });
    var best = { length: 0, from: 0, to: -1 }, cur = null;
    for (var i = 0; i < dates.length; i++) {
      if (busy[i]) { cur = null; continue; }
      if (!cur) cur = { length: 0, from: i, to: i };
      cur.length++; cur.to = i;
      if (cur.length > best.length) best = { length: cur.length, from: cur.from, to: cur.to };
    }
    if (!best.length) return null;
    return {
      length: best.length,
      fromDate: dates[best.from], toDate: dates[best.to],
      text: plural(best.length, 'date') + ' in a row (' + nice(dates[best.from]) + '–' + nice(dates[best.to]) + ')'
    };
  }

  // ------------------------------------------------------------ alternatives

  var DAY_START = 8 * 60, DAY_END = 21 * 60;

  function timeShifts(rooms, dates, from, to, offsets) {
    offsets = offsets || [-60, -45, -30, 30, 45, 60, 90, -90, 120, -120];
    var out = [];
    offsets.forEach(function (off) {
      var a = from + off, b = to + off;
      if (a < DAY_START || b > DAY_END) return;
      var free = rooms.filter(function (r) { return clashesAt(r, dates, a, b).length === 0; });
      out.push({ offset: off, from: a, to: b, count: free.length, rooms: free });
    });
    out.sort(function (x, y) {
      if (y.count !== x.count) return y.count - x.count;
      return Math.abs(x.offset) - Math.abs(y.offset);
    });
    return out;
  }

  /* What would you have to give up? Options whose effect is computable from data
   * already in hand carry a real count; options that need another fetch are marked
   * needsRefetch so the caller can present them as a re-run rather than a promise. */
  function alternatives(res, q) {
    var out = [];
    var dates = res.dates, pool = res.rooms;
    var baseFree = pool.filter(function (r) { return r.clashes.length === 0; }).length;

    var seenCount = {};
    timeShifts(pool, dates, q.slotFrom, q.slotTo).filter(function (s) {
      if (s.count <= baseFree || seenCount[s.count]) return false;
      seenCount[s.count] = true;   // sorted by count desc then smallest shift first
      return true;
    }).slice(0, 2).forEach(function (s) {
      out.push({
        kind: 'shift', known: true, count: s.count,
        text: 'Move the slot to ' + hhmm(s.from) + '–' + hhmm(s.to) + ' (' +
          (s.offset > 0 ? s.offset + ' min later' : Math.abs(s.offset) + ' min earlier') + ') and ' +
          s.count + ' rooms are free on every date',
        apply: { slotFrom: s.from, slotTo: s.to },
        rooms: s.rooms.slice(0, 5).map(function (r) { return r.name; })
      });
    });

    if (!baseFree) {
      for (var n = 1; n <= 3; n++) {
        var c = pool.filter(function (r) { return r.clashes.length <= n; }).length;
        if (c > 0) {
          out.push({
            kind: 'clashes', known: true, count: c,
            text: 'Accept ' + plural(n, 'clash', 'clashes') + ' and ' + plural(c, 'room') +
              (c === 1 ? ' qualifies' : ' qualify'),
            apply: { maxClashes: n }
          });
          break;
        }
      }
    }

    var partial = pool.map(function (r) { return { room: r, run: longestFreeRun(r.clashes, dates) }; })
      .filter(function (x) { return x.run && x.run.length < dates.length && x.run.length >= Math.ceil(dates.length * 0.6); })
      .sort(function (a, b) { return b.run.length - a.run.length; })[0];
    if (partial && !baseFree) {
      out.push({
        kind: 'partial', known: true, count: 1,
        text: 'If a short run is enough, ' + partial.room.name + ' is free for ' + partial.run.text
      });
    }

    if (q.minCapacity > 0) {
      var lower = Math.max(0, q.minCapacity - 10);
      out.push({
        kind: 'capacity', known: false, needsRefetch: true,
        text: 'Drop the capacity floor from ' + q.minCapacity + ' to ' + lower + ' and search again',
        apply: { minCapacity: lower }
      });
    }
    if (q.buildings && q.buildings.length) {
      out.push({
        kind: 'buildings', known: false, needsRefetch: true,
        text: 'Widen from ' + list(q.buildings, 'and') + ' to the whole ' + res.campusName + ' campus',
        apply: { buildings: [] }
      });
    }
    if (q.ordinaryOnly && res.dropped && res.dropped.specialist.length) {
      out.push({
        kind: 'specialist', known: false, needsRefetch: true,
        text: 'Include the ' + res.dropped.specialist.length + ' labs and studios that were filtered out',
        apply: { ordinaryOnly: false }
      });
    }
    return out;
  }

  // ----------------------------------------------------------------- summary

  function summarise(res, q, alts) {
    var dates = res.dates, lines = [];
    var clean = res.rooms.filter(function (r) { return r.clashes.length === 0; });
    var near = res.rooms.filter(function (r) { return r.clashes.length > 0 && r.clashes.length <= q.maxClashes; })
      .sort(function (a, b) { return a.clashes.length - b.clashes.length; });
    var slot = hhmm(q.slotFrom) + '–' + hhmm(q.slotTo);
    var when = plural(dates.length, 'date') + ' from ' + nice(dates[0]) + ' to ' + nice(dates[dates.length - 1]);

    if (clean.length) {
      var named = clean.slice(0, 4).map(function (r) {
        return r.name + (r.capacity ? ' (' + r.capacity + ')' : '');
      });
      lines.push(plural(clean.length, 'room') + ' ' + (clean.length === 1 ? 'is' : 'are') +
        ' free at ' + slot + ' on all ' + when + ': ' + list(named) +
        (clean.length > named.length ? ', and ' + (clean.length - named.length) + ' more' : '') + '.');
    } else {
      lines.push('Nothing in the ' + plural(res.rooms.length, 'room') + ' searched is free at ' +
        slot + ' on all ' + when + '.');
    }

    if (near.length) {
      var best = near[0];
      var shape = clashShape(best.clashes, dates);
      var detail = best.clashes.slice(0, 3).map(function (c) {
        return (shape.kind === 'single' ? '' : nice(c.date) + ' ') + 'taken by ' + c.what + ' ' + c.when;
      }).join('; ');
      lines.push('Closest miss is ' + best.name + (best.capacity ? ' (' + best.capacity + ')' : '') +
        ', ' + shape.text + ' — ' + detail + '.');
    }

    var firstKnown = (alts || []).filter(function (a) { return a.known && a.kind === 'shift'; })[0];
    if (firstKnown) lines.push(firstKnown.text + '.');

    var caveats = [];
    if (res.shells && res.shells.length) {
      caveats.push(res.shells.length + ' records had no events at all across the whole period, so they are ' +
        'almost certainly shells rather than real free rooms, and are excluded');
    }
    if (res.dropped && res.dropped.specialist.length) {
      caveats.push(res.dropped.specialist.length + ' labs and studios were filtered out by name');
    }
    if (caveats.length) lines.push(caveats.join('; ') + '.');

    return lines;
  }

  // ------------------------------------------------------------ module lookup

  /* Where does a module actually sit, and what explains the weeks it doesn't?
   * Answers the two cases separately, because the fix differs: a free room means the
   * event's week pattern simply doesn't cover that week and timetabling can extend it;
   * a booked room means something else is there and you need an alternative. */
  function modulePattern(events, roomsById, allDates) {
    if (!events.length) return null;

    var groups = {};
    events.forEach(function (e) {
      var wd = new Date(e.date + 'T12:00:00Z').getUTCDay();
      var key = wd + '|' + e.from + '|' + e.roomId;
      (groups[key] = groups[key] || { weekday: wd, from: e.from, to: e.to, roomId: e.roomId, roomName: e.roomName, dates: [] }).dates.push(e.date);
    });
    var patterns = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return b.dates.length - a.dates.length; });

    return patterns.map(function (p) {
      var candidates = allDates.filter(function (d) {
        return new Date(d + 'T12:00:00Z').getUTCDay() === p.weekday;
      });
      var present = {};
      p.dates.forEach(function (d) { present[d] = true; });
      var room = roomsById[p.roomId];
      var gaps = candidates.filter(function (d) { return !present[d]; }).map(function (d) {
        var hits = room ? (room.byDate[d] || []).filter(function (iv) {
          return iv.from < p.to && iv.to > p.from;
        }) : [];
        return {
          date: d,
          free: hits.length === 0,
          blockedBy: hits.map(function (h) { return h.name || 'busy'; }).join(', '),
          when: hits.map(function (h) { return hhmm(h.from) + '–' + hhmm(h.to); }).join(', ')
        };
      });
      return {
        roomId: p.roomId, roomName: p.roomName, weekday: p.weekday,
        from: p.from, to: p.to,
        occurrences: p.dates.slice().sort(),
        candidates: candidates,
        gaps: gaps,
        // Week numbers counted from the first time this module appears, not from any
        // institutional calendar — say so rather than inventing a numbering.
        weekOf: function (d) { return candidates.indexOf(d) + 1; }
      };
    });
  }

  function summariseModule(code, patterns) {
    if (!patterns || !patterns.length) return ['Nothing matching ' + code + ' was found in the rooms searched.'];
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var lines = [];
    patterns.slice(0, 3).forEach(function (p) {
      lines.push(code + ' sits in ' + p.roomName + ' on ' + DAYS[p.weekday] + 's at ' +
        hhmm(p.from) + '–' + hhmm(p.to) + ', on ' + plural(p.occurrences.length, 'date') +
        ' out of ' + p.candidates.length + ' in range.');
      if (!p.gaps.length) { lines.push('No gaps — it runs every one.'); return; }
      var free = p.gaps.filter(function (g) { return g.free; });
      var booked = p.gaps.filter(function (g) { return !g.free; });
      if (free.length) {
        lines.push('Missing but the room is free: ' + list(free.map(function (g) { return nice(g.date); })) +
          '. Nothing is blocking it — the event\'s week pattern just does not cover ' +
          (free.length === 1 ? 'that week' : 'those weeks') + ', so timetabling can extend it without moving anyone.');
      }
      if (booked.length) {
        lines.push('Missing and the room is taken: ' + booked.map(function (g) {
          return nice(g.date) + ' by ' + g.blockedBy + ' ' + g.when;
        }).join('; ') + '. These need an alternative room.');
      }
    });
    return lines;
  }

  var api = {
    clashesAt: clashesAt, runs: runs, clashShape: clashShape, longestFreeRun: longestFreeRun,
    timeShifts: timeShifts, alternatives: alternatives, summarise: summarise,
    modulePattern: modulePattern, summariseModule: summariseModule, hhmm: hhmm, nice: nice
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.URF = Object.assign(window.URF || {}, { analyse: api });
})();
