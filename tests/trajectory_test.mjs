// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web model.trajectory(): a bone's path in an animation as the core plays it (tip or origin, a range,
// fps), physics included, without touching the caller's characters.
//   node tests/trajectory_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 200, height: 200 },
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', length: 50 }, { id: 'h1', parent: 'root', y: 10, rotate: 90, length: 30 }, { id: 'h2', parent: 'h1', x: 30, length: 30 }],
  parts: [{ id: 'p', bone: 'arm', vertices: [0, -2, 50, -2, 50, 2, 0, 2], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  chains: [{ id: 'hair', bones: ['h1', 'h2'], stiffness: 20, damping: 2, gravity: [0, 300] }],
  animations: [{ id: 'swing', duration: 1, loop: false, bones: { arm: { rotate: [[0, 0], [1, 90]] }, root: { x: [[0, 0], [1, 40]] } } }],
}));
const path = model.trajectory('swing', 'arm', { fps: 10 });
const at = (t) => path.find((p) => Math.abs(p[0] - t) < 1e-6);
check(path.length === 11 && Math.hypot(at(0)[1] - 50, at(0)[2]) < 1e-3 && Math.hypot(at(1)[1] - 40, at(1)[2] - 50) < 1e-2,
  `the arm's tip from (50, 0) to (40, 50) in 11 samples (${path.length}; end ${at(1).slice(1).map((v) => v.toFixed(2))})`);
const origin = model.trajectory('swing', 'arm', { fps: 10, tip: false });
check(Math.abs(origin.at(-1)[1] - 40) < 1e-3 && Math.abs(origin.at(-1)[2]) < 1e-3, 'tip: false follows the origin');
const part = model.trajectory('swing', 'arm', { fps: 10, from: 0.5 });
check(part.length === 6 && Math.abs(part[0][0] - 0.5) < 1e-6, 'from: recorded from there on');
const hair = model.trajectory('swing', 'h2', { fps: 30 });
const lag = hair.map(([t, x]) => x - 40 * t);
check(Math.max(...lag) - Math.min(...lag) > 1, `physics included: the hair's tip lags as the root moves (sways ${(Math.max(...lag) - Math.min(...lag)).toFixed(2)} px)`);
const again = model.trajectory('swing', 'h2', { fps: 30 });
check(hair.every((p, i) => p.every((v, k) => v === again[i][k])), 'the same call gives the same path (physics starts over)');
const mine = model.createInstance();
mine.reset(); mine.play('swing', 0.3); mine.update(0); const before = mine.boneWorld(1);
model.trajectory('swing', 'arm');
check(mine.boneWorld(1).every((v, k) => v === before[k]), 'the caller\'s characters are not touched');
check(model.trajectory('nope', 'arm') === null && model.trajectory('swing', 'nope') === null, 'unknown animations and bones give null');
check(model.bones[1].length === 50, 'model.bones has each bone\'s length');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all trajectory checks passed');
