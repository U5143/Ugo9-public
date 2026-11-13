// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Pixel art kept on the pixel grid (tools/pixel_check.mjs, 機能の比べ #19): a part drawn at 1× or 2× with its texel
// corners on pixel corners is on the grid; one 0.3 px off, one at 1.5×, one turned 10° are found (at rest), and so is
// one an animation moves by half a pixel (with the animation and the time); the output scale counts (2× output: the
// 1.5× part becomes 3×). The snap moves the parts only a little off onto the grid (the drawn picture shifts by less
// than a pixel), leaves the turned and the odd-sized ones, and keeps the morphs and animations.
//   node tests/pixel_check_test.mjs
import fs from 'node:fs';
import { pixelCheck, pixelSnap, formatCheck } from '../tools/pixel_check.mjs';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const T = 64; // the texture page is 64×64
// a quad showing texels (u0, v0)-(u1, v1), drawn with its corners at the given points (top left, top right, bottom left, bottom right)
const quad = (id, [u0, v0, u1, v1], corners, more = {}) => ({
  id, texture: 0, opacity: 1, vertices: corners.flat(), uvs: [u0 / T, v0 / T, u1 / T, v0 / T, u0 / T, v1 / T, u1 / T, v1 / T], triangles: [0, 1, 2, 1, 3, 2], ...more,
});
const box = (x, y, w, h) => [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
const turn = (cx, cy, w, h, deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return box(-w / 2, -h / 2, w, h).map(([x, y]) => [cx + c * x - s * y, cy + s * x + c * y]); };
const model = {
  format: 'ugo9', version: 1, canvas: { width: 200, height: 100 }, textures: ['atlas.png'],
  parameters: [], bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 0, y: 0 }],
  parts: [
    quad('good', [0, 0, 16, 16], box(10, 10, 16, 16)),
    quad('off', [0, 0, 16, 16], box(40.3, 10, 16, 16)),
    quad('double', [16, 0, 24, 8], box(70, 10, 16, 16)),
    quad('odd', [16, 0, 24, 8], box(100, 10, 12, 12)),
    quad('turned', [0, 16, 16, 32], turn(140, 20, 16, 16, 10)),
    quad('walker', [0, 32, 16, 48], box(10, 50, 16, 16), { bone: 'arm' }),
  ],
  deformers: [], physics: [],
  animations: [{ id: 'walk', duration: 1, loop: true, bones: { arm: { x: [[0, 0], [1, 1]] } } }],
};
const ug9 = new Uint8Array(compileUgo(model, { warnings: [] }));
const r = await pixelCheck(ug9, { wasm, textureSizes: [[T, T]], fps: 4 });
const of = (id) => r.parts.find((p) => p.part === id);
console.log(formatCheck(r).split('\n').map((l) => '     ' + l).join('\n'));

check(!of('good') && !of('double'), 'on the grid: 1× and 2× with the corners on pixel corners (not listed)');
check(of('off')?.rest?.kind === 'offset' && Math.abs(of('off').rest.offset - 0.3) < 0.01, `0.3 px off: found at rest (${of('off')?.rest?.offset} px)`);
check(of('odd')?.rest?.kind === 'scaled' && Math.abs(of('odd').rest.size - 1.5) < 0.01, `1.5×: not a whole-number size (${of('odd')?.rest?.size})`);
check(of('turned')?.rest?.kind === 'turned' && Math.abs(of('turned').rest.angle - 10) < 0.05, `turned 10°: found (${of('turned')?.rest?.angle}°)`);
const w = of('walker');
check(w && !w.rest && w.moving.length === 1 && w.moving[0].animation === 'walk' && w.moving[0].issue.kind === 'offset' && Math.abs(w.moving[0].issue.offset - 0.5) < 0.01,
  `moved half a pixel by an animation: found with its animation and time (${w?.moving[0]?.animation} at ${w?.moving[0]?.time}s, ${w?.moving[0]?.issue.offset} px)`);
const r2 = await pixelCheck(ug9, { wasm, textureSizes: [[T, T]], scale: 2, animations: [] });
check(!r2.parts.find((p) => p.part === 'odd') && r2.parts.find((p) => p.part === 'off')?.rest?.kind === 'offset', 'drawn at 2× output: the 1.5× part is 3× (on the grid); 0.3 px off is 0.6 px off (still found)');
const named = await pixelCheck(ug9, { wasm, textureSizes: (name) => (name === 'atlas.png' ? [T, T] : [0, 0]), animations: [] });
check(named.parts.length === 3, 'texture sizes found by the texture name');

// the snap
const s = pixelSnap(model, { textureSizes: [[T, T]] });
check(s.moved.join() === 'off' && s.skipped.map((k) => `${k.part}:${k.why}`).sort().join() === 'odd:scaled,turned:turned', `snap: moves the part a little off (${s.moved}), leaves the turned and the odd-sized (${s.skipped.map((k) => k.part)})`);
const moved = s.model.parts.find((p) => p.id === 'off').vertices, before = model.parts.find((p) => p.id === 'off').vertices;
check(moved.every((x, i) => Number.isInteger(x) && Math.abs(x - before[i]) < 0.5), `the part moved by less than a pixel, onto whole pixels (${moved.slice(0, 2)})`);
check(JSON.stringify(s.model.animations) === JSON.stringify(model.animations) && JSON.stringify(s.model.parts.filter((p) => p.id !== 'off')) === JSON.stringify(model.parts.filter((p) => p.id !== 'off')), 'everything else as it was (the other parts, the animations)');
const after = await pixelCheck(new Uint8Array(compileUgo(s.model, { warnings: [] })), { wasm, textureSizes: [[T, T]], animations: [] });
check(!after.parts.find((p) => p.part === 'off'), 'after the snap the check finds it on the grid');
const bent = structuredClone(model);
bent.parts[1].vertices[1] += 2; // one corner 2 px off: the mesh is bent at rest
check(pixelSnap(bent, { textureSizes: [[T, T]] }).skipped.some((k) => k.part === 'off' && k.why === 'bent'), 'a mesh bent at rest is left as it is');

console.log(failures ? `\n${failures} check(s) failed` : '\nall pixel grid checks passed');
process.exit(failures ? 1 : 0);
