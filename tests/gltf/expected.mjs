// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Writes build/gltf/expected.json: values from the Ugo9 core at a few
// animation frames, for tests/gltf/verify_godot.gd to compare against.
//   node tests/gltf/expected.mjs [build/gltf/basic.glb]
import fs from 'node:fs';
import { UgoRuntime } from '../../web/ugo.js';

const glbPath = process.argv[2] || 'build/gltf/basic.glb';
const glb = fs.readFileSync(glbPath);
const names = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()).meshes[0].extras.targetNames;
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const b = fs.readFileSync(new URL('../../samples/basic/model.ug9', import.meta.url));
const model = rt.loadModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const ex = rt.ex, sc = rt.alloc(32), FPS = 30;
const out = {};
for (const [anim, frame] of [['idle', 45], ['idle', 62], ['talk', 14]]) {
  const inst = model.createInstance(), ai = model.animationIndex.get(anim), dur = model.animations[ai].duration, dt = 1 / FPS;
  for (let t = -dur; t < -1e-9; t += dt) { inst.reset(); inst.play(ai, t); inst.update(dt); }
  for (let f = 0; f <= frame; f++) { inst.reset(); inst.play(ai, f / FPS); inst.update(dt); }
  const fr = inst.frame();
  const morph = Object.fromEntries(names.map((n, i) => [n, fr[model.morphOffset + i]]));
  const bones = {};
  for (let i = 0; i < model.boneCount; i++) {
    ex.ugo_bone_pose(inst.ptr, i, sc);
    const [x, y, rot] = rt.f32(sc, 5);
    bones[rt.str(ex.ugo_bone_name(model.ptr, i))] = { tx: x * 0.01, ty: -y * 0.01, angleZ: -rot };
  }
  const opacity = {};
  for (let i = 0; i < model.partCount; i++) opacity[rt.str(ex.ugo_part_name(model.ptr, i))] = fr[model.opacityOffset + i];
  out[`${anim}@${frame}`] = { time: frame / FPS, morph, bones, opacity };
}
fs.mkdirSync('build/gltf', { recursive: true });
fs.writeFileSync('build/gltf/expected.json', JSON.stringify(out, null, 1));
console.log('build/gltf/expected.json written');
