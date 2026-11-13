// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Vertices weighted to more than 4 bones: how far would they move if cut to the K strongest,
// and does the core (format 0.4: any number of bones) put them where all their weights say?
//   node tools/measure_weights.mjs build/spine/キャラ [K]   (a folder with model.json + model.ug9 (or the older model.ugo); default K = 4)
// Every animation is played at 30 fps and each such vertex is skinned with the core's bone
// matrices: with all weights, with the K strongest, and compared with ugo_deform_cpu.
import fs from 'node:fs';
import path from 'node:path';
import { UgoRuntime } from '../web/ugo.js';

const dir = process.argv[2], K = Number(process.argv[3] || 4); // bones kept (the format keeps 4)
if (!dir) { console.error('usage: node tools/measure_weights.mjs MODEL_FOLDER'); process.exit(2); }
const json = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const runtimeFile = ['model.ug9', 'model.ugo'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'model.ug9');
const m = rt.loadModel(fs.readFileSync(runtimeFile));
const boneIndex = new Map(Array.from({ length: m.boneCount }, (_, i) => [rt.str(rt.ex.ugo_bone_name(m.ptr, i)), i]));

// vertices with > 4 influences: rest position, full weights, the 4 kept (renormalised)
const many = [];
let first = 0; // index of the part's first vertex in the .ugo (parts keep their order)
for (const p of json.parts) {
  const start = first;
  first += p.vertices.length / 2;
  if (!p.weights) continue;
  p.weights.forEach((w, i) => {
    if (w.length <= 4) return;
    const full = w.map(([b, x]) => [boneIndex.get(b), x]);
    const kept = [...full].sort((a, b) => b[1] - a[1]).slice(0, K), s = kept.reduce((t, k) => t + k[1], 0);
    many.push({ index: start + i, part: p.id, x: p.vertices[2 * i], y: p.vertices[2 * i + 1], full, kept: kept.map(([b, x]) => [b, x / s]), dropped: 1 - s });
  });
}
const vertsTotal = json.parts.reduce((s, p) => s + p.vertices.length / 2, 0);
console.log(`${path.basename(dir)}: ${many.length} of ${vertsTotal} vertices have more than 4 bones (up to ${Math.max(0, ...many.map((v) => v.full.length))}); weight dropped: max ${Math.max(0, ...many.map((v) => v.dropped)).toFixed(3)}`);
if (!many.length) process.exit(0);

const inst = m.createInstance(), out = rt.alloc(8 * m.vertexCount);
let coreWorst = 0;
const skin = (wts, f, x, y) => {
  let px = 0, py = 0;
  for (const [b, w] of wts) {
    const o = m.skinOffset + 8 * b;
    px += w * (f[o] * x + f[o + 2] * y + f[o + 4]);
    py += w * (f[o + 1] * x + f[o + 3] * y + f[o + 5]);
  }
  return [px, py];
};
const results = [];
for (const a of m.animations) {
  let worst = { d: 0 };
  const n = Math.max(1, Math.ceil(a.duration * 30));
  for (let k = 0; k <= n; k++) {
    const t = Math.min(a.duration, k / 30);
    inst.reset(); inst.play(a.name, t); inst.update(0);
    const f = inst.frame();
    rt.ex.ugo_deform_cpu(inst.ptr, out);
    const core = rt.f32(out, 2 * m.vertexCount);
    for (const v of many) {
      const [ax, ay] = skin(v.full, f, v.x, v.y), [bx, by] = skin(v.kept, f, v.x, v.y);
      coreWorst = Math.max(coreWorst, Math.hypot(ax - core[2 * v.index], ay - core[2 * v.index + 1]));
      const d = Math.hypot(ax - bx, ay - by);
      if (d > worst.d) worst = { d, t, part: v.part };
    }
  }
  results.push({ anim: a.name, ...worst });
}
results.sort((a, b) => b.d - a.d);
const over = (px) => results.filter((r) => r.d > px).length;
console.log(`  the core vs all weights: largest difference ${coreWorst.toFixed(4)} px`);
console.log(`  cut to ${K}: largest move: ${results[0].d.toFixed(2)} px (${results[0].anim} t=${results[0].t?.toFixed(2)}s, ${results[0].part}); animations over 1 px: ${over(1)}, over 0.5 px: ${over(0.5)} of ${results.length}`);
for (const r of results.slice(0, 5)) console.log(`   ${r.anim.padEnd(12)} ${r.d.toFixed(2).padStart(7)} px  ${r.part ?? ''}`);
