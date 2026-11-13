// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animation tracks that key bones, part opacity and morphs directly (format 0.2).
//   node tests/tracks_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

const model = {
  format: 'ugo9', version: '0.2',
  parameters: [{ id: 'Smile', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 100, y: 50 }],
  parts: [
    { id: 'square', bone: 'arm', vertices: [100, 50, 110, 50, 110, 60, 100, 60], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] },
    { id: 'dot', bone: 'root', vertices: [0, 0, 1, 0, 1, 1], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] },
  ],
  deformers: [
    { id: 'bulge', morphs: { square: { vertices: [1], deltas: [5, 0] } } },          // animation only
    { region: { Smile: [0, 1, 1] }, morphs: { square: { vertices: [2], deltas: [0, 3] } } }, // parameter
  ],
  animations: [{
    id: 'wave', duration: 1, loop: false,
    bones: { arm: { rotate: [[0, 0], [1, 90]], x: [[0, 0], [1, 20]], scaleX: [[0, 0], [1, 1]] } },
    opacity: { dot: [[0, 1], [1, 0]] },
    morphs: { bulge: [[0, 0], [1, 1]] },
  }],
};

const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const m = rt.loadModel(compileUgo(model));
const inst = m.createInstance();
const scratch = rt.alloc(8 * m.vertexCount);
const positions = () => Array.from(rt.f32(scratch, 2 * m.vertexCount));
const at = (t, extra) => {
  inst.reset();
  inst.play('wave', t);
  if (extra) extra();
  inst.update(0);
  rt.ex.ugo_deform_cpu(inst.ptr, scratch);
  return { p: positions(), op: inst.frame()[m.opacityOffset + 1] };
};

const r0 = at(0);
check(near(r0.p[0], 100) && near(r0.p[1], 50) && near(r0.p[2], 110) && near(r0.p[3], 50), 'rest pose at t = 0');
check(near(r0.op, 1), 'opacity 1 at t = 0');

// t = 1: arm rotated 90 degrees clockwise on screen (y down), moved +20 in x, scaled x2, bulge morph full
const r1 = at(1);
// vertex 0 sits on the bone origin: only the translation moves it
check(near(r1.p[0], 120) && near(r1.p[1], 50), `bone translation (${r1.p[0].toFixed(2)}, ${r1.p[1].toFixed(2)})`);
// vertex 1: (110,50) + bulge (5,0) -> local (15,0); scaleX 2 -> (30,0); rotate 90 -> (0,30); + origin (120,50)
check(near(r1.p[2], 120) && near(r1.p[3], 80), `rotation, scale and morph together (${r1.p[2].toFixed(2)}, ${r1.p[3].toFixed(2)})`);
check(near(r1.op, 0), 'opacity keyed to 0 at t = 1');

// halfway: linear keys
const rh = at(0.5);
check(near(rh.op, 0.5), `opacity 0.5 halfway (${rh.op.toFixed(3)})`);

// parameter-driven morph still adds on top
const rs = at(0, () => inst.set('Smile', 1));
check(near(rs.p[5], 63), `parameter morph adds to animation (${rs.p[5].toFixed(2)})`);

// reset clears what the animation keyed
inst.reset();
inst.update(0);
rt.ex.ugo_deform_cpu(inst.ptr, scratch);
const p = positions();
check(near(p[2], 110) && near(p[3], 50) && near(inst.frame()[m.opacityOffset + 1], 1), 'reset_params clears bone, opacity and morph tracks');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all track checks passed');
