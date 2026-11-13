// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Weight tools (an editor's weight menu; Spine's smooth / prune / swap, bone locks): on a part's per-vertex
// weights in the authoring JSON, [[["boneA", 0.7], ["boneB", 0.3]], ...] (docs/形式.md, parts[].weights).
//
//   import { editWeights } from './tools/weights.mjs';
//   const model = editWeights(src, 'arm', 'smooth', { iterations: 2, locked: ['hand'] });
//
// Operations (each keeps every vertex's weights summing to 1, and never changes a locked bone's weight):
//   smooth  { iterations = 1, amount = 0.5, vertices }  each vertex moves amount of the way to the mean of
//                                                       its neighbours on the mesh's edges
//   prune   { threshold = 0.01, vertices }              weights below the threshold go
//   limit   { count = 4, vertices }                     only the strongest count bones per vertex stay
//   swap    { a, b, vertices }                          bone a's weights go to b and b's to a
//   normalize { vertices }                              sums made 1 again
// A part fixed to one bone (parts[].bone) is first written as weights of 1 on it. vertices limits the work
// to those vertex numbers. Plain ES module; a copy of the model is returned.

const asMap = (list) => new Map((list || []).map(([b, w]) => [b, w]));
const asList = (m) => [...m].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1]);

/** Weights summing to 1, the locked bones' weights kept as they are (the others share what is left). */
function settle(m, lockedSet) {
  let locked = 0, free = 0;
  for (const [b, w] of m) (lockedSet.has(b) ? (locked += w) : (free += w));
  const room = Math.max(0, 1 - locked);
  if (free > 0) for (const [b, w] of m) if (!lockedSet.has(b)) m.set(b, (w / free) * room);
  return m;
}

function neighbours(part) {
  const n = part.vertices.length / 2, out = Array.from({ length: n }, () => new Set());
  const t = part.triangles || [];
  for (let k = 0; k < t.length; k += 3) for (let e = 0; e < 3; e++) { const a = t[k + e], b = t[k + (e + 1) % 3]; out[a].add(b); out[b].add(a); }
  return out;
}

/** One operation on a part (changed in place). */
export function editPartWeights(part, op, o = {}) {
  const n = part.vertices.length / 2;
  if (!Array.isArray(part.weights)) {
    if (part.warp != null) throw new Error(`ugo weights: part ${part.id} is in a warp grid (it has no weights)`);
    part.weights = Array.from({ length: n }, () => (part.bone != null ? [[part.bone, 1]] : []));
    delete part.bone;
  }
  const lockedSet = new Set(o.locked || []);
  const which = o.vertices ? o.vertices.filter((v) => v >= 0 && v < n) : Array.from({ length: n }, (_, i) => i);
  if (op === 'smooth') {
    const near = neighbours(part), amount = o.amount ?? 0.5;
    for (let it = 0; it < (o.iterations ?? 1); it++) {
      const before = part.weights.map(asMap), next = new Map();
      for (const v of which) {
        if (!near[v].size) continue;
        const mean = new Map();
        for (const u of near[v]) for (const [b, w] of before[u]) mean.set(b, (mean.get(b) || 0) + w / near[v].size);
        const m = new Map(before[v]);
        for (const b of new Set([...m.keys(), ...mean.keys()])) {
          if (lockedSet.has(b)) continue;
          m.set(b, (m.get(b) || 0) + ((mean.get(b) || 0) - (m.get(b) || 0)) * amount);
        }
        next.set(v, asList(settle(m, lockedSet)));
      }
      for (const [v, list] of next) part.weights[v] = list;
    }
  } else if (op === 'prune' || op === 'limit') {
    for (const v of which) {
      const m = asMap(part.weights[v]);
      const keep = op === 'prune'
        ? [...m].filter(([b, w]) => w >= (o.threshold ?? 0.01) || lockedSet.has(b))
        : [...m].sort((x, y) => y[1] - x[1]).filter(([b], i) => i < (o.count ?? 4) || lockedSet.has(b));
      if (!keep.length) continue; // never leave a vertex without a bone
      part.weights[v] = asList(settle(new Map(keep), lockedSet));
    }
  } else if (op === 'swap') {
    if (o.a == null || o.b == null) throw new Error('ugo weights: swap needs a and b');
    for (const v of which) part.weights[v] = asList(new Map(part.weights[v].map(([b, w]) => [b === o.a ? o.b : b === o.b ? o.a : b, w])));
  } else if (op === 'normalize') {
    for (const v of which) part.weights[v] = asList(settle(asMap(part.weights[v]), lockedSet));
  } else throw new Error(`ugo weights: unknown operation "${op}"`);
  return part;
}

/** The same on a model's part by id: a copy of the model. */
export function editWeights(src, partId, op, o = {}) {
  const model = structuredClone(src);
  const part = (model.parts || []).find((p) => p.id === partId);
  if (!part) throw new Error(`ugo weights: no part "${partId}"`);
  editPartWeights(part, op, o);
  return model;
}
