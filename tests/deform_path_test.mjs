// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/deform_path.mjs: a straight line bent into a curve carries the vertices on and near it (same place
// along, same distance across), fades out by `radius`, leaves far vertices alone, and the morph plays in
// the core.
//   node tests/deform_path_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { pathMorph } from '../tools/deform_path.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

// a strip of hair 0..100 along x, -10..10 across, and one far vertex
const verts = [];
for (let i = 0; i <= 10; i++) verts.push(10 * i, -10, 10 * i, 0, 10 * i, 10);
verts.push(50, 200);
const from = [[0, 0], [50, 0], [100, 0]], to = [[0, 0], [50, 0], [50 + 50 * Math.SQRT1_2, 50 * Math.SQRT1_2]]; // the far half bent down by 45°
const m = pathMorph(verts, from, to, { radius: 40, inner: 15 });
const at = (v) => { const k = m.vertices.indexOf(v); const d = k < 0 ? [0, 0] : m.deltas.slice(2 * k, 2 * k + 2); return [verts[2 * v] + d[0], verts[2 * v + 1] + d[1]]; };
const tip = at(31), want = [50 + 50 * Math.SQRT1_2, 50 * Math.SQRT1_2];
check(Math.hypot(tip[0] - want[0], tip[1] - want[1]) < 1e-9, `a vertex on the line's end goes to the bent end (${tip.map((v) => v.toFixed(3))})`);
const side = at(32), wantSide = [want[0] - 10 * Math.SQRT1_2, want[1] + 10 * Math.SQRT1_2];
check(Math.hypot(side[0] - wantSide[0], side[1] - wantSide[1]) < 1e-9, 'a vertex 10 px across keeps its distance across the bent line (within `inner`)');
check(m.vertices.every((v) => v !== 33) && at(4).every((x, k) => x === verts[8 + k]), 'far vertices and those on the unbent half do not move');
const mid = 3 * 8 + 2, moved = Math.hypot(at(mid)[0] - verts[2 * mid], at(mid)[1] - verts[2 * mid + 1]);
const wide = pathMorph(verts, from, to, { radius: 12, inner: 0 }), k = wide.vertices.indexOf(mid);
const movedWide = k < 0 ? 0 : Math.hypot(wide.deltas[2 * k], wide.deltas[2 * k + 1]);
check(moved > movedWide && movedWide < moved * 0.5, `the move fades with distance (10 px across: ${moved.toFixed(2)} px within inner, ${movedWide.toFixed(2)} px with radius 12)`);
// in the core: as a morph on a parameter
const tri = [];
for (let i = 0; i < 10; i++) { const a = 3 * i; tri.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
const src = { format: 'ugo9', canvas: { width: 300, height: 300 }, parameters: [{ id: 'Bend', min: 0, default: 0, max: 1 }], bones: [{ id: 'root' }],
  parts: [{ id: 'hair', bone: 'root', vertices: verts.slice(0, 66), uvs: verts.slice(0, 66).map((v) => v / 100), triangles: tri }],
  deformers: [{ region: { Bend: [0, 1, 1] }, morphs: { hair: pathMorph(verts.slice(0, 66), from, to, { radius: 40, inner: 15 }) } }] };
const model = rt.loadModel(compileUgo(src)), inst = model.createInstance();
inst.reset(); inst.set('Bend', 1); inst.update(0);
const p = inst.deformedPositions();
check(Math.hypot(p[62] - want[0], p[63] - want[1]) < 1e-3, 'the morph plays in the core: at Bend 1 the hair\'s tip is at the bent end');
let threw = false; try { pathMorph(verts, from, [[0, 0]]); } catch { threw = true; }
check(threw, 'lines of different lengths are refused');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all deform path checks passed');
