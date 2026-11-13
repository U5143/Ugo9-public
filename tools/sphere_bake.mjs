// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Sphere and cylinder deformers baked into what the format already has (docs/球体デフォーマ.md):
// the keyforms of a warp grid, and for parts with a depth (parallax) morphs of those parts.
// Plain ES module: the editor's sphere tool calls it with one of model.editor.shapes.
//
//   import { makeSphereBake } from '../tools/sphere_bake.mjs';
//   const { motions, keys, params, notes, warnings } = makeSphereBake(model, shape);
//   // shape: { id, type: 'sphere' | 'cylinder', center, radius, depth, exact, falloff,
//   //          params: { x, y }, turn: { x, y }, step, axis, target: { warp } }
//   // motions: [{ at: { AngleX: 10 }, warps: { face: { dense } }, morphs: { eyeL: { dense } } }, ...]
//
// How it follows a real sphere (makeFaceAngles was off by up to 9 % of the radius):
// - up to `exact` radii the points move exactly as on the turned ellipsoid; from there to
//   `falloff` radii the depth goes down to 0 along a curve that keeps its slope, and what a turning
//   flat plane would add (its shrinking) is taken off bit by bit; past `falloff` nothing moves
// - a key every `step` degrees on each axis, and at every crossing the two-axis correction (the
//   shape there minus the two single turns): with regions between neighbour keys the in-between
//   angles are bilinear between the four keys around them
// - the control points are solved by least squares, so that the grid's surface (its control
//   points are not on it) puts the points where the turn puts them
// - grids inside the target grid follow through its surface; parts with a depth
//   (model.editor.depth, a part of the radius, nearer is positive) get a morph at each key along
//   the axes, and the two-axis correction at the crossings, that put their vertices, through the
//   grids, where the raised surface turns to (shape.depthCorners: false leaves the crossings out:
//   12 morphs a vertex instead of 48, but 3.6 % off at 30° / 30°)

import { makeNotes } from './notes.mjs';
import { extend, surface, solveCell, surfaceWeights } from './warp_surface.mjs';

const D = Math.PI / 180;
const smooth = (t) => (t <= 0 ? 1 : t >= 1 ? 0 : 1 - t * t * (3 - 2 * t)); // 1 -> 0, flat at both ends

/** The shape's depth at (x, y) (px) and how much of the move is kept there (0..1).
 *  sphere: r = the distance from the centre in radii; cylinder: r = the distance from its axis. */
export function shapeField(x, y, shape) {
  const { center: [cx, cy], radius: [rx, ry], exact = 0.9, falloff = 1.6 } = shape;
  const depth = (shape.depth ?? 0.6) * rx;
  let r;
  if (shape.type === 'cylinder') { const a = (shape.axis || 0) * D; r = Math.abs((x - cx) * Math.cos(a) + (y - cy) * Math.sin(a)) / rx; }
  else r = Math.hypot((x - cx) / rx, (y - cy) / ry);
  let z;
  if (r <= exact) z = depth * Math.sqrt(1 - r * r);
  else if (r >= falloff) z = 0;
  else { // a cubic from the ellipsoid's value and slope at `exact` down to 0 (flat) at `falloff`
    const z0 = depth * Math.sqrt(1 - exact * exact), slope = (-depth * exact) / Math.sqrt(1 - exact * exact), L = falloff - exact, t = (r - exact) / L;
    z = Math.max(0, (2 * t ** 3 - 3 * t * t + 1) * z0 + (t ** 3 - 2 * t * t + t) * slope * L);
  }
  return { z, keep: smooth((r - exact) / (falloff - exact)) };
}

/** Where the rest point (x, y), raised by `lift` px, goes when the shape turns by yaw (to +x) and
 *  pitch (to -y, up); a cylinder turns about its axis only (yaw). */
export function shapeTurn([x, y], yaw, pitch, shape, lift = 0) {
  const { z, keep } = shapeField(x, y, shape), [cx, cy] = shape.center;
  const rot = (Z) => {
    let X = x - cx, Y = y - cy;
    if (shape.type === 'cylinder') {
      const a = (shape.axis || 0) * D, u = X * Math.cos(a) + Y * Math.sin(a), v = -X * Math.sin(a) + Y * Math.cos(a);
      const u2 = u * Math.cos(yaw) + Z * Math.sin(yaw);
      return [u2 * Math.cos(a) - v * Math.sin(a) + cx, u2 * Math.sin(a) + v * Math.cos(a) + cy];
    }
    [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)];
    [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)];
    return [X + cx, Y + cy];
  };
  // the turned point, less (outside the exact part, gradually) what turning a flat plane would do:
  // past the falloff the depth is 0 and that is all of the move, so nothing moves there
  const t = rot(z + lift * keep), f = keep < 1 ? rot(0) : null;
  return f ? [t[0] - (1 - keep) * (f[0] - x), t[1] - (1 - keep) * (f[1] - y)] : t;
}

// symmetric positive matrix (n x n) -> a solver for A x = b (Cholesky)
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j * n + j];
  }
  return (b) => {
    const y = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
  };
}

// keys along one axis: every `step` degrees out to the full turn at both ends -> [[value, degrees]]
function axisKeys([min, def, max], turn, step) {
  const keys = [[def, 0]];
  for (const [end, sign] of [[max, 1], [min, -1]]) {
    if (end === def || !turn) continue;
    const n = Math.max(1, Math.ceil(turn / step - 1e-9));
    for (let k = 1; k <= n; k++) { const deg = Math.min(turn, k * step); keys.push([+(def + ((end - def) * deg) / turn).toFixed(6), sign * deg]); }
  }
  return keys.sort((a, b) => a[0] - b[0]);
}

/** Stretches up to this much (|scale - 1|) are baked as their own keys added to the turn's; past
 *  it (or with shape.stretch.exact) the turn and the stretch are baked together on a 3-axis key
 *  grid with the angles every 15° (accurate, about 3 x the data). */
export const STRETCH_ADD_LIMIT = 0.05;

/**
 * model: working JSON (format 0.5+); shape: one of model.editor.shapes (see the top). Also reads
 * model.editor.depth ({ partId: depth as a part of the radius }) for the parts in the target grids.
 * shape.stretch (optional): { param, scale: [sx, sy] at the parameter's max (its min mirrors it), exact }.
 * shape.depthStep: degrees between the depth morphs' keys (default 15; they are motions of their own).
 * -> { motions, keys: { [param]: [values] }, params, notes, warnings }
 */
export function makeSphereBake(model, shape) {
  const { warnings, notes, note } = makeNotes();
  const warps = model.warps || [];
  const grid = warps.find((w) => w.id === shape.target?.warp);
  if (!grid) throw new Error(`shape ${shape.id}: no target grid ${shape.target?.warp}`);
  const tree = [grid];
  for (let k = 0; k < tree.length; k++) for (const w of warps) if (shape.nested !== false && w.parent === tree[k].id && !tree.includes(w)) tree.push(w);
  const amount = shape.amount ?? 1;
  // a rest point moved by the shape: stretched (radii x S inside, fading out like the turn), then turned
  const moveAt = (p, yaw, pitch, S = [1, 1], lift = 0) => {
    let q = p, sh = shape;
    if (S[0] !== 1 || S[1] !== 1) {
      const k = shapeField(p[0], p[1], shape).keep, [cx, cy] = shape.center;
      q = [cx + (p[0] - cx) * (1 + (S[0] - 1) * k), cy + (p[1] - cy) * (1 + (S[1] - 1) * k)];
      sh = { ...shape, radius: [shape.radius[0] * S[0], shape.radius[1] * S[1]] };
    }
    const t = shapeTurn(q, yaw, pitch, sh, lift);
    return amount === 1 ? t : [p[0] + (t[0] - p[0]) * amount, p[1] + (t[1] - p[1]) * amount];
  };
  const cyl = shape.type === 'cylinder';
  // the standard names (docs/パラメータの名前.md) unless the model has only the older ones
  const hasP = (id) => (model.parameters || []).some((q) => q.id === id), pick = (std, old) => (!hasP(std) && hasP(old) ? old : std);
  const px = shape.params?.x || pick('HeadTurnX', 'AngleX'), py = cyl ? null : shape.params?.y || pick('HeadTurnY', 'AngleY');
  const params = [];
  const range = (id) => {
    const p = (model.parameters || []).find((q) => q.id === id);
    if (!p) { params.push([id, -30, 0, 30]); note('paramMissing', { param: id, min: -30, default: 0, max: 30 }, `no parameter ${id}: keys made for -30 and 30 (add the parameter)`); }
    return p ? [p.min, p.default ?? 0, p.max] : [-30, 0, 30];
  };
  // the stretch: its own keys added to the turn's, or (big or exact) a third axis with the angles every 15°
  const st = shape.stretch?.param ? shape.stretch : null;
  let full = false, sKeys = null;
  if (st) {
    const [smin, sdef, smax] = range(st.param), sc = st.scale || [1, 1], mirror = sc.map((v) => 2 - v);
    sKeys = [[smin, mirror], [sdef, [1, 1]], [smax, sc]].filter(([v], i, a) => i === 1 || v !== sdef).sort((a, b) => a[0] - b[0]);
    full = !!st.exact || Math.max(...sc.map((v) => Math.abs(v - 1))) > STRETCH_ADD_LIMIT;
    note(full ? 'sphereStretchFull' : 'sphereStretchAdd', { shape: shape.id, param: st.param, scale: sc, step: full ? 15 : shape.step || 10 },
      full ? `shape ${shape.id}: the stretch ${sc.join(' x ')} is baked with the turn on one key grid (angles every 15°; accurate, bigger)` : `shape ${shape.id}: the stretch ${sc.join(' x ')} is small: baked as its own keys, added to the turn's`, 'info');
  }
  const step = full ? 15 : shape.step || 10;
  const keysX = axisKeys(range(px), shape.turn?.x ?? 30, step), keysY = py ? axisKeys(range(py), shape.turn?.y ?? 20, step) : [[0, 0]];
  // a hint for the grid's size: the shape should span about 8 cells of it
  const [gx, gy, gw, gh] = grid.rect;
  const cellsAcross = Math.min((2 * shape.radius[0] * grid.cols) / gw, cyl ? Infinity : (2 * shape.radius[1] * grid.rows) / gh);
  if (cellsAcross < 7) note('sphereGridCoarse', { shape: shape.id, grid: grid.id, cells: +cellsAcross.toFixed(1), want: 8 }, `shape ${shape.id} spans only ${cellsAcross.toFixed(1)} cells of grid ${grid.id}: 8 or more follow it within 1 %`);

  // least squares for the target grid: samples on a lattice over it (the exact part and the still
  // part past the falloff count fully, the band between only a little) and the vertices of its parts
  const nC = (grid.cols + 1) * (grid.rows + 1), restOf = (w) => {
    const [x0, y0, ww, wh] = w.rect, pts = [];
    for (let j = 0; j <= w.rows; j++) for (let i = 0; i <= w.cols; i++) pts.push([x0 + (ww * i) / w.cols, y0 + (wh * j) / w.rows]);
    return pts;
  };
  const rest = restOf(grid), toCell = ([x, y]) => [((x - gx) / gw) * grid.cols, ((y - gy) / gh) * grid.rows];
  const samples = [], S = 4 * Math.max(grid.cols, grid.rows);
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) samples.push([gx + (gw * i) / S, gy + (gh * j) / S]);
  for (const p of model.parts || []) if (p.warp === grid.id && p.vertices) for (let i = 0; i < p.vertices.length; i += 2) {
    const c = toCell([p.vertices[i], p.vertices[i + 1]]);
    if (c[0] >= 0 && c[1] >= 0 && c[0] <= grid.cols && c[1] <= grid.rows) samples.push([p.vertices[i], p.vertices[i + 1]]);
  }
  const band = shape.bandWeight ?? 0.05;
  const sw = samples.map((p) => { const k = shapeField(p[0], p[1], shape).keep; return k >= 1 || k <= 0 ? 1 : band; });
  const W = samples.map((p) => [...surfaceWeights(grid.cols, grid.rows, ...toCell(p))]);
  const lam = 1e-3, A = new Float64Array(nC * nC);
  W.forEach((w, k) => { for (const [i, ci] of w) for (const [j, cj] of w) A[i * nC + j] += sw[k] * ci * cj; });
  for (let i = 0; i < nC; i++) A[i * nC + i] += lam;
  const solve = cholesky(A, nC);

  // every grid's control point deltas (rest-space px) at one pose: the target grid by least
  // squares, the grids inside through their parent's surface
  const netsOf = (d) => { // the final nets of every grid, from its deltas
    const nets = new Map();
    for (const w of tree) {
      const r = restOf(w), moved = r.map((p, k) => [p[0] + d.get(w.id)[k][0], p[1] + d.get(w.id)[k][1]]);
      if (w === grid) { nets.set(w.id, extend(moved, w.cols, w.rows)); continue; }
      const parent = warps.find((q) => q.id === w.parent), net = nets.get(parent.id), [qx, qy, qw, qh] = parent.rect, sx = parent.cols / qw, sy = parent.rows / qh;
      nets.set(w.id, extend(moved.map(([x, y]) => surface(net, (x - qx) * sx, (y - qy) * sy)), w.cols, w.rows));
    }
    return nets;
  };
  const bake = (degX, degY, St = [1, 1]) => {
    const yaw = degX * D, pitch = degY * D, d = new Map(), nets = new Map();
    const bx = new Float64Array(nC), by = new Float64Array(nC);
    samples.forEach((p, k) => { const t = moveAt(p, yaw, pitch, St); for (const [i, c] of W[k]) { bx[i] += sw[k] * c * t[0]; by[i] += sw[k] * c * t[1]; } });
    rest.forEach((p, i) => { const t = moveAt(p, yaw, pitch, St); bx[i] += lam * t[0]; by[i] += lam * t[1]; });
    const X = solve(bx), Y = solve(by), fitted = rest.map((_, i) => [X[i], Y[i]]);
    d.set(grid.id, fitted.map(([x, y], i) => [x - rest[i][0], y - rest[i][1]]));
    nets.set(grid.id, extend(fitted, grid.cols, grid.rows));
    for (const w of tree) {
      if (w === grid) continue;
      const parent = warps.find((q) => q.id === w.parent), net = nets.get(parent.id), [qx, qy, qw, qh] = parent.rect, sx = parent.cols / qw, sy = parent.rows / qh;
      const r = restOf(w), target = r.map((p) => moveAt(p, yaw, pitch, St));
      d.set(w.id, target.map((t, k) => {
        const c0 = [(r[k][0] - qx) * sx, (r[k][1] - qy) * sy], [u, v] = solveCell(net, t, c0);
        return [(u - c0[0]) / sx, (v - c0[1]) / sy];
      }));
      nets.set(w.id, extend(target, w.cols, w.rows));
    }
    return d;
  };
  const flat = (a) => a.flatMap(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);
  const pack = (m) => Object.fromEntries([...m].map(([id, a]) => [id, { dense: flat(a) }]));
  const combine = (terms) => { // sum of [sign, Map(id -> [[x, y]])]
    const out = new Map();
    for (const [sign, m] of terms) for (const [id, a] of m) {
      if (!out.has(id)) out.set(id, a.map(() => [0, 0]));
      const o = out.get(id);
      a.forEach(([x, y], k) => { o[k][0] += sign * x; o[k][1] += sign * y; });
    }
    return out;
  };

  // Motions on a key grid: axes [{ id, keys: [[value, coord]] }] with coord 0 / [1, 1] at the default.
  // Each node with some axes off their default gets what it adds to the lower nodes (inclusion-
  // exclusion over those axes), so that with tent regions between neighbour keys the sum is the
  // multilinear blend of the node values.
  const isDef = (c) => (Array.isArray(c) ? c[0] === 1 && c[1] === 1 : c === 0);
  const keyGrid = (axes, valueAt) => {
    const cache = new Map(), V = (coords) => { const k = JSON.stringify(coords); if (!cache.has(k)) cache.set(k, valueAt(coords)); return cache.get(k); };
    const out = [];
    const walk = (i, pick) => {
      if (i < axes.length) { for (const key of axes[i].keys) walk(i + 1, [...pick, key]); return; }
      const on = pick.map((k, a) => (isDef(k[1]) ? -1 : a)).filter((a) => a >= 0);
      if (!on.length) return;
      const terms = [];
      for (let mask = 1; mask < 1 << on.length; mask++) { // the non-empty subsets of the axes that are on
        const coords = pick.map((k, a) => { const j = on.indexOf(a); return j >= 0 && mask & (1 << j) ? k[1] : axes[a].keys.find((q) => isDef(q[1]))[1]; });
        const bits = on.filter((_, j) => mask & (1 << j)).length;
        terms.push([(on.length - bits) % 2 ? -1 : 1, V(coords)]);
      }
      out.push({ at: Object.fromEntries(on.map((a) => [axes[a].id, pick[a][0]])), value: combine(terms) });
    };
    walk(0, []);
    return { motions: out, V };
  };
  const angleAxes = [{ id: px, keys: keysX }, ...(py ? [{ id: py, keys: keysY }] : [])];
  const at3 = (coords) => [coords[0], py ? coords[1] : 0, st && full ? coords[coords.length - 1] : [1, 1]];
  const motions = [];
  const main = keyGrid(full ? [...angleAxes, { id: st.param, keys: sKeys }] : angleAxes, (coords) => { const [ax, ay, sc] = at3(coords); return bake(ax, ay, sc); });
  for (const m of main.motions) motions.push({ at: m.at, warps: pack(m.value) });
  if (st && !full) for (const [v, sc] of sKeys) if (!isDef(sc)) motions.push({ at: { [st.param]: v }, warps: pack(bake(0, 0, sc)) });

  // parts with a depth: morphs of their own on keys every depthStep degrees; each puts the vertices,
  // through the grids as they are at that angle (the blend of the keys around it), where the
  // raised surface turns to
  const depthOf = model.editor?.depth || {}, lifted = (model.parts || []).filter((p) => depthOf[p.id] && tree.some((w) => w.id === p.warp));
  if (lifted.length) {
    const blendAt = (ax, ay) => { // the grids' deltas at (ax, ay): bilinear between the grid keys around it
      const near = (keys, deg) => { const cs = keys.map((k) => k[1]); let i = 0; while (i < cs.length - 2 && cs[i + 1] < deg) i++; const t = cs[i + 1] === cs[i] ? 0 : Math.min(1, Math.max(0, (deg - cs[i]) / (cs[i + 1] - cs[i]))); return [[cs[i], 1 - t], [cs[i + 1], t]]; };
      const xs = near(keysX, ax), ys = py ? near(keysY, ay) : [[0, 1]], terms = [];
      for (const [cx, wx] of xs) for (const [cy, wy] of ys) if (wx * wy) terms.push([wx * wy, main.V(full ? [cx, ...(py ? [cy] : []), [1, 1]] : [cx, ...(py ? [cy] : [])])]);
      return combine(terms);
    };
    const dStep = shape.depthStep || 15;
    const mx = axisKeys(range(px), shape.turn?.x ?? 30, dStep), my = py ? axisKeys(range(py), shape.turn?.y ?? 20, dStep) : null;
    const morphAt = (coords) => {
      const ax = coords[0], ay = py ? coords[1] : 0, nets = netsOf(ax || ay ? blendAt(ax, ay) : new Map(tree.map((w) => [w.id, restOf(w).map(() => [0, 0])])));
      const out = new Map();
      for (const p of lifted) {
        const w = warps.find((q) => q.id === p.warp), net = nets.get(w.id), [wx, wy, ww, wh] = w.rect, sx = w.cols / ww, sy = w.rows / wh, lift = depthOf[p.id] * shape.radius[0];
        const a = [];
        for (let i = 0; i < p.vertices.length; i += 2) {
          const q = [p.vertices[i], p.vertices[i + 1]], t = moveAt(q, ax * D, ay * D, [1, 1], lift);
          const c0 = [(q[0] - wx) * sx, (q[1] - wy) * sy], [u, v] = solveCell(net, t, c0);
          a.push([(u - c0[0]) / sx, (v - c0[1]) / sy]);
        }
        out.set(p.id, a);
      }
      return out;
    };
    const dm = keyGrid([{ id: px, keys: mx }, ...(py ? [{ id: py, keys: my }] : [])], morphAt);
    for (const m of dm.motions) motions.push({ at: m.at, morphs: pack(m.value) });
  }
  const keys = { [px]: keysX.map((k) => k[0]) };
  if (py) keys[py] = keysY.map((k) => k[0]);
  if (st) keys[st.param] = sKeys.map((k) => k[0]);
  return { motions, keys, params, notes, warnings };
}
