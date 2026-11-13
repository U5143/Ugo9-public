// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animation layers (ugo_apply_animation_ex, web inst.play(.., { add, mask })): an added animation adds its
// change from the rest pose on top, a mask applies only the bones, parts, parameters, ... it names, and with
// neither it is the plain mix.
//   node tests/anim_layers_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const quad = (x) => [x - 5, -5, x + 5, -5, x + 5, 5, x - 5, 5];
const mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'P', min: 0, default: 2, max: 10 }, { id: 'Q', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 10 }, { id: 'leg', parent: 'root', x: -10 }],
  parts: [{ id: 'a', bone: 'arm', opacity: 0.5, vertices: quad(10), ...mesh }, { id: 'b', bone: 'leg', vertices: quad(-10), ...mesh }],
  animations: [
    { id: 'base', duration: 1, tracks: { P: [[0, 4], [1, 8]], Q: [[0, 1], [1, 1]] },
      bones: { arm: { rotate: [[0, 0], [1, 60]] }, leg: { rotate: [[0, 10], [1, 10]] } }, opacity: { a: [[0, 1], [1, 1]] } },
    { id: 'wave', duration: 1, tracks: { P: [[0, 8], [1, 8]] }, bones: { arm: { rotate: [[0, 90], [1, 90]] } }, opacity: { a: [[0, 0.25], [1, 0.25]] } },
  ],
}));
const deg = (inst, b) => { const w = inst.boneWorld(b); return Math.atan2(w[1], w[0]) * 180 / Math.PI; };
const state = (inst) => { inst.update(0); return { arm: deg(inst, 1), leg: deg(inst, 2), P: inst.get('P'), Q: inst.get('Q'), a: inst.frame()[model.opacityOffset], b: inst.frame()[model.opacityOffset + 1] }; };
const run = (f) => { const inst = model.createInstance(); inst.reset(); f(inst); return state(inst); };
const near = (x, y) => Math.abs(x - y) < 1e-4;
const same = (s, t) => Object.keys(s).every((k) => near(s[k], t[k]));

// neither add nor mask: the plain mix
{
  const plain = run((i) => { i.play('base', 0.5); i.play('wave', 0, 0.5); });
  const ex = run((i) => { i.play('base', 0.5, 1, {}); i.play('wave', 0, 0.5, { add: false }); });
  check(same(plain, ex), `with no choices it is the plain mix (arm ${plain.arm.toFixed(3)}°)`);
  check(near(plain.arm, 30 + (90 - 30) * 0.5) && near(plain.P, 6 + (8 - 6) * 0.5) && near(plain.a, 1 + (0.25 - 1) * 0.5), 'the plain mix goes towards the second animation');
}
// add
{
  const s = run((i) => { i.play('base', 0.5); i.play('wave', 0, 0.5, { add: true }); });
  check(near(s.arm, 30 + 90 * 0.5), `added: the bone turns by the added change on top (${s.arm.toFixed(3)}°, expected 75)`);
  check(near(s.P, 6 + (8 - 2) * 0.5), `added: a parameter adds its change from its default (${s.P.toFixed(3)}, expected 9)`);
  check(near(s.a, 1 + (0.25 - 0.5) * 0.5), `added: opacity adds its change from the part's own (${s.a.toFixed(4)}, expected 0.875)`);
  check(near(s.leg, 10) && near(s.Q, 1), 'added: what the added animation does not key stays as it was');
  const alone = run((i) => i.play('wave', 0, 1, { add: true }));
  check(near(alone.arm, 90) && near(alone.P, 8) && near(alone.a, 0.25), 'added at weight 1 on the rest pose gives the animation itself');
}
// mask
{
  const mask = model.animationMask({ bones: ['arm'], params: [], parts: ['b'] });
  const s = run((i) => i.play('base', 0.5, 1, { mask }));
  check(near(s.arm, 30) && near(s.leg, 0), `a mask of bones applies only those (arm ${s.arm.toFixed(2)}°, leg ${s.leg.toFixed(2)}°)`);
  check(near(s.P, 2) && near(s.Q, 0), 'an empty list of parameters applies none of them');
  check(near(s.a, 0.5), 'parts not in the mask keep their own opacity');
  const all = model.animationMask({ bones: ['arm', 'leg'] });
  const t = run((i) => i.play('base', 0.5, 1, { mask: all })), plain = run((i) => i.play('base', 0.5));
  check(same(t, plain), 'kinds the mask leaves out are applied whole');
  const both = run((i) => { i.play('base', 0.5); i.play('wave', 0, 1, { add: true, mask: model.animationMask({ bones: [2], params: [], parts: [] }) }); });
  check(near(both.arm, 30) && near(both.P, 6) && near(both.a, 1), 'add and mask together: a mask that leaves the waving arm out adds nothing');
  let threw = false;
  try { model.animationMask({ bones: ['tail'] }); } catch { threw = true; }
  check(threw, 'a mask naming a bone the model lacks is refused');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all animation layer checks passed');
