// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// An atlas back to one picture per part (tools/unpack_atlas.mjs, 機能の比べ #18): a PSD of gradient pictures read
// with the atlas packed tightly (some pictures turned; also with packing at any angle allowed) comes back as each layer's own pixels in
// its place on the canvas, in drawing order; the list says where each one goes.
//   node tests/unpack_atlas_test.mjs
import zlib from 'node:zlib';
import { importPsd } from '../tools/import_psd.mjs';
import { unpackAtlas } from '../tools/unpack_atlas.mjs';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);

// layers whose every pixel differs from its neighbours (a picture turned the wrong way would not match)
const grad = (seed) => (x, y) => [(x * 37 + seed * 11) & 255, (y * 23 + seed * 7) & 255, ((x + y) * 13 + seed) & 255, 255];
const W = 300, H = 240;
const layers = [
  { name: 'wide', left: 10, top: 10, width: 120, height: 30, pixel: grad(1) },
  { name: 'tall', left: 150, top: 20, width: 24, height: 150, pixel: grad(2) },
  { name: 'tall2', left: 190, top: 30, width: 20, height: 140, pixel: grad(3) },
  { name: 'square', left: 40, top: 80, width: 60, height: 60, pixel: grad(4) },
];
for (const opts of [{}, { atlasAnyAngle: true }]) {
  const res = importPsd(writePsd(W, H, layers, { composite: () => [255, 255, 255] }), { inflate, keepPixels: false, maxAtlasSize: 256, ...opts });
  const turned = res.layers.filter((l) => l.atlas.turned).length, angled = res.layers.filter((l) => l.atlas.angle).length;
  const parts = unpackAtlas(res.model, res.atlases);
  const results = layers.map((L, i) => {
    const p = parts.find((x) => x.part === L.name);
    let bad = 0, n = 0;
    for (let y = 1; y < L.height - 1; y++) for (let x = 1; x < L.width - 1; x++) { // the inside (the edge pixels share the mesh's outline)
      const cx = L.left + x, cy = L.top + y, px = cx - p.canvasLeft, py = cy - p.canvasTop;
      if (px < 0 || py < 0 || px >= p.width || py >= p.height) { bad++; n++; continue; }
      const o = (py * p.width + px) * 4, want = L.pixel(x, y);
      n++;
      if ([0, 1, 2, 3].some((k) => Math.abs(p.rgba[o + k] - want[k]) > (angled ? 40 : 0))) bad++;
    }
    return [L.name, bad, n];
  });
  const tol = opts.atlasAnyAngle ? 0.03 : 0;
  check(results.every(([, bad, n]) => bad <= n * tol), `${opts.atlasAnyAngle ? 'packed at any angle' : 'packed in 90° turns'} (${turned} turned, ${angled} at an angle): each part comes back as its layer's pixels in place (${results.map(([nm, b, n]) => `${nm} ${b}/${n}`).join(', ')}${tol ? '; at an angle the atlas itself was resampled' : ''})`);
  if (!opts.atlasAnyAngle) check(parts.map((p) => p.part).join() === res.model.parts.map((p) => p.id).join() && parts.every((p, i) => p.order === i) && parts.every((p) => p.left === p.canvasLeft - Math.round(res.model.canvas.originX) && p.top === p.canvasTop - Math.round(res.model.canvas.originY)) && parts[0].canvasLeft <= 10 && parts[0].canvasLeft >= 4 && parts[0].canvasTop <= 10 && parts[0].canvasTop >= 4,
    'in drawing order; each one\'s place given in model space and canvas pixels (the box takes in the mesh\'s few pixels of margin)');
}

// the PSD folders each part was in (source.psd.layers, as the editor keeps them)
{
  const res = importPsd(writePsd(W, H, layers, { composite: () => [255, 255, 255] }), { inflate, keepPixels: false, maxAtlasSize: 256 });
  const model = { ...res.model, source: { psd: { layers: res.layers.map((l, i) => ({ part: l.part, path: i === 0 ? ['体', '上', l.name] : [l.name] })) } } };
  const parts = unpackAtlas(model, res.atlases);
  check(parts.find((p) => p.part === 'wide').folders?.join('/') === '体/上' && !('folders' in parts.find((p) => p.part === 'tall')), 'each part\'s PSD folders (outermost first); none for a layer outside folders');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall atlas unpack checks passed');
process.exit(failures ? 1 : 0);
