// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Swaying bone chains (format 0.6):
//   node tests/chain_test.mjs
// A chain of three bones hanging down from a root. Checks what the rules in
// docs/形式.md promise: no motion at rest, gravity pulls the tip, the root
// stays put and bone lengths are kept, moving the character on screen leaves
// the chain behind and it springs back, the tip lags behind the middle joint,
// the same input gives the same bits, reset_physics starts over.
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);

const model = (chain) => ({
  format: 'ugo9', version: '0.6', canvas: { width: 200, height: 200, originX: 100, originY: 20 },
  bones: [{ id: 'root' }, { id: 'c1', parent: 'root', rotation: 90, length: 30 },
    { id: 'c2', parent: 'c1', x: 30, length: 30 }, { id: 'c3', parent: 'c2', x: 30, length: 30 }],
  chains: [{ id: 'tail', bones: ['c1', 'c2', 'c3'], ...chain }],
});
const load = (chain) => rt.loadModel(compileUgo(model(chain)));
const joints = (inst) => { // roots of c1..c3, then c3's tip
  const w = [1, 2, 3].map((b) => inst.boneWorld(b));
  return [...w.map((m) => [m[4], m[5]]), [w[2][4] + 30 * w[2][0], w[2][5] + 30 * w[2][1]]];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const run = (inst, seconds, each) => { for (let f = 0; f < Math.round(seconds * 60); f++) { inst.reset(); if (each) each(inst, f); inst.update(1 / 60); } };

{ // at rest, nothing moves
  const inst = load({ stiffness: 40, damping: 4 }).createInstance();
  const before = joints(inst);
  run(inst, 2);
  const after = joints(inst);
  check(Math.max(...after.map((p, k) => dist(p, before[k]))) < 1e-3, 'no gravity, no move: the chain stays in its pose');
}
{ // gravity to the right
  const inst = load({ stiffness: 10, damping: 6, gravity: [400, 0] }).createInstance();
  const before = joints(inst);
  run(inst, 4);
  const after = joints(inst);
  check(dist(after[0], before[0]) < 1e-4, 'the root joint stays where the pose puts it');
  check(after[3][0] - before[3][0] > 10 && after[3][0] - before[3][0] > after[1][0] - before[1][0], `gravity pulls the tip furthest (tip ${(after[3][0] - before[3][0]).toFixed(1)} px, first joint ${(after[1][0] - before[1][0]).toFixed(1)} px)`);
  const lens = [1, 2, 3].map((k) => dist(after[k], after[k - 1]));
  check(lens.every((l) => Math.abs(l - 30) < 0.05), `bone lengths are kept (${lens.map((l) => l.toFixed(3)).join(', ')})`);
}
{ // the character moves right on screen, then stops
  const inst = load({ stiffness: 30, damping: 3 }).createInstance();
  const rest = joints(inst);
  const lagTip = [], lagMid = [];
  run(inst, 5, (it, f) => {
    const x = f < 15 ? f * 8 : 120; // 120 px in a quarter second, then still
    it.setTransform(1, 0, 0, 1, x, 0);
  });
  // replay to record, with the same input (and determinism check)
  const a = load({ stiffness: 30, damping: 3 }).createInstance(), b = load({ stiffness: 30, damping: 3 }).createInstance();
  for (let f = 0; f < 180; f++) {
    for (const it of [a, b]) { it.reset(); it.setTransform(1, 0, 0, 1, f < 15 ? f * 8 : 120, 0); it.update(1 / 60); }
    const j = joints(a);
    lagMid.push(j[2][0] - rest[2][0]); lagTip.push(j[3][0] - rest[3][0]);
  }
  check(Math.min(...lagTip) < -5, `moving right leaves the tip behind (to ${Math.min(...lagTip).toFixed(1)} px)`);
  const peak = (arr) => arr.indexOf(Math.min(...arr));
  check(peak(lagTip) >= peak(lagMid), `the tip lags behind the middle joint (deepest at frame ${peak(lagMid)} and ${peak(lagTip)})`);
  const end = joints(inst);
  check(Math.max(...end.map((p, k) => dist(p, rest[k]))) < 0.5, `it springs back once the character stops (${Math.max(...end.map((p, k) => dist(p, rest[k]))).toFixed(3)} px after 4.75 s)`);
  check(a.frame().every((v, k) => v === b.frame()[k]), 'the same input gives the same bits');
  a.resetPhysics(); a.reset(); a.update(1 / 60);
  const r = joints(a);
  check(Math.max(...r.map((p, k) => dist(p, rest[k]))) < 1e-3, 'reset_physics starts over from the pose');
}
{ // mix 0: the bones keep the animated pose
  const inst = load({ stiffness: 10, damping: 6, gravity: [400, 0], mix: 0 }).createInstance();
  const before = joints(inst);
  run(inst, 1);
  check(Math.max(...joints(inst).map((p, k) => dist(p, before[k]))) < 1e-4, 'mix 0 leaves the pose alone');
}
{ // reading a chain back (for exporters, e.g. VRM spring bones)
  const c = load({ stiffness: 12, damping: 3, gravity: [5, 600], inertia: 0.5, mix: 0.8 }).chains;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check(c.length === 1 && c[0].bones.join() === '1,2,3' && near(c[0].stiffness, 12) && near(c[0].damping, 3) && near(c[0].gravity[0], 5)
    && near(c[0].gravity[1], 600) && near(c[0].inertia, 0.5) && near(c[0].mix, 0.8), 'UgoModel.chains / ugo_chain_info / ugo_chain_bones read the chain back');
}
check(rt.ex.ugo_skeleton_is_simple(load({}).ptr) === 0, 'ugo_skeleton_is_simple: 0 with a swaying chain');
{ // carrying the state into an instance of an edited model (the editor recompiling)
  const sample = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));
  const sway = (m, inst, frames, from = 0) => { for (let f = from; f < from + frames; f++) { inst.reset(); inst.play('idle', f / 60); inst.set('BodyAngleX', 10 * Math.sin(f / 7)); inst.update(1 / 60); } };
  for (const [label, src] of [['parameter physics (the sample\'s hair)', sample], ['a swaying chain', model({ stiffness: 20, damping: 2, gravity: [300, 0] })]]) {
    const ma = rt.loadModel(compileUgo(src)), a = ma.createInstance();
    a.setTransform(1, 0, 0, 1, 30, 0);
    const run = (inst, n, from) => (src === sample ? sway(ma, inst, n, from) : run2(inst, n, from));
    const run2 = (inst, n, from) => { for (let f = from; f < from + n; f++) { inst.reset(); inst.setTransform(1, 0, 0, 1, 30 + 40 * Math.sin(f / 9), 0); inst.update(1 / 60); } };
    run(a, 50, 0);
    const state = a.saveState();
    const b = rt.loadModel(compileUgo(src)).createInstance(); // the "recompiled" model
    b.loadState(state);
    run(a, 1, 50); run(b, 1, 50);
    check(a.frame().every((v, k) => v === b.frame()[k]), `${label}: an instance given the saved state goes on exactly as the old one`);
  }
  // an edit (stiffer chain, a new parameter): the chain is found by its bones' names and keeps swaying
  const src = model({ stiffness: 20, damping: 2, gravity: [300, 0] });
  const a = rt.loadModel(compileUgo(src)).createInstance();
  for (let f = 0; f < 30; f++) { a.reset(); a.update(1 / 60); }
  const edited = { ...src, parameters: [{ id: 'New', min: 0, max: 1, default: 0 }], chains: [{ ...src.chains[0], stiffness: 25 }] };
  const b = rt.loadModel(compileUgo(edited)).createInstance(), fresh = rt.loadModel(compileUgo(edited)).createInstance();
  b.loadState(a.saveState()); b.reset(); b.update(0); fresh.reset(); fresh.update(0);
  const tipA = joints(a)[3], tipB = joints(b)[3], tipF = joints(fresh)[3];
  check(dist(tipA, tipB) < 1e-3 && dist(tipB, tipF) > 5, `after an edit the chain carries on where it was (tip ${dist(tipA, tipB).toExponential(1)} px from before, ${dist(tipB, tipF).toFixed(1)} px from rest)`);
}
{ // what the compiler refuses
  const throws = (edit) => { const m = model({}); edit(m); try { compileUgo(m); return false; } catch { return true; } };
  check(throws((m) => { m.chains[0].bones = ['c1', 'c3']; }), 'a chain whose bones are not parent and child is refused');
  check(throws((m) => { m.constraints = [{ id: 'x', type: 'ik', bones: ['c2'], target: 'root' }]; }), 'a constraint that moves a chain bone is refused');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all chain checks passed');
