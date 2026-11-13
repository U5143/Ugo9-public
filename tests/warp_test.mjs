// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Warp grids (format 0.5) in the C core against an independent JS reading of
// the rules in docs/形式.md:
//   node tests/warp_test.mjs
// - a uniform cubic B-spline over the control points plus one extended ring
//   (P[-1] = 2 P[0] - P[1]), written here as a sum of the cardinal B-spline
//   B(x) (the core uses the four cubic pieces), straight on past the edges
// - the rest pose puts every vertex where the JSON put it
// - grid keyforms, a grid inside a grid, a morph inside a grid, a moving bone
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const rig = JSON.parse(fs.readFileSync(new URL('./pose/rig.json', import.meta.url), 'utf8'));
const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const model = rt.loadModel(compileUgo(rig));
const inst = model.createInstance();
const ex = rt.ex, nv = model.vertexCount, out = rt.alloc(8 * nv);
const parts = model.partData().parts;
const firstVert = (() => { const tmp = rt.alloc(16), r = rt.u32(tmp, 4); return parts.map((_, i) => { ex.ugo_part_range(model.ptr, i, tmp); return r[0]; }); })();

const Bc = (x) => { const a = Math.abs(x); return a < 1 ? 2 / 3 - a * a + a * a * a / 2 : a < 2 ? (2 - a) ** 3 / 6 : 0; };
// surface of a (cols+1) x (rows+1) net P (model space) at cell coordinates (u, v)
function surface(P, cols, rows, u, v) {
  const at = (i, j) => { // extended ring by reflection through the edge points
    if (i < 0) { const a = at(0, j), b = at(1, j); return [2 * a[0] - b[0], 2 * a[1] - b[1]]; }
    if (i > cols) { const a = at(cols, j), b = at(cols - 1, j); return [2 * a[0] - b[0], 2 * a[1] - b[1]]; }
    if (j < 0) { const a = at(i, 0), b = at(i, 1); return [2 * a[0] - b[0], 2 * a[1] - b[1]]; }
    if (j > rows) { const a = at(i, rows), b = at(i, rows - 1); return [2 * a[0] - b[0], 2 * a[1] - b[1]]; }
    return P[j * (cols + 1) + i];
  };
  const inside = (x, y) => {
    let sx = 0, sy = 0;
    for (let j = -1; j <= rows + 1; j++) for (let i = -1; i <= cols + 1; i++) {
      const w = Bc(x - i) * Bc(y - j);
      if (w) { const p = at(i, j); sx += w * p[0]; sy += w * p[1]; }
    }
    return [sx, sy];
  };
  const qu = Math.min(Math.max(u, 0), cols), qv = Math.min(Math.max(v, 0), rows);
  const s = inside(qu, qv);
  if (qu === u && qv === v) return s;
  const h = 1e-3, du = qu === 0 ? h : -h, dv = qv === 0 ? h : -h; // one-sided slopes, from inside
  const su = inside(qu + du, qv), sv = inside(qu, qv + dv);
  return [s[0] + (su[0] - s[0]) / du * (u - qu) + (sv[0] - s[0]) / dv * (v - qv),
    s[1] + (su[1] - s[1]) / du * (u - qu) + (sv[1] - s[1]) / dv * (v - qv)];
}

// what the JSON says, evaluated directly
function expected(bend, S) {
  const wPos = Math.max(bend, 0), wNeg = Math.max(-bend, 0);
  const [grid, inner] = rig.warps;
  const toCell = (w, x, y) => [(x - w.rect[0]) / w.rect[2] * w.cols, (y - w.rect[1]) / w.rect[3] * w.rows];
  const restPts = (w) => { const p = []; for (let j = 0; j <= w.rows; j++) for (let i = 0; i <= w.cols; i++) p.push([w.rect[0] + w.rect[2] * i / w.cols, w.rect[1] + w.rect[3] * j / w.rows]); return p; };
  const gd = rig.deformers[0].warps.grid.dense;
  const G = restPts(grid).map(([x, y], k) => {
    const px = x + wPos * gd[2 * k], py = y + wPos * gd[2 * k + 1];
    return [S[0] * px + S[2] * py + S[4], S[1] * px + S[3] * py + S[5]]; // bone a
  });
  const id = rig.deformers[1].warps.inner;
  const I = restPts(inner).map(([x, y], k) => {
    let dx = 0, dy = 0;
    id.points.forEach((p, n) => { if (p === k) { dx += id.deltas[2 * n]; dy += id.deltas[2 * n + 1]; } });
    const [u, v] = toCell(grid, x + wNeg * dx, y + wNeg * dy); // a delta in px is a delta in the parent's cells
    return surface(G, grid.cols, grid.rows, u, v);
  });
  const res = {};
  for (const p of rig.parts.filter((q) => q.warp)) {
    const w = p.warp === 'grid' ? grid : inner, P = p.warp === 'grid' ? G : I;
    const m = rig.deformers[0].morphs[p.id];
    res[p.id] = [];
    for (let k = 0; k < p.vertices.length / 2; k++) {
      let x = p.vertices[2 * k], y = p.vertices[2 * k + 1];
      if (m) m.vertices.forEach((vi, n) => { if (vi === k) { x += wPos * m.deltas[2 * n]; y += wPos * m.deltas[2 * n + 1]; } });
      const [u, v] = toCell(w, x, y);
      res[p.id].push(surface(P, w.cols, w.rows, u, v));
    }
  }
  return res;
}

const boneA = rig.bones.findIndex((b) => b.id === 'a');
let worstRest = 0, worst = 0, moved = 0;
for (const [label, t] of [['rest', null], ['idle 0.3', 0.3], ['idle 0.7', 0.7], ['idle 1.3', 1.3]]) {
  inst.reset();
  if (t !== null) inst.play('idle', t);
  inst.update(0);
  ex.ugo_deform_cpu(inst.ptr, out);
  const got = rt.f32(out, 2 * nv), fr = inst.frame();
  const S = Array.from(fr.subarray(model.skinOffset + 8 * boneA, model.skinOffset + 8 * boneA + 6));
  const want = expected(inst.get('Bend'), S);
  for (const [pid, pts] of Object.entries(want)) {
    const pi = parts.findIndex((p) => p.name === pid);
    pts.forEach(([x, y], k) => {
      const v = firstVert[pi] + k, e = Math.hypot(got[2 * v] - x, got[2 * v + 1] - y);
      if (t === null) {
        const src = rig.parts.find((q) => q.id === pid);
        worstRest = Math.max(worstRest, Math.hypot(got[2 * v] - src.vertices[2 * k], got[2 * v + 1] - src.vertices[2 * k + 1]));
      } else moved = Math.max(moved, Math.hypot(got[2 * v] - rig.parts.find((q) => q.id === pid).vertices[2 * k], 0));
      worst = Math.max(worst, e);
    });
  }
  if (label === 'idle 0.7') check(inst.get('Bend') > 0.5, `the idle animation bends the grid (Bend ${inst.get('Bend').toFixed(2)})`);
  if (label === 'idle 1.3') check(inst.get('Bend') < -0.5, `and bends it the other way (Bend ${inst.get('Bend').toFixed(2)})`);
}
check(worstRest < 1e-3, `rest pose: vertices in warp grids stay where the JSON put them (worst ${worstRest.toExponential(2)} px)`);
check(moved > 5, `the grids move the vertices (up to ${moved.toFixed(1)} px)`);
check(worst < 2e-2, `C core matches the JS reading of the warp rules (worst ${worst.toExponential(2)} px, incl. a nested grid, a morph inside a grid and vertices outside the grid)`);
// a bone in a warp grid (rotation deformer): its root sits on the surface and turns with it, plus its own rotation
{
  const rotB = rig.bones.find((b) => b.id === 'rot'), tipB = rig.bones.find((b) => b.id === 'rotTip');
  const g = rig.warps[0], D = Math.PI / 180, bi = (id) => model.boneCount && rig.bones.findIndex((b) => b.id === id);
  let worstRot = 0, turned = 0;
  for (const t of [0, 0.7, 1.3]) {
    inst.reset(); inst.play('idle', t); inst.update(0);
    const fr = inst.frame(), A = boneA;
    const S = Array.from(fr.subarray(model.skinOffset + 8 * A, model.skinOffset + 8 * A + 6));
    const bend = inst.get('Bend'), wPos = Math.max(bend, 0);
    const gd = rig.deformers[0].warps.grid.dense;
    const G = [];
    for (let j = 0; j <= g.rows; j++) for (let i = 0; i <= g.cols; i++) {
      const k = j * (g.cols + 1) + i, x = g.rect[0] + g.rect[2] * i / g.cols + wPos * gd[2 * k], y = g.rect[1] + g.rect[3] * j / g.rows + wPos * gd[2 * k + 1];
      G.push([S[0] * x + S[2] * y + S[4], S[1] * x + S[3] * y + S[5]]);
    }
    const cu = (rotB.x - g.rect[0]) / g.rect[2] * g.cols, cv = (rotB.y - g.rect[1]) / g.rect[3] * g.rows;
    const p0 = surface(G, g.cols, g.rows, cu, cv), p1 = surface(G, g.cols, g.rows, cu + 1e-3, cv);
    const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + wPos * 20 * D; // the grid's turn + the bone's own (Bend region)
    const rotW = [Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), p0[0], p0[1]];
    const ta = ang + (tipB.rotation || 0) * D, tx = rotW[0] * tipB.x + rotW[2] * tipB.y + rotW[4], ty = rotW[1] * tipB.x + rotW[3] * tipB.y + rotW[5];
    const tipW = [Math.cos(ta), Math.sin(ta), -Math.sin(ta), Math.cos(ta), tx, ty];
    const wa = rt.alloc(24);
    for (const [id, want] of [['rot', rotW], ['rotTip', tipW]]) {
      ex.ugo_bone_world(inst.ptr, rig.bones.findIndex((b) => b.id === id), wa);
      const got = rt.f32(wa, 6);
      for (let k = 0; k < 6; k++) worstRot = Math.max(worstRot, Math.abs(got[k] - want[k]) / (k < 4 ? 0.01 : 1));
    }
    turned = Math.max(turned, Math.abs(ang));
  }
  check(worstRot < 2e-2, `a bone in a warp grid sits on the surface and turns with it (worst ${worstRot.toExponential(2)}; turned up to ${(turned / D).toFixed(1)} deg)`);
}

// what the compiler refuses for bones in grids
{
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  const withBones = (extra) => ({ ...rig, ...extra });
  check(throws(() => compileUgo(withBones({ bones: rig.bones.map((b) => (b.id === 'rot' ? { ...b, parent: 'a' } : b)) }))), 'a bone in a grid with a parent bone is refused');
  check(throws(() => compileUgo(withBones({ constraints: [...rig.constraints, { id: 'bad', type: 'transform', bones: ['rotTip'], target: 'a' }] }))), 'a constraint on a bone in a grid is refused');
  check(throws(() => compileUgo(withBones({ warps: [...rig.warps, { id: 'onRot', cols: 1, rows: 1, rect: [0, 0, 10, 10], bone: 'rotTip' }] }))), 'a grid on a bone inside a grid is refused');
}

// the Web wrapper: the grids' rects, control points and surface
{
  const close = (a, b, e = 1e-3) => a.every((v, k) => Math.abs(v - b[k]) < e);
  check(rig.warps.every((w) => close(model.warps[model.warpIndex.get(w.id)].rect, w.rect)), 'UgoModel.warps gives each grid\'s rect (also for the nested one)');
  inst.reset(); inst.play('idle', 0.7); inst.update(0);
  const pts = inst.warpPoints(0), g = rig.warps[0];
  const corner = inst.warpEval(0, g.rect[0], g.rect[1]); // the surface passes through the outer points
  check(pts.length === 2 * (g.cols + 1) * (g.rows + 1) && close(corner, [pts[0], pts[1]]), 'UgoInstance.warpPoints / warpEval: the surface passes through the corner point');
  ex.ugo_deform_cpu(inst.ptr, out);
  const pi = parts.findIndex((p) => p.name === 'warped'), src = rig.parts.find((p) => p.id === 'warped'), got = rt.f32(out, 2 * nv);
  check(inst.deformedPositions().every((v, k) => v === got[k]), 'UgoInstance.deformedPositions is ugo_deform_cpu');
  const e = inst.warpEval(0, src.vertices[0], src.vertices[1]);
  check(close(e, [got[2 * firstVert[pi]], got[2 * firstVert[pi] + 1]]), 'warpEval at a vertex\'s rest position is where the vertex goes');
}
{ // a bone in a warp grid isn't a plain parent-child skeleton
  const plain = rt.loadModel(compileUgo({ format: 'ugo9', bones: [{ id: 'root' }, { id: 'b', parent: 'root', x: 5 }] }));
  const inGrid = rt.loadModel(compileUgo({ format: 'ugo9', bones: [{ id: 'root' }, { id: 'g', warp: 'w', x: 5 }],
    warps: [{ id: 'w', cols: 1, rows: 1, rect: [0, 0, 10, 10] }] }));
  check(ex.ugo_skeleton_is_simple(plain.ptr) === 1 && ex.ugo_skeleton_is_simple(inGrid.ptr) === 0, 'ugo_skeleton_is_simple: 0 with a bone in a warp grid');
}
check(ex.ugo_warp_count(model.ptr) === 2 && ex.ugo_part_warp(model.ptr, parts.findIndex((p) => p.name === 'innerPart')) === 1, 'warp accessors');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all warp checks passed');
