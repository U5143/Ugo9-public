// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/rebind_pose.mjs: a pose becomes the rest pose. The rebound model at rest looks as the original
// posed (skinned vertices with blended weights included), its morphs move the same way, warp grids (and
// what is in them) move with the pose.
//   node tests/rebind_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { rebindPose } from '../tools/rebind_pose.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

// an arm of two bones; the mesh's middle vertices are shared between them
const verts = [], tri = [];
for (let i = 0; i <= 8; i++) verts.push(10 * i, -5, 10 * i, 5);
for (let i = 0; i < 8; i++) { const a = 2 * i; tri.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
const weights = [];
for (let i = 0; i <= 8; i++) { const w = Math.min(1, Math.max(0, (i - 3) / 2)); weights.push([['upper', 1 - w], ['lower', w]].filter(([, x]) => x > 0), [['upper', 1 - w], ['lower', w]].filter(([, x]) => x > 0)); }
const src = {
  format: 'ugo9', canvas: { width: 200, height: 200 },
  parameters: [{ id: 'Bulge', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'upper', parent: 'root', length: 40 }, { id: 'lower', parent: 'upper', x: 40, length: 40 }],
  parts: [{ id: 'arm', vertices: verts, uvs: verts.map((v, i) => (i & 1 ? (v + 5) / 10 : v / 80)), triangles: tri, weights }],
  deformers: [{ region: { Bulge: [0, 1, 1] }, morphs: { arm: { dense: verts.map((_, i) => (i & 1 ? (i % 4 === 1 ? -3 : 3) : 1)) } } }],
};
const pose = { upper: { rotate: 25 }, lower: { rotate: 50, x: 3 } };
const positions = (s, offsets, bulge) => {
  const m = rt.loadModel(compileUgo(s)), i = m.createInstance();
  i.reset(); i.set('Bulge', bulge); for (const [b, p] of Object.entries(offsets)) i.setBoneOffset(b, p); i.update(0);
  return i.deformedPositions();
};
const { model, warnings } = rebindPose(rt, src, pose);
const diff = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
const d0 = diff(positions(src, pose, 0), positions(model, {}, 0));
check(d0 < 1e-3, `the rebound model at rest looks as the original posed (worst ${d0.toExponential(2)} px)`);
const d1 = diff(positions(src, pose, 1), positions(model, {}, 1));
check(d1 < 1e-3, `its morph moves the same way on the turned mesh (worst ${d1.toExponential(2)} px)`);
check(Math.abs(model.bones[1].rotate - 25) < 1e-3 && Math.abs(model.bones[2].rotate - 50) < 1e-3 && Math.abs(model.bones[2].x - 43) < 1e-3,
  `the bones' rest is the pose (upper ${model.bones[1].rotate.toFixed(3)}°, lower ${model.bones[2].rotate.toFixed(3)}° at x ${model.bones[2].x.toFixed(3)})`);
check(src.bones[1].rotate === undefined && warnings.length === 0, 'the source is untouched, and nothing to warn about here');
// warp grids carried by a bone: the grids, the parts in them and the grid's own deltas move with the pose
{
  const face = [];
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) face.push(-20 + 10 * i, -60 + 10 * j);
  const ftri = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const a = j * 5 + i; ftri.push(a, a + 1, a + 5, a + 1, a + 6, a + 5); }
  const gsrc = {
    format: 'ugo9', canvas: { width: 200, height: 200 },
    parameters: [{ id: 'Smile', min: 0, default: 0, max: 1 }, { id: 'Squash', min: 0, default: 0, max: 1 }],
    bones: [{ id: 'root' }, { id: 'neck', parent: 'root', y: -10, length: 20 }, { id: 'head', parent: 'neck', x: 20 }],
    warps: [{ id: 'g', cols: 3, rows: 3, rect: [-25, -65, 50, 50], angle: 10, bone: 'head' }, { id: 'eye', cols: 2, rows: 2, rect: [-10, -50, 20, 20], parent: 'g' }],
    parts: [{ id: 'face', warp: 'g', vertices: face, uvs: face.map((v, i) => (i & 1 ? (v + 60) / 40 : (v + 20) / 40)), triangles: ftri },
      { id: 'eye', warp: 'eye', vertices: [-5, -45, 5, -45, 5, -35, -5, -35], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
    deformers: [{ region: { Smile: [0, 1, 1] }, morphs: { face: { vertices: [6, 8], deltas: [0, -3, 2, 1] } } },
      { region: { Squash: [0, 1, 1] }, warps: { g: { points: [5, 6], deltas: [4, 0, 0, 4] } } }],
  };
  const gpose = { neck: { rotate: 30, x: 5 }, head: { rotate: -15, scaleX: 0.2, scaleY: 0.2 } };
  const set = (s, offsets, params) => { const mm = rt.loadModel(compileUgo(s)), i = mm.createInstance(); i.reset(); for (const [k, v] of Object.entries(params)) i.set(k, v); for (const [b, p] of Object.entries(offsets)) i.setBoneOffset(b, p); i.update(0); return i.deformedPositions(); };
  const r = rebindPose(rt, gsrc, gpose);
  let worst = 0;
  for (const params of [{}, { Smile: 1 }, { Squash: 1 }, { Smile: 1, Squash: 1 }]) worst = Math.max(worst, diff(set(gsrc, gpose, params), set(r.model, {}, params)));
  check(worst < 1e-3 && r.warnings.length === 0, `warp grids (nested too) move with the pose: the same picture at rest and with their morphs and grid deltas (worst ${worst.toExponential(2)} px)`);
  const skew = rebindPose(rt, gsrc, { head: { scaleX: 0.5 } });
  check(skew.warnings.some((w) => w.startsWith('warp g')), 'an uneven scale of the grid\'s bone is warned about');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all rebind checks passed');
