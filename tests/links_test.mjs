// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web UgoLinks (set from code): a follower moves by the leader's change times scale, inverted, with a delay,
// added to its own value and kept in its range.
//   node tests/links_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoLinks, UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'Lead', min: -30, default: 0, max: 30 }, { id: 'Follow', min: -1, default: 0, max: 1 }, { id: 'Other', min: 0, default: 0.5, max: 1 }],
  bones: [{ id: 'root' }], parts: [{ id: 'p', bone: 'root', vertices: [0, 0, 1, 0, 1, 1], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }],
}));
const inst = model.createInstance();
const frame = (links, lead, dt = 1 / 60) => { inst.reset(); inst.set('Lead', lead); links.update(dt, inst); links.apply(inst); return [inst.get('Follow'), inst.get('Other')]; };
const now = new UgoLinks(model).add({ from: 'Lead', to: 'Follow', scale: 0.02 });
check(Math.abs(frame(now, 20)[0] - 0.4) < 1e-6, `the follower moves by the leader's change times scale (${frame(now, 20)[0].toFixed(3)})`);
const inv = new UgoLinks(model).add({ from: 'Lead', to: 'Other', scale: 0.01, invert: true });
check(Math.abs(frame(inv, 20)[1] - 0.3) < 1e-6, 'invert flips it, on top of the follower\'s own default');
check(Math.abs(frame(now, 200)[0] - 1) < 1e-6, 'the follower stays in its range');
const slow = new UgoLinks(model).add({ from: 'Lead', to: 'Follow', scale: 0.02, delay: 0.2 });
const first = frame(slow, 20);
let late = first; for (let i = 0; i < 120; i++) late = frame(slow, 20);
check(first[0] > 0 && first[0] < 0.1 && Math.abs(late[0] - 0.4) < 1e-3, `with a delay it follows smoothly (${first[0].toFixed(3)} after one frame, ${late[0].toFixed(3)} after 2 s)`);
let threw = false; try { new UgoLinks(model).add({ from: 'Lead', to: 'Nope' }); } catch { threw = true; }
check(threw, 'an unknown parameter is refused');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all link checks passed');
