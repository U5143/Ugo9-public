// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/mesh_subdivide.mjs: chosen triangles split in four, neighbours split so there are no cracks, old
// vertex numbers kept, and the subdivided part draws and moves as before (positions, UVs, weights and
// morphs in the middle of their edges) in the real core.
//   node tests/subdivide_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { subdivide } from '../tools/mesh_subdivide.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const verts = [], tri = [], weights = [];
for (let j = 0; j <= 2; j++) for (let i = 0; i <= 4; i++) { verts.push(20 * i, 20 * j); const w = i / 4; weights.push([['a', 1 - w], ['b', w]].filter(([, x]) => x > 0)); }
for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) { const a = j * 5 + i; tri.push(a, a + 1, a + 5, a + 1, a + 6, a + 5); }
const src = {
  format: 'ugo9', canvas: { width: 200, height: 200 },
  parameters: [{ id: 'M', min: 0, default: 0, max: 1 }, { id: 'S', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'a', parent: 'root' }, { id: 'b', parent: 'root', x: 80 }],
  parts: [{ id: 'skin', vertices: verts, uvs: verts.map((v, i) => v / (i & 1 ? 40 : 80)), triangles: tri, weights }],
  deformers: [{ region: { M: [0, 1, 1] }, morphs: { skin: { dense: verts.map((v, i) => (i & 1 ? 0.1 * v : 0)) } } },
    { region: { S: [0, 1, 1] }, morphs: { skin: { vertices: [6, 7], deltas: [0, -4, 0, -4] } } }],
  animations: [{ id: 'bend', duration: 1, bones: { b: { rotate: [[0, 0], [1, 40]] } } }],
};
const { model, added } = subdivide(src, 'skin', [2, 3, 10]);
const p = model.parts[0], n0 = verts.length / 2;
check(added > 0 && p.vertices.length / 2 === n0 + added && p.vertices.slice(0, 2 * n0).every((v, i) => v === verts[i]), `${added} points added after the old ones, which keep their numbers`);
// no cracks: every edge of a triangle is shared by at most 2 triangles, and no point lies inside another triangle's edge
const edges = new Map();
for (let t = 0; t < p.triangles.length; t += 3) for (let k = 0; k < 3; k++) { const a = p.triangles[t + k], b = p.triangles[t + (k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`; edges.set(key, (edges.get(key) || 0) + 1); }
const pt = (i) => [p.vertices[2 * i], p.vertices[2 * i + 1]];
let tjunction = 0;
for (const [key, count] of edges) {
  if (count !== 1) continue; // only outline edges and T-junctions are single
  const [a, b] = key.split(',').map(Number), A = pt(a), B = pt(b);
  for (let v = 0; v < p.vertices.length / 2; v++) {
    if (v === a || v === b) continue;
    const P = pt(v), cross = (B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0]), dot = (P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1]);
    if (Math.abs(cross) < 1e-9 && dot > 1e-9 && dot < (B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2 - 1e-9) tjunction++;
  }
}
check(tjunction === 0, 'no cracks: no new point sits on an edge of a triangle that was not split there');
const area = (q) => { let s = 0; for (let t = 0; t < q.triangles.length; t += 3) { const [a, b, c] = [0, 1, 2].map((k) => [q.vertices[2 * q.triangles[t + k]], q.vertices[2 * q.triangles[t + k] + 1]]); s += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; } return s; };
check(Math.abs(area(p) - area(src.parts[0])) < 1e-9, `the same area with the same winding (${area(p)} = ${area(src.parts[0])})`);
// in the core: every old vertex moves exactly as before
const play = (s, params, t) => { const m = rt.loadModel(compileUgo(s)), i = m.createInstance(); i.reset(); for (const [k, v] of Object.entries(params)) i.set(k, v); i.play('bend', t); i.update(0); return i.deformedPositions(); };
let worst = 0;
for (const params of [{}, { M: 1 }, { S: 1 }]) for (const t of [0, 0.5, 1]) {
  const a = play(src, params, t), b = play(model, params, t);
  for (let k = 0; k < 2 * n0; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
}
check(worst < 1e-4, `the old vertices move exactly as before with morphs and bones (worst ${worst.toExponential(2)} px)`);
const sparse = model.deformers[1].morphs.skin;
check(sparse.vertices.length > 2 && sparse.vertices.slice(0, 2).join() === '6,7', `a sparse morph gains the new points next to moving ones (${sparse.vertices.length} points)`);
check(subdivide(src, 'skin', []).added === 0, 'nothing chosen: nothing changes');
let threw = false; try { subdivide(src, 'nope', [0]); } catch { threw = true; }
check(threw, 'an unknown part is refused');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all subdivide checks passed');
