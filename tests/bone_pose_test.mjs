// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Posing bones without an animation (ugo_set_bone_offset / ugo_get_bone_offset, web inst.setBoneOffset,
// boneOffset) and dragging a bone's tip (ugo_solve_ik_to, web inst.dragBone): the pose shows after update,
// mixes by weight, and a drag brings the tip to a reachable point, also under a mirrored parent.
//   node tests/bone_pose_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const build = (rootScaleX = 1) => rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 300, height: 300, originX: 150, originY: 150 },
  bones: [{ id: 'root', scaleX: rootScaleX }, { id: 'upper', parent: 'root', length: 50 }, { id: 'lower', parent: 'upper', x: 50, length: 50 },
    { id: 'hand', parent: 'lower', x: 50, length: 10 }],
  parts: [{ id: 'p', bone: 'upper', vertices: [0, -5, 100, -5, 100, 5, 0, 5], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
}));
const tip = (inst, b, len) => { const w = inst.boneWorld(b); return [w[4] + w[0] * len, w[5] + w[1] * len]; };
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

// pose
{
  const m = build(), inst = m.createInstance();
  inst.reset(); inst.setBoneOffset('upper', { rotate: 90 }); inst.update(0);
  const [x, y] = tip(inst, 1, 50);
  check(near(x, 0, 1e-3) && near(y, 50, 1e-3), `a posed bone turns: upper's end at (${x.toFixed(3)}, ${y.toFixed(3)}), expected (0, 50)`);
  check(near(inst.boneOffset('upper').rotate, 90), 'boneOffset reads back what was set');
  inst.reset(); inst.setBoneOffset('upper', { rotate: 90 }, 0.5); inst.update(0);
  const w = inst.boneWorld(1);
  check(near(Math.atan2(w[1], w[0]) * 180 / Math.PI, 45, 1e-3), 'a pose at weight 0.5 goes half way');
  inst.reset(); inst.setBoneOffset('lower', { x: 10, scaleX: 1 }); inst.update(0);
  const p = inst.boneOffset('lower');
  check(near(p.x, 10) && near(p.scaleX, 1) && near(p.rotate, 0), 'fields left out stay as they were (scale is added to the rest scale)');
  inst.reset(); inst.update(0);
  check(near(inst.boneOffset('upper').rotate, 0), 'reset clears the pose');
}
// drag
for (const mirror of [1, -1]) {
  const m = build(mirror), inst = m.createInstance();
  inst.reset(); inst.update(0);
  const target = [30 * mirror, 70];
  let left = 0;
  for (let k = 0; k < 6; k++) { left = inst.dragBone('lower', target[0], target[1], 2, 10); inst.update(0); }
  const [x, y] = tip(inst, 2, 50), d = Math.hypot(x - target[0], y - target[1]);
  check(d < 0.05 && left < 0.05, `${mirror < 0 ? 'under a mirrored parent, ' : ''}dragging the lower bone's end brings it to the point (${d.toFixed(4)} px away)`);
  const root = inst.boneWorld(0);
  check(near(root[4], 0) && near(root[5], 0) && near(Math.atan2(root[1], root[0]), mirror < 0 ? Math.atan2(root[1], root[0]) : 0), 'bones above the chain do not move');
}
{
  const m = build(), inst = m.createInstance();
  inst.reset(); inst.update(0);
  for (let k = 0; k < 6; k++) { inst.dragBone('lower', 0, 300, 2, 10); inst.update(0); }
  const [x, y] = tip(inst, 2, 50);
  check(near(x, 0, 0.05) && near(y, 100, 0.05), `out of reach, the chain points straight at it (end at ${x.toFixed(3)}, ${y.toFixed(3)})`);
  inst.reset(); inst.update(0);
  inst.dragBone('hand', 0, 60, 1, 10); inst.update(0);
  const lower = inst.boneWorld(2);
  check(near(lower[0], 1) && near(lower[1], 0), 'a chain of 1 turns only that bone');
  check(inst.dragBone(99, 0, 0) === -1 && inst.ex.ugo_solve_ik_to(inst.ptr, 1, 0, 0, 0, 5) === -1, 'a bad bone or a chain of 0 is refused');
}

// the skeleton as the model has it, and the resulting local pose
{
  const m = build(), inst = m.createInstance();
  check(m.bones.length === 4 && m.bones[2].name === 'lower' && m.bones[2].parent === 1 && Math.abs(m.bones[2].rest.x - 50) < 1e-6, 'model.bones: names, parents and rest poses');
  check(m.skeletonIsSimple, 'a skeleton without constraints is simple');
  inst.reset(); inst.setBoneOffset('lower', { rotate: 30, x: 5 }); inst.update(0);
  const l = inst.boneLocal('lower');
  check(Math.abs(l.rotate - 30) < 1e-3 && Math.abs(l.x - 55) < 1e-3, `boneLocal: the resulting pose relative to the parent (rotate ${l.rotate.toFixed(3)}, x ${l.x.toFixed(3)})`);
  const pd = m.partData().parts[0];
  check(pd.firstVertex === 0 && pd.vertexCount === 4 && pd.order === 0, 'partData has each part\'s vertices and its own draw order value');
  inst.reset(); inst.paramValues(); check(inst.paramValues().length === 0, 'paramValues: a view of the parameters (none here)');
}

// world pose: keep a child where it is while its parent moves (Spine's "compensate")
for (const mirror of [1, -1]) {
  const m = build(mirror), inst = m.createInstance();
  inst.reset(); inst.setBoneOffset('lower', { rotate: 20 }); inst.update(0);
  const keep = inst.boneWorld(2);
  inst.setBoneOffset('upper', { rotate: 50, x: 7 }); inst.update(0); // the parent moves: the child follows
  const moved = inst.boneWorld(2);
  inst.setBoneWorld('lower', keep); inst.update(0);                   // put it back
  const back = inst.boneWorld(2);
  const d = Math.max(...back.map((v, k) => Math.abs(v - keep[k])));
  check(Math.hypot(moved[4] - keep[4], moved[5] - keep[5]) > 5 && d < 1e-3, `${mirror < 0 ? 'under a mirrored parent, ' : ''}setBoneWorld puts the child back where it was after its parent moved (off by ${d.toExponential(1)})`);
  const before = inst.boneWorld(1);
  inst.setBoneWorld('upper', before); inst.update(0);
  const after = inst.boneWorld(1);
  check(Math.max(...after.map((v, k) => Math.abs(v - before[k]))) < 1e-4, 'putting a bone at its own world changes (almost) nothing');
}
{
  const m = build(), inst = m.createInstance();
  inst.reset(); inst.setBoneOffset('upper', { rotate: 170 }); inst.update(0);
  const w = inst.boneWorld(1), t = Math.PI * 190 / 180;
  inst.setBoneWorld('upper', [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), w[4], w[5]]);
  check(Math.abs(inst.boneOffset('upper').rotate - 190) < 1e-3, `angles take the short way (170° -> 190°, not -170°: ${inst.boneOffset('upper').rotate.toFixed(3)}°)`);
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all bone pose checks passed');
