// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/weights.mjs: smooth, prune, limit, swap and normalize keep every vertex's weights summing to 1 and
// never change a locked bone's weight; the result compiles and plays.
//   node tests/weights_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { editWeights } from '../tools/weights.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const verts = [], tri = [], weights = [];
for (let j = 0; j <= 1; j++) for (let i = 0; i <= 6; i++) { verts.push(10 * i, 10 * j); weights.push(i < 3 ? [['a', 1]] : i === 3 ? [['a', 0.6], ['b', 0.395], ['c', 0.005]] : [['b', 1]]); }
for (let i = 0; i < 6; i++) tri.push(i, i + 1, i + 7, i + 1, i + 8, i + 7);
const src = {
  format: 'ugo9', canvas: { width: 100, height: 100 },
  bones: [{ id: 'root' }, { id: 'a', parent: 'root' }, { id: 'b', parent: 'root', x: 30 }, { id: 'c', parent: 'root', x: 60 }],
  parts: [{ id: 'arm', vertices: verts, uvs: verts.map((v) => v / 60), triangles: tri, weights }, { id: 'pin', bone: 'a', vertices: [0, 0, 5, 0, 5, 5], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] }],
};
const sums = (m) => m.parts[0].weights.every((l) => Math.abs(l.reduce((s, [, w]) => s + w, 0) - 1) < 1e-9);
const w = (m, v, b) => (m.parts[0].weights[v].find(([x]) => x === b) || [, 0])[1];

const smooth = editWeights(src, 'arm', 'smooth', { iterations: 2 });
check(sums(smooth) && w(smooth, 2, 'b') > 0 && w(smooth, 4, 'a') > 0, `smooth spreads the change over the neighbours (vertex 2 gets b ${w(smooth, 2, 'b').toFixed(3)})`);
check(w(src, 2, 'b') === 0, 'the source is untouched');
const locked = editWeights(src, 'arm', 'smooth', { iterations: 3, locked: ['a'] });
check(sums(locked) && [0, 1, 2, 3, 4, 5, 6].every((v) => w(locked, v, 'a') === w(src, v, 'a')), 'a locked bone keeps its weights while the others are smoothed');
const pruned = editWeights(src, 'arm', 'prune', { threshold: 0.01 });
check(sums(pruned) && w(pruned, 3, 'c') === 0 && Math.abs(w(pruned, 3, 'a') - 0.6 / 0.995) < 1e-9, 'prune drops weights below the threshold and shares their part out');
const limited = editWeights(src, 'arm', 'limit', { count: 1 });
check(sums(limited) && limited.parts[0].weights.every((l) => l.length === 1) && w(limited, 3, 'a') === 1, 'limit keeps the strongest bones only');
const swapped = editWeights(src, 'arm', 'swap', { a: 'a', b: 'b' });
check(w(swapped, 0, 'b') === 1 && w(swapped, 3, 'b') === 0.6 && w(swapped, 3, 'a') === 0.395, 'swap exchanges two bones\' weights');
const some = editWeights(src, 'arm', 'smooth', { vertices: [3] });
check([0, 1, 2, 4, 5, 6].every((v) => JSON.stringify(some.parts[0].weights[v]) === JSON.stringify(src.parts[0].weights[v])), 'vertices limits the work to those');
const pin = editWeights(src, 'pin', 'normalize');
check(pin.parts[1].bone === undefined && pin.parts[1].weights.every((l) => l.length === 1 && l[0][0] === 'a' && l[0][1] === 1), 'a part on one bone becomes weights of 1 on it');
let ok = true;
for (const m of [smooth, locked, pruned, limited, swapped, pin]) { try { rt.loadModel(compileUgo(m)).createInstance().update(0); } catch { ok = false; } }
check(ok, 'every result compiles and plays');
let threw = false; try { editWeights(src, 'arm', 'twist'); } catch { threw = true; }
check(threw, 'an unknown operation is refused');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all weight checks passed');
