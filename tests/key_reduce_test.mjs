// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/key_reduce.mjs: straight runs lose the keys a line already gives, curves keep theirs, and the
// reduced model plays within the tolerance of the original in the real core; loop seams are found.
//   node tests/key_reduce_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { reduceKeys, reduceTrack } from '../tools/key_reduce.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const line = Array.from({ length: 101 }, (_, i) => [i / 100, 3 * i]);
check(reduceTrack(line, 0.001).length === 2, 'a straight line of 101 keys keeps its two ends');
const bend = [[0, 0], [1, 1], [2, 2], [3, 0], [4, -2]];
check(JSON.stringify(reduceTrack(bend, 0.001)) === JSON.stringify([[0, 0], [2, 2], [4, -2]]), 'the corners are kept');
const curvy = [[0, 0], [1, 1, 'smooth'], [2, 2], [3, 3], [4, 4, 'step'], [5, 5], [6, 6, 'bezier', 0.3, 6, 0.6, 7], [7, 7]];
const c = reduceTrack(curvy, 0.001);
check(c.some((k) => k[2] === 'smooth') && c.some((k) => k[2] === 'step') && c.some((k) => k[2] === 'bezier') && c.length === 7,
  `keys that start or end a curve, step or smooth piece stay (${c.length} of ${curvy.length}: only the straight key between them goes)`);
check(reduceTrack([[0, [1, 0, 0]], [0.5, [0.5, 0.5, 0]], [1, [0, 1, 0]]], 0.001).length === 2, 'colours: every channel on the line');

const sine = Array.from({ length: 241 }, (_, i) => [i / 120, 30 * Math.sin(i / 120 * Math.PI)]);
const src = {
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'P', min: -30, default: 0, max: 30 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', length: 10 }],
  parts: [{ id: 'p', bone: 'arm', vertices: [0, -1, 10, -1, 10, 1, 0, 1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  animations: [{ id: 'a', duration: 2, tracks: { P: sine }, bones: { arm: { rotate: sine.map(([t, v]) => [t, 3 * v]), x: line.map(([t, v]) => [2 * t, v / 10]) } } }],
};
const r = reduceKeys(src);
check(r.removed > 400 && r.kept < 150 && src.animations[0].tracks.P.length === 241, `the model's keys: ${r.removed} removed, ${r.kept} kept (the source untouched)`);
const play = (m, t) => { const i = m.createInstance(); i.reset(); i.play(0, t); i.update(0); const w = i.boneWorld(1); return [i.get('P'), Math.atan2(w[1], w[0]) * 180 / Math.PI, w[4]]; };
const before = rt.loadModel(compileUgo(src)), after = rt.loadModel(compileUgo(r.model));
let dp = 0, dr = 0, dx = 0;
for (let t = 0; t < 2; t += 0.0031) { const a = play(before, t), b = play(after, t); dp = Math.max(dp, Math.abs(a[0] - b[0])); dr = Math.max(dr, Math.abs(a[1] - b[1])); dx = Math.max(dx, Math.abs(a[2] - b[2])); }
check(dp <= 0.06 + 0.002 && dr <= 0.05 + 0.01 && dx <= 0.05 + 0.002, `the reduced model plays within the tolerance in the core (parameter ${dp.toFixed(4)} of 0.06, angle ${dr.toFixed(4)}°, x ${dx.toFixed(4)} px)`);
check(r.seams.some((s) => s.track === 'bones.arm.x'), `a looping animation whose track ends elsewhere is reported (${r.seams.map((s) => s.track)})`);
const fixed = reduceKeys(src, { fixSeams: true });
check(fixed.model.animations[0].bones.arm.x.at(-1)[1] === 0, 'fixSeams sets the last key to the first value');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all key reduce checks passed');
