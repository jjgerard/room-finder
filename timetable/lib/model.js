'use strict';

const fs = require('fs');
const path = require('path');
const { readCsv } = require('./csv');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_WEEK = 16;

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtMin(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// "1-6,8,10–12" → bitmask. Both hyphen and en-dash appear in the data.
function weekMask(pattern) {
  let mask = 0;
  if (pattern == null) return mask;
  for (let part of String(pattern).split(',')) {
    part = part.trim().replace(/–/g, '-');
    if (!part) continue;
    const dash = part.indexOf('-', 1);
    if (dash > 0) {
      const a = parseInt(part.slice(0, dash), 10);
      const b = parseInt(part.slice(dash + 1), 10);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      for (let w = Math.max(1, a); w <= Math.min(MAX_WEEK, b); w++) mask |= 1 << (w - 1);
    } else {
      const w = parseInt(part, 10);
      if (!Number.isNaN(w) && w >= 1 && w <= MAX_WEEK) mask |= 1 << (w - 1);
    }
  }
  return mask;
}

function weekList(mask) {
  const out = [];
  for (let w = 1; w <= MAX_WEEK; w++) if (mask & (1 << (w - 1))) out.push(w);
  return out;
}

function splitList(s) {
  return String(s || '').split(';').map(x => x.trim()).filter(Boolean);
}

function load(dir) {
  dir = dir || path.join(__dirname, '..', 'data');
  const rd = f => readCsv(fs.readFileSync(path.join(dir, f), 'utf8'));

  const roomRows = rd('belfast_rooms.csv');
  const rooms = roomRows.map(r => ({
    id: Number(r.room_id),
    name: r.room_name,
    type: r.type,
    // capacity 0 means "not recorded", not "no seats" — 138 of 228 rooms.
    capacity: Number(r.capacity) || 0,
    capacityKnown: Number(r.capacity) > 0,
  }));
  const roomByName = new Map(rooms.map(r => [r.name, r.id]));

  // BK rows are one-off room bookings by a named person ("260220/BK/A Gribben"):
  // no module, no programmes, no linked group, not teaching, and absent from the
  // conflict graph entirely. They were specific to spring 2026 and are not
  // rescheduled, so they are excluded from the problem rather than solved around.
  const classRows = rd('belfast_classes.csv').filter(r => r.activity !== 'BK');
  const classes = classRows.map(r => {
    const start = toMin(r.current_start);
    const dur = Number(r.duration_min);
    const cand = [];
    for (const nm of splitList(r.candidate_rooms)) {
      const id = roomByName.get(nm);
      if (id !== undefined) cand.push(id);
    }
    const homeRoom = roomByName.get(r.current_room);
    return {
      id: Number(r.class_id),
      module: r.module || '',
      activity: r.activity || '',
      title: r.title || '',
      programmes: splitList(r.programmes),
      yearLevel: r.year_level,
      size: Number(r.size_estimate) || 0,
      sizeKnown: r.size_basis === 'known_headcount',
      day: DAYS.indexOf(r.current_day),
      start,
      dur,
      end: start + dur,
      roomType: r.current_room_type,
      // The room the class sits in today. For a multi-room class this is its
      // dominant room; `nRooms > 1` is the split we are trying to remove.
      homeRoom: homeRoom === undefined ? null : homeRoom,
      homeRoomName: r.current_room,
      nRooms: Number(r.n_current_rooms) || 1,
      isMultiRoom: r.is_multi_room === '1',
      weeks: weekMask(r.weeks),
      weeksText: r.weeks,
      nWeeks: Number(r.n_weeks) || 0,
      isTeaching: r.is_teaching === '1',
      isBlock: r.is_block_teaching === '1',
      recommendOffsite: r.recommend_offsite === '1',
      linked: r.linked_group || '',
      order: r.group_order === '' ? null : Number(r.group_order),
      cand,
      // Baseline placement, kept so movement can be measured and reverted.
      origDay: DAYS.indexOf(r.current_day),
      origStart: start,
      origRoom: homeRoom === undefined ? null : homeRoom,
    };
  });

  const byId = new Map(classes.map(c => [c.id, c]));

  const pairFile = f => rd(f)
    .map(r => [Number(r.class_id_a), Number(r.class_id_b)])
    .filter(([a, b]) => byId.has(a) && byId.has(b));

  const cannotShareTime = pairFile('conflicts_cannot_share_time.csv');
  const cannotShareDayRaw = pairFile('cannot_share_day.csv');

  // Rule 5 is "no NEW same-day pairings" — a pair already sharing a day today
  // is grandfathered. 2,469 of 12,854 are, so this matters a lot.
  const cannotShareDay = cannotShareDayRaw.filter(([a, b]) =>
    byId.get(a).origDay !== byId.get(b).origDay);

  const byModule = new Map();
  for (const c of classes) {
    if (!c.module) continue;
    if (!byModule.has(c.module)) byModule.set(c.module, []);
    byModule.get(c.module).push(c);
  }

  // An exam that currently runs straight after one of its module's classes
  // keeps doing so, since linked_group never covers exams.
  //
  // Deliberately narrow: only EXM rows, and only one partner each. A general
  // "same module, currently adjacent" rule looks reasonable and is not — modules
  // run parallel tutorial groups, so group 1 ending as group 2 begins is a
  // densely packed day, not a relationship. Chaining those transitively welds
  // half a module's Monday into one rigid train that cannot move at all.
  const preservedAdjacency = [];
  const takenExam = new Set();
  for (const group of byModule.values()) {
    for (const e of group) {
      if (e.activity !== 'EXM' || takenExam.has(e.id)) continue;
      // Prefer the class this exam follows; fall back to the one it precedes.
      let before = null, after = null;
      for (const o of group) {
        if (o === e || o.activity === 'EXM') continue;
        if (!(o.weeks & e.weeks)) continue;
        if (o.origDay !== e.origDay) continue;
        if (o.origStart + o.dur === e.origStart && !before) before = o;
        else if (e.origStart + e.dur === o.origStart && !after) after = o;
      }
      if (before) { preservedAdjacency.push([before.id, e.id]); takenExam.add(e.id); }
      else if (after) { preservedAdjacency.push([e.id, after.id]); takenExam.add(e.id); }
    }
  }

  // Exams sit in their module's usual slot only 12 times in 51 — 20 are same-day
  // at another time and 14 are on a different day. Rather than impose a
  // convention the timetable does not follow, each exam keeps the relationship
  // it already has: one that shares a day and start time with a sibling class
  // today keeps sharing them, so it follows the lecture if the lecture moves.
  const preservedSlot = [];
  for (const group of byModule.values()) {
    for (const e of group) {
      // An exam already tied by adjacency cannot also be tied to a start time.
      if (e.activity !== 'EXM' || takenExam.has(e.id)) continue;
      for (const o of group) {
        if (o === e || o.activity === 'EXM') continue;
        if (o.origDay === e.origDay && o.origStart === e.origStart) {
          preservedSlot.push([o.id, e.id]);
          break;
        }
      }
    }
  }

  // Linked groups, ordered by group_order: same day, contiguous, in order.
  const linkedGroups = new Map();
  for (const c of classes) {
    if (!c.linked) continue;
    if (!linkedGroups.has(c.linked)) linkedGroups.set(c.linked, []);
    linkedGroups.get(c.linked).push(c);
  }
  for (const g of linkedGroups.values()) g.sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    rooms, roomByName, classes, byId,
    cannotShareTime, cannotShareDay, cannotShareDayRaw,
    preservedAdjacency, preservedSlot,
    linkedGroups: [...linkedGroups.entries()].map(([key, members]) => ({ key, members })),
  };
}

module.exports = { load, DAYS, MAX_WEEK, toMin, fmtMin, weekMask, weekList, splitList };
