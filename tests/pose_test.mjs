// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The C core's skeleton pose (transform inheritance, shear, IK and transform
// constraints, animated constraint mixes) against tools/skeleton_pose.mjs.
//   node tests/pose_test.mjs
// The JS rules were checked against real Spine exports (docs/Spine.md); this
// makes sure the runtime computes the same thing.
import fs from 'node:fs';
import { compileUgo, consForPose } from '../tools/compile.mjs';
import { poseWorld, INHERIT } from '../tools/skeleton_pose.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const range = (a, b) => a + (b - a) * rnd();

const rigUrl = new URL('./pose/rig.json', import.meta.url);
const rig = JSON.parse(fs.readFileSync(rigUrl, 'utf8'));
const { constraints } = rig;
// bones in warp grids (and below them) are placed by the grids: tests/warp_test.mjs checks those
const inGrid = new Set();
for (const b of rig.bones) if (b.warp || inGrid.has(b.parent)) inGrid.add(b.id);
const bones = rig.bones.filter((b) => !inGrid.has(b.id));

// one animation key per pose at t = 0, 1, 2, ...
const POSES = 40;
const anim = { id: 'random', loop: false, bones: {}, constraints: { arm: { mix: [], bend: [] }, follow: { mixRotate: [], mixX: [] } } };
const offsets = bones.map(() => []);
const mixes = [];
for (let p = 0; p < POSES; p++) {
  bones.forEach((b, i) => {
    const o = p === 0 ? [0, 0, 0, 0, 0, 0, 0] : [range(-30, 30), range(-15, 15), range(-15, 15), range(-0.3, 0.3), range(-0.3, 0.3), range(-10, 10), range(-10, 10)];
    offsets[i].push(o);
    const t = (anim.bones[b.id] ||= { rotate: [], x: [], y: [], scaleX: [], scaleY: [], shearX: [], shearY: [] });
    ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY'].forEach((k, j) => t[k].push([p, o[j], 'step']));
  });
  const m = p === 0 ? [1, 1, 0.6, 0.5] : [range(0, 1), rnd() < 0.5 ? -1 : 1, range(-1, 1), range(0, 1)];
  mixes.push(m);
  anim.constraints.arm.mix.push([p, m[0], 'step']);
  anim.constraints.arm.bend.push([p, m[1], 'step']);
  anim.constraints.follow.mixRotate.push([p, m[2], 'step']);
  anim.constraints.follow.mixX.push([p, m[3], 'step']);
}
const bin = compileUgo({ ...rig, bones, parts: [], textures: [], deformers: [], warps: [], colors: [], chains: [], animations: [anim] }); // (chains: tests/chain_test.mjs)

// tests/pose/rig.ug9 (used by the native tests and the corrupted-file runs) is compiled from rig.json
const committed = fs.readFileSync(new URL('./pose/rig.ug9', import.meta.url));
check(Buffer.compare(committed, Buffer.from(compileUgo(rig))) === 0, 'tests/pose/rig.ug9 is up to date (node tools/compile.mjs tests/pose/rig.json)');
// tests/runs/model.ug9 (the native tests: the animations' track runs; rig.json with an animation of held values) too
check(Buffer.compare(fs.readFileSync(new URL('./runs/model.ug9', import.meta.url)), Buffer.from(compileUgo(JSON.parse(fs.readFileSync(new URL('./runs/model.json', import.meta.url), 'utf8'))))) === 0,
  'tests/runs/model.ug9 is up to date (node tools/compile.mjs tests/runs/model.json)');

const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const model = rt.loadModel(bin);
const inst = model.createInstance();
const scratch = rt.alloc(64);
const D = Math.PI / 180;

// the same skeleton for skeleton_pose.mjs (compile reorders bones parents-first; this list already is)
const index = new Map(bones.map((b, i) => [b.id, i]));
const jsBones = bones.map((b) => ({ parent: b.parent ? index.get(b.parent) : -1, inherit: INHERIT[b.inherit || 'normal'], length: b.length || 0 }));
const rest = bones.map((b) => [b.x || 0, b.y || 0, (b.rotation || 0) * D, b.scaleX ?? 1, b.scaleY ?? 1, (b.shearX || 0) * D, (b.shearY || 0) * D]);
const records = [];
for (const c of constraints) {
  const one = { ...c };
  const list = c.type === 'transform' ? c.bones.map((bn) => ({ ...one, bones: [bn] })) : [one];
  for (const r of list) {
    if (r.type === 'ik') {
      records.push({ id: c.id, type: 0, flags: (r.compress ? 1 : 0) | (r.stretch ? 2 : 0) | (r.uniform ? 4 : 0), bone: index.get(r.bones[0]), bone2: r.bones[1] ? index.get(r.bones[1]) : -1, target: index.get(r.target), mix: [r.mix ?? 1, 0, 0, 0, 0, 0], off: [r.bend < 0 ? -1 : 1, 0, 0, 0, 0, 0] });
    } else {
      records.push({ id: c.id, type: 1, flags: (r.local ? 1 : 0) | (r.relative ? 2 : 0), bone: index.get(r.bones[0]), bone2: -1, target: index.get(r.target),
        mix: ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'].map((k) => r[k] ?? 1),
        off: [(r.rotation || 0) * D, r.x || 0, r.y || 0, r.scaleX || 0, r.scaleY || 0, (r.shearY || 0) * D] });
    }
  }
}

let worst = 0, worstAt = '';
for (let p = 0; p < POSES; p++) {
  inst.reset();
  inst.play('random', p);
  inst.update(0);
  const locals = rest.map((r, i) => {
    const o = offsets[i][p];
    return [r[0] + o[1], r[1] + o[2], r[2] + o[0] * D, r[3] + o[3], r[4] + o[4], r[5] + o[5] * D, r[6] + o[6] * D];
  });
  const cons = records.map((r) => {
    const c = { ...r, mix: [...r.mix], off: [...r.off] };
    if (r.id === 'arm') { c.mix[0] = mixes[p][0]; c.off[0] = mixes[p][1]; }
    if (r.id === 'follow') { c.mix[0] = mixes[p][2]; c.mix[1] = mixes[p][3]; }
    return consForPose(c);
  });
  const W = poseWorld(jsBones, locals, cons);
  for (let i = 0; i < bones.length; i++) {
    rt.ex.ugo_bone_world(inst.ptr, i, scratch);
    const got = rt.f32(scratch, 6);
    for (let k = 0; k < 6; k++) {
      const scale = k < 4 ? 1 : 100; // translations in pixels, axes in units
      const e = Math.abs(got[k] - W[i][k]) / scale;
      if (e > worst) { worst = e; worstAt = `pose ${p}, bone ${bones[i].id}, value ${k}: ${got[k].toFixed(4)} vs ${W[i][k].toFixed(4)}`; }
    }
  }
}
{ // the Web wrapper hands out the same matrices
  const all = inst.boneWorlds(), one = inst.boneWorld(bones.length - 1);
  rt.ex.ugo_bone_world(inst.ptr, bones.length - 1, scratch);
  const ref = Array.from(rt.f32(scratch, 6));
  check(one.every((v, k) => v === ref[k]) && ref.every((v, k) => v === all[6 * (bones.length - 1) + k]), 'UgoInstance.boneWorld / boneWorlds return ugo_bone_world');
}
check(worst < 1e-3, `C core matches skeleton_pose.mjs over ${POSES} random poses (worst ${worst.toExponential(2)}${worst ? ` at ${worstAt}` : ''})`);

// vertices with more than four bones (0.4): ugo_deform_cpu adds every influence
{
  const full = rt.loadModel(compileUgo(rig)), fi = full.createInstance(), ex = rt.ex;
  const nv = full.vertexCount, nx = ex.ugo_extra_weight_count(full.ptr);
  const pos = rt.f32(ex.ugo_positions(full.ptr), 2 * nv), joints = rt.u16(ex.ugo_joints(full.ptr), 4 * nv), wts = rt.f32(ex.ugo_weights(full.ptr), 4 * nv);
  const xs = rt.u32(ex.ugo_extra_weight_starts(full.ptr), nv + 1), xr = ex.ugo_extra_weights(full.ptr);
  const out = rt.alloc(8 * nv);
  let worstV = 0;
  for (const t of [0, 0.4, 1.1]) {
    fi.reset(); fi.play('idle', t); fi.update(0);
    ex.ugo_deform_cpu(fi.ptr, out);
    const fr = fi.frame(), got = rt.f32(out, 2 * nv), xb = rt.u32(xr, 2 * nx), xw = rt.f32(xr, 2 * nx);
    const vparts = rt.u32(ex.ugo_vertex_parts(full.ptr), nv);
    for (let v = 0; v < nv; v++) {
      if (ex.ugo_part_warp(full.ptr, vparts[v]) >= 0) continue; // warp grids place those (tests/warp_test.mjs)
      const infl = [];
      for (let j = 0; j < 4; j++) if (wts[4 * v + j] > 0) infl.push([joints[4 * v + j], wts[4 * v + j]]);
      for (let e = xs[v]; e < xs[v + 1]; e++) infl.push([xb[2 * e], xw[2 * e + 1]]);
      let x = 0, y = 0;
      for (const [b, w] of infl) {
        const S = fr.subarray(full.skinOffset + 8 * b);
        x += w * (S[0] * pos[2 * v] + S[2] * pos[2 * v + 1] + S[4]);
        y += w * (S[1] * pos[2 * v] + S[3] * pos[2 * v + 1] + S[5]);
      }
      worstV = Math.max(worstV, Math.abs(x - got[2 * v]), Math.abs(y - got[2 * v + 1]));
    }
  }
  check(nx === 7 && worstV < 1e-3, `vertices with 6 bones: ${nx} extra influences, deform matches (worst ${worstV.toExponential(2)} px)`);
}

// a .ug9 from format 0.2 is refused with a version error, not misread
const old = new Uint8Array(bin.slice(0));
new DataView(old.buffer).setUint16(4, 0, true); // major 0, minor 2
new DataView(old.buffer).setUint16(6, 2, true);
let refused = false;
try { rt.loadModel(old.buffer); } catch { refused = true; }
check(refused, 'a 0.2 file is refused (the 0.x layouts are not read by a 1.x core)');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all pose checks passed');
