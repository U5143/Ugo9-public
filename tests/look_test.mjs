// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web UgoLook: the face, eyes and a little of the body turn towards a point, smoothly, on the standard
// parameter names or the older ones, and come back when it stops; a model without them is left alone.
//   node tests/look_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoLook, UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const make = (names) => rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 200, height: 400, originX: 100, originY: 400 },
  parameters: names.map(([id, lo, hi]) => ({ id, min: lo, default: 0, max: hi })),
  bones: [{ id: 'root' }], parts: [{ id: 'p', bone: 'root', vertices: [0, 0, 1, 0, 1, 1], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }],
}));
const std = make([['HeadTurnX', -30, 30], ['HeadTurnY', -30, 30], ['PupilX', -1, 1], ['PupilY', -1, 1], ['BodyTurnX', -10, 10]]);
const run = (model, frames, setup) => {
  const look = new UgoLook(model), inst = model.createInstance();
  setup(look);
  for (let i = 0; i < frames; i++) { look.update(1 / 60); inst.reset(); look.apply(inst); }
  return { look, inst };
};
const far = run(std, 120, (l) => l.lookAt(1000, -1300)); // right and up of the face (0, -300)
const g = (r, n) => r.inst.get(n);
check(Math.abs(g(far, 'HeadTurnX') - 30) < 0.05 && Math.abs(g(far, 'HeadTurnY') - 30) < 0.05 && Math.abs(g(far, 'PupilX') - 1) < 0.01 && Math.abs(g(far, 'BodyTurnX') - 3) < 0.01,
  `looking far right and up turns all the way (head ${g(far, 'HeadTurnX').toFixed(2)}, ${g(far, 'HeadTurnY').toFixed(2)}; body ${g(far, 'BodyTurnX').toFixed(2)} = 0.3 of its range)`);
const half = run(std, 120, (l) => l.lookAt(200, -300));
check(Math.abs(g(half, 'HeadTurnX') - 15) < 0.05 && Math.abs(g(half, 'HeadTurnY')) < 0.05, `half the range turns half way (${g(half, 'HeadTurnX').toFixed(2)})`);
const early = run(std, 3, (l) => l.lookAt(1000, -300));
check(g(early, 'HeadTurnX') > 1 && g(early, 'HeadTurnX') < 25, `it turns smoothly, not at once (${g(early, 'HeadTurnX').toFixed(2)} after 3 frames)`);
const back = run(std, 120, (l) => l.lookAt(1000, -300));
back.look.stop();
for (let i = 0; i < 120; i++) { back.look.update(1 / 60); back.inst.reset(); back.look.apply(back.inst); }
check(Math.abs(g(back, 'HeadTurnX')) < 0.05, `after stop it comes back (${g(back, 'HeadTurnX').toFixed(3)})`);
const old = make([['AngleX', -30, 30], ['EyeBallX', -1, 1]]), o = run(old, 120, (l) => l.lookAt(1000, -300));
check(Math.abs(g(o, 'AngleX') - 30) < 0.05 && Math.abs(g(o, 'EyeBallX') - 1) < 0.01, 'the older names work too');
const none = make([['Other', 0, 1]]);
let ok = true; try { run(none, 10, (l) => l.lookAt(5, 5)); } catch { ok = false; }
check(ok, 'a model without these parameters is left alone');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all look checks passed');
