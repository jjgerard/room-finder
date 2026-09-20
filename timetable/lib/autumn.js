'use strict';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Autumn 2026, shaped like the spring class file so the rest of the model can
// treat both terms identically.
//
// Spring arrives as belfast_classes.csv: one row per class, already carrying
// programmes, a size estimate, linked groups and candidate rooms, with the
// cohort and same-day conflict pairs in files beside it. Autumn exists only in
// terms.json, which is one row per class-ROOM booking and carries none of
// that. Everything missing here is derived the same way the spring file's own
// authors must have derived it, and every derivation is marked so the site can
// say which figures are read and which are inferred.

/** "CMM115_S1/SEM/CAM 2" → the booking it belongs to. */
function bookingsFrom(rows) {
  const byTitle = new Map();
  for (const r of rows) {
    const key = r[2] + '|' + r[3] + '|' + r[4] + '|' + r[5] + '|' + r[8];
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(r);
  }
  return byTitle;
}

/**
 * Autumn's bookings as class rows in the spring file's shape.
 *
 * @param terms  the parsed terms.json
 * @param rooms  the room inventory, for capacity and type
 */
function autumnRows(terms, rooms) {
  const rows = (terms.autumn || {}).rows || [];
  const degrees = terms.degrees || [];
  const mod = terms.mod || {};
  const out = [];
  let id = 0;

  for (const [, group] of bookingsFrom(rows)) {
    const first = group[0];
    // A booking split across rooms is one class in one room here, as in the
    // spring file, and the number of rooms is kept so the site can say it was
    // split. The room it keeps is the FIRST one listed, not the biggest:
    // choosing the biggest funnelled hundreds of bookings into the same few
    // large rooms and invented five thousand clashes that are not in the
    // timetable at all.
    const used = [...new Set(group.map(r => r[6]))];
    const dominant = rooms[first[6]];
    if (!dominant) continue;

    const entry = mod[first[0]] || null;
    const progs = entry ? (entry[0] || []).map(i => degrees[i]).filter(Boolean) : [];

    out.push({
      class_id: String(id++),
      module: first[0] || '',
      activity: first[1] || 'OTH',
      title: first[2] || '',
      programmes: progs.join(';'),
      n_programmes: String(progs.length),
      year_level: '',
      // The same proxy spring uses, and marked as such: the room a class sits
      // in stands in for its cohort.
      size_estimate: String(dominant.capacity || 0),
      size_basis: 'room_capacity_proxy',
      // The class file names the day; terms.json numbers it.
      current_day: DAYS[first[3]] || '',
      current_start: fmt(first[4]),
      current_end: fmt(first[4] + first[5]),
      duration_min: String(first[5]),
      current_room: dominant.name,
      current_room_type: dominant.type,
      current_room_capacity: String(dominant.capacity || 0),
      n_current_rooms: String(used.length),
      is_multi_room: used.length > 1 ? '1' : '0',
      weeks: String(first[8] || ''),
      n_weeks: String(first[7] || 0),
      is_teaching: first[0] ? '1' : '0',
      is_block_teaching: first[5] >= 300 ? '1' : '0',
      recommend_offsite: '0',
      // Linked groups are declared in the spring file and absent here, so they
      // are inferred from the timetable itself: a module's sessions that
      // already run back-to-back on one day are treated as a group that must
      // stay that way. That is weaker than a declaration — it can only
      // preserve what is already contiguous, never discover a pair that ought
      // to be — and it is the honest reading of what autumn tells us.
      linked_group: '',
      group_order: '',
      n_candidate_rooms: '0',
      candidate_rooms: '',
    });
  }

  linkAdjacent(out);
  return out;
}

function fmt(v) {
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

function toMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

/** Sessions of one module that already run back-to-back become a linked group. */
function linkAdjacent(rows) {
  const byModuleDay = new Map();
  for (const r of rows) {
    if (!r.module) continue;
    const k = r.module + '|' + r.current_day + '|' + r.weeks;
    if (!byModuleDay.has(k)) byModuleDay.set(k, []);
    byModuleDay.get(k).push(r);
  }
  let group = 0;
  for (const [, list] of byModuleDay) {
    if (list.length < 2) continue;
    list.sort((a, b) => toMin(a.current_start) - toMin(b.current_start));
    let chain = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const prev = chain[chain.length - 1];
      const touching = toMin(prev.current_start) + Number(prev.duration_min) ===
        toMin(list[i].current_start);
      if (touching) { chain.push(list[i]); continue; }
      if (chain.length > 1) stamp(chain, ++group);
      chain = [list[i]];
    }
    if (chain.length > 1) stamp(chain, ++group);
  }
}

function stamp(chain, group) {
  chain.forEach((r, i) => {
    r.linked_group = 'A' + group;
    r.group_order = String(i + 1);
  });
}

module.exports = { autumnRows };
