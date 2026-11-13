// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Grow a warp grid by rings of cells (Live2D's "expand the warp deformer to its children, keeping the
// motion"): the grid gains whole cells on the sides asked, and every deformation of the grid gets the new
// points at the places the core already used for them. The core extends a grid past its edges by
// P[-1] = 2 P[0] - P[1] (core/src/ugo.c), so a ring written that way, in the rest pose and in every
// deformer's deltas, leaves the grid's surface over its old area as it was (exactly, for a grid carried by
// a bone; a grid inside another grid only nearly, with a warning). What lay outside, and only followed the
// edge's slope, is now inside cells and bends with them.
//
//   import { expandWarp, fitWarp } from './tools/warp_expand.mjs';
//   const { model } = expandWarp(src, 'face', { left: 1, right: 2, top: 0, bottom: 1 });
//   const { model, rings } = fitWarp(src, 'face');   // as many rings as the parts, grids and bones in it need
//
// The rectangle grows along the grid's own axes about the same cells (its angle stays). Plain ES module;
// a copy of the model is returned.

const DEG = Math.PI / 180;

/** Model space -> the grid's cell coordinates (as the compiler places them). */
function toCell(w, x, y) {
  const [x0, y0, ww, hh] = w.rect, a = (w.angle ?? 0) * DEG;
  let px = x, py = y;
  if (a) { const cx = x0 + ww / 2, cy = y0 + hh / 2, c = Math.cos(-a), s = Math.sin(-a), dx = x - cx, dy = y - cy; px = cx + c * dx - s * dy; py = cy + s * dx + c * dy; }
  return [(px - x0) / ww * w.cols, (py - y0) / hh * w.rows];
}

/** Grows one side by one ring: the points' grid (cols+1 x rows+1, row by row) of every deformation of w. */
function growOnce(model, w, side) {
  const C = w.cols + 1, R = w.rows + 1;
  const horizontal = side === 'left' || side === 'right';
  const C2 = horizontal ? C + 1 : C, R2 = horizontal ? R : R + 1;
  const grow = (pts) => { // pts: 2 floats per point, C x R -> C2 x R2, the new ring = 2 edge - next
    const out = new Array(2 * C2 * R2);
    const at = (i, j) => 2 * (j * C + i);
    for (let j = 0; j < R2; j++) for (let i = 0; i < C2; i++) {
      let si = i, sj = j, ext = null;
      if (side === 'left') { si = i - 1; if (i === 0) ext = [at(0, j), at(1, j)]; }
      if (side === 'right' && i === C) ext = [at(C - 1, j), at(C - 2, j)];
      if (side === 'top') { sj = j - 1; if (j === 0) ext = [at(i, 0), at(i, 1)]; }
      if (side === 'bottom' && j === R) ext = [at(i, R - 1), at(i, R - 2)];
      for (let k = 0; k < 2; k++) out[2 * (j * C2 + i) + k] = ext ? 2 * pts[ext[0] + k] - pts[ext[1] + k] : pts[at(si, sj) + k];
    }
    return out;
  };
  // the deformers' point deltas (dense, or a few points: made dense)
  for (const d of model.deformers || []) {
    const wo = d.warps?.[w.id];
    if (!wo) continue;
    let dense = wo.dense;
    if (!Array.isArray(dense)) {
      dense = new Array(2 * C * R).fill(0);
      (wo.points || []).forEach((p, n) => { dense[2 * p] = wo.deltas[2 * n]; dense[2 * p + 1] = wo.deltas[2 * n + 1]; });
    }
    d.warps[w.id] = { dense: grow(dense) };
  }
  // the rectangle, one cell more on that side (along the grid's own axes; the centre moves with it)
  const cw = w.rect[2] / w.cols, ch = w.rect[3] / w.rows, a = (w.angle ?? 0) * DEG;
  const [x0, y0, ww, hh] = w.rect, cx = x0 + ww / 2, cy = y0 + hh / 2;
  const shift = { left: [-cw / 2, 0], right: [cw / 2, 0], top: [0, -ch / 2], bottom: [0, ch / 2] }[side];
  const nx = cx + Math.cos(a) * shift[0] - Math.sin(a) * shift[1], ny = cy + Math.sin(a) * shift[0] + Math.cos(a) * shift[1];
  const nw = horizontal ? ww + cw : ww, nh = horizontal ? hh : hh + ch;
  w.rect = [nx - nw / 2, ny - nh / 2, nw, nh];
  if (horizontal) w.cols++; else w.rows++;
}

/** Grows grid `warpId` by rings of cells: { left, right, top, bottom } (whole numbers). */
export function expandWarp(src, warpId, rings = {}) {
  const model = structuredClone(src);
  const w = (model.warps || []).find((g) => g.id === warpId);
  if (!w) throw new Error(`ugo warp expand: no warp "${warpId}"`);
  const warnings = [];
  if (w.parent != null) warnings.push(`warp ${warpId} is inside warp ${w.parent}: its surface over the old area stays only nearly the same`);
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const n = rings[side] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 64) throw new Error(`ugo warp expand: ${side} must be a whole number 0..64`);
    for (let k = 0; k < n; k++) growOnce(model, w, side);
  }
  if (w.cols > 64 || w.rows > 64) throw new Error(`ugo warp expand: warp ${warpId} would have ${w.cols} x ${w.rows} cells (64 at most)`);
  return { model, warnings };
}

/** As many rings as the parts, nested grids and bones in grid `warpId` need to lie inside it. */
export function fitWarp(src, warpId, { margin = 0 } = {}) {
  const w = (src.warps || []).find((g) => g.id === warpId);
  if (!w) throw new Error(`ugo warp expand: no warp "${warpId}"`);
  let x0 = 0, y0 = 0, x1 = w.cols, y1 = w.rows;
  const see = (x, y) => { const [cx, cy] = toCell(w, x, y); x0 = Math.min(x0, cx - margin); y0 = Math.min(y0, cy - margin); x1 = Math.max(x1, cx + margin); y1 = Math.max(y1, cy + margin); };
  for (const p of src.parts || []) if (p.warp === warpId) for (let k = 0; k < p.vertices.length; k += 2) see(p.vertices[k], p.vertices[k + 1]);
  for (const g of src.warps || []) if (g.parent === warpId) { const [gx, gy, gw, gh] = g.rect; see(gx, gy); see(gx + gw, gy); see(gx, gy + gh); see(gx + gw, gy + gh); }
  for (const b of src.bones || []) if (b.warp === warpId) see(b.x ?? 0, b.y ?? 0);
  const rings = { left: Math.ceil(-x0), right: Math.ceil(x1 - w.cols), top: Math.ceil(-y0), bottom: Math.ceil(y1 - w.rows) };
  return { ...expandWarp(src, warpId, rings), rings };
}
