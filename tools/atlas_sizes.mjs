// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Atlases at several sizes at once (機能の比べ #17、利用者の声 #18): for each scale (1, 0.5, 0.25, ...) the atlas pages
// made smaller and a .ug9 that names them. The model is the same in each (its size on the canvas, its meshes and
// UVs: UVs run 0..1 over a page, so they hold at any size); only the pictures have fewer pixels, for small screens,
// thumbnails or a quick first load. Each new pixel is the area-weighted mean of the pixels it covers, colours weighted
// by their transparency (no dark rims).
//
//   atlasSizes(json, pages, scales, opts) -> [{ scale, suffix, pages: [{ name, width, height, rgba }], ug9, notes }]
//     json: the working JSON; pages: its textures' pixels [{ width, height, rgba }] in model.textures' order
//     opts.suffix(scale) -> the names' ending ('' for 1, '@0.5x' ...); opts.compile: compileUgo's options (curveKeys ...)
//   scalePage(page, k) -> { width, height, rgba }
//   node tools/atlas_sizes.mjs model.json|model.ug9 --scales 1,0.5,0.25 [--out folder]
//     -> folder/model.ug9 + atlas.png, model@0.5x.ug9 + atlas@0.5x.png, ...
// Works in the browser (no Node APIs outside the CLI block).
import { compileUgo } from './compile.mjs';

/** A page made k times as large (k ≤ 1): each new pixel the area-weighted mean of the old ones it covers (premultiplied). */
export function scalePage(page, k) {
  const W = page.width, H = page.height, w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const sx = W / w, sy = H / h, src = page.rgba, out = new Uint8Array(w * h * 4);
  // per new column / row: the old ones it covers and how much of each
  const spans = (n, s, N) => Array.from({ length: n }, (_, X) => {
    const a = X * s, b = (X + 1) * s, list = [];
    for (let i = Math.floor(a); i < Math.min(N, Math.ceil(b)); i++) { const wt = Math.min(b, i + 1) - Math.max(a, i); if (wt > 1e-9) list.push([i, wt]); }
    return list;
  });
  const cols = spans(w, sx, W), rows = spans(h, sy, H);
  for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) {
    let r = 0, g = 0, b = 0, a = 0, area = 0;
    for (const [y, wy] of rows[Y]) for (const [x, wx] of cols[X]) {
      const i = (y * W + x) * 4, wt = wx * wy, al = src[i + 3] * wt;
      r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; area += wt;
    }
    const o = (Y * w + X) * 4;
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / area); }
  }
  return { width: w, height: h, rgba: out };
}

const defaultSuffix = (k) => (k === 1 ? '' : `@${k}x`);
const withSuffix = (name, suffix) => { const dot = name.lastIndexOf('.'); return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`; };

/** Each scale's pages and .ug9. */
export function atlasSizes(json, pages, scales, opts = {}) {
  const suffixOf = opts.suffix || defaultSuffix;
  return scales.map((k) => {
    if (!(k > 0 && k <= 1)) throw new Error(`a scale is above 0 and at most 1 (${k})`);
    const suffix = suffixOf(k), notes = [];
    const out = (json.textures || []).map((name, i) => {
      const p = k === 1 ? pages[i] : scalePage(pages[i], k);
      const off = [pages[i].width * k, pages[i].height * k].some((v, j) => Math.abs(v - [p.width, p.height][j]) > 1e-9);
      if (off) notes.push({ code: 'atlasSizeRounded', vars: { name, width: p.width, height: p.height }, text: `${name} at ${k}: ${pages[i].width * k}×${pages[i].height * k} rounded to ${p.width}×${p.height} (the pictures shift by under half a pixel)` });
      return { name: withSuffix(name, suffix), ...p };
    });
    const m = structuredClone(json);
    m.textures = out.map((p) => p.name);
    return { scale: k, suffix, pages: out, ug9: new Uint8Array(compileUgo(m, { warnings: [], ...(opts.compile || {}) })), notes };
  });
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), path = await import('node:path');
  const { decodePng, encodePng } = await import('./png.mjs');
  const { importUg9 } = await import('./import_ug9.mjs');
  const args = process.argv.slice(2), src = args.find((a, i) => !a.startsWith('--') && !['--scales', '--out'].includes(args[i - 1]));
  const scales = (args.includes('--scales') ? args[args.indexOf('--scales') + 1] : '1,0.5,0.25').split(',').map(Number);
  if (!src) { console.error('usage: node tools/atlas_sizes.mjs model.json|model.ug9 --scales 1,0.5,0.25 [--out folder]'); process.exit(2); }
  const dir = path.dirname(src), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : dir;
  const json = /\.ug9$/i.test(src) ? importUg9(fs.readFileSync(src)).json : JSON.parse(fs.readFileSync(src, 'utf8'));
  const pages = json.textures.map((t) => decodePng(fs.readFileSync(path.join(dir, t))));
  const base = path.basename(src).replace(/\.(json|ug9)$/i, '');
  fs.mkdirSync(out, { recursive: true });
  for (const r of atlasSizes(json, pages, scales)) {
    r.pages.forEach((p, i) => {
      const to = path.join(out, p.name), from = path.join(dir, json.textures[i]);
      if (r.scale !== 1) fs.writeFileSync(to, encodePng(p.width, p.height, p.rgba));
      else if (path.resolve(to) !== path.resolve(from)) fs.copyFileSync(from, to); // at 1 the page as it is
    });
    const file = path.join(out, `${base}${r.suffix}.ug9`);
    fs.writeFileSync(file, r.ug9);
    for (const n of r.notes) console.log(`note: ${n.text}`);
    console.log(`${file}: ${r.pages.map((p) => `${p.name} ${p.width}x${p.height}`).join(', ')}`);
  }
}
