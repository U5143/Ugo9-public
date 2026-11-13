// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A first draft of a face turning left / right and up / down (Live2D's "auto-generate face
// motion"), as moves of a face warp grid's control points and of the grids inside it (eyes,
// brows, mouth). Plain ES module: the editor imports it.
//
//   import { makeFaceAngles } from '../tools/face_angles.mjs';
//   const { motions, warnings, center, radius } = makeFaceAngles(model, { warp: 'face', auto: 'parts' });
//   // motions: [{ at: { HeadTurnX: 30 }, warps: { face: { dense: [dx0, dy0, ...] }, eyeL: { dense } } }, ...]
//
// The face is taken as painted on the front of an ellipsoid (centre, half width, half height,
// and a depth); turning the ellipsoid moves each control point to where its point of the
// surface goes, seen from the front (points nearer the viewer move more, the far side bunches
// up). The parameter's min and max are the turned-most keys; the four corners hold only what
// turning both ways at once adds to the two single turns (Ugo9's 2-axis regions add it there).
// Grids inside the face grid ride on its curved surface; their points get what that surface
// still leaves out, so each of them lands on the turned ellipsoid too (the face grid is smooth,
// so without this the eyes would move like the flat cheek around them).
// Deltas are in the grids' rest space (model px), as the format's "warps" take them.

import { makeNotes } from './notes.mjs';

const D = Math.PI / 180;

import { extend, surface, solveCell, surfaceWeights } from './warp_surface.mjs';
import { makeSphereBake } from './sphere_bake.mjs';

export { extend, surface, solveCell, surfaceWeights };

const FACE_NAME = /face|顔|輪郭|かお/i, HAIR_NAME = /hair|髪|bang|前髪|後ろ髪|もみあげ/i;
const partName = (p) => `${p.id ?? ''} ${p.name ?? ''}`;

/**
 * model: working JSON (format 0.5+). opts:
 *   warp     the face grid's id (default: 'face', else the first grid without a parent)
 *   paramX, paramY   parameters for left / right and up / down (default the standard names HeadTurnX, HeadTurnY of
 *                    docs/パラメータの名前.md; a model that has the older AngleX / AngleY and not those keeps them)
 *   auto     where the face's centre and radius come from when not given: 'rect' (the grid's
 *            rectangle, default) or 'parts' (the parts in the grid: the ones named face / 顔 /
 *            輪郭 if any, else all but hair)
 *   center   [x, y] of the face; radius [rx, ry]
 *   turnX, turnY     how far the face turns at the parameter's ends, in degrees (default 30, 20)
 *   depth    how far the face stands out, as a part of rx (default 0.6)
 *   amount   scales every move (default 1)
 *   nested   also move the grids inside the face grid (default true)
 * -> { motions: [{ at, warps }], warnings, notes, center, radius, params }
 *    notes: warnings as { code, vars, level, text } (tools/notes.mjs), for the editor to word
 *    params: the parameters to add first, [[id, min, default, max]] (empty when all are there)
 */
export function makeFaceAngles(model, opts = {}) {
  const { warnings, notes, note } = makeNotes();
  // the names (利用者の声 #409): the standard ones, unless the model already uses the older ones
  const has = (id) => (model.parameters || []).some((p) => p.id === id), pick = (std, old) => (!has(std) && has(old) ? old : std);
  const nameX = opts.paramX || pick('HeadTurnX', 'AngleX'), nameY = opts.paramY || pick('HeadTurnY', 'AngleY');
  const warps = model.warps || [];
  const grid = warps.find((w) => w.id === (opts.warp || 'face')) || (!opts.warp && warps.find((w) => !w.parent));
  if (!grid) throw new Error(`no warp grid ${opts.warp || 'face'} in the model`);
  if (grid.parent) note('gridNested', { grid: grid.id, parent: grid.parent }, `grid ${grid.id} is inside grid ${grid.parent}: only its own points are turned, the face may turn too far or too little`);
  // the face grid and the grids inside it, parents first
  const tree = [grid];
  for (let k = 0; k < tree.length; k++) for (const w of warps) if (w.parent === tree[k].id && !tree.includes(w)) tree.push(w);
  const moved = opts.nested === false ? [grid] : tree;

  // the face's centre and radius
  const [gx, gy, gw, gh] = grid.rect;
  let center = opts.center, radius = opts.radius, from = center && radius ? 'given' : 'the grid', fromVars = { from: center && radius ? 'given' : 'grid', parts: [] };
  if ((!center || !radius) && opts.auto === 'parts') {
    const inTree = (model.parts || []).filter((p) => tree.some((w) => w.id === p.warp) && p.vertices?.length);
    let use = inTree.filter((p) => p.warp === grid.id && FACE_NAME.test(partName(p)) && !HAIR_NAME.test(partName(p)));
    if (use.length) { from = `part${use.length > 1 ? 's' : ''} ${use.map((p) => p.id).join(', ')}`; fromVars = { from: 'parts', parts: use.map((p) => p.id) }; }
    else { use = inTree.filter((p) => !HAIR_NAME.test(partName(p))); if (!use.length) use = inTree; from = 'the parts in the grid'; fromVars = { from: 'parts', parts: use.map((p) => p.id) }; }
    if (use.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of use) for (let i = 0; i < p.vertices.length; i += 2) {
        x0 = Math.min(x0, p.vertices[i]); x1 = Math.max(x1, p.vertices[i]); y0 = Math.min(y0, p.vertices[i + 1]); y1 = Math.max(y1, p.vertices[i + 1]);
      }
      center ||= [(x0 + x1) / 2, (y0 + y1) / 2]; radius ||= [(x1 - x0) / 2, (y1 - y0) / 2];
    } else { note('gridNoParts', { grid: grid.id }, `no parts in grid ${grid.id}: the face's centre and radius come from the grid's rectangle`); from = 'the grid'; fromVars = { from: 'grid', parts: [] }; }
  }
  center ||= [gx + gw / 2, gy + gh / 2]; radius ||= [gw / 2, gh / 2];
  const [cx, cy] = center, [rx, ry] = radius;
  const r1 = (v) => +v.toFixed(1);
  note('faceCentre', { center: [r1(cx), r1(cy)], radius: [r1(rx), r1(ry)], ...fromVars }, `face centre [${r1(cx)}, ${r1(cy)}], radius [${r1(rx)}, ${r1(ry)}] (from ${from})`, 'info');

  if (opts.method !== 'points') { // the sphere bake (tools/sphere_bake.mjs): exact on the face, keys every `step` degrees
    const exact = opts.exact ?? 0.9, k = 1 / exact; // the sphere a little larger than the face, so all of the face is on its exact part
    const shape = { id: 'face', type: 'sphere', center: [cx, cy], radius: [rx * k, ry * k], depth: (opts.depth ?? 0.6) * exact, exact, falloff: opts.falloff ?? 1.6,
      params: { x: nameX, y: nameY }, turn: { x: opts.turnX ?? 30, y: opts.turnY ?? 20 }, step: opts.step ?? 10,
      amount: opts.amount ?? 1, nested: opts.nested, target: { warp: grid.id } };
    const r = makeSphereBake(model, shape);
    for (const n of r.notes) note(n.code, n.vars, n.text, n.level);
    return { motions: r.motions, warnings, notes, center: [cx, cy], radius: [rx, ry], params: r.params, keys: r.keys, shape };
  }
  // the older way (opts.method 'points'): the control points moved to the turned ellipsoid, keys at the ends only
  const depth = (opts.depth ?? 0.6) * rx, amount = opts.amount ?? 1;
  const px = nameX, py = nameY;
  const params = [];
  const param = (id) => {
    const p = (model.parameters || []).find((q) => q.id === id);
    if (!p) params.push([id, -30, 0, 30]);
    if (!p) note('paramMissing', { param: id, min: -30, default: 0, max: 30 }, `no parameter ${id}: keys made for -30 and 30 (add the parameter)`);
    return p ? [p.min, p.default ?? 0, p.max] : [-30, 0, 30];
  };
  const [xMin, xDef, xMax] = param(px), [yMin, yDef, yMax] = param(py);

  // each grid's control points at rest, row by row from the top left
  const restOf = (w) => {
    const [x0, y0, ww, wh] = w.rect, pts = [];
    for (let j = 0; j <= w.rows; j++) for (let i = 0; i <= w.cols; i++) pts.push([x0 + (ww * i) / w.cols, y0 + (wh * j) / w.rows]);
    return pts;
  };
  const rests = new Map(moved.map((w) => [w.id, restOf(w)]));
  // a point after turning by yaw (to +x) and pitch (to -y, up), scaled by amount
  const turnPoint = ([x, y], yaw, pitch) => {
    const u = (x - cx) / rx, v = (y - cy) / ry;
    const z = depth * Math.sqrt(Math.max(0, 1 - u * u - v * v)); // on the ellipsoid; 0 outside it
    let X = x - cx, Y = y - cy, Z = z;
    [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)]; // turn right
    [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)]; // turn up
    return [x + (X + cx - x) * amount, y + (Y + cy - y) * amount];
  };
  // every moved grid's deltas for one turn: the face grid's points go straight to the turned
  // place; a grid inside goes there through its parent's turned surface
  const turned = (yaw, pitch) => {
    const nets = new Map(), out = new Map();
    for (const w of moved) {
      const rest = rests.get(w.id), target = rest.map((p) => turnPoint(p, yaw, pitch));
      const parent = w === grid ? null : warps.find((q) => q.id === w.parent);
      let d;
      if (!parent) d = target.map(([x, y], k) => [x - rest[k][0], y - rest[k][1]]);
      else {
        const net = nets.get(parent.id), [qx, qy, qw, qh] = parent.rect, sx = parent.cols / qw, sy = parent.rows / qh;
        d = target.map((t, k) => {
          const c0 = [(rest[k][0] - qx) * sx, (rest[k][1] - qy) * sy], [u, v] = solveCell(net, t, c0);
          return [(u - c0[0]) / sx, (v - c0[1]) / sy];
        });
      }
      nets.set(w.id, extend(target, w.cols, w.rows));
      out.set(w.id, d);
    }
    return out;
  };
  const flat = (d) => d.flatMap(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]);
  const pack = (m) => Object.fromEntries([...m].map(([id, d]) => [id, { dense: flat(d) }]));
  const turnX = (opts.turnX ?? 30) * D, turnY = (opts.turnY ?? 20) * D;
  // the parameter's value -> turn: its end is the full turn, its default none
  const yawOf = (v) => (v === xDef ? 0 : (v > xDef ? 1 : -1) * turnX), pitchOf = (v) => (v === yDef ? 0 : (v > yDef ? 1 : -1) * turnY);

  const motions = [];
  const single = new Map();
  for (const v of [xMax, xMin]) if (v !== xDef) { const d = turned(yawOf(v), 0); single.set(`x${v}`, d); motions.push({ at: { [px]: v }, warps: pack(d) }); }
  for (const v of [yMax, yMin]) if (v !== yDef) { const d = turned(0, pitchOf(v)); single.set(`y${v}`, d); motions.push({ at: { [py]: v }, warps: pack(d) }); }
  // corners: the both-ways turn minus the two single turns (deltas add up linearly, also inside)
  for (const vx of [xMax, xMin]) for (const vy of [yMax, yMin]) {
    if (vx === xDef || vy === yDef) continue;
    const both = turned(yawOf(vx), pitchOf(vy)), a = single.get(`x${vx}`), b = single.get(`y${vy}`);
    const corner = new Map([...both].map(([id, d]) => [id, d.map(([dx, dy], k) => [dx - a.get(id)[k][0] - b.get(id)[k][0], dy - a.get(id)[k][1] - b.get(id)[k][1]])]));
    motions.push({ at: { [px]: vx, [py]: vy }, warps: pack(corner) });
  }
  return { motions, warnings, notes, center: [cx, cy], radius: [rx, ry], params };
}
