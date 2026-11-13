// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Reading an animation's tracks (ugo_animation_track*, web model.animationTracks): kinds, targets, keys in
// seconds and authoring units (curve keys as their pieces), and value(t) equal to what playing gives.
//   node tests/track_read_test.mjs
import fs from 'node:fs';
import { UgoRuntime } from '../web/ugo.js';
import { build } from './v11/make_model.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(build().v11);

const tracks = model.animationTracks('wave');
const by = (kind, target) => tracks.find((t) => t.kind === kind && t.target === target);
check(tracks.length === 7, `wave has its 7 tracks (${tracks.map((t) => `${t.kind}:${t.target}`).join(', ')})`);
const C = by('param', 'C'), D = by('param', 'D'), A = by('param', 'A'), arm = by('rotate', 'arm'), op = by('opacity', 'p');
check(C && C.keys.length === 0 && Math.abs(C.value(0.7) - 0.5) < 1e-6, 'a track without keys has one value');
check(D && D.smooth && !A.smooth, 'the smooth mark is read');
check(A.keys.length === 25 && A.keys[0][0] === 0 && Math.abs(A.keys.at(-1)[0] - 2) < 1e-3 && A.keys.every((k, i) => !i || k[0] >= A.keys[i - 1][0]),
  `curve keys come as their pieces, in seconds (${A.keys.length} keys from 0 to ${A.keys.at(-1)[0].toFixed(4)} s)`);
check(arm && Math.abs(arm.value(1) - 90) < 0.01 && Math.abs(arm.keys.find(([t]) => Math.abs(t - 1) < 1e-3)[1] - 90) < 0.01, `bone angles are in degrees (arm at 1 s: ${arm.value(1).toFixed(4)}°)`);
check(op && op.target === 'p', 'an opacity track names its part');
let worst = 0;
const inst = model.createInstance();
for (let t = 0; t < 2; t += 0.0137) {
  inst.reset(); inst.play('wave', t);
  for (const id of ['A', 'B', 'D', 'E']) worst = Math.max(worst, Math.abs(by('param', id).value(t) - inst.get(id)));
}
check(worst < 1e-6, `value(t) is what playing gives (worst ${worst})`);
check(Math.abs(A.value(2.5) - A.value(0.5)) < 1e-6, 'value(t) wraps a looping animation');
check(model.animationTracks('nope') === null && rt.ex.ugo_animation_track_count(model.ptr, 99) === 0 && rt.ex.ugo_animation_track(model.ptr, 0, 999, 0) === 0, 'unknown animations and tracks give nothing');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all track reading checks passed');
