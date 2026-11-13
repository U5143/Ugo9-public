// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/warp_expand.mjs: a grid grown by rings keeps its surface over its old area (the parts inside move as
// before, with the grid's deformations and a bone turning it), fitWarp finds the rings that bring
// overflowing vertices inside, and a nested grid is warned about.
//   node tests/warp_expand_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { expandWarp, fitWarp } from '../tools/warp_expand.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const inside = [], outside = [];
for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) inside.push(-40 + 20 * i, -40 + 20 * j);
outside.push(-70, 0, 75, 10, 0, 68);
const tri = (n) => Array.from({ length: n - 2 }, (_, k) => [0, k + 1, k + 2]).flat();
let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 16;
const src = {
  format: 'ugo9', canvas: { width: 300, height: 300, originX: 150, originY: 150 },
  parameters: [{ id: 'A', min: 0, default: 0, max: 1 }, { id: 'B', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'head', parent: 'root', y: -10 }],
  warps: [{ id: 'g', cols: 3, rows: 3, rect: [-50, -50, 100, 100], angle: 15, bone: 'head' }],
  parts: [{ id: 'in', warp: 'g', vertices: inside, uvs: inside.map(() => 0.5), triangles: tri(25) },
    { id: 'out', warp: 'g', vertices: outside, uvs: outside.map(() => 0.5), triangles: [0, 1, 2] }],
  deformers: [{ region: { A: [0, 1, 1] }, warps: { g: { dense: Array.from({ length: 32 }, rnd) } } },
    { region: { B: [0, 1, 1] }, warps: { g: { points: [5, 6, 10], deltas: [6, -4, -3, 5, 8, 8] } } }],
  animations: [{ id: 'turn', duration: 1, bones: { head: { rotate: [[0, 0], [1, 40]], x: [[0, 0], [1, 12]] } } }],
};
const positions = (s, a, b, t) => { const m = rt.loadModel(compileUgo(s)), i = m.createInstance(); i.reset(); i.set('A', a); i.set('B', b); i.play('turn', t); i.update(0); return i.deformedPositions(); };
const worstInside = (s2) => {
  let worst = 0;
  for (const [a, b, t] of [[0, 0, 0], [1, 0, 0.3], [0, 1, 0.7], [1, 1, 0.99], [0.4, 0.6, 0.5]]) {
    const p = positions(src, a, b, t), q = positions(s2, a, b, t);
    for (let k = 0; k < inside.length; k++) worst = Math.max(worst, Math.abs(p[k] - q[k]));
  }
  return worst;
};
const grown = expandWarp(src, 'g', { left: 1, right: 2, top: 1, bottom: 1 });
const g = grown.model.warps[0];
check(g.cols === 6 && g.rows === 5 && grown.model.deformers[0].warps.g.dense.length === 2 * 7 * 6 && grown.model.deformers[1].warps.g.dense.length === 2 * 7 * 6,
  `rings added on the sides asked (${g.cols} x ${g.rows} cells; the deltas grown with them)`);
const d = worstInside(grown.model);
check(d < 1e-3 && grown.warnings.length === 0, `inside the old area the parts move as before, with the grid's deltas and the bone turning it (worst ${d.toExponential(2)} px)`);
const fit = fitWarp(src, 'g');
check(fit.rings.left >= 1 && fit.rings.right >= 1 && fit.rings.bottom >= 1 && fit.rings.top === 0, `fitWarp finds the rings the overflowing vertices need (${JSON.stringify(fit.rings)})`);
const cells = (() => { const w = fit.model.warps[0], a = (w.angle) * Math.PI / 180, [x0, y0, ww, hh] = w.rect, cx = x0 + ww / 2, cy = y0 + hh / 2; return outside.reduce((ok, _, k) => { if (k & 1) return ok; const dx = outside[k] - cx, dy = outside[k + 1] - cy, px = cx + Math.cos(-a) * dx - Math.sin(-a) * dy, py = cy + Math.sin(-a) * dx + Math.cos(-a) * dy; return ok && px >= x0 - 1e-9 && px <= x0 + ww + 1e-9 && py >= y0 - 1e-9 && py <= y0 + hh + 1e-9; }, true); })();
check(cells && worstInside(fit.model) < 1e-3, 'after fitting, every vertex lies inside the grid, and the old area still moves as before');
const nested = { ...src, warps: [...src.warps, { id: 'eye', cols: 2, rows: 2, rect: [-10, -10, 20, 20], parent: 'g' }] };
check(expandWarp(nested, 'eye', { left: 1 }).warnings.length === 1, 'a grid inside another grid is warned about (only nearly the same)');
let threw = false; try { expandWarp(src, 'g', { left: 70 }); } catch { threw = true; }
check(threw, 'more than 64 cells is refused');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all warp expand checks passed');
