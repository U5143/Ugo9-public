// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// layerPixelsFromAtlas (tools/import_psd.mjs): a layer's pixels read back from its atlas page, in
// the PSD's pixels, and written back with replaceLayerPixels (tools/psd_add_layer.mjs). The round
// trip (import -> read back -> replace) gives the layer's pixels again: exactly for pictures lying
// upright or turned 90° in the atlas, closely for ones turned by their own angle (atlasAnyAngle)
// and for a big PSD read smaller.
//   node tests/psd_atlas_back_test.mjs
import zlib from 'node:zlib';
import { importPsd, readPsd, layerPixelsFromAtlas, layerMeta } from '../tools/import_psd.mjs';
import { replaceLayerPixels } from '../tools/psd_add_layer.mjs';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);

// pictures: a soft blob, a tall thin one (it lies turned in the atlas), a slanted stripe (turned by
// its angle with atlasAnyAngle), an empty layer (skipped by the import, so the places differ)
const layer = (name, left, top, width, height, f) => ({ name, left, top, width, height, pixel: f });
const blob = layer('blob', 10, 12, 60, 50, (x, y) => { const d = Math.hypot(x - 30, y - 25); return [200, 80 + x, 40 + y * 2, d < 18 ? 255 : d < 24 ? Math.round((24 - d) * 40) : 0]; });
const tall = layer('tall', 90, 4, 14, 110, (x, y) => [x * 15, 255 - y * 2, 120, x > 1 && x < 12 ? 255 : 0]);
const stripe = layer('stripe', 20, 70, 100, 60, (x, y) => { const d = Math.abs((x - 50) * 0.5 - (y - 30) * 0.866); return [30 + x, 200, 60 + y, d < 6 ? 255 : d < 8 ? 120 : 0]; });
const empty = layer('nothing', 0, 0, 8, 8, () => [0, 0, 0, 0]);
const W = 140, H = 140;
const psd = writePsd(W, H, [blob, empty, tall, stripe], { composite: () => [255, 255, 255, 255] });
const orig = readPsd(psd, { inflate }).layers;

// one layer's pixels in a box (canvas coordinates), from readPsd's layers
const px = (L, x, y) => { const lx = x - L.left, ly = y - L.top; if (lx < 0 || ly < 0 || lx >= L.width || ly >= L.height) return [0, 0, 0, 0]; const i = (ly * L.width + lx) * 4; return [...L.rgba.subarray(i, i + 4)]; };
function compare(A, B, box) { // -> { worst alpha, mean alpha error, worst colour where both are fairly opaque, differing pixels }
  let wa = 0, wc = 0, n = 0, sum = 0;
  for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
    const p = px(A, x, y), q = px(B, x, y), da = Math.abs(p[3] - q[3]);
    const dc = p[3] > 128 && q[3] > 128 ? Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - q[k]))) : 0;
    wa = Math.max(wa, da); wc = Math.max(wc, dc); sum += da; if (da || dc) n++;
  }
  return { wa, wc, n, mean: sum / (box.width * box.height) };
}

for (const [label, opts, exact] of [['upright and turned 90°', {}, true], ['turned by their angle (atlasAnyAngle)', { atlasAnyAngle: true }, false], ['a big PSD read at 50 %', { maxCanvas: 70 }, false]]) {
  const res = importPsd(psd, { inflate, keepPixels: false, ...opts });
  const kinds = res.layers.map((l) => (l.atlas.angle ? `${l.name} ${l.atlas.angle}°` : l.atlas.turned ? `${l.name} turned` : `${l.name} upright`)).join(', ');
  let out = psd;
  const results = [];
  for (const meta of res.layers.map(layerMeta)) { // saved meta (no pixels), as the editor keeps it
    const back = layerPixelsFromAtlas(meta, res.atlases[meta.atlas.page || 0], { scale: res.scale });
    out = replaceLayerPixels(out, { index: meta.psdIndex }, back, { inflate });
    results.push([meta, back]);
  }
  const now = readPsd(out, { inflate }).layers;
  const lines = results.map(([meta, back]) => {
    const c = compare(orig[meta.psdIndex], now[meta.psdIndex], back);
    return { name: meta.name, ...c, ok: exact ? c.wa === 0 && c.wc === 0 : c.mean <= (opts.maxCanvas ? 16 : 6) && c.wc <= 16 }; // resampled twice: the edges soften (read at 50 %: 2 px soft edges, the same middle)
  });
  check(lines.every((l) => l.ok) && now.length === orig.length,
    `${label} (${kinds}; scale ${res.scale}): read back from the atlas and written back, the layers ${exact ? 'are the same pixels' : 'come back close'} (${lines.map((l) => `${l.name}: alpha ±${l.wa} (mean ${l.mean.toFixed(2)}), colour ±${l.wc}, ${l.n} px differ`).join('; ')})`);
  if (exact) check(res.layers.some((l) => l.atlas.turned), 'one of them lay turned 90° in the atlas (the case is tested)');
  else if (!opts.maxCanvas) check(res.layers.some((l) => l.atlas.angle), 'one of them lay turned by its angle (the case is tested)');
  if (exact) check(res.layers.map((l) => l.psdIndex).join() === '0,2,3', `psdIndex: the layer's place in the PSD, the skipped empty layer counted (${res.layers.map((l) => l.psdIndex).join(', ')})`);
}
// the box comes back in PSD coordinates, the right size for the PSD
{
  const res = importPsd(psd, { inflate, maxCanvas: 70 }), meta = res.layers.find((l) => l.name === 'blob');
  const back = layerPixelsFromAtlas(meta, res.atlases[0], { scale: res.scale });
  check(Math.abs(back.left - (meta.atlas.left / res.scale)) <= 1 && Math.abs(back.width - meta.atlas.width / res.scale) <= 2 && back.rgba.length === back.width * back.height * 4,
    `scale ${res.scale}: the box ${back.left},${back.top} ${back.width}×${back.height} is in the PSD's pixels (the atlas box ${meta.atlas.left},${meta.atlas.top} ${meta.atlas.width}×${meta.atlas.height})`);
}
let err = '';
try { layerPixelsFromAtlas({ name: 'x' }, null); } catch (e) { err = e.message; }
check(/needs the layer/.test(err), 'without the atlas box or page: a clear error');

console.log(failures ? `\n${failures} check(s) failed` : '\nall atlas read-back checks passed');
process.exit(failures ? 1 : 0);
