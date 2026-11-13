// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web UgoAnimator: layers, crossfades, a queue (playlist), speed, a time range, added layers, stopping with a
// fade, and the 'end' event.
//   node tests/animator_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoAnimator, UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const quad = [-5, -5, 5, -5, 5, 5, -5, 5], mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'P', min: 0, default: 0, max: 100 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root' }],
  parts: [{ id: 'a', bone: 'arm', vertices: quad, ...mesh }],
  animations: [
    { id: 'ramp', duration: 1, tracks: { P: [[0, 0], [1, 100]] } },              // P = 100 t, loops
    { id: 'hold', duration: 1, tracks: { P: [[0, 50], [1, 50]] } },               // P = 50
    { id: 'once', duration: 0.5, loop: false, tracks: { P: [[0, 10], [0.5, 10]] } },
    { id: 'wave', duration: 1, bones: { arm: { rotate: [[0, 90], [1, 90]] } } },
  ],
}));
const inst = model.createInstance();
const frame = (anim) => { inst.reset(); anim.apply(inst); inst.update(0); const w = inst.boneWorld(1); return { P: inst.get('P'), arm: Math.atan2(w[1], w[0]) * 180 / Math.PI }; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

{
  const a = new UgoAnimator(model);
  a.play('ramp'); a.update(0.25);
  check(near(frame(a).P, 25), `one animation plays at its time (${frame(a).P.toFixed(3)})`);
  a.update(1.0);
  check(near(frame(a).P, 25), 'a looping one wraps');
  a.play('hold', { fade: 1 }); a.update(0.5);
  const p = frame(a).P, ramp = 75; // ramp at 1.75 -> 0.75
  check(near(p, ramp + (50 - ramp) * 0.5), `half way through a 1 s crossfade, half of each (${p.toFixed(3)}, expected ${(ramp + (50 - ramp) * 0.5).toFixed(3)})`);
  a.update(0.6);
  check(near(frame(a).P, 50) && !a.layers[0].old, 'after the fade only the new one is left');
}
{
  const a = new UgoAnimator(model), ends = [];
  a.on('end', (e) => ends.push(e.name));
  a.play('once', { fade: 0 }); a.queue('hold', { fade: 0 });
  a.update(0.3);
  check(near(frame(a).P, 10), 'the first of the queue plays');
  a.update(0.3);
  check(near(frame(a).P, 50) && ends.join() === 'once', `when it ends the next one starts, and 'end' says so (${ends})`);
  const b = new UgoAnimator(model);
  b.play('ramp', { fade: 0 }); b.queue('hold', { fade: 0 }); b.update(1.1);
  check(near(frame(b).P, 50), 'a looping one hands over to the queue after its loop');
}
{
  const a = new UgoAnimator(model);
  a.play('ramp', { speed: 2, from: 0.25, to: 0.75, fade: 0 }); a.update(0.1);
  check(near(frame(a).P, 45), `speed and range: 0.25 + 2 * 0.1 s (${frame(a).P.toFixed(3)})`);
  a.update(0.2);
  check(near(frame(a).P, 35), `the range loops within itself: 0.85 s is 0.35 s (${frame(a).P.toFixed(3)})`);
}
{
  const a = new UgoAnimator(model);
  a.play('hold'); a.play('wave', { layer: 1, add: true, fade: 0 }); a.update(0.1);
  let f = frame(a);
  check(near(f.P, 50) && near(f.arm, 90), 'an added layer goes on top of layer 0');
  a.stop(1, 0.5); a.update(0.25);
  f = frame(a);
  check(near(f.arm, 45) && near(f.P, 50), `stopping fades the layer out (${f.arm.toFixed(2)}° half way)`);
  a.update(0.3);
  check(near(frame(a).arm, 0) && !a.layers[1].old, 'and then it is gone');
  const m = new UgoAnimator(model);
  m.play('ramp', { fade: 0 }); m.update(0.2); m.play('hold', { layer: 1, fade: 0, weight: 0.5 });
  check(near(frame(m).P, 20 + (50 - 20) * 0.5), 'a mixing layer with weight 0.5 goes half way to it');
}
{ // save and load: rewinding gives the same frames
  const a = new UgoAnimator(model);
  a.play('ramp', { fade: 0 }); a.update(0.3); a.play('hold', { fade: 0.5 }); a.queue('once'); a.update(0.1);
  const saved = a.save(), seq = [];
  for (let i = 0; i < 20; i++) { a.update(0.05); seq.push(frame(a).P); }
  a.load(saved);
  const again = [];
  for (let i = 0; i < 20; i++) { a.update(0.05); again.push(frame(a).P); }
  check(again.every((p, i) => p === seq[i]), 'save() and load() rewind the layers, fades and queue');
}
{
  let threw = false;
  try { new UgoAnimator(model).play('nope'); } catch { threw = true; }
  check(threw, 'an unknown animation is refused');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all animator checks passed');
