// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoFrames (web/ugo.js), fixed frames for video tools (利用者の声 #409: Remotion asks for frames in any order,
// on several workers): on the sample (its hair sways with physics), frame n is the same, bit for bit, whether the
// frames are asked for in order, backwards, in a shuffled order, or on another instance that starts at frame n;
// and it equals playing straight from frame 0. Also: the core loads from bytes (no fetch of a file: URL).
//   node tests/frames_test.mjs
import fs from 'node:fs';
import { UgoRuntime, UgoFrames } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = await UgoRuntime.load(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)));
check(!!rt.ex.ugo_update, 'UgoRuntime.load takes the bytes of ugo.wasm (Node, server-side rendering)');
const model = rt.loadModel(fs.readFileSync(new URL('../samples/basic/model.ug9', import.meta.url)));

const fps = 30, N = 150;
// a scene that depends on the time only: the idle animation, a turning head, the character walking right
const setup = (inst, t) => {
  inst.play('idle', t);
  inst.set('HeadTurnX', 30 * Math.sin(t * 2.1));
  inst.setTransform(1, 0, 0, 1, 200 + 40 * t, 500);
};
const block = (inst) => Array.from(inst.frame());

// played straight, by hand
const straight = [];
{
  const inst = model.createInstance();
  for (let n = 0; n < N; n++) { inst.reset(); setup(inst, n / fps); inst.update(n === 0 ? 0 : 1 / fps); straight.push(block(inst)); }
}
const swings = straight.some((f, n) => n > 0 && f.some((v, i) => v !== straight[0][i]));
const hair = model.paramIndex.get('HairSideSway');
check(swings && hair !== undefined, 'the scene moves (and the sample has swaying hair)');
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

const inOrder = new UgoFrames(model, { fps, setup });
check(straight.every((f, n) => same(block(inOrder.frame(n)), f)), 'in order: every frame equals playing straight');
const back = new UgoFrames(model, { fps, setup });
let ok = true;
for (let n = N - 1; n >= 0; n--) ok &&= same(block(back.frame(n)), straight[n]);
check(ok, 'backwards: the same frames');
let seed = 9;
const order = Array.from({ length: N }, (_, i) => i).sort(() => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5);
const shuffled = new UgoFrames(model, { fps, setup });
check(order.every((n) => same(block(shuffled.frame(n)), straight[n])), `shuffled (${order.slice(0, 6).join(', ')}, ...): the same frames`);
// another worker that starts somewhere in the middle
check([137, 71, 3, 120].every((n) => same(block(new UgoFrames(model, { fps, setup }).frame(n)), straight[n])), 'a fresh one asked for frame 137, 71, 3 or 120 first: the same');
const again = new UgoFrames(model, { fps, setup });
again.frame(140);
check(same(block(again.frame(140)), straight[140]) && same(block(again.frame(45)), straight[45]), 'the same frame twice, then far back: the same');
// the swaying hair is what makes this hard: it really differs from a frame computed without its past
const cold = model.createInstance();
cold.reset(); setup(cold, 100 / fps); cold.update(1 / fps);
check(cold.get(hair) !== again.frame(100).get(hair), `(without its past the hair would be elsewhere: ${cold.get(hair).toFixed(3)} vs ${again.frame(100).get(hair).toFixed(3)})`);
// other rates
for (const f of [24, 60]) {
  const a = new UgoFrames(model, { fps: f, setup }), b = new UgoFrames(model, { fps: f, setup });
  for (let n = 0; n <= 90; n++) a.frame(n);
  check([90, 7, 55].every((n) => same(block(a.frame(n)), block(b.frame(n)))), `${f} fps: the same frames in another order`);
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all frames checks passed');
