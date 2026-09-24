'use strict';

// Attaching a saved solution to a model.
//
// A solution is a list of placements, and each one has to find the class it
// belongs to. Doing that by class id looks obvious and is wrong: an autumn
// class id is `id++` over the rows of terms.json, so refreshing the current
// timetable shifts every id after the first change and each placement lands on
// a different class. In a test, moving 40 bookings took the rebuilt term from
// 0 hard violations to 7,263 — not because the rebuild had become invalid, but
// because it was being read against the wrong classes.
//
// That is worth being precise about, because the two are easy to confuse. A
// rebuilt timetable breaks no rule as a fact about ITSELF: its own classes, in
// its own rooms, at its own times. Refreshing what the timetabling team has
// booked cannot change that. What a refresh does change is which classes exist
// — so afterwards some placements have no class and some classes have no
// placement, and the honest report is those few, not thousands of phantom
// clashes.
//
// So join on something that describes the class rather than its position. Each
// row carries the slot the class sat in when it was solved, and
// title + day + start + room is unique for all 1,870 spring classes and all
// but two of autumn's 2,261. The two that collide fall back to pairing in the
// order they appear, and the id is the last resort.

const key = (title, day, start, room) => [title, day, start, room].join('\u0000');

/**
 * @param model  the model to attach to
 * @param rows   solution rows, each {id, title, was:{day,start,room}, …}
 * @returns {placed, missing, orphans}
 *   placed   Map class id -> row
 *   missing  classes with no placement (new since the solution was written)
 *   orphans  rows with no class (gone since)
 */
function join(model, rows) {
  // Index the model by the stable key, keeping duplicates in order.
  const byKey = new Map();
  for (const c of model.classes) {
    const k = key(c.title, c.origDay, c.origStart, c.origRoom);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }

  const placed = new Map();
  const orphans = [];
  const taken = new Set();

  for (const r of rows) {
    const w = r.was || {};
    const list = byKey.get(key(r.title, w.day, w.start, w.room));
    const c = list && list.find(x => !taken.has(x.id));
    if (c) { placed.set(c.id, r); taken.add(c.id); continue; }
    // Older solutions, and the handful of rows whose key is shared, fall back
    // to the id — but only when it names a class with the same title, so a
    // shifted id cannot quietly claim somebody else's placement.
    const byId = model.byId.get(r.id);
    if (byId && !taken.has(byId.id) && byId.title === r.title) {
      placed.set(byId.id, r);
      taken.add(byId.id);
      continue;
    }
    orphans.push(r);
  }

  const missing = model.classes.filter(c => !placed.has(c.id));
  return { placed, missing, orphans };
}

module.exports = { join, key };
