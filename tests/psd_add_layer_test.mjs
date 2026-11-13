// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// addLayerToPsd (tools/psd_add_layer.mjs): one more layer in a PSD, the rest unchanged. Read back
// with our importer and, where Python's psd-tools is installed (an independent PSD reader),
// with it too: the old layers are as they were, the new one is on top with its pixels, name,
// opacity and visibility, and every byte outside the layer info is the same.
//   node tests/psd_add_layer_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addLayerToPsd } from '../tools/psd_add_layer.mjs';
import { importPsd } from '../tools/import_psd.mjs';
import { writePsd } from './psd/make_big.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'psd_add_layer');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const hash = (a) => crypto.createHash('sha256').update(a).digest('hex').slice(0, 16);

// the new layer: a ring of colour with soft and empty pixels, so RLE and transparency both show
const W = 61, H = 37, rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = Math.hypot(x - W / 2, y - H / 2), i = (y * W + x) * 4;
  rgba.set([200, (x * 4) & 255, (y * 7) & 255, d < 10 ? 0 : d < 16 ? 255 : d < 18 ? 120 : 0], i);
}
const layer = { name: 'マスク 目 L', left: 33, top: 21, width: W, height: H, rgba, opacity: 0.6, hidden: true };

// the PSD's sections: the bytes before the layer and mask info, the global mask info and blocks after the layer info, the merged picture
const sections = (b) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), big = v.getUint16(4) === 2;
  let p = 26;
  p += 4 + v.getUint32(p); p += 4 + v.getUint32(p);
  const lmAt = p, lm = big ? v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4) : v.getUint32(p);
  p += big ? 8 : 4;
  const li = big ? v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4) : v.getUint32(p), liEnd = p + (big ? 8 : 4) + li, lmEnd = lmAt + (big ? 8 : 4) + lm;
  return { head: b.subarray(0, lmAt), tail: b.subarray(liEnd, lmEnd), merged: b.subarray(lmEnd) };
};
const layerHash = (l) => hash(Buffer.concat([Buffer.from(JSON.stringify([l.name, l.left, l.top, l.width, l.height, l.visible, +l.opacity.toFixed(3), l.blend, l.path])), Buffer.from(l.rgba || [])]));

const psdTools = (() => { try { execFileSync('python3', ['-c', 'import psd_tools'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const square = (name, left, top, size, colour) => ({ name, left, top, width: size, height: size, pixel: () => colour });
const cases = [
  ['tests/psd/face.psd (written by psd-tools)', fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face.psd'))],
  ['tests/psd/clip.psd', fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'clip.psd'))],
  ['made here: folders, a hidden layer', writePsd(160, 120, [square('back', 0, 0, 120, [250, 250, 250, 255]),
    { name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, square('eye', 40, 30, 20, [20, 40, 200, 255]),
    { name: '目', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, { ...square('sketch', 5, 5, 30, [0, 0, 0, 255]), hidden: true }],
  { composite: (x, y) => [x, y, 100] })],
];
for (const [name, bytes] of cases) {
  const out = addLayerToPsd(bytes, layer), file = path.join(OUT, `${name.split(/[ /]/).filter(Boolean)[name.startsWith('tests') ? 2 : 0].replace('.psd', '')}.psd`);
  fs.writeFileSync(file, out);
  const a = importPsd(bytes, { inflate, keepPixels: true }), b = importPsd(out, { inflate, keepPixels: true });
  const s0 = sections(bytes), s1 = sections(out);
  check(Buffer.compare(Buffer.from(s0.head), Buffer.from(s1.head)) === 0 && Buffer.compare(Buffer.from(s0.tail), Buffer.from(s1.tail)) === 0 && Buffer.compare(Buffer.from(s0.merged), Buffer.from(s1.merged)) === 0,
    `${name}: the header, colour data, image resources, the blocks after the layers and the merged picture are the same bytes`);
  const old = a.layers.map(layerHash), now = b.layers.map(layerHash);
  check(now.length === old.length + 1 && old.every((h, i) => h === now[i]), `${name}: the ${old.length} layers read back the same (names, places, folders, pixels)`);
  const L = b.layers[b.layers.length - 1];
  let same = L.name === layer.name && !L.visible && Math.abs(L.opacity - 153 / 255) < 1e-9 && L.path.length === 1;
  for (let y = 0; y < L.height && same; y++) for (let x = 0; x < L.width; x++) {
    const i = ((L.top - layer.top + y) * W + L.left - layer.left + x) * 4, j = (y * L.width + x) * 4;
    if (rgba[i + 3] !== L.rgba[j + 3] || (rgba[i + 3] && [0, 1, 2].some((k) => rgba[i + k] !== L.rgba[j + k]))) { same = false; break; }
  }
  check(same, `${name}: the new layer is on top, outside the folders, hidden, opacity 60 %, named ${L.name}, with its pixels`);
  if (psdTools) {
    const py = `
import sys, json
from psd_tools import PSDImage
p = PSDImage.open(sys.argv[1])
top = list(p)[-1]
im = top.topil().convert('RGBA')
raw = im.tobytes()
px = [raw[i:i + 4] for i in range(0, len(raw), 4)]
print(json.dumps({ 'n': len(list(p.descendants())), 'name': top.name, 'bbox': list(top.bbox), 'visible': top.visible, 'opacity': top.opacity, 'w': im.width, 'h': im.height, 'px': [list(q) for q in px] }))`;
    const r = JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 1 << 26 }));
    let ok = r.name === layer.name && r.visible === false && r.opacity === 153 && r.bbox[0] === layer.left && r.bbox[1] === layer.top;
    // psd-tools gives the layer's own box (its pixels from bbox)
    for (let y = 0; y < r.h && ok; y++) for (let x = 0; x < r.w; x++) {
      const q = r.px[y * r.w + x], i = ((r.bbox[1] - layer.top + y) * W + r.bbox[0] - layer.left + x) * 4;
      if (q[3] !== rgba[i + 3] || (q[3] && [0, 1, 2].some((k) => q[k] !== rgba[i + k]))) { ok = false; break; }
    }
    check(ok, `${name}: psd-tools reads the new layer: ${r.name}, box ${r.bbox.join(',')}, hidden, opacity ${r.opacity}, the same pixels`);
  }
  // twice: two layers added, both there
  const twice = addLayerToPsd(out, { ...layer, name: 'second', hidden: false, opacity: 1 }), c = importPsd(twice, { inflate });
  check(c.layers.length === old.length + 2 && c.layers.at(-1).name === 'second' && c.layers.at(-2).name === layer.name, `${name}: a second layer goes on top of the first`);
}
if (!psdTools) console.log('     (psd-tools is not installed: the check with an independent reader is skipped; pip install psd-tools)');

// what it refuses, with a code
const code = (fn) => { try { fn(); return 'none'; } catch (e) { return e.code; } };
check(code(() => addLayerToPsd(writePsd(64, 48, [], { composite: () => [1, 2, 3] }), layer)) === 'psdAddNoLayers', 'a flat PSD (no layers) is refused: a layer would hide its picture');
check(code(() => addLayerToPsd(fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face16.psd')), layer)) === 'psdAddDepth', 'a 16-bit PSD is refused (psdAddDepth)');
check(code(() => addLayerToPsd(writePsd(40, 40, [square('ink', 0, 0, 10, [255, 0, 0, 0, 255])], { mode: 4 }), layer)) === 'psdAddMode', 'a CMYK PSD is refused (psdAddMode)');
check(code(() => addLayerToPsd(new Uint8Array(30), layer)) === 'psdAddNotPsd', 'not a PSD: psdAddNotPsd');
check(code(() => addLayerToPsd(cases[0][1], { ...layer, rgba: new Uint8Array(10) })) === 'psdAddBadLayer', 'pixels that do not fit the size: psdAddBadLayer');

console.log(failures ? `\n${failures} check(s) failed` : '\nall add-layer checks passed');
process.exit(failures ? 1 : 0);
