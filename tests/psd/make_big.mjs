// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Writes large layered PSDs (8-bit RGB, RLE) for measuring the importer on big canvases:
// a full-canvas white background, `count` soft round blobs of about a fifth of the canvas,
// a hidden layer and a folder, the way illustrations are often laid out.
//   node tests/psd/make_big.mjs 8000 8000 40 build/psd_big/8000.psd
// writePsd() is also used by the tests to build PSDs with odd parts.
import fs from 'node:fs';
import path from 'node:path';

const be = (v, n) => { const b = Buffer.alloc(n); if (n === 2) b.writeInt16BE(v); else b.writeInt32BE(v); return b; };
function packBits(row) { // PackBits, one row
  const out = [];
  for (let i = 0; i < row.length;) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run > 1) { out.push(257 - run, row[i]); i += run; continue; }
    let lit = 1;
    while (i + lit < row.length && lit < 128 && !(i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1])) lit++;
    out.push(lit - 1, ...row.subarray(i, i + lit)); i += lit;
  }
  return Buffer.from(out);
}
const pascal = (s) => { const b = Buffer.from(s, 'latin1').subarray(0, 255), n = Buffer.concat([Buffer.from([b.length]), b]); return Buffer.concat([n, Buffer.alloc((4 - (n.length % 4)) % 4)]); };
const luni = (s) => { const d = Buffer.alloc(4 + 2 * s.length); d.writeUInt32BE(s.length); for (let i = 0; i < s.length; i++) d.writeUInt16BE(s.charCodeAt(i), 4 + 2 * i); return block('luni', d); };
const block = (key, data) => Buffer.concat([Buffer.from('8BIM' + key, 'latin1'), be(data.length, 4), data, Buffer.alloc(data.length % 2)]);

/**
 * layers (bottom first): { name, left, top, width, height, pixel(x, y) -> [r, g, b, a], hidden, opacity, clipping,
 *   blend ('norm'...), section (1 open folder, 3 folder end), extra: [Buffer blocks] }
 *   compression (a channel compression code to write instead of RLE, e.g. 7 for an unknown one)
 * opts: { psb (the large document format: 8-byte lengths, 4-byte row counts), mode: 3 RGB (default) | 4 CMYK | 1 gray | 2 indexed, pixel() of CMYK layers gives [c, m, y, k, a] (ink 0..255),
 *   palette (768 bytes, indexed), composite(x, y) -> the merged picture's colour channels (and alpha with compositeAlpha) }
 */
export function writePsd(width, height, layers, opts = {}) {
  const mode = opts.mode ?? 3, nc = mode === 4 ? 4 : mode === 1 || mode === 2 ? 1 : 3, psb = !!opts.psb, rc = psb ? 4 : 2;
  const len8 = (n) => (psb ? Buffer.concat([be(0, 4), be(n, 4)]) : be(n, 4));
  const recs = [], datas = [];
  for (const L of layers) {
    const w = L.width || 0, h = L.height || 0, ids = [-1, ...Array.from({ length: nc }, (_, i) => i)];
    const planes = ids.map(() => Buffer.alloc(w * h));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = L.pixel(x, y), i = y * w + x;
      planes[0][i] = p[nc];
      for (let c = 0; c < nc; c++) planes[c + 1][i] = mode === 4 ? 255 - p[c] : p[c]; // CMYK is stored inverted
    }
    const chans = planes.map((pl) => {
      if (!w || !h) return Buffer.from([0, 0]);
      const rows = []; for (let y = 0; y < h; y++) rows.push(packBits(pl.subarray(y * w, (y + 1) * w)));
      if (L.compression !== undefined) return Buffer.concat([be(L.compression, 2), Buffer.alloc(w * h)]);
      return Buffer.concat([be(1, 2), ...rows.map((r) => be(r.length, rc)), ...rows]);
    });
    datas.push(...chans);
    const extra = Buffer.concat([be(0, 4), be(0, 4), pascal(L.name), luni(L.name), ...(L.section ? [block('lsct', be(L.section, 4))] : []), ...(L.extra || [])]);
    recs.push(Buffer.concat([be(L.top || 0, 4), be(L.left || 0, 4), be((L.top || 0) + h, 4), be((L.left || 0) + w, 4), be(ids.length, 2),
      ...ids.flatMap((id, k) => [be(id, 2), len8(chans[k].length)]),
      Buffer.from('8BIM' + (L.blend || 'norm'), 'latin1'), Buffer.from([L.opacity ?? 255, L.clipping ? 1 : 0, L.hidden ? 2 : 0, 0]), be(extra.length, 4), extra]));
  }
  let lm = Buffer.alloc(0);
  if (layers.length) {
    let info = Buffer.concat([be(-layers.length, 2), ...recs, ...datas]);
    while (info.length % (psb ? 4 : 2)) info = Buffer.concat([info, Buffer.alloc(1)]);
    lm = Buffer.concat([len8(info.length), info, be(0, 4)]);
  }
  // the merged picture: RLE, every channel's row lengths first
  const n = nc + (opts.compositeAlpha || layers.length ? 1 : 0), rows = [];
  for (let c = 0; c < n; c++) for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width);
    if (opts.composite) for (let x = 0; x < width; x++) row[x] = opts.composite(x, y)[c] ?? 255;
    rows.push(packBits(row));
  }
  const composite = Buffer.concat([be(1, 2), ...rows.map((r) => be(r.length, rc)), ...rows]);
  const palette = mode === 2 ? Buffer.from(opts.palette) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from('8BPS', 'latin1'), be(psb ? 2 : 1, 2), Buffer.alloc(6), be(n, 2), be(height, 4), be(width, 4), be(8, 2), be(mode, 2),
    be(palette.length, 4), palette, be(0, 4), len8(lm.length), lm, composite]);
}

export { block, luni };

export function bigLayers(width, height, count) {
  const layers = [{ name: 'background', left: 0, top: 0, width, height, pixel: () => [255, 255, 255, 255] }];
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blob = (name, s) => {
    const cx = s / 2, col = [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0];
    return { name, left: rnd() * (width - s) | 0, top: rnd() * (height - s) | 0, width: s, height: s,
      pixel: (x, y) => { const d = Math.hypot(x - cx, y - cx) / cx; return [col[0], col[1], col[2], d < 0.9 ? 255 : d < 1 ? (1 - d) * 2550 | 0 : 0]; } };
  };
  layers.push({ name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] });
  for (let i = 0; i < count; i++) layers.push(blob(`blob ${i + 1}`, Math.round(Math.min(width, height) * (0.08 + 0.17 * rnd()))));
  layers.push({ name: 'parts', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] });
  layers.push({ ...blob('hidden sketch', Math.round(Math.min(width, height) * 0.2)), hidden: true });
  return layers;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [w, h, count, out] = process.argv.slice(2);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, writePsd(+w, +h, bigLayers(+w, +h, +count)));
  console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
}
