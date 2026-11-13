// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A part that runs along a line (a drop of sweat sliding down and round again): the line, how
// fast it goes where, and how visible it is where, baked into ordinary keys of the bone that
// carries the part. The .ugo format does not change; the line itself stays with the editor and is
// baked again when it changes. Plain ES module: the editor imports it.
//
//   import { bakePathAnimation, bakePathParam } from '../tools/path_bake.mjs';
//   // over time: bone keys (x, y, rotate) and opacity keys, to put into animations[]
//   const { bones, opacity, keys } = bakePathAnimation({ path, bone: 'drop', origin: [0, -300], duration: 4,
//     speed: [[0, 1], [0.5, 0.3], [1, 1]], opacity: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]], part: 'sweat' });
//   anim.bones = { ...anim.bones, ...bones }; anim.opacity = { ...anim.opacity, ...opacity };
//   // by a parameter: deformers whose ranges follow each other along it
//   const { deformers } = bakePathParam({ path, bone: 'drop', origin: [0, -300], param: 'Sweat', range: [0, 1] });
//
// The line: { points: [[x, y], ...], closed, handles } in the space the bone's x and y live in
// (model space for a bone with no parent; the grid's rest-pose model space for a bone in a warp
// grid, so the line bends with the grid). Without handles the line is smooth through the points
// (Catmull-Rom); handles are Bezier handles relative to each point, [inX, inY, outX, outY]; a
// point with handles [0, 0, 0, 0] is a corner. Positions along the line are fractions of its
// length, 0 at the first point and 1 at the end (back at the first point for a closed line).
//
// Speed and opacity are given at positions along the line, [[u, value], ...] in order, straight
// in between. Keys are sampled finely and then dropped where a straight line between the kept
// keys stays within `tolerance` px (rotation within `angleTolerance` degrees, opacity within 1/255).

const r = (v, d = 4) => +v.toFixed(d);

// ---- the line ----------------------------------------------------------

/** The line as cubic Bezier pieces with a table of its length: { at(s) -> {x, y, dx, dy}, length }. */
export function makePath(path) {
  const P = (path.points || []).map(([x, y]) => [+x, +y]);
  if (P.length < 2 || P.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) throw new Error('path_bake: a line needs at least 2 points with finite x, y');
  const closed = !!path.closed, n = P.length, segs = closed ? n : n - 1;
  const handles = path.handles;
  if (handles && handles.length !== n) throw new Error('path_bake: handles need one [inX, inY, outX, outY] per point');
  // Catmull-Rom tangents (one-sided at the ends of an open line)
  const tangent = (i) => {
    const a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const f = !closed && (i === 0 || i === n - 1) ? 1 : 0.5;
    return [(b[0] - a[0]) * f, (b[1] - a[1]) * f];
  };
  const pieces = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, a = P[i], b = P[j];
    let c1, c2;
    if (handles) { c1 = [a[0] + handles[i][2], a[1] + handles[i][3]]; c2 = [b[0] + handles[j][0], b[1] + handles[j][1]]; }
    else { const ta = tangent(i), tb = tangent(j); c1 = [a[0] + ta[0] / 3, a[1] + ta[1] / 3]; c2 = [b[0] - tb[0] / 3, b[1] - tb[1] / 3]; }
    pieces.push([a, c1, c2, b]);
  }
  const bez = (q, t) => {
    const u = 1 - t, w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t], dw = [-3 * u * u, 3 * u * u - 6 * u * t, 6 * u * t - 3 * t * t, 3 * t * t];
    let x = 0, y = 0, dx = 0, dy = 0;
    for (let k = 0; k < 4; k++) { x += w[k] * q[k][0]; y += w[k] * q[k][1]; dx += dw[k] * q[k][0]; dy += dw[k] * q[k][1]; }
    return { x, y, dx, dy };
  };
  // length table: STEPS samples per piece
  const STEPS = 256, table = [0]; // table[i * STEPS + k]: length up to piece i at t = k / STEPS
  let total = 0;
  for (const q of pieces) {
    let prev = bez(q, 0);
    for (let k = 1; k <= STEPS; k++) {
      const p = bez(q, k / STEPS);
      total += Math.hypot(p.x - prev.x, p.y - prev.y);
      table.push(total);
      prev = p;
    }
  }
  if (!(total > 0)) throw new Error('path_bake: the line has no length');
  /** The point at fraction u (0..1) of the length, and the line's direction there. */
  const at = (u) => {
    const s = Math.min(1, Math.max(0, u)) * total;
    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (table[mid] <= s) lo = mid; else hi = mid; }
    const f = table[hi] > table[lo] ? (s - table[lo]) / (table[hi] - table[lo]) : 0;
    const g = Math.min(pieces.length * STEPS, lo + f), piece = Math.min(pieces.length - 1, Math.floor(g / STEPS));
    return bez(pieces[piece], g / STEPS - piece);
  };
  return { at, length: total, closed };
}

// ---- stops along the line ---------------------------------------------

// [[u, v], ...] -> v at u (straight between stops, held beyond them)
function stops(list, fallback, what) {
  if (list == null) return () => fallback;
  if (typeof list === 'number') return () => list;
  if (!Array.isArray(list) || !list.length) throw new Error(`path_bake: ${what} must be [[u, value], ...]`);
  for (let i = 0; i < list.length; i++) {
    const [u, v] = list[i];
    if (!Number.isFinite(u) || !Number.isFinite(v) || (i && u < list[i - 1][0])) throw new Error(`path_bake: ${what} needs finite [u, value] pairs with u in order`);
  }
  return (u) => {
    if (u <= list[0][0]) return list[0][1];
    for (let i = 1; i < list.length; i++) {
      const [u1, v1] = list[i], [u0, v0] = list[i - 1];
      if (u <= u1) return u1 > u0 ? v0 + (v1 - v0) * (u - u0) / (u1 - u0) : v1;
    }
    return list[list.length - 1][1];
  };
}

// time 0..duration -> position 0..1, with the speed (relative) given along the line
function timing(speedAt, duration) {
  const N = 4096, T = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const a = speedAt((i - 1) / N), b = speedAt(i / N);
    if (!(a > 0 && b > 0)) throw new Error('path_bake: the speed must be above 0 everywhere on the line');
    T[i] = T[i - 1] + (1 / a + 1 / b) / 2 / N;
  }
  const scale = duration / T[N];
  return (t) => {
    const want = t / scale;
    if (want <= 0) return 0;
    if (want >= T[N]) return 1;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= want) lo = mid; else hi = mid; }
    return (lo + (want - T[lo]) / (T[hi] - T[lo])) / N;
  };
}

// ---- dropping keys ------------------------------------------------------

// samples [{ t, v: [..] }] -> the indices to keep: between kept ones, a straight line stays within tol
// of every sample (dist(a, b) measures how far apart two values are)
function simplify(samples, tol, dist) {
  const keep = [0];
  let i = 0;
  while (i < samples.length - 1) {
    let j = i + 1;
    for (let k = i + 2; k < samples.length; k++) {
      let ok = true;
      const a = samples[i], b = samples[k];
      for (let m = i + 1; m < k && ok; m++) {
        const f = (samples[m].t - a.t) / (b.t - a.t), lerp = a.v.map((x, c) => x + (b.v[c] - x) * f);
        if (dist(lerp, samples[m].v) > tol) ok = false;
      }
      if (!ok) break;
      j = k;
    }
    keep.push(j);
    i = j;
  }
  return keep;
}
const planar = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const single = (a, b) => Math.abs(a[0] - b[0]);

// ---- baking ---------------------------------------------------------------

function common(o) {
  if (!o || !o.path) throw new Error('path_bake: give the line as path: { points: [[x, y], ...] }');
  if (!o.bone) throw new Error('path_bake: name the bone that carries the part (bone)');
  const line = makePath(o.path), origin = o.origin || [0, 0];
  const rotate = o.rotate ?? false, restRotation = o.restRotation ?? 0, angleOffset = o.angleOffset ?? 0;
  const opacityAt = o.opacity == null ? null : stops(o.opacity, 1, 'opacity');
  if (o.opacity != null && !o.part) throw new Error('path_bake: opacity along the line needs the part it changes (part)');
  return {
    line, opacityAt, rotate,
    tolerance: o.tolerance ?? 0.25, angleTolerance: o.angleTolerance ?? 0.5, opacityTolerance: o.opacityTolerance ?? 1 / 255,
    // what the bone's tracks get at position u: offsets from its rest pose
    pose: (u) => {
      const p = line.at(u);
      return { x: p.x - origin[0], y: p.y - origin[1], rot: Math.atan2(p.dy, p.dx) * 180 / Math.PI + angleOffset - restRotation };
    },
  };
}

// keeps an angle near the one before it (no jump of 360° between keys)
const unwrap = (list) => { for (let i = 1; i < list.length; i++) list[i] += 360 * Math.round((list[i - 1] - list[i]) / 360); return list; };

/**
 * Over time. opts: path, bone, origin [x, y] (the bone's rest x, y: keys are offsets from it),
 *   duration (s), speed ([[u, relative speed], ...] or a number; default even), opacity ([[u, 0..1], ...]),
 *   part (for opacity), rotate (turn the bone with the line; default false), restRotation (deg, the
 *   bone's own), angleOffset (deg: which way the part points along the line), tolerance (px, 0.25),
 *   angleTolerance (deg, 0.5), fps (samples per second before keys are dropped, 240).
 * -> { bones: { [bone]: { x, y, rotate? } }, opacity: { [part]: keys } | {}, keys (how many), samples, at(t) }
 *   keys are [[time, value], ...], straight between them (the format's default). at(t): where the line
 *   itself has the bone at time t ({ u, x, y, rot, op }, before keys are dropped), e.g. to draw it.
 */
export function bakePathAnimation(opts) {
  const c = common(opts), duration = opts.duration ?? 1;
  if (!(duration > 0)) throw new Error('path_bake: duration must be above 0');
  const uAt = timing(stops(opts.speed, 1, 'speed'), duration);
  const fps = opts.fps ?? 240, n = Math.max(2, Math.ceil(duration * fps));
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const t = duration * i / n, u = uAt(t), p = c.pose(u);
    samples.push({ t, u, x: p.x, y: p.y, rot: p.rot, op: c.opacityAt ? c.opacityAt(u) : 1 });
  }
  unwrap(samples.map((s) => s.rot)).forEach((v, i) => { samples[i].rot = v; });
  const out = finish(c, opts, samples, (s) => s.t, (s) => r(s.t, 5));
  out.at = (t) => exact(c, uAt(Math.min(duration, Math.max(0, t))));
  return out;
}

// where the line itself puts the bone at position u (before keys are dropped): { u, x, y, rot, op }
function exact(c, u) {
  const p = c.pose(u);
  return { u, x: p.x, y: p.y, rot: p.rot, op: c.opacityAt ? c.opacityAt(u) : 1 };
}

/**
 * By a parameter: as the parameter goes from range[0] to range[1] the part runs the line (speed and
 * opacity as above, along the parameter instead of time). opts as bakePathAnimation, plus param,
 * range [from, to] (default the parameter's whole range), partOpacity (the part's own opacity, which
 * the deformers' opacity changes add to; default 1), steps (samples, 960).
 * -> { deformers: [...], keys (how many points), at(v) (where the line has the bone at parameter value v) }
 *   deformers: one per kept point, its region the parameter's tent from the point before to the next
 *   (so they add up to a straight line between points), moving the bone (and the part's opacity).
 */
export function bakePathParam(opts) {
  const c = common(opts);
  if (!opts.param) throw new Error('path_bake: name the parameter (param)');
  const [p0, p1] = opts.range || [0, 1];
  if (!(p1 > p0)) throw new Error('path_bake: range must go up');
  const uAt = timing(stops(opts.speed, 1, 'speed'), 1);
  const steps = opts.steps ?? 960, samples = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, u = uAt(f), p = c.pose(u);
    samples.push({ t: p0 + (p1 - p0) * f, u, x: p.x, y: p.y, rot: p.rot, op: c.opacityAt ? c.opacityAt(u) : 1 });
  }
  unwrap(samples.map((s) => s.rot)).forEach((v, i) => { samples[i].rot = v; });
  const kept = keepAll(c, samples);
  const own = opts.partOpacity ?? 1, deformers = [];
  kept.forEach((k, i) => {
    const s = samples[k], before = samples[kept[Math.max(0, i - 1)]].t, after = samples[kept[Math.min(kept.length - 1, i + 1)]].t;
    const bone = { x: r(s.x), y: r(s.y) };
    if (c.rotate) bone.rotation = r(s.rot);
    const d = { region: { [opts.param]: [r(before, 6), r(s.t, 6), r(after, 6)] }, bones: { [opts.bone]: bone } };
    if (c.opacityAt) d.opacity = { [opts.part]: r(s.op - own) };
    deformers.push(d);
  });
  return { deformers, keys: kept.length, at: (v) => exact(c, uAt(Math.min(1, Math.max(0, (v - p0) / (p1 - p0))))) };
}

// the samples every track needs to keep (one set of points, so the deformers can share them)
function keepAll(c, samples) {
  const set = new Set(simplify(samples.map((s) => ({ t: s.t, v: [s.x, s.y] })), c.tolerance, planar));
  if (c.rotate) for (const k of simplify(samples.map((s) => ({ t: s.t, v: [s.rot] })), c.angleTolerance, single)) set.add(k);
  if (c.opacityAt) for (const k of simplify(samples.map((s) => ({ t: s.t, v: [s.op] })), c.opacityTolerance, single)) set.add(k);
  return [...set].sort((a, b) => a - b);
}

function finish(c, opts, samples, timeOf, keyTime) {
  // each track keeps its own keys (x and y together: their error is a distance)
  const track = (idx, value) => idx.map((k) => [keyTime(samples[k]), r(value(samples[k]))]);
  const xy = simplify(samples.map((s) => ({ t: timeOf(s), v: [s.x, s.y] })), c.tolerance, planar);
  const bone = { x: track(xy, (s) => s.x), y: track(xy, (s) => s.y) };
  let keys = 2 * xy.length;
  if (c.rotate) {
    const ri = simplify(samples.map((s) => ({ t: timeOf(s), v: [s.rot] })), c.angleTolerance, single);
    bone.rotate = track(ri, (s) => s.rot);
    keys += ri.length;
  }
  const opacity = {};
  if (c.opacityAt) {
    const oi = simplify(samples.map((s) => ({ t: timeOf(s), v: [s.op] })), c.opacityTolerance, single);
    opacity[opts.part] = track(oi, (s) => s.op);
    keys += oi.length;
  }
  return { bones: { [opts.bone]: bone }, opacity, keys, samples: samples.length };
}
