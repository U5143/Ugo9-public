// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A mesh for a line drawing (進行の残り「輪郭の込み入った大きいレイヤーのメッシュ作りが遅い」): a layer of thin strokes
// has hundreds of thousands of outline corners, and finding the nearest one for each uncovered pixel looked through
// all of them (a 1728×1440 drawing took about 3 minutes). Now the nearest is found by cells, and the contour mesh
// stops as soon as it has more points than 'auto' would take (it then takes the grid). The meshes are the same as
// before (the counts below were made with the old code), and the big drawing takes well under a second with 'auto'.
//   node tests/mesh_lineart_test.mjs
import { meshFromLayer } from '../tools/import_psd.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
// strokes 1 to 3.5 px wide wandering over the layer (the same every time)
function lineArt(W, H, N) {
  const rgba = new Uint8Array(W * H * 4);
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < N; k++) {
    let x = rnd() * W, y = rnd() * H, a = rnd() * 6.28;
    const len = 200 + rnd() * 600, wdt = 1 + rnd() * 2.5;
    for (let t = 0; t < len; t++) {
      a += (rnd() - 0.5) * 0.2; x += Math.cos(a); y += Math.sin(a);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const px = Math.round(x + dx), py = Math.round(y + dy), d = Math.hypot(dx, dy);
        if (px < 0 || py < 0 || px >= W || py >= H || d > wdt) continue;
        const i = (py * W + px) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; rgba[i + 3] = Math.max(rgba[i + 3], d < wdt - 1 ? 255 : 160);
      }
    }
  }
  return { left: 0, top: 0, width: W, height: H, rgba, atlas: { left: 0, top: 0, width: W, height: H, page: 0 } };
}
const mesh = (L, kind) => {
  const t0 = performance.now(), m = meshFromLayer(L, { atlasWidth: L.width, atlasHeight: L.height, originX: 0, originY: 0, mesh: kind });
  return { verts: m.vertices.length / 2, tris: m.triangles.length / 3, s: (performance.now() - t0) / 1000 };
};

// the same meshes as the old code made (its counts)
for (const [W, H, N, kind, verts, tris] of [[864, 720, 100, 'contour', 10039, 10791], [864, 720, 100, 'auto', 1088, 1814], [600, 500, 40, 'contour', 5134, 5377], [400, 400, 300, 'contour', 2435, 2809], [1200, 300, 60, 'auto', 588, 872]]) {
  const m = mesh(lineArt(W, H, N), kind);
  check(m.verts === verts && m.tris === tris, `${W}×${H}, ${N} strokes, ${kind}: ${m.verts} points, ${m.tris} triangles as before (${m.s.toFixed(2)} s)`);
}
// the big one: 'auto' gives the grid as before, quickly
const big = mesh(lineArt(1728, 1440, 300), 'auto');
check(big.verts === 1650 && big.tris === 2224 && big.s < 10, `1728×1440, 300 strokes, auto: the grid as before (${big.verts} points), in ${big.s.toFixed(2)} s (it was about 3 minutes)`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall line drawing mesh checks passed');
process.exit(failures ? 1 : 0);
