// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_settle_physics (web inst.settlePhysics): the swaying settles under held parameters, so a jump to a new pose
// (a game's first frame of a scene) does not swing in; ugo_deform_part_cpu (web inst.deformedPart): one part's vertices,
// the same as the whole model's.
//   node tests/settle_test.mjs
import fs from 'node:fs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const model = rt.loadModel(fs.readFileSync(new URL('../samples/basic/model.ug9', import.meta.url)));

const swing = (settle) => {
  const inst = model.createInstance();
  inst.reset(); inst.update(0); // the springs start at rest, then the head turns
  if (settle) { inst.reset(); inst.set('HeadTurnX', 30); inst.settlePhysics(5); }
  const before = inst.get('HairSideSway');
  inst.reset(); inst.set('HeadTurnX', 30); inst.update(1 / 60);
  return Math.abs(inst.get('HairSideSway') - before);
};
const raw = swing(false), settled = swing(true);
check(raw > 1e-3 && settled < raw / 50, `after settling, a frame hardly moves the sway (${settled.toExponential(2)}; without: ${raw.toExponential(2)})`);

const inst = model.createInstance();
inst.reset(); inst.set('HeadTurnX', 20); inst.set('MouthOpen', 1); inst.update(1 / 30);
const all = inst.deformedPositions();
let worst = 0, parts = 0;
for (let p = 0; p < model.partCount; p++) {
  const got = inst.deformedPart(p), buf = rt.alloc(16);
  rt.ex.ugo_part_range(model.ptr, p, buf);
  const start = rt.u32(buf, 1)[0]; // range[0]: the part's first vertex
  for (let k = 0; k < got.length; k++) worst = Math.max(worst, Math.abs(got[k] - all[2 * start + k]));
  parts++;
}
check(worst === 0, `each part's vertices equal the whole model's (${parts} parts, worst ${worst})`);
check(inst.deformedPart(9999) === null, 'an unknown part gives nothing');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all settle checks passed');
