// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web UgoBlink and UgoMouth (the engines' helper rules): blinks every 2-6 s from a seeded random, closing in
// 0.07 s and opening in 0.12 s, multiplying the eyes' values; the mouth opens fast and closes slower.
//   node tests/blink_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoBlink, UgoMouth, UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'EyeOpenL', min: 0, default: 1, max: 1 }, { id: 'EyeOpenR', min: 0, default: 1, max: 1 }, { id: 'MouthOpen', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }], parts: [{ id: 'p', bone: 'root', vertices: [0, 0, 1, 0, 1, 1], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }],
}));
const inst = model.createInstance(), dt = 1 / 100;
const trace = (seed, seconds, eyeStart = 1) => {
  const b = new UgoBlink(model, { seed }), out = [];
  for (let i = 0; i < seconds / dt; i++) { b.update(dt); inst.reset(); inst.set('EyeOpenL', eyeStart); b.apply(inst); out.push(inst.get('EyeOpenL')); }
  return out;
};
const eyes = trace(12345, 20);
const starts = eyes.map((v, i) => (v < 1 && (i === 0 || eyes[i - 1] === 1) ? i * dt : null)).filter((t) => t !== null);
const gaps = starts.slice(1).map((t, i) => t - starts[i]);
check(starts.length >= 3 && gaps.every((g) => g >= 2 && g <= 6 + 0.2), `blinks come every 2-6 s (${starts.map((t) => t.toFixed(2)).join(', ')})`);
const firstShut = eyes.findIndex((v) => v < 0.1) * dt - starts[0];
const reopen = (eyes.findIndex((v, i) => i * dt > starts[0] && v === 1) * dt) - starts[0];
check(firstShut <= 0.07 + 0.02 && reopen >= 0.17 && reopen <= 0.21, `a blink shuts in about 0.07 s and is open again after about 0.19 s (${firstShut.toFixed(2)}, ${reopen.toFixed(2)})`);
check(JSON.stringify(trace(12345, 10)) === JSON.stringify(trace(12345, 10)) && JSON.stringify(trace(7, 10)) !== JSON.stringify(trace(12345, 10)), 'the same seed blinks the same; another seed differently');
const half = trace(12345, 20, 0.5);
check(half.every((v, i) => Math.abs(v - eyes[i] * 0.5) < 1e-6), 'it multiplies: half-closed eyes still blink');

const mouth = new UgoMouth(model), at = () => { inst.reset(); mouth.apply(inst); return inst.get('MouthOpen'); };
check(at() === 0, 'level < 0 leaves the mouth alone');
mouth.level = 1;
let opened = 0; for (let i = 0; i < 6; i++) mouth.update(dt); opened = at();
mouth.level = 0;
let closed = 0; for (let i = 0; i < 6; i++) mouth.update(dt); closed = 1 - (at() / opened);
check(opened > 0.8 && closed < opened && closed > 0.3, `it opens fast (${opened.toFixed(2)} after 0.06 s) and closes slower (${(closed * 100).toFixed(0)}% of the way in 0.06 s)`);

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all blink checks passed');
