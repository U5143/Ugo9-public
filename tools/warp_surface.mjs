// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The core's warp surface in JS (core/src/ugo.c warp_eval), for tools that bake moves into warp
// grids (face_angles.mjs, sphere_bake.mjs).

// the core's warp surface (core/src/ugo.c warp_eval): net = the control points [x, y] row by row;
// one more ring P[-1] = 2 P[0] - P[1]; uniform cubic B-spline; straight on past the edges
const bspline = (t) => { const s = 1 - t, t2 = t * t, t3 = t2 * t; return [s * s * s / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6]; };
const bsplineD = (t) => { const s = 1 - t; return [-0.5 * s * s, -2 * t + 1.5 * t * t, 0.5 + t - 1.5 * t * t, 0.5 * t * t]; };
export function extend(net, cols, rows) {
  const W = cols + 3, H = rows + 3, E = new Array(W * H);
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) E[(j + 1) * W + i + 1] = net[j * (cols + 1) + i];
  const lin = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  for (let b = 1; b < H - 1; b++) { E[b * W] = lin(E[b * W + 1], E[b * W + 2]); E[b * W + W - 1] = lin(E[b * W + W - 2], E[b * W + W - 3]); }
  for (let a = 0; a < W; a++) { E[a] = lin(E[W + a], E[2 * W + a]); E[(H - 1) * W + a] = lin(E[(H - 2) * W + a], E[(H - 3) * W + a]); }
  return { E, W, cols, rows };
}
export function surface({ E, W, cols, rows }, x, y) {
  const qx = Math.min(Math.max(x, 0), cols), qy = Math.min(Math.max(y, 0), rows);
  const cx = Math.min(Math.floor(qx), cols - 1), cy = Math.min(Math.floor(qy), rows - 1);
  const bu = bspline(qx - cx), bv = bspline(qy - cy), ex = x - qx, ey = y - qy;
  const du = ex ? bsplineD(qx - cx) : null, dv = ey ? bsplineD(qy - cy) : null;
  let ox = 0, oy = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const P = E[(cy + j) * W + cx + i];
    const w = bu[i] * bv[j] + (du ? du[i] * bv[j] * ex : 0) + (dv ? bu[i] * dv[j] * ey : 0);
    ox += w * P[0]; oy += w * P[1];
  }
  return [ox, oy];
}
// a point (cell coordinates, inside the grid) as weights of the control points: the surface is
// linear in them (the outer ring too) -> Map(control point index -> weight)
export function surfaceWeights(cols, rows, u, v) {
  const out = new Map(), qx = Math.min(Math.max(u, 0), cols), qy = Math.min(Math.max(v, 0), rows);
  const cx = Math.min(Math.floor(qx), cols - 1), cy = Math.min(Math.floor(qy), rows - 1), bu = bspline(qx - cx), bv = bspline(qy - cy);
  const ext = (a, n) => (a === 0 ? [[0, 2], [1, -1]] : a === n + 2 ? [[n, 2], [n - 1, -1]] : [[a - 1, 1]]); // extended index -> control points
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const c = bu[i] * bv[j];
    for (const [ii, ci] of ext(cx + i, cols)) for (const [jj, cj] of ext(cy + j, rows)) { const k = jj * (cols + 1) + ii; out.set(k, (out.get(k) || 0) + c * ci * cj); }
  }
  return out;
}
// the cell point the surface puts at target (Newton's method, numeric slope)
export function solveCell(net, target, start) {
  let [u, v] = start;
  for (let it = 0; it < 30; it++) {
    const [x, y] = surface(net, u, v), fx = x - target[0], fy = y - target[1];
    if (Math.abs(fx) + Math.abs(fy) < 1e-7) break;
    const h = 1e-4, [xu, yu] = surface(net, u + h, v), [xv, yv] = surface(net, u, v + h);
    const a = (xu - x) / h, b = (xv - x) / h, c = (yu - y) / h, d = (yv - y) / h, det = a * d - b * c;
    if (!det) break;
    u -= (d * fx - b * fy) / det; v -= (-c * fx + a * fy) / det;
  }
  return [u, v];
}

