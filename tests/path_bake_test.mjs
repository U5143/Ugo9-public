// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/path_bake.mjs: a part running along a line, baked into bone keys (over time) or deformers
// (by a parameter). The baked model is compiled and run in the real core: the bone must be where
// the line puts it (within the tolerance), turned with it, as visible as asked, as fast as asked,
// and inside a warp grid it must bend with the grid.
//   node tests/path_bake_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { bakePathAnimation, bakePathParam, makePath } from '../tools/path_bake.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const ORIGIN = [10, -40];
const quad = [-3, -3, 3, -3, 3, 3, -3, 3], mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
const model = (extra) => ({
  format: 'ugo9', canvas: { width: 200, height: 200, originX: 100, originY: 100 },
  parameters: [{ id: 'Sweat', min: 0, default: 0, max: 1 }, { id: 'Pull', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'drop', x: ORIGIN[0], y: ORIGIN[1], ...(extra.dropBone || {}) }],
  parts: [{ id: 'sweat', bone: 'drop', vertices: quad.map((v, i) => v + ORIGIN[i & 1]), ...mesh }],
  ...extra.model,
});
const world = (inst) => { const w = inst.boneWorld(1); return { x: w[4], y: w[5], rot: Math.atan2(w[1], w[0]) * 180 / Math.PI }; };
const angleDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const path = { points: [[0, -60], [30, -40], [20, 0], [-10, 10], [-25, -30]], closed: true };

// ---- over time ----
{
  const opts = { path, bone: 'drop', origin: ORIGIN, duration: 4, rotate: true, speed: [[0, 1], [0.4, 0.25], [0.6, 0.25], [1, 1]],
    opacity: [[0, 0], [0.1, 1], [0.8, 1], [1, 0]], part: 'sweat' };
  const b = bakePathAnimation(opts);
  const src = model({ model: { animations: [{ id: 'run', duration: 4, loop: true, bones: b.bones, opacity: b.opacity }] } });
  const m = rt.loadModel(compileUgo(src)), inst = m.createInstance();
  let dPos = 0, dRot = 0, dOp = 0;
  for (let t = 0; t <= 4; t += 0.0173) {
    inst.reset(); inst.play('run', Math.min(t, 3.9999)); inst.update(0);
    const w = world(inst), e = b.at(Math.min(t, 3.9999)), op = inst.frame()[m.opacityOffset];
    dPos = Math.max(dPos, Math.hypot(w.x - (e.x + ORIGIN[0]), w.y - (e.y + ORIGIN[1])));
    dRot = Math.max(dRot, angleDiff(w.rot, e.rot));
    dOp = Math.max(dOp, Math.abs(op - e.op));
  }
  check(dPos < 0.25 + 0.05, `the bone follows the line within the tolerance (worst ${dPos.toFixed(3)} px, tolerance 0.25)`);
  check(dRot < 0.5 + 0.1, `and turns with it (worst ${dRot.toFixed(3)}°, tolerance 0.5)`);
  check(dOp < 1 / 255 + 0.002, `the part's opacity follows the stops along the line (worst ${dOp.toFixed(4)})`);
  check(b.keys < b.samples, `keys are dropped where the line is straight enough (${b.keys} keys from ${b.samples} samples per track)`);
  // speed: a quarter as fast between 0.4 and 0.6 of the way
  const rate = (t) => (b.at(t + 0.01).u - b.at(t).u) / 0.01, tSlow = (() => { let t = 0; while (b.at(t).u < 0.5) t += 0.001; return t; })();
  const speed = (u) => (u < 0.4 ? 1 - 0.75 * u / 0.4 : u < 0.6 ? 0.25 : 0.25 + 0.75 * (u - 0.6) / 0.4); // the stops above
  const ratio = rate(tSlow) / rate(0.05), want = speed(0.5) / speed(b.at(0.05).u);
  check(Math.abs(ratio / want - 1) < 0.01, `the speed along the line is as asked (at half way ${ratio.toFixed(3)} of the speed near the start, asked ${want.toFixed(3)})`);
  const s = b.at(0), e = b.at(4);
  check(Math.hypot(s.x - e.x, s.y - e.y) < 1e-6 && b.bones.drop.x[0][0] === 0 && b.bones.drop.x.at(-1)[0] === 4, 'a closed line loops: it ends where it starts, with keys at 0 and at the end');
  const straight = bakePathAnimation({ path: { points: [[0, 0], [100, 0]] }, bone: 'drop', duration: 2 });
  check(straight.bones.drop.x.length === 2, `an even run along a straight line needs only its two ends (${straight.bones.drop.x.length} keys)`);
}

// ---- by a parameter ----
{
  const opts = { path: { points: [[0, -60], [25, -30], [5, 10]] }, bone: 'drop', origin: ORIGIN, param: 'Sweat', range: [0, 1], rotate: true,
    opacity: [[0, 1], [0.7, 1], [1, 0]], part: 'sweat' };
  const b = bakePathParam(opts);
  const m = rt.loadModel(compileUgo(model({ model: { deformers: b.deformers } }))), inst = m.createInstance();
  let dPos = 0, dRot = 0, dOp = 0;
  for (let v = 0; v <= 1; v += 0.0071) {
    inst.reset(); inst.set('Sweat', v); inst.update(0);
    const w = world(inst), e = b.at(v), op = inst.frame()[m.opacityOffset];
    dPos = Math.max(dPos, Math.hypot(w.x - (e.x + ORIGIN[0]), w.y - (e.y + ORIGIN[1])));
    dRot = Math.max(dRot, angleDiff(w.rot, e.rot));
    dOp = Math.max(dOp, Math.abs(op - e.op));
  }
  check(dPos < 0.3, `by a parameter the bone follows the line too (worst ${dPos.toFixed(3)} px, ${b.keys} deformers)`);
  check(dRot < 0.6, `and turns with it (worst ${dRot.toFixed(3)}°)`);
  check(dOp < 1 / 255 + 0.002, `and the opacity follows (worst ${dOp.toFixed(4)})`);
}

// ---- inside a warp grid: the line bends with the grid ----
{
  const grid = { id: 'g', cols: 2, rows: 2, rect: [-60, -100, 120, 140], bone: 'root' };
  const b = bakePathAnimation({ path, bone: 'drop', origin: ORIGIN, duration: 2, tolerance: 0.1 });
  const pull = { region: { Pull: [0, 1, 1] }, warps: { g: { points: [4], deltas: [15, -10] } } };
  const src = model({ dropBone: { warp: 'g' }, model: { warps: [grid], deformers: [pull], animations: [{ id: 'run', duration: 2, bones: b.bones }] } });
  const m = rt.loadModel(compileUgo(src)), inst = m.createInstance();
  let dRest = 0, dBent = 0, moved = 0;
  for (let t = 0; t < 2; t += 0.037) {
    const e = b.at(t), px = e.x + ORIGIN[0], py = e.y + ORIGIN[1];
    inst.reset(); inst.play('run', t); inst.update(0);
    let w = world(inst);
    dRest = Math.max(dRest, Math.hypot(w.x - px, w.y - py));
    inst.reset(); inst.play('run', t); inst.set('Pull', 1); inst.update(0);
    w = world(inst);
    const q = inst.warpEval(0, px, py);
    dBent = Math.max(dBent, Math.hypot(w.x - q[0], w.y - q[1]));
    moved = Math.max(moved, Math.hypot(q[0] - px, q[1] - py));
  }
  check(dRest < 0.15, `in a warp grid at rest the bone follows the line (worst ${dRest.toFixed(3)} px)`);
  check(moved > 5 && dBent < 0.3, `and when the grid bends, the line bends with it (the grid moves it up to ${moved.toFixed(1)} px; worst ${dBent.toFixed(3)} px from the bent line)`);
}

// ---- the line itself, and bad input ----
{
  const sq = makePath({ points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true, handles: Array(4).fill([0, 0, 0, 0]) });
  check(Math.abs(sq.length - 40) < 1e-6 && Math.hypot(sq.at(0.5).x - 10, sq.at(0.5).y - 10) < 1e-6, `handles of 0 make corners: a square's length is 40 (${sq.length.toFixed(6)}) and half way is the far corner`);
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  check(throws(() => makePath({ points: [[0, 0]] })), 'a line of one point is refused');
  check(throws(() => bakePathAnimation({ path, bone: 'drop', speed: [[0, 1], [0.5, 0]] })), 'a speed of 0 is refused');
  check(throws(() => bakePathAnimation({ path, bone: 'drop', opacity: [[0, 1]] })), 'opacity without the part is refused');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all path bake checks passed');
