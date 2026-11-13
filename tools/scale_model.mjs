// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The whole model k times as large, meshes and all (a PSD redrawn at another size: the meshes,
// grids, bones and keys made on the old one are kept, scaled to the new one). Plain ES module.
//
//   import { scaleModel } from '../tools/scale_model.mjs';
//   const half = scaleModel(model, 0.5);   // model is not changed
//
// Every value in px is multiplied by k (the model's (0, 0) stays where it is): the canvas, the
// vertices, the morphs, the bones' x / y / length, the transform constraints' x / y, the warp
// grids' rect and their moves, the animation's bone x / y keys, the chains' gravity (px/s²), and
// the sphere / cylinder shapes the editor keeps (editor.shapes: center, radius). Angles, scales,
// UVs, weights, opacity, colours, parameters and times stay as they are, so the drawn picture is
// the same picture, k times as large. `source` (the import's own record) is not touched: the
// editor decides what a re-read PSD of the new size means there.

const scaleList = (a, k) => (Array.isArray(a) ? a.map((v) => v * k) : a);
// a key [t, v, interp, ...]: its value, and a curve key's value handles cy1, cy2 ([t, v, "bezier", cx1, cy1, cx2, cy2], format 1.1)
const scaleKeys = (keys, k) => (Array.isArray(keys) ? keys.map(([t, v, ...rest]) => (rest[0] === 'bezier' ? [t, v * k, 'bezier', rest[1], rest[2] * k, rest[3], rest[4] * k, ...rest.slice(5)] : [t, v * k, ...rest])) : keys);
// a morph / warp move: { dense } or { vertices | points, deltas }
const scaleMove = (m, k) => { if (m.dense) m.dense = scaleList(m.dense, k); if (m.deltas) m.deltas = scaleList(m.deltas, k); };

/** model (working JSON) -> a new model k times as large (k > 0). */
export function scaleModel(model, k) {
  if (!(k > 0) || !Number.isFinite(k)) throw new Error(`scaleModel: k must be a positive number (got ${k})`);
  const m = structuredClone(model);
  if (m.canvas) for (const f of ['width', 'height', 'originX', 'originY']) if (typeof m.canvas[f] === 'number') m.canvas[f] *= k;
  for (const p of m.parts || []) p.vertices = scaleList(p.vertices, k);
  for (const b of m.bones || []) for (const f of ['x', 'y', 'length']) if (typeof b[f] === 'number') b[f] *= k;
  for (const c of m.constraints || []) if (c.type === 'transform') for (const f of ['x', 'y']) if (typeof c[f] === 'number') c[f] *= k;
  for (const w of m.warps || []) w.rect = scaleList(w.rect, k);
  for (const d of m.deformers || []) {
    for (const mv of Object.values(d.morphs || {})) scaleMove(mv, k);
    for (const mv of Object.values(d.warps || {})) scaleMove(mv, k);
    for (const b of Object.values(d.bones || {})) for (const f of ['x', 'y']) if (typeof b[f] === 'number') b[f] *= k;
  }
  for (const ch of m.chains || []) if (ch.gravity) ch.gravity = scaleList(ch.gravity, k);
  for (const a of m.animations || []) for (const tracks of Object.values(a.bones || {})) for (const f of ['x', 'y']) if (tracks[f]) tracks[f] = scaleKeys(tracks[f], k);
  for (const s of m.editor?.shapes || []) { if (s.center) s.center = scaleList(s.center, k); if (s.radius) s.radius = scaleList(s.radius, k); }
  return m;
}
