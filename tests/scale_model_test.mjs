// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// scaleModel (tools/scale_model.mjs): k times then 1/k times gives the model back, and the drawn
// picture is the same picture k times as large, in every pose (parameters, animations, the chain's
// swing over time). Models: a PSD character with the first drafts (face, eye and mouth grids, the
// face turn, blinks, an idle loop), the warp sample (nested grids, a bone in a grid, 2-axis
// corrections), the pose rig (IK, transform constraints, a chain) and a Spine import.
//   node tests/scale_model_test.mjs
import fs from 'node:fs';
import { scaleModel } from '../tools/scale_model.mjs';
import { importPsd } from '../tools/import_psd.mjs';
import { importSpine, loadSkeleton } from '../tools/import_spine.mjs';
import { makeStarterRig } from '../tools/starter_rig.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

// ---- the models ----
const sq = (name, left, top, w, h, colour) => ({ name, left, top, width: w, height: h, pixel: () => colour });
const folder = (name, inside) => [{ name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, ...inside, { name, section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }];
const res = importPsd(writePsd(200, 300, [
  sq('体', 70, 220, 60, 80, [90, 90, 200, 255]),
  ...folder('頭', [
    sq('顔', 50, 60, 100, 120, [250, 220, 200, 255]),
    sq('白目 左', 65, 100, 24, 12, [255, 255, 255, 255]), sq('まつ毛 左', 63, 95, 28, 6, [20, 20, 20, 255]),
    sq('白目 右', 111, 100, 24, 12, [255, 255, 255, 255]), sq('まつ毛 右', 109, 95, 28, 6, [20, 20, 20, 255]),
    sq('上唇', 90, 150, 20, 4, [200, 80, 80, 255]), sq('口の中', 91, 153, 18, 4, [120, 30, 40, 255]), sq('下唇', 90, 156, 20, 4, [200, 80, 80, 255]),
  ]),
]), { groupBones: true });
const psdModel = (() => { // the first drafts, written as the editor writes them
  const m = { ...res.model, version: '0.6' }, r = makeStarterRig(m);
  m.warps = [...(m.warps || []), ...r.warps];
  for (const p of m.parts) if (r.assign[p.id]) { delete p.bone; delete p.weights; p.warp = r.assign[p.id]; }
  for (const [id, min, def, max] of r.params) m.parameters.push({ id, min, default: def, max });
  const tent = (id, v) => { const ks = r.keys?.[id]; if (ks) { const i = ks.indexOf(v); return [ks[Math.max(0, i - 1)], v, ks[Math.min(ks.length - 1, i + 1)]]; } const p = m.parameters.find((q) => q.id === id); return v > p.default ? [p.default, v, v] : [v, v, p.default]; };
  for (const mo of r.motions) m.deformers.push({ region: Object.fromEntries(Object.entries(mo.at).map(([k, v]) => [k, tent(k, v)])), ...(mo.warps ? { warps: mo.warps } : {}), ...(mo.morphs ? { morphs: mo.morphs } : {}) });
  if (r.animation) m.animations.push(r.animation);
  m.editor = { shapes: [{ id: 'face', type: 'sphere', center: [0, -150], radius: [50, 60] }] };
  return m;
})();
const spine = importSpine(loadSkeleton(fs.readFileSync(new URL('./spine/rig.json', import.meta.url))), fs.readFileSync(new URL('./spine/rig.atlas', import.meta.url), 'utf8')).model;
const models = [['PSD + first drafts', psdModel], ['warp sample', read('./warp/model.json')], ['pose rig (IK, transform, chain)', read('./pose/rig.json')], ['Spine import', spine]];

// ---- 1. k then 1/k: the same model ----
const worstDiff = (a, b, path = '') => { // the largest difference between two JSON values (numbers: absolute)
  if (typeof a === 'number' && typeof b === 'number') return [Math.abs(a - b), path];
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return [Infinity, path];
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let w = [0, ''];
    for (const k of keys) { const d = worstDiff(a[k], b[k], `${path}.${k}`); if (d[0] > w[0]) w = d; }
    return w;
  }
  return [a === b ? 0 : Infinity, path];
};
for (const [name, m] of models) {
  const half = scaleModel(m, 0.5), back = scaleModel(half, 2), odd = scaleModel(scaleModel(m, 0.37), 1 / 0.37);
  const [d0] = worstDiff(m, back), [d1, at1] = worstDiff(m, odd);
  check(d0 === 0 && d1 < 1e-9 && JSON.stringify(m) === JSON.stringify(structuredClone(m)), `${name}: × 0.5 × 2 gives it back exactly, × 0.37 × 1/0.37 within ${d1.toExponential(1)}${d1 >= 1e-9 ? ` (at ${at1})` : ''}; the model is not changed`);
}

// ---- 2. the drawn picture k times as large ----
const poses = (m) => { // parameters at their ends and in between, each animation at a few times
  const out = [{ label: 'rest' }];
  for (const p of m.parameters || []) for (const v of [p.min, p.max, (p.min + p.max) * 0.3]) out.push({ label: `${p.id} ${v}`, params: { [p.id]: v } });
  const ps = m.parameters || [];
  if (ps.length > 1) out.push({ label: 'all at 0.7', params: Object.fromEntries(ps.map((p) => [p.id, p.min + 0.7 * (p.max - p.min)])) });
  for (const a of m.animations || []) for (const f of [0, 0.25, 0.5, 0.9]) out.push({ label: `${a.id} @${(f * (a.duration || 1)).toFixed(2)}`, anim: a.id, t: f * (a.duration || 1) });
  return out;
};
const run = (inst, pose, steps) => {
  inst.reset(); inst.resetPhysics?.();
  let pos = null;
  for (let s = 0; s < steps; s++) { // a few frames, so a chain swings
    inst.reset();
    for (const [id, v] of Object.entries(pose.params || {})) inst.set(id, v);
    if (pose.anim) inst.play(pose.anim, (pose.t || 0) + s / 60);
    inst.update(s ? 1 / 60 : 0);
  }
  pos = inst.deformedPositions();
  return pos;
};
for (const k of [0.5, 0.37, 2.5]) for (const [name, m] of models) {
  const a = rt.loadModel(compileUgo(m)).createInstance(), b = rt.loadModel(compileUgo(scaleModel(m, k))).createInstance();
  const steps = m.chains?.length ? 30 : 1;
  let worst = 0, where = '', size = 0;
  for (const pose of poses(m)) {
    const pa = run(a, pose, steps), pb = run(b, pose, steps);
    for (let i = 0; i < pa.length; i++) {
      size = Math.max(size, Math.abs(pa[i]));
      const e = Math.abs(pb[i] - k * pa[i]);
      if (e > worst) { worst = e; where = pose.label; }
    }
  }
  // the .ugo keeps moves rounded to 1/65535 of their range (docs/形式.md), and k times the
  // rounded value is not the rounded k times value: allow 1/30000 of the scaled model's size
  const allow = (k * size) / 30000;
  check(worst <= allow, `${name}, k = ${k}: every vertex in ${poses(m).length} poses is k times as far from (0, 0) (largest miss ${worst.toExponential(1)} px, ${(worst / (k * size) * 1e6).toFixed(1)} millionths of the size${worst > allow ? ` at ${where}` : ''})`);
}

// ---- 3. what stays: UVs, angles, weights, the canvas scaled with its origin ----
{
  const m = psdModel, s = scaleModel(m, 0.5);
  check(JSON.stringify(s.parts.map((p) => p.uvs)) === JSON.stringify(m.parts.map((p) => p.uvs)) && s.textures.join() === m.textures.join(), 'UVs and textures are kept (the pictures are the same)');
  check(s.canvas.width === m.canvas.width / 2 && s.canvas.originX === m.canvas.originX / 2 && s.editor.shapes[0].radius[0] === 25, `canvas ${m.canvas.width}×${m.canvas.height} → ${s.canvas.width}×${s.canvas.height} (origin scaled too), the sphere shape's radius 50 → 25`);
  const r = read('./pose/rig.json'), rs = scaleModel(r, 2);
  check(rs.chains[0].gravity[1] === r.chains[0].gravity[1] * 2 && rs.chains[0].stiffness === r.chains[0].stiffness, `chain: gravity ${r.chains[0].gravity[1]} → ${rs.chains[0].gravity[1]} px/s², stiffness kept`);
  // a curve key (format 1.1) on a bone's x: its value handles cy1, cy2 scale with it, its time handles do not
  const c = structuredClone(r);
  c.animations = [{ id: 'c', duration: 1, bones: { [c.bones[0].id]: { x: [[0, 10, 'bezier', 0.25, 40, 0.75, -20], [1, 30]], rotate: [[0, 5, 'bezier', 0.2, 9, 0.8, 1], [1, 3]] } } }];
  const cs = scaleModel(c, 2).animations[0].bones[c.bones[0].id];
  check(JSON.stringify(cs.x) === JSON.stringify([[0, 20, 'bezier', 0.25, 80, 0.75, -40], [1, 60]]) && JSON.stringify(cs.rotate) === JSON.stringify(c.animations[0].bones[c.bones[0].id].rotate),
    `a curve key on x × 2: value and cy1, cy2 doubled, cx kept (${JSON.stringify(cs.x[0])}); rotation kept`);
  let bad = '';
  try { scaleModel(m, 0); } catch (e) { bad = e.message; }
  check(/positive/.test(bad), 'k = 0 is refused');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall scale checks passed');
process.exit(failures ? 1 : 0);
