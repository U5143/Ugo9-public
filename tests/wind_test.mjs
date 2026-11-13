// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_set_wind (web inst.setWind): wind pushes the swaying chains its way, gusts make it come and go, the
// same times give the same sway, and no wind changes nothing.
//   node tests/wind_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 200, height: 200 },
  bones: [{ id: 'root' }, { id: 'h1', parent: 'root', rotate: 90, length: 40 }, { id: 'h2', parent: 'h1', x: 40, length: 40 }],
  parts: [{ id: 'p', bone: 'h1', vertices: [0, -2, 80, -2, 80, 2, 0, 2], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  chains: [{ id: 'hair', bones: ['h1', 'h2'], stiffness: 5, damping: 3, gravity: [0, 300] }],
}));
const tipX = (inst) => { const w = inst.boneWorld(2); return w[4] + w[0] * 40; };
const run = (wind, seconds = 3, fps = 60) => {
  const inst = model.createInstance(), xs = [];
  if (wind) inst.setWind(...wind);
  for (let i = 0; i < seconds * fps; i++) { inst.reset(); inst.update(1 / fps); xs.push(tipX(inst)); }
  return xs;
};
const calm = run(null), still = run([0, 0, 0]), right = run([600, 0, 0]), left = run([-600, 0, 0]), gusty = run([600, 0, 1.5]), again = run([600, 0, 1.5]);
check(calm.every((x, i) => x === still[i]), 'wind 0 sways exactly as no wind');
check(right.at(-1) > calm.at(-1) + 10 && left.at(-1) < calm.at(-1) - 10, `the wind pushes the hair its way (tip x: calm ${calm.at(-1).toFixed(1)}, right ${right.at(-1).toFixed(1)}, left ${left.at(-1).toFixed(1)})`);
const span = (xs) => Math.max(...xs.slice(-90)) - Math.min(...xs.slice(-90));
check(span(gusty) > span(right) + 1, `gusts make it come and go (last 1.5 s swing: steady ${span(right).toFixed(2)}, gusty ${span(gusty).toFixed(2)})`);
check(gusty.every((x, i) => x === again[i]), 'the same times give the same sway');

// saved and put back with the state: a replay from the middle sways the same
{
  const a = model.createInstance();
  a.setWind(600, 0, 1.5);
  for (let i = 0; i < 70; i++) { a.reset(); a.update(1 / 60); }
  const saved = a.saveState(), rest = [];
  for (let i = 0; i < 60; i++) { a.reset(); a.update(1 / 60); rest.push(tipX(a)); }
  const b = model.createInstance();
  b.loadState(saved);
  const replay = [];
  for (let i = 0; i < 60; i++) { b.reset(); b.update(1 / 60); replay.push(tipX(b)); }
  check(replay.every((x, i) => x === rest[i]) && saved.wind[2] === 1.5, 'the wind and its clock are saved with the state: a replay from the middle sways the same');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all wind checks passed');
