// GENERATED — copied from timetable/lib by `node timetable/export.js`.
// Edit the original, not this copy.
;(function () {
'use strict';

// "Where else could this class go, and what is stopping it?"
//
// Pure: no DOM, no I/O, no network — the same file runs in node (so it is
// tested) and in the explore page. Modelled on the extension's analyse.js: the
// useful answer is not a yes/no but a named blocker. "Blocked by CMM125/LEC in
// BC-03-123" is actionable; "unavailable" is not.
//
// Moves operate on a COMPONENT, never a single class. A lecture whose seminar
// must follow it cannot move alone, so offering the lecture a slot its seminar
// cannot follow into would be offering an illegal move.

const DAY_COUNT = 5;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// The teaching day is defined once, in constraints.js. Reaching for it rather
// than restating it is what stops this file offering slots the solver forbids.
const RULES = (typeof require === 'function')
  ? require('./constraints')
  : (typeof window !== 'undefined' ? window.TTConstraints : null);
const DAY_START = RULES ? RULES.DAY_START : 9 * 60 + 15;
const DAY_END = RULES ? RULES.DAY_END : 17 * 60 + 15;
const DAY_WIDTH = DAY_END - DAY_START;

function fmt(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

function overlaps(aS, aD, bS, bD) { return aS < bS + bD && bS < aS + aD; }

/** (room,day) → class ids, so a placement test does not scan every class. */
function buildIndex(model, assign) {
  const byRoomDay = new Map();
  for (const c of model.classes) {
    const p = assign.get ? assign.get(c.id) : assign[c.id];
    if (!p) continue;
    const key = p.room + ':' + p.day;
    if (!byRoomDay.has(key)) byRoomDay.set(key, []);
    byRoomDay.get(key).push(c.id);
  }
  const timeP = new Map(), dayP = new Map();
  for (const c of model.classes) { timeP.set(c.id, []); dayP.set(c.id, []); }
  for (const [a, b] of model.cannotShareTime) { timeP.get(a).push(b); timeP.get(b).push(a); }
  for (const [a, b] of model.cannotShareDay) { dayP.get(a).push(b); dayP.get(b).push(a); }
  return { byRoomDay, timeP, dayP };
}

/** "CMM151 Drawing in Practice/LEC" reads better than "CMM151/LEC". */
function describe(model, c) {
  const name = (model.modTitles || {})[c.module];
  return (c.module || c.activity) + (name ? ' ' + name : '') + '/' + c.activity;
}

/**
 * Everything that would stop `cls` sitting at (day, start, room).
 * `ignore` is the set of class ids moving with it, which cannot block it.
 */
function blockersAt(model, assign, idx, cls, day, start, room, ignore) {
  const out = [];
  const at = id => (assign.get ? assign.get(id) : assign[id]);

  if (day < 0 || day > 4) out.push({ rule: 'window', text: 'outside the teaching week' });
  // A session longer than the day may overrun its end — there is nowhere else
  // for it — but may never start before the day begins.
  const tooLong = cls.windowExempt || cls.dur > DAY_WIDTH;
  if (!cls.isFixed && (start < DAY_START || (!tooLong && start + cls.dur > DAY_END))) {
    out.push({
      rule: 'window',
      text: `${fmt(start)}–${fmt(start + cls.dur)} falls outside ` +
            `${fmt(DAY_START)}–${fmt(DAY_END)}`,
    });
  }

  const roomObj = model.rooms[room];
  if (room !== cls.origRoom && !cls.cand.includes(room)) {
    const why = roomObj && roomObj.type !== cls.roomType
      ? `${roomObj.type} room, needs ${cls.roomType}`
      : roomObj && roomObj.capacityKnown && roomObj.capacity < cls.size
        ? `seats ${roomObj.capacity}, needs about ${cls.size}`
        : 'not a listed candidate room';
    out.push({ rule: 'roomFit', text: `${roomObj ? roomObj.name : 'room ' + room} — ${why}` });
  }

  for (const otherId of (idx.byRoomDay.get(room + ':' + day) || [])) {
    if (otherId === cls.id || (ignore && ignore.has(otherId))) continue;
    const o = model.byId.get(otherId), po = at(otherId);
    if (!overlaps(start, cls.dur, po.start, o.dur)) continue;
    if (!(cls.weeks & o.weeks)) continue;
    out.push({
      rule: 'roomClash', other: otherId,
      text: `${roomObj ? roomObj.name : 'the room'} is taken by ${describe(model, o)} ` +
            `${fmt(po.start)}–${fmt(po.start + o.dur)}`,
    });
  }

  for (const otherId of idx.timeP.get(cls.id) || []) {
    if (ignore && ignore.has(otherId)) continue;
    const o = model.byId.get(otherId), po = at(otherId);
    if (po.day !== day) continue;
    if (!overlaps(start, cls.dur, po.start, o.dur)) continue;
    if (!(cls.weeks & o.weeks)) continue;
    out.push({
      rule: 'timeClash', other: otherId,
      text: `clashes with ${describe(model, o)} ` +
            `${fmt(po.start)}–${fmt(po.start + o.dur)} (same students or staff)`,
    });
  }

  for (const otherId of idx.dayP.get(cls.id) || []) {
    if (ignore && ignore.has(otherId)) continue;
    const po = at(otherId);
    if (po.day !== day) continue;
    const o = model.byId.get(otherId);
    out.push({
      rule: 'dayPairing', other: otherId,
      text: `would put ${describe(model, o)} on the same day for a cohort that ` +
            `does not share one today`,
    });
  }

  return out;
}

/** The component a class belongs to, as {members:[{cls,off}], span}. */
function componentOf(model, components, classId) {
  const cls = model.byId.get(classId);
  return components[cls.component];
}

/**
 * Rank alternative placements for a class's whole component.
 *
 * Ordered by how much they disturb: same slot different room, then same day
 * different time, then another day. That mirrors what a timetabler would try
 * by hand, and means the first clear option offered is the cheapest one.
 */
function alternatives(model, components, assign, classId, opts) {
  opts = opts || {};
  const limit = opts.limit == null ? 12 : opts.limit;
  const starts = opts.starts || defaultStarts();
  const idx = opts.index || buildIndex(model, assign);
  const at = id => (assign.get ? assign.get(id) : assign[id]);

  const comp = componentOf(model, components, classId);
  const ids = new Set(comp.members.map(m => m.cls.id));
  const anchor = comp.members[0].cls;
  const anchorAt = at(anchor.id);
  const curDay = anchorAt.day, curStart = anchorAt.start;

  // How the component sits now, and why (if at all) that is illegal.
  const current = {
    day: curDay, start: curStart,
    members: comp.members.map(m => ({
      id: m.cls.id, room: at(m.cls.id).room,
      blockers: blockersAt(model, assign, idx, m.cls, at(m.cls.id).day, at(m.cls.id).start, at(m.cls.id).room, ids),
    })),
  };
  current.blockers = current.members.flatMap(m => m.blockers);

  const options = [];
  for (let d = 0; d < DAY_COUNT; d++) {
    for (const s of starts) {
      if (d === curDay && s === curStart) continue;
      if (comp.span > DAY_WIDTH ? s !== DAY_START : s + comp.span > DAY_END) continue;

      // For each member pick the least-blocked room, preferring the one it
      // already holds so an otherwise fine move is not reported as a room change.
      const placed = [];
      let blockers = [];
      let roomChanges = 0;
      for (const m of comp.members) {
        const memberStart = s + m.off;
        const held = at(m.cls.id).room;
        const choices = [held, ...m.cls.cand.filter(r => r !== held)];
        let pick = null;
        for (const r of choices) {
          const b = blockersAt(model, assign, idx, m.cls, d, memberStart, r, ids);
          if (!b.length) { pick = { room: r, blockers: [] }; break; }
          if (!pick || b.length < pick.blockers.length) pick = { room: r, blockers: b };
        }
        if (!pick) pick = { room: held, blockers: [{ rule: 'roomFit', text: 'no room available' }] };
        placed.push({ id: m.cls.id, room: pick.room, blockers: pick.blockers });
        blockers = blockers.concat(pick.blockers);
        if (pick.room !== m.cls.origRoom) roomChanges++;
      }

      options.push({
        day: d, start: s,
        kind: d === curDay && s === curStart ? 'room' : d === curDay ? 'time' : 'day',
        members: placed,
        blockers,
        clear: blockers.length === 0,
        roomChanges,
        // Smaller is less disruptive: a different day costs most, then a
        // different time, then a different room.
        disturbance: (d === anchor.origDay ? 0 : 100) +
                     Math.abs(s - anchor.origStart) / 60 +
                     roomChanges,
      });
    }
  }

  // A room-only change at the current slot is the cheapest fix of all, so it is
  // generated separately rather than being excluded with the current placement.
  const roomOnly = [];
  for (const m of comp.members) {
    const memberStart = curStart + m.off;
    const held = at(m.cls.id).room;
    for (const r of m.cls.cand) {
      if (r === held) continue;
      const b = blockersAt(model, assign, idx, m.cls, curDay, memberStart, r, ids);
      if (!b.length) {
        roomOnly.push({
          classId: m.cls.id, room: r, day: curDay, start: memberStart,
          roomName: model.rooms[r] ? model.rooms[r].name : String(r),
        });
      }
    }
  }

  const clear = options.filter(o => o.clear).sort((a, b) => a.disturbance - b.disturbance);
  const near = options.filter(o => !o.clear).sort((a, b) =>
    a.blockers.length - b.blockers.length || a.disturbance - b.disturbance);

  return {
    classId,
    component: { size: comp.members.length, span: comp.span, ids: [...ids] },
    current,
    roomOnly: roomOnly.slice(0, limit),
    clear: clear.slice(0, limit),
    near: near.slice(0, limit),
    counts: { clear: clear.length, blocked: near.length, roomOnly: roomOnly.length },
  };
}

function defaultStarts() {
  const out = [];
  for (let t = DAY_START; t + 60 <= DAY_END; t += 60) out.push(t);
  return out;
}

const api = { alternatives, blockersAt, buildIndex, componentOf, defaultStarts, describe, fmt, DAY_NAMES };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.TTSuggest = api;

})();
