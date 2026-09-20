// Rehydrates docs/data/timetable.json into the exact shape that
// constraints.js and suggest.js expect, so the page can run the solver's own
// code rather than a second implementation of the rules.

(function () {
  'use strict';

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Column order is fixed by timetable/export.js.
  var I = {
    id: 0, module: 1, activity: 2, title: 3, dur: 4, weeks: 5, weeksText: 6,
    teaching: 7, block: 8, multiRoom: 9, nRooms: 10, roomType: 11, size: 12,
    origDay: 13, origStart: 14, origRoom: 15,
    day: 16, start: 17, room: 18, changed: 19,
  };

  function fmt(v) {
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  }

  function unflat(a) {
    var out = [];
    for (var i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
    return out;
  }

  function weekList(mask) {
    var out = [];
    for (var w = 1; w <= 16; w++) if (mask & (1 << (w - 1))) out.push(w);
    return out;
  }

  function hydrate(packed) {
    var rooms = packed.rooms.map(function (r, i) {
      return { id: i, name: r[0], type: r[1], capacity: r[2], capacityKnown: r[2] > 0 };
    });

    var classes = packed.classes.map(function (row, i) {
      return {
        id: row[I.id],
        module: row[I.module], activity: row[I.activity], title: row[I.title],
        dur: row[I.dur], weeks: row[I.weeks], weeksText: row[I.weeksText],
        isTeaching: !!row[I.teaching], isBlock: !!row[I.block],
        isMultiRoom: !!row[I.multiRoom], nRooms: row[I.nRooms],
        roomType: row[I.roomType], size: row[I.size],
        origDay: row[I.origDay], origStart: row[I.origStart], origRoom: row[I.origRoom],
        day: row[I.day], start: row[I.start], room: row[I.room],
        changed: row[I.changed] || '',
        cand: packed.cand[i],
      };
    });

    var byId = new Map(classes.map(function (c) { return [c.id, c]; }));

    var model = {
      rooms: rooms,
      classes: classes,
      byId: byId,
      cannotShareTime: unflat(packed.timePairs),
      cannotShareDay: unflat(packed.dayPairs),
      preservedAdjacency: unflat(packed.adjPairs),
      preservedSlot: unflat(packed.slotPairs),
      linkedGroups: packed.groups.map(function (g) {
        return { key: g[0], members: g.slice(1).map(function (id) { return byId.get(id); }) };
      }),
      meta: packed.meta,
    };

    // Components, in the same shape components.js produces.
    var components = packed.comps.map(function (members, ci) {
      var ms = members.map(function (m) { return { cls: byId.get(m[0]), off: m[1] }; });
      ms.forEach(function (m) { m.cls.component = ci; });
      var span = Math.max.apply(null, ms.map(function (m) { return m.off + m.cls.dur; }));
      return {
        id: ci, members: ms, span: span, size: ms.length,
        origDay: ms[0].cls.origDay, origStart: ms[0].cls.origStart,
      };
    });

    return { model: model, components: components };
  }

  // Two assignments: today's timetable, and the solved one.
  function assignments(model) {
    var current = new Map(), solved = new Map();
    model.classes.forEach(function (c) {
      current.set(c.id, { day: c.origDay, start: c.origStart, room: c.origRoom });
      solved.set(c.id, { day: c.day, start: c.start, room: c.room });
    });
    return { current: current, solved: solved };
  }

  function loadTimetable(url) {
    return fetch(url || 'data/timetable.json').then(function (r) {
      if (!r.ok) throw new Error('could not load the timetable data (' + r.status + ')');
      return r.json();
    }).then(function (packed) {
      var h = hydrate(packed);
      h.assign = assignments(h.model);
      return h;
    });
  }

  window.TTModel = {
    DAYS: DAYS, I: I, fmt: fmt, weekList: weekList,
    hydrate: hydrate, assignments: assignments, loadTimetable: loadTimetable,
  };
})();
