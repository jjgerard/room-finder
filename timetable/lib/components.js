'use strict';

// Classes are not independently movable. A linked group must run contiguously
// in order; an exam that follows its lecture must keep following it; an exam in
// its module's usual slot must keep that slot. These couplings chain — a
// lecture's seminar may itself have an exam pinned to it — so the movable unit
// is a whole connected component, not a class.
//
// Within a component every class holds a FIXED start offset from the
// component's anchor, and they all share a day. Solving then places the
// component once and the members follow, which makes strict back-to-back true
// by construction rather than something to repair afterwards.

// Union-find carrying, for each node, its start offset from the set's root.
function makeUF(n) {
  const parent = new Int32Array(n);
  const offset = new Int32Array(n); // start[x] = start[parent[x]] + offset[x]
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(x) {
    if (parent[x] === x) return { root: x, off: 0 };
    const up = find(parent[x]);
    parent[x] = up.root;
    offset[x] += up.off;
    return { root: parent[x], off: offset[x] };
  }

  // Assert start[b] - start[a] === delta. Returns false if that contradicts
  // what is already known, which means the input data is inconsistent.
  function union(a, b, delta) {
    const fa = find(a), fb = find(b);
    if (fa.root === fb.root) return fb.off - fa.off === delta;
    parent[fb.root] = fa.root;
    offset[fb.root] = fa.off + delta - fb.off;
    return true;
  }

  return { find, union };
}

function build(model) {
  const idx = new Map(model.classes.map((c, i) => [c.id, i]));
  const uf = makeUF(model.classes.length);
  const conflicts = [];

  const tie = (aId, bId, delta, why) => {
    const a = idx.get(aId), b = idx.get(bId);
    if (a === undefined || b === undefined) return;
    if (!uf.union(a, b, delta)) conflicts.push({ a: aId, b: bId, delta, why });
  };

  // Linked groups: each member starts exactly when the previous one ends.
  for (const g of model.linkedGroups) {
    for (let i = 0; i + 1 < g.members.length; i++) {
      tie(g.members[i].id, g.members[i + 1].id, g.members[i].dur, 'linked group ' + g.key);
    }
  }
  // Same-module pairs already back-to-back stay back-to-back.
  for (const [a, b] of model.preservedAdjacency) {
    tie(a, b, model.byId.get(a).dur, 'preserved adjacency');
  }
  // An exam in its module's usual slot keeps that slot (starts together).
  for (const [a, b] of model.preservedSlot) tie(a, b, 0, 'exam in usual slot');

  // Collect members per root.
  const groups = new Map();
  model.classes.forEach((c, i) => {
    const f = uf.find(i);
    if (!groups.has(f.root)) groups.set(f.root, []);
    groups.get(f.root).push({ cls: c, off: f.off });
  });

  const components = [];
  for (const members of groups.values()) {
    // Normalise so the earliest member sits at offset 0.
    const base = Math.min(...members.map(m => m.off));
    for (const m of members) m.off -= base;
    members.sort((x, y) => x.off - y.off);
    const span = Math.max(...members.map(m => m.off + m.cls.dur));
    const anchor = members[0].cls;
    components.push({
      id: components.length,
      members,                       // [{cls, off}]
      span,                          // total minutes from first start to last end
      origDay: anchor.origDay,
      origStart: anchor.origStart,   // start of the earliest member
      size: members.length,
    });
  }
  for (const comp of components) for (const m of comp.members) m.cls.component = comp.id;

  return { components, conflicts };
}

module.exports = { build, makeUF };
