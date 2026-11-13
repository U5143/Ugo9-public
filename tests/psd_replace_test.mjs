// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// replaceLayerPixels (tools/psd_add_layer.mjs): a layer's pixels redrawn in a box, the rest of
// the PSD unchanged. Read back with our importer: the layer has its old pixels with the box drawn
// over them (bigger where the box reaches out), every other layer's record and channel data are
// the same bytes, the merged picture changes only inside the area the layer covered or covers now.
// Where Python's psd-tools is installed (an independent PSD reader and compositor), it reads the
// new layer's pixels too, and its own drawing of the layers matches the new merged picture there. For the merged
// picture only the layers over the area are read (readPsd's within): the area drawn from those is the same as from all.
//   node tests/psd_replace_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceLayerPixels } from '../tools/psd_add_layer.mjs';
import { readPsd } from '../tools/import_psd.mjs';
import { writePsd, block } from './psd/make_big.mjs';
import { drawArea } from '../tools/psd_add_layer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'psd_replace');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const magick = (() => { try { execFileSync('convert', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const psdTools = (() => { try { execFileSync('python3', ['-c', 'import psd_tools'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// the records and channel data of a PSD's layers, as bytes (to compare the untouched ones)
function rawLayers(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 26; p += 4 + v.getUint32(p); p += 4 + v.getUint32(p); p += 8;
  const count = Math.abs(v.getInt16(p)); p += 2;
  const recs = [];
  for (let i = 0; i < count; i++) {
    const at = p; p += 16;
    const n = v.getUint16(p); p += 2;
    let size = 0; for (let c = 0; c < n; c++) { size += v.getUint32(p + 2); p += 6; }
    const rest = p; p += 12; p += 4 + v.getUint32(p);
    recs.push({ head: b.subarray(at, rest), rest: b.subarray(rest, p), size });
  }
  for (const r of recs) { r.data = b.subarray(p, p + r.size); p += r.size; }
  return recs;
}
// the merged picture's planes (RLE or raw), straight from the end of the file
function mergedPlanes(b, big = false) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), nc = v.getUint16(12), H = v.getUint32(14), W = v.getUint32(18);
  let p = 26; p += 4 + v.getUint32(p); p += 4 + v.getUint32(p); p += big ? 8 + v.getUint32(p + 4) : 4 + v.getUint32(p);
  const comp = v.getUint16(p); p += 2;
  const planes = [];
  if (comp === 0) { for (let c = 0; c < nc; c++) planes.push(b.subarray(p + c * W * H, p + (c + 1) * W * H)); return { W, H, planes }; }
  const counts = []; for (let i = 0; i < nc * H; i++) { counts.push(big ? v.getUint32(p) : v.getUint16(p)); p += big ? 4 : 2; }
  for (let c = 0; c < nc; c++) {
    const pl = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const end = p + counts[c * H + y]; let o = y * W;
      while (p < end) { const k = b[p++]; if (k < 128) { pl.set(b.subarray(p, p + k + 1), o); p += k + 1; o += k + 1; } else if (k > 128) { pl.fill(b[p++], o, o + 257 - k); o += 257 - k; } }
    }
    planes.push(pl);
  }
  return { W, H, planes };
}
// a layer's own pixels (its channels -1, 0, 1, 2; its masks not applied), straight from its record
function rawPixels(b, i) {
  const r = rawLayers(b)[i], v = new DataView(r.head.buffer, r.head.byteOffset, r.head.byteLength);
  const top = v.getInt32(0), left = v.getInt32(4), w = v.getInt32(12) - left, h = v.getInt32(8) - top, n = v.getUint16(16);
  const rgba = new Uint8Array(Math.max(0, w * h) * 4);
  for (let q = 3; q < rgba.length; q += 4) rgba[q] = 255;
  let o = 0;
  for (let c = 0; c < n; c++) {
    const id = v.getInt16(18 + c * 6), len = v.getUint32(20 + c * 6), d = r.data.subarray(o, o + len), k = { [-1]: 3, 0: 0, 1: 1, 2: 2 }[id];
    o += len;
    if (k === undefined || !w || !h) continue;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), comp = dv.getUint16(0), plane = new Uint8Array(w * h);
    if (comp === 0) plane.set(d.subarray(2, 2 + w * h));
    else { let p = 2 + 2 * h; for (let y = 0; y < h; y++) { const end = p + dv.getUint16(2 + 2 * y); let x = y * w; while (p < end) { const t = d[p++]; if (t < 128) { plane.set(d.subarray(p, p + t + 1), x); p += t + 1; x += t + 1; } else if (t > 128) { plane.fill(d[p++], x, x + 257 - t); x += 257 - t; } } } }
    for (let j = 0; j < w * h; j++) rgba[j * 4 + k] = plane[j];
  }
  return { left, top, width: w, height: h, rgba };
}
const at = (L, x, y) => { const lx = x - L.left, ly = y - L.top; if (!L || lx < 0 || ly < 0 || lx >= L.width || ly >= L.height) return [0, 0, 0, 0]; const i = (ly * L.width + lx) * 4; return [...L.rgba.subarray(i, i + 4)]; };

// the new pixels: a ring with soft and transparent parts (transparent ones erase)
const box = (left, top, w, h) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - w / 2, y - h / 2), i = (y * w + x) * 4;
    rgba.set([30 + x * 3, 200 - y * 2, 90, d < 4 ? 0 : d < Math.min(w, h) / 2 - 2 ? 255 : d < Math.min(w, h) / 2 ? 140 : 0], i);
  }
  return { left, top, width: w, height: h, rgba };
};

const square = (name, left, top, size, colour, more = {}) => ({ name, left, top, width: size, height: size, pixel: () => colour, ...more });
const end = { name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] };
const made = writePsd(96, 80, [square('back', 0, 0, 80, [240, 240, 230, 255]), end, square('face', 20, 15, 40, [250, 210, 190, 255]),
  square('shade', 22, 30, 30, [90, 60, 120, 255], { clipping: true, blend: 'mul ', opacity: 180 }), square('eye', 30, 25, 8, [20, 30, 80, 255]),
  { name: '顔', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, square('note', 60, 50, 20, [255, 0, 0, 255], { hidden: true }), square('glow', 50, 10, 30, [80, 80, 40, 255], { blend: 'scrn' })],
{ composite: (x, y) => [200, 200, 200, 255] }); // a merged picture to see what is kept

const cases = [
  ['tests/psd/face.psd', fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face.psd')), 'eyes/eye', { index: 2 }, box(100, 120, 30, 40)],
  ['tests/psd/clip.psd', fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'clip.psd')), 'skin', null, box(20, 6, 40, 30)],
  ['made here: a folder, clipping, multiply, screen, a hidden layer', made, '顔/face', null, box(10, 5, 30, 30)],
];
for (const [name, bytes, which, alt, pic] of cases) {
  const tag = path.basename(name.split(':')[0]).replace(/\.psd$/, '').replace(/\s+/g, '_');
  let out;
  // the pixels as they are (the layer's own)
  try { out = replaceLayerPixels(bytes, alt ?? which, pic, { inflate, unmask: false }); } catch (e) { check(false, `${name}: ${e.code} ${e.message}`); continue; }
  const file = path.join(OUT, `${tag}.psd`);
  fs.writeFileSync(file, out);
  const a = readPsd(bytes, { inflate }), b2 = readPsd(out, { inflate });
  const k = alt ? alt.index : a.layers.findIndex((l) => [...l.groupObjs.map((g) => g.name), l.name].join('/') === which);
  // its record: the k-th record that is not a folder's
  const recOf = (() => { const sec = []; const recs = rawLayers(bytes); let n = -1; for (let i = 0; i < recs.length; i++) { const isFolder = /lsct/.test(Buffer.from(recs[i].rest).toString('latin1')) && (() => { const t = Buffer.from(recs[i].rest), j = t.indexOf('lsct'); return t.readUInt32BE(j + 8) > 0; })(); sec.push(isFolder); if (!isFolder && ++n === k) return i; } return -1; })();
  const L0 = { ...rawPixels(bytes, recOf), ...{ name: a.layers[k].name, opacity: a.layers[k].opacity, blend: a.layers[k].blend, clipping: a.layers[k].clipping, visible: a.layers[k].visible } };
  const L1 = { ...rawPixels(out, recOf), ...{ name: b2.layers[k].name, opacity: b2.layers[k].opacity, blend: b2.layers[k].blend, clipping: b2.layers[k].clipping, visible: b2.layers[k].visible } };
  // the layer: its old pixels, the box over them
  let bad = 0;
  const x0 = Math.min(L0.left, pic.left), y0 = Math.min(L0.top, pic.top), x1 = Math.max(L0.left + L0.width, pic.left + pic.width), y1 = Math.max(L0.top + L0.height, pic.top + pic.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const inBox = x >= pic.left && y >= pic.top && x < pic.left + pic.width && y < pic.top + pic.height;
    const want = inBox ? [...pic.rgba.subarray(((y - pic.top) * pic.width + x - pic.left) * 4, ((y - pic.top) * pic.width + x - pic.left) * 4 + 4)] : at(L0, x, y), got = at(L1, x, y);
    if (want[3] !== got[3] || (want[3] && [0, 1, 2].some((c) => want[c] !== got[c]))) bad++;
  }
  check(bad === 0 && L1.name === L0.name && L1.opacity === L0.opacity && L1.blend === L0.blend && L1.clipping === L0.clipping && L1.visible === L0.visible,
    `${name}: ${which}: its own pixels are the old ones with the box drawn over them (${x1 - x0}×${y1 - y0} px, ${bad} differ), name, opacity, blend, clipping and visibility kept`);
  // every other layer: the same bytes
  const r0 = rawLayers(bytes), r1 = rawLayers(out);
  const changed = r0.map((r, i) => Buffer.compare(Buffer.from(r.head), Buffer.from(r1[i].head)) || Buffer.compare(Buffer.from(r.data), Buffer.from(r1[i].data)) ? i : -1).filter((i) => i >= 0);
  const restSame = r0.every((r, i) => Buffer.compare(Buffer.from(r.rest), Buffer.from(r1[i].rest)) === 0);
  check(r0.length === r1.length && changed.length === 1 && restSame, `${name}: one record and its data changed, the other ${r0.length - 1} records (folders too) and every record's flags, masks, name and blocks are the same bytes`);
  // the merged picture: the same outside the area, drawn again inside
  const m0 = mergedPlanes(bytes), m1 = mergedPlanes(out);
  const ax0 = Math.max(0, x0), ay0 = Math.max(0, y0), ax1 = Math.min(m0.W, x1), ay1 = Math.min(m0.H, y1);
  let outside = 0, inside = 0;
  for (let c = 0; c < m0.planes.length; c++) for (let y = 0; y < m0.H; y++) for (let x = 0; x < m0.W; x++) {
    const diff = m0.planes[c][y * m0.W + x] !== m1.planes[c][y * m0.W + x];
    if (x >= ax0 && x < ax1 && y >= ay0 && y < ay1) inside += diff; else outside += diff;
  }
  check(outside === 0 && inside > 0, `${name}: the merged picture is the same outside the area ${ax0},${ay0}–${ax1},${ay1} and drawn again inside it (${inside} samples changed)`);
  if (psdTools) {
    const py = `
import sys, json
import numpy as np
from psd_tools import PSDImage
p = PSDImage.open(sys.argv[1])
layers = [l for l in p.descendants() if not l.is_group()]
L = layers[int(sys.argv[2])]
im = np.asarray(L.topil().convert('RGBA')).astype(int)
x0, y0, x1, y1 = [int(v) for v in sys.argv[3:7]]
ours = np.asarray(p.topil().convert('RGBA')).astype(int)[y0:y1, x0:x1]
theirs = np.asarray(p.composite(force=True, viewport=(0, 0, p.width, p.height)).convert('RGBA')).astype(int)[y0:y1, x0:x1]
a = theirs[:, :, 3:4] / 255.0
if p.channels < 4:  # no transparency in the merged picture: it is the layers over white
    theirs = np.concatenate([np.rint(theirs[:, :, :3] * a + 255 * (1 - a)), np.full(a.shape, 255)], axis=2).astype(int)
    a = np.ones(a.shape)
d = np.abs(ours[:, :, 3] - theirs[:, :, 3]).max()
cdiff = (np.abs(ours[:, :, :3] - theirs[:, :, :3]) * (a > 0.05)).max(axis=2)
print(json.dumps({ 'name': L.name, 'bbox': list(L.bbox), 'opaque': int((im[:, :, 3] > 0).sum()), 'alpha': int(d), 'colour': int(cdiff.max()), 'over3': int((cdiff > 3).sum()), 'n': int(cdiff.size) }))`;
    const r = JSON.parse(execFileSync('python3', ['-c', py, file, String(k), String(ax0), String(ay0), String(ax1), String(ay1)], { encoding: 'utf8', maxBuffer: 1 << 26 }));
    const opaque = (() => { let n = 0; for (let i = 3; i < L1.rgba.length; i += 4) n += L1.rgba[i] > 0; return n; })(); // its own pixels (psd-tools' topil leaves the mask out)
    check(r.name === L0.name && r.opaque === opaque && r.alpha <= 1 && r.colour <= 2 && r.over3 === 0,
      `${name}: psd-tools reads the layer (${r.name}, ${r.opaque} drawn pixels as ours) and its own drawing of all layers matches the new merged picture in the area (alpha ±${r.alpha}, colour ±${r.colour}, ${r.over3} of ${r.n} pixels over 3)`);
  }
  if (magick) { // ImageMagick: a third reader; its layer list (the merged picture first, then the layers bottom first, folders left out)
    const list = execFileSync('convert', [file, '-format', '%wx%h%X%Y %l\n', 'info:'], { encoding: 'utf8' }).trim().split('\n').slice(1).map((l) => l.trim());
    const want = `${L1.width}x${L1.height}+${L1.left}+${L1.top} ${L1.name}`;
    check(list.length === a.layers.length && list[k] === want, `${name}: ImageMagick reads ${list.length} layers, ${which} as ${list[k]}`);
  }
}
if (!psdTools) console.log('     (psd-tools is not installed: the checks with an independent reader and compositor are skipped; pip install psd-tools)');

// the layer's mask stays, byte for byte (face.psd's layers have one each)
{
  const bytes = fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face.psd')), out = replaceLayerPixels(bytes, 'body', box(100, 200, 30, 30), { inflate });
  const chans = (b, i) => { const r = rawLayers(b)[i], v = new DataView(r.head.buffer, r.head.byteOffset), n = v.getUint16(16), list = []; let o = 0; for (let c = 0; c < n; c++) { const id = v.getInt16(18 + c * 6), len = v.getUint32(20 + c * 6); list.push([id, r.data.subarray(o, o + len)]); o += len; } return list; };
  const m0 = chans(bytes, 0).filter(([id]) => id < -1), m1 = chans(out, 0).filter(([id]) => id < -1);
  check(m0.length > 0 && m0.length === m1.length && m0.every(([id, d], i) => m1[i][0] === id && Buffer.compare(Buffer.from(d), Buffer.from(m1[i][1])) === 0), `the layer's mask channels (${m0.map(([id]) => id).join(', ')}) are the same bytes`);
}
// growing: a box wholly outside the old one, and a layer that had no pixels
{
  const out = replaceLayerPixels(made, 'glow', box(2, 60, 16, 16), { inflate }), L = readPsd(out, { inflate }).layers.find((l) => l.name === 'glow');
  check(at(L, 10, 63)[3] === 255 && at(L, 60, 20)[3] === 255, `a box outside the layer: the layer grows to hold both (${L.left},${L.top} ${L.width}×${L.height})`);
  const empty = writePsd(40, 40, [square('a', 0, 0, 40, [1, 2, 3, 255]), { name: 'blank', left: 0, top: 0, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }], { composite: () => [1, 2, 3, 255] });
  const e2 = readPsd(replaceLayerPixels(empty, 'blank', box(5, 5, 20, 20), { inflate }), { inflate }).layers.find((l) => l.name === 'blank');
  check(e2.width > 0 && at(e2, 15, 8)[3] === 255, 'a layer with no pixels gets the box');
}
// the default (unmask): pixels as importPsd sees them (through the layer's mask, its vector mask and
// its folders' masks) are divided back by the masks, so the layer looks the same again; where the
// masks hide all, its old pixels stay. Without it (unmask: false) the masks would be applied twice
for (const [file, index] of [['face.psd', 0], ['folder_mask.psd', 0], ['vector.psd', 0]]) {
  const bytes = fs.readFileSync(path.join(ROOT, 'tests', 'psd', file)), seen = readPsd(bytes, { inflate }).layers[index];
  // the layer as seen, its colours changed, its transparency kept
  const pic = { left: seen.left, top: seen.top, width: seen.width, height: seen.height, rgba: seen.rgba.map((v, i) => (i % 4 === 3 ? v : 255 - v)) };
  const look = (opts) => readPsd(replaceLayerPixels(bytes, { index }, pic, { inflate, ...opts }), { inflate }).layers[index];
  const diff = (L) => { let wa = 0, wc = 0; for (let y = 0; y < pic.height; y++) for (let x = 0; x < pic.width; x++) { const p = [...pic.rgba.subarray((y * pic.width + x) * 4, (y * pic.width + x) * 4 + 4)], q = at(L, pic.left + x, pic.top + y); wa = Math.max(wa, Math.abs(p[3] - q[3])); if (p[3] > 8 && q[3] > 8) wc = Math.max(wc, ...[0, 1, 2].map((c) => Math.abs(p[c] - q[c]))); } return [wa, wc]; };
  const [wa, wc] = diff(look({})), [wa2] = diff(look({ unmask: false }));
  // a mask of only 0 and 255 thins nothing twice; a soft one (the vector mask's edge) does
  check(wa <= 2 && wc <= 1 && (file === 'vector.psd' ? wa2 > 8 : wa2 >= wa), `${file}: pixels taken through the masks and written back look the same (alpha ±${wa}, colour ±${wc}); written as they are, the masks would ${file === 'vector.psd' ? 'thin them' : 'give'} alpha ±${wa2}`);
}
// a mask that hides all outside its box: said (psd-tools writes one the size of each layer)
{
  const notes = [];
  replaceLayerPixels(fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'clip.psd')), 'skin', box(40, 40, 20, 20), { inflate, notes });
  check(notes.length === 1 && notes[0].code === 'psdEditMaskHides' && notes[0].vars.layer === 'skin', `a box past the layer's mask: ${notes[0]?.code} (${notes[0]?.text})`);
}
// a PSB (the large document format: 8-byte lengths, 4-byte row counts): the same layers as a PSD
// give the same layers and merged picture after the same change
{
  const layers = [square('back', 0, 0, 60, [240, 240, 230, 255]), square('face', 10, 10, 30, [250, 210, 190, 255]), square('shade', 15, 20, 20, [90, 60, 120, 255], { clipping: true, blend: 'mul ' })];
  const pic = box(20, 5, 30, 30), opts = { composite: () => [200, 200, 200, 255] };
  const a1 = replaceLayerPixels(writePsd(64, 48, layers, opts), 'face', pic, { inflate }), b1 = replaceLayerPixels(writePsd(64, 48, layers, { ...opts, psb: true }), 'face', pic, { inflate });
  const la = readPsd(a1, { inflate }).layers, lb = readPsd(b1, { inflate }).layers;
  const same = la.length === lb.length && la.every((L, i) => L.left === lb[i].left && L.top === lb[i].top && L.width === lb[i].width && Buffer.compare(Buffer.from(L.rgba), Buffer.from(lb[i].rgba)) === 0);
  const ma = mergedPlanes(a1), mb = mergedPlanes(b1, true);
  check(new DataView(b1.buffer, b1.byteOffset).getUint16(4) === 2 && same && ma.planes.every((pl, c) => Buffer.compare(Buffer.from(pl), Buffer.from(mb.planes[c])) === 0),
    `a PSB: the layers (${lb.map((l) => `${l.name} ${l.width}×${l.height}`).join(', ')}) and the merged picture come out as from the same PSD`);
}
// what it refuses, with a code
const code = (fn) => { try { fn(); return 'none'; } catch (e) { return e.code; } };
const twice = writePsd(30, 30, [square('x', 0, 0, 10, [1, 1, 1, 255]), square('x', 5, 5, 10, [2, 2, 2, 255])]);
const text = writePsd(30, 30, [square('words', 0, 0, 10, [1, 1, 1, 255], { extra: [block('TySh', Buffer.alloc(8))] })]);
{ // only the layers over the area are read: the same drawing, fewer layers read
  const area = [55, 45, 85, 75], all = readPsd(made).layers, some = readPsd(made, { within: area }).layers;
  const a1 = drawArea(all, area), a2 = drawArea(some, area), outside = some.filter((L) => L.outside).map((L) => L.name);
  check(a1.every((v, i) => v === a2[i]) && some.length === all.length && outside.join() === 'shade,eye,glow',
    `within ${area.join(',')}: the same drawing; not read: ${outside.join(', ')} (each keeps its place)`);
}
check(code(() => replaceLayerPixels(made, 'nothing', box(0, 0, 4, 4))) === 'psdEditNoLayer', 'no such layer: psdEditNoLayer');
check(code(() => replaceLayerPixels(twice, 'x', box(0, 0, 4, 4))) === 'psdEditAmbiguous' && code(() => replaceLayerPixels(twice, { index: 1 }, box(0, 0, 4, 4))) === 'none', 'two layers on one path: psdEditAmbiguous; { index } picks one');
check(code(() => replaceLayerPixels(text, 'words', box(0, 0, 4, 4))) === 'psdEditKind', 'a text layer: psdEditKind (its pixels come from the text)');
check(code(() => replaceLayerPixels(fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face16.psd')), { index: 0 }, box(0, 0, 4, 4))) === 'psdEditDepth', 'a 16-bit PSD: psdEditDepth');
check(code(() => replaceLayerPixels(made, 'back', { left: 0, top: 0, width: 4, height: 4, rgba: new Uint8Array(3) })) === 'psdEditBadPixels', 'pixels that do not fit the size: psdEditBadPixels');
check(code(() => replaceLayerPixels(new Uint8Array(40), 'x', box(0, 0, 4, 4))) === 'psdEditNotPsd', 'not a PSD: psdEditNotPsd');

console.log(failures ? `\n${failures} check(s) failed` : '\nall replace-layer checks passed');
process.exit(failures ? 1 : 0);
