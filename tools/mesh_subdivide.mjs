// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Finer mesh where it is needed (an editor's "subdivide", Live2D's mesh refinement): the chosen triangles of a
// part are each split into four at their edges' middles. A neighbour that shares a split edge is split in two
// there, so the mesh stays closed (no cracks).
//
//   import { subdivide } from './tools/mesh_subdivide.mjs';
//   const { model, added } = subdivide(src, 'face', [0, 5, 6]);   // triangle numbers (triangles[3t..3t+2])
//
// New points go after the part's vertices, so every number already used for its vertices (morph lists,
// glue pairs, editor selections) keeps its meaning. A new point takes the middle of its edge in every
// per-vertex value: position, UV, weights (each bone's weight averaged, then the list renormalised) and
// each morph's delta (a sparse morph gains the new point where either end moves). A part in a warp grid
// is split the same way (its positions are model space, as written). Plain ES module; a copy is returned.

export function subdivide(src, partId, triangleNumbers) {
  const model = structuredClone(src);
  const part = (model.parts || []).find((p) => p.id === partId);
  if (!part) throw new Error(`ugo subdivide: no part "${partId}"`);
  const tri = part.triangles, nt = tri.length / 3, nv0 = part.vertices.length / 2;
  const chosen = new Set(triangleNumbers.filter((t) => Number.isInteger(t) && t >= 0 && t < nt));
  if (!chosen.size) return { model, added: 0 };
  const mid = new Map(); // "a,b" (a < b) -> new vertex
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const ends = []; // new vertex -> [a, b]
  const middle = (a, b) => {
    const k = key(a, b);
    if (!mid.has(k)) { mid.set(k, nv0 + ends.length); ends.push([a, b]); }
    return mid.get(k);
  };
  // the chosen triangles: four each
  const out = [];
  for (let t = 0; t < nt; t++) {
    if (!chosen.has(t)) continue;
    const [a, b, c] = tri.slice(3 * t, 3 * t + 3), ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
    out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  // the others: split in two (or three, four) where an edge of theirs was split, keeping their winding
  for (let t = 0; t < nt; t++) {
    if (chosen.has(t)) continue;
    const [a, b, c] = tri.slice(3 * t, 3 * t + 3);
    const m = [[a, b], [b, c], [c, a]].map(([x, y]) => mid.get(key(x, y)));
    const split = m.filter((x) => x !== undefined).length;
    if (!split) out.push([a, b, c]);
    else if (split === 3) out.push([a, m[0], m[2]], [m[0], b, m[1]], [m[2], m[1], c], [m[0], m[1], m[2]]);
    else if (split === 1) {
      const e = m.findIndex((x) => x !== undefined), v = [a, b, c], p = v[e], q = v[(e + 1) % 3], r = v[(e + 2) % 3];
      out.push([p, m[e], r], [m[e], q, r]);
    } else { // two edges: a fan from the corner between the split ones
      const e = m.findIndex((x) => x === undefined), v = [a, b, c], p = v[e], q = v[(e + 1) % 3], r = v[(e + 2) % 3];
      const mq = m[(e + 1) % 3], mr = m[(e + 2) % 3]; // q-r and r-p
      out.push([p, q, mq], [p, mq, mr], [mq, r, mr]);
    }
  }
  part.triangles = out.flat();
  // per-vertex values at the middles
  const half = (arr, n) => { for (const [a, b] of ends) for (let k = 0; k < n; k++) arr.push((arr[n * a + k] + arr[n * b + k]) / 2); };
  half(part.vertices, 2);
  if (Array.isArray(part.uvs)) half(part.uvs, 2);
  if (Array.isArray(part.weights)) for (const [a, b] of ends) {
    const sum = new Map();
    for (const [bone, w] of [...part.weights[a], ...part.weights[b]]) sum.set(bone, (sum.get(bone) || 0) + w / 2);
    const total = [...sum.values()].reduce((x, y) => x + y, 0) || 1;
    part.weights.push([...sum].map(([bone, w]) => [bone, w / total]));
  }
  for (const d of model.deformers || []) {
    const mo = d.morphs?.[partId];
    if (!mo) continue;
    if (Array.isArray(mo.dense)) half(mo.dense, 2);
    else if (Array.isArray(mo.vertices)) {
      const at = new Map(mo.vertices.map((v, i) => [v, i]));
      ends.forEach(([a, b], i) => {
        const da = at.has(a) ? mo.deltas.slice(2 * at.get(a), 2 * at.get(a) + 2) : [0, 0];
        const db = at.has(b) ? mo.deltas.slice(2 * at.get(b), 2 * at.get(b) + 2) : [0, 0];
        if (!at.has(a) && !at.has(b)) return;
        mo.vertices.push(nv0 + i);
        mo.deltas.push((da[0] + db[0]) / 2, (da[1] + db[1]) / 2);
      });
    }
  }
  return { model, added: ends.length };
}
