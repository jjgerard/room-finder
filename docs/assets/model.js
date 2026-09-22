// Rehydrates docs/data/timetable.json.
//
// Two things come out of it:
//  - three display timetables (autumn, spring as it stands, spring rebuilt),
//    each a flat list of bookings ready to draw;
//  - the full model behind the rebuilt term, in the exact shape that
//    constraints.js and suggest.js expect, so the page can run the solver's own
//    code rather than a second implementation of the rules.

(function () {
  'use strict';

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Column order is fixed by timetable/export.js.
  var C = {
    id: 0, module: 1, activity: 2, title: 3, dur: 4, weeks: 5, weeksText: 6,
    teaching: 7, block: 8, multiRoom: 9, nRooms: 10, roomType: 11, size: 12,
    origDay: 13, origStart: 14, origRoom: 15,
    day: 16, start: 17, room: 18, changed: 19,
    attended: 20, shadowOf: 21, fixed: 22, progs: 23,
  };

  // A display row: [module, activity, title, day, start, dur, room, nWeeks,
  //                 weeks, progIds, changed]
  var R = {
    module: 0, activity: 1, title: 2, day: 3, start: 4, dur: 5, room: 6,
    nWeeks: 7, weeks: 8, progs: 9, changed: 10,
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

  // "1-6,8" → bitmask, for the display rows which carry the text pattern only.
  function weekMask(pattern) {
    var mask = 0;
    if (pattern == null) return mask;
    String(pattern).split(',').forEach(function (part) {
      part = part.trim().replace(/–/g, '-');
      if (!part) return;
      var dash = part.indexOf('-', 1);
      if (dash > 0) {
        var a = parseInt(part.slice(0, dash), 10), b = parseInt(part.slice(dash + 1), 10);
        if (isNaN(a) || isNaN(b)) return;
        for (var w = Math.max(1, a); w <= Math.min(16, b); w++) mask |= 1 << (w - 1);
      } else {
        var v = parseInt(part, 10);
        if (!isNaN(v) && v >= 1 && v <= 16) mask |= 1 << (v - 1);
      }
    });
    return mask;
  }

  /**
   * One term's model and components, from a pack in the shape export.js
   * writes. The rooms, programme names and module titles are shared between
   * terms, so they are passed in rather than repeated in every file.
   */
  function buildModel(packed, rooms, programmes, modTitles) {
    var classes = packed.classes.map(function (row, i) {
      return {
        id: row[C.id],
        module: row[C.module], activity: row[C.activity], title: row[C.title],
        dur: row[C.dur], weeks: row[C.weeks], weeksText: row[C.weeksText],
        isTeaching: !!row[C.teaching], isBlock: !!row[C.block],
        isMultiRoom: !!row[C.multiRoom], nRooms: row[C.nRooms],
        roomType: row[C.roomType], size: row[C.size],
        origDay: row[C.origDay], origStart: row[C.origStart], origRoom: row[C.origRoom],
        day: row[C.day], start: row[C.start], room: row[C.room],
        changed: row[C.changed] || '',
        // Soft goals count every class a cohort attends, not just the ones
        // flagged as teaching — see timetable/lib/model.js.
        attended: !!row[C.attended],
        shadowOf: row[C.shadowOf] >= 0 ? row[C.shadowOf] : null,
        isShadow: row[C.shadowOf] >= 0,
        isFixed: !!row[C.fixed],
        progs: row[C.progs] || [],
        cand: packed.cand[i],
        candType: (packed.candType && packed.candType[i]) || packed.cand[i],
      };
    });

    var byId = new Map(classes.map(function (c) { return [c.id, c]; }));

    var model = {
      rooms: rooms,
      classes: classes,
      byId: byId,
      programmes: programmes,
      modTitles: modTitles || {},
      // Pairs grandfathered to share a room, in the shape constraints.js wants:
      // a Set of "a:b" with the smaller id first.
      mayShareRoom: new Set(unflat(packed.sharePairs || []).map(function (p) {
        return p[0] < p[1] ? p[0] + ':' + p[1] : p[1] + ':' + p[0];
      })),
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

  function hydrate(packed) {
    var rooms = packed.rooms.map(function (r, i) {
      return { id: i, name: r[0], type: r[1], capacity: r[2], capacityKnown: r[2] > 0 };
    });
    var built = buildModel(packed, rooms, packed.programmes, packed.modTitles);

    // Display rows, with the week mask precomputed so drawing does not reparse.
    var terms = {};
    Object.keys(packed.terms).forEach(function (key) {
      var t = packed.terms[key];
      terms[key] = {
        key: key, label: t.label, sub: t.sub, checkable: !!t.checkable,
        // A term the browser has no model for carries its own scorecard,
        // computed where the model exists.
        score: t.score || null,
        // And, for a term as it stands, the figures the About page compares
        // against — counted in export.js so an S+ refresh moves them.
        today: t.today || null,
        rows: t.rows.map(function (r) {
          return {
            module: r[R.module], activity: r[R.activity], title: r[R.title],
            day: r[R.day], start: r[R.start], dur: r[R.dur], room: r[R.room],
            nWeeks: r[R.nWeeks], weeksText: r[R.weeks], weeks: weekMask(r[R.weeks]),
            progs: r[R.progs] || [], changed: r[R.changed] || '',
          };
        }),
      };
    });

    return {
      model: built.model, components: built.components, terms: terms,
      rooms: rooms, programmes: packed.programmes, modTitles: packed.modTitles || {},
      // The room-type overrides the solver is using, for the page that edits them.
      roomTypes: packed.roomTypes || [],
      // How many corrections timetabling has supplied, by kind.
      corrections: packed.corrections || null,
    };
  }

  /**
   * Today's room usage as it is actually booked: one entry per class-room
   * booking, each carrying its own room, slot and weeks.
   *
   * The rebuilt term's model cannot express this. It gives a class one room,
   * one slot and one week list covering every room it uses, so a split class
   * looks double-booked in the weeks it is elsewhere. The checker takes this
   * list instead when judging the timetable as it stands.
   */
  function currentOccupancy(h) {
    var t = h.terms && h.terms.springNow;
    if (!t) return null;
    var byTitle = {};
    h.model.classes.forEach(function (c) {
      (byTitle[c.title] || (byTitle[c.title] = [])).push(c.id);
    });
    return t.rows.map(function (r) {
      return { title: r.title, module: r.module, room: r.room, day: r.day,
               start: r.start, dur: r.dur, weeks: r.weeks,
               ids: byTitle[r.title] || [] };
    });
  }

  /**
   * Classes taught in one room and then another across the term.
   *
   * This is the fault the rebuild exists to remove, and it is NOT the same as
   * a class holding several rooms. MEC114's tutorial teaches 350 students in
   * seven rooms in the same hour, and the fine art studios keep fourteen:
   * that is parallel teaching, and the rebuild books every one of them. What
   * is wrong is a class meeting in one room for six weeks and another for the
   * rest, because nobody could hold one room for the term.
   *
   * So a slot only counts when its rooms are never occupied together: if any
   * single week has two of them in use, the class is teaching in parallel and
   * is left alone. Counting rooms instead of weeks is what made the rebuilt
   * spring term report 499 bookings "split across rooms" while breaking no
   * rule — it was counting the parallel teaching it had deliberately kept.
   *
   * Bookings with no module code are institutional rather than taught — room
   * bookings for staff training, applicant days — and are not the timetable's
   * to fix.
   *
   * @param rows display rows, with `weeks` as a bitmask
   * @return [{title, module, day, start, rooms: [id], rows}]
   */
  function wanderingSlots(rows) {
    var slots = {};
    rows.forEach(function (r) {
      if (!r.module) return;
      var k = r.title + '|' + r.day + '|' + r.start;
      (slots[k] || (slots[k] = [])).push(r);
    });
    var out = [];
    Object.keys(slots).forEach(function (k) {
      var list = slots[k], seen = {};
      list.forEach(function (r) { seen[r.room] = true; });
      var ids = Object.keys(seen).map(Number);
      if (ids.length < 2) return;
      for (var w = 0; w < 16; w++) {
        var n = 0;
        ids.forEach(function (rm) {
          if (list.some(function (r) { return r.room === rm && (r.weeks & (1 << w)); })) n++;
        });
        if (n > 1) return;
      }
      out.push({ title: list[0].title, module: list[0].module,
                 day: list[0].day, start: list[0].start, rooms: ids, rows: list });
    });
    return out;
  }

  // Two assignments over the rebuilt term's model: today, and the rebuild.
  function assignments(model) {
    var current = new Map(), solved = new Map();
    model.classes.forEach(function (c) {
      current.set(c.id, { day: c.origDay, start: c.origStart, room: c.origRoom });
      solved.set(c.id, { day: c.day, start: c.start, room: c.room });
    });
    return { current: current, solved: solved };
  }

  /**
   * A second term's model, fetched only when something asks for it. Fix a
   * clash needs autumn's; the pages that only draw a timetable do not, and
   * should not pay 845 KB for it on load.
   */
  function loadModel(url, h) {
    if (!h.__models) h.__models = {};
    if (h.__models[url]) return Promise.resolve(h.__models[url]);
    h.__models[url] = fetch(url).then(function (r) {
      if (!r.ok) throw new Error('could not load ' + url + ' (' + r.status + ')');
      return r.json();
    }).then(function (pack) {
      var built = buildModel(pack, h.rooms, h.programmes, h.modTitles);
      built.assign = assignments(built.model);
      return built;
    });
    return h.__models[url];
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
    DAYS: DAYS, C: C, R: R, fmt: fmt, weekList: weekList, weekMask: weekMask,
    hydrate: hydrate, assignments: assignments, loadTimetable: loadTimetable,
    wanderingSlots: wanderingSlots,
    buildModel: buildModel, loadModel: loadModel,
    currentOccupancy: currentOccupancy,
  };
})();
