// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// PSD (Photoshop, layered) -> Ugo9 working JSON: one part per pixel layer, the layers
// packed into one atlas, a mesh over each layer's opaque pixels (following the outline).
//
//   node tools/import_psd.mjs picture.psd outDir [--spacing 24] [--mesh auto|contour|grid] [--alpha 8] [--group-bones] [--no-clipping]
//   -> outDir/model.json, model.ug9, atlas.png
//
// importPsd() runs in the browser as well (plain ES module, no Node API); only the CLI at
// the bottom uses Node. Written from Adobe's published "Photoshop File Formats
// Specification". Reads 8-bit RGB / grayscale PSD and PSB, raw / RLE / ZIP channels
// (ZIP needs opts.inflate, e.g. zlib.inflateSync, since browsers only inflate async).

import { makeNotes } from './notes.mjs';
import { BLEND_FUNCTIONS, RUNTIME_BLENDS } from './blend_modes.mjs';
import { adjustment, applyAdjustment } from './adjustments.mjs';
import { readEffects, paintEffects } from './layer_effects.mjs';
import { drawArea } from './psd_add_layer.mjs';

const BLEND = { norm: 'normal', pass: 'passThrough', mul: 'multiply', scrn: 'screen', lddg: 'add', lbrn: 'linearBurn', dark: 'darken', lite: 'lighten',
  over: 'overlay', sLit: 'softLight', hLit: 'hardLight', div: 'colorDodge', fdiv: 'divide', diff: 'difference', smud: 'exclusion',
  colr: 'color', lum: 'luminosity', hue: 'hue', sat: 'saturation', diss: 'dissolve', idiv: 'colorBurn', vLit: 'vividLight', lLit: 'linearLight',
  pLit: 'pinLight', hMix: 'hardMix', fsub: 'subtract', dkCl: 'darkerColor', lgCl: 'lighterColor' };

class Reader {
  constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  i16() { const x = this.v.getInt16(this.p); this.p += 2; return x; }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u64() { const hi = this.u32(), lo = this.u32(); return hi * 2 ** 32 + lo; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; return s; }
  bytes(n) { const x = this.b.subarray(this.p, this.p + n); this.p += n; return x; }
}

// what a layer is, from its additional information blocks (Photoshop File Formats Specification)
const ADJUSTMENT = ['levl', 'curv', 'brit', 'blnc', 'hue ', 'hue2', 'selc', 'mixr', 'grdm', 'phfl', 'expA', 'vibA', 'thrs', 'post', 'nvrt', 'CgEd', 'clrL', 'blwh'];
function layerKind(keys) {
  if (ADJUSTMENT.some((k) => keys.has(k))) return 'adjustment';
  if (['SoCo', 'GdFl', 'PtFl'].some((k) => keys.has(k))) return 'fill';
  if (keys.has('TySh') || keys.has('tySh')) return 'text';
  if (['SoLd', 'SoLE', 'PlLd', 'plLd'].some((k) => keys.has(k))) return 'smartObject';
  return 'pixels';
}

function unpackBits(src, out, at, n) { // PackBits, into out[at .. at + n) (out starts as zeros)
  let i = 0, o = 0;
  while (o < n && i < src.length) {
    const h = src[i++];
    if (h < 128) { const m = Math.min(h + 1, n - o); out.set(src.subarray(i, i + m), at + o); i += h + 1; o += m; }
    else if (h > 128) { const m = Math.min(257 - h, n - o); if (i < src.length) out.fill(src[i], at + o, at + o + m); i++; o += m; }
  }
}

/** Layers of a PSD/PSB: { width, height, layers: [{ name, groups, left, top, width, height, visible, opacity, blend, clipping, rgba }] }
 *  in drawing order (bottom first). Group folders are not layers; their names are in `groups` (outermost first).
 *  ZIP channels need opts.inflate (sync); readPsdAsync inflates them itself (DecompressionStream).
 *  opts.scaleFor(width, height) -> s: each layer is scaled by s (< 1) as soon as it is read (the
 *  result's `scale`), so the full-size pixels of all layers are never held at once.
 *  opts.within [x0, y0, x1, y1]: a layer whose box is outside it (and has no effects) is not read: it keeps its place
 *  with no pixels (width 0, `outside: true`). */
export function readPsd(bytes, opts = {}) {
  const gen = readPsdGen(bytes, opts);
  let r = gen.next();
  while (!r.done) { // a ZIP channel to inflate
    if (!opts.inflate) psdError('psdNeedsInflate', {}, 'ZIP-compressed PSD layers need opts.inflate');
    let out, err;
    try { out = opts.inflate(r.value); } catch (e) { err = e; }
    r = err ? gen.throw(err) : gen.next(out);
  }
  return r.value;
}
/** How much of one layer its masks let show (its own mask, its vector mask and its folders' masks,
 *  as importPsd applies them), over a box in canvas pixels: Uint8Array (width × height, 0..255), or
 *  null when there is no such layer. index: the layer's place (folders not counted, bottom first:
 *  importPsd's layers[].psdIndex). 8-bit PSD layers in the layer info (what replaceLayerPixels writes). */
export function psdMaskCoverage(bytes, index, box, opts = {}) {
  return readPsd(bytes, { inflate: opts.inflate, coverage: { index, ...box } }).coverage ?? null;
}
/** readPsd that inflates ZIP channels with the browser's DecompressionStream (one channel at a time). */
export async function readPsdAsync(bytes, opts = {}) {
  return drive(readPsdGen(bytes, opts), opts);
}
async function drive(gen, opts) { // runs a reading generator, inflating the ZIP data it yields
  const inflate = opts.inflate ? async (b) => opts.inflate(b)
    : async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  let r = gen.next();
  while (!r.done) {
    let out, err;
    try { out = await inflate(r.value); } catch (e) { err = e; }
    r = err ? gen.throw(err) : gen.next(out);
  }
  return r.value;
}

function* readPsdGen(bytes, opts) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const { warnings, notes, note } = makeNotes();
  if (r.b.length < 26 || r.str(4) !== '8BPS') psdError('psdNotPsd', {}, 'not a PSD file');
  const version = r.u16();
  if (version !== 1 && version !== 2) psdError('psdVersion', { version }, `unknown PSD version ${version}`);
  const big = version === 2, len = () => (big ? r.u64() : r.u32());
  r.p += 6;
  const channels = r.u16(); // of the merged image
  const height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
  if (depth !== 8 && depth !== 16) psdError('psdDepth', { depth }, `only 8- and 16-bit PSD is read (this one is ${depth}-bit); save it as 8- or 16-bit in the drawing app`);
  if (![1, 2, 3, 4, 8].includes(mode)) psdError('psdMode', { mode: MODES[mode] || String(mode) }, `colour mode ${MODES[mode] || mode} is not read; convert the picture to RGB in the drawing app`);
  if (depth === 16) note('psd16bit', {}, '16-bit PSD: read as 8-bit');
  if (mode === 4) note('psdCmyk', {}, 'CMYK PSD: the colours are turned into RGB simply (no colour profile), they may look a little different');
  let palette = null;
  try {
    const cmLen = r.u32();
    if (mode === 2 && cmLen >= 768) palette = r.b.slice(r.p, r.p + 768);
    r.p += cmLen; // colour mode data
    r.p += 4 + r.v.getUint32(r.p); // image resources
  } catch { psdError('psdTruncated', {}, 'the file is cut short (it may not have finished saving or downloading)'); }
  let lmEnd = r.p, layers = [];
  const ctx = { r, big, len, depth, mode, width, height, opts, warnings, notes, note, alpha: false, scale: opts.scaleFor ? opts.scaleFor(width, height) : 1 };
  try {
    lmEnd = (() => { const n = len(); return r.p + n; })();
    if (r.p < lmEnd) {
      const liLen = len(), liEnd = r.p + liLen;
      if (liLen > 0) layers = yield* readLayerInfo(ctx);
      if (opts.coverage) return { coverage: ctx.coverage ?? null };
      r.p = liEnd;
      // global layer mask info, then additional blocks: 16-bit files keep their layers in 'Lr16'
      if (r.p + 4 <= lmEnd) r.p += 4 + r.v.getUint32(r.p);
      while (!layers.length && r.p + 12 <= lmEnd) {
        const sig = r.str(4);
        if (sig !== '8BIM' && sig !== '8B64') break;
        const k = r.str(4), n = big && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(k) ? r.u64() : r.u32();
        const at = r.p;
        if (k === 'Lr16' || k === 'Layr') layers = yield* readLayerInfo(ctx);
        else if (k === 'Lr32') note('psd32bit', {}, '32-bit layers are not read');
        r.p = at + n + ((at + n) % 4 ? 4 - ((at + n) % 4) : 0);
      }
    }
  } catch (e) {
    if (e.psd) throw e;
    note('psdLayersBroken', {}, 'the layers could not be read (the file is broken or cut short): only the merged picture is read');
    layers = [];
  }
  // no layers (a flat picture, or broken layers): the merged picture as one layer
  if (!layers.length) {
    let img = null;
    try { r.p = lmEnd; img = yield* readComposite(r, { width, height, depth, mode, channels, palette, big, alpha: ctx.alpha, opts }); } catch (e) { if (e.psd) throw e; }
    if (img && ctx.scale < 1) img = scaleLayer(img, ctx.scale);
    if (img) { layers = [img]; note('psdFlatImage', {}, 'no layers: the merged picture is read as one layer', 'info'); }
    else note('psdNoLayers', {}, 'no layers found (a flat picture, or layers stored in a way not read yet)');
  }
  return { width, height, layers, scale: ctx.scale, warnings, notes };
}

const MODES = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };
// a PSD that can't be read at all: an Error with a code and values for the editor to word
function psdError(code, vars, text) { const e = new Error(text); e.code = code; e.vars = vars; e.psd = true; throw e; }

// samples of one channel (raw, RLE, ZIP, ZIP with prediction) -> 8-bit plane
function* readPlane(r, comp, cw, chh, bps, big, end, opts, counts) {
  const raw = new Uint8Array(Math.max(0, cw * chh * bps)), row = cw * bps;
  if (cw > 0 && chh > 0) {
    if (comp === 0) { if (r.p + raw.length > r.b.length) throw new Error('cut short'); raw.set(r.bytes(raw.length)); }
    else if (comp === 1) {
      if (!counts) { counts = []; for (let y = 0; y < chh; y++) counts.push(big ? r.u32() : r.u16()); }
      for (let y = 0; y < chh; y++) { if (r.p + counts[y] > r.b.length) throw new Error('cut short'); unpackBits(r.bytes(counts[y]), raw, y * row, row); }
    } else if (comp === 2 || comp === 3) {
      raw.set((yield r.bytes(end - r.p)).subarray(0, raw.length)); // the driver inflates it
      if (comp === 3 && bps === 1) for (let y = 0; y < chh; y++) for (let x = 1; x < cw; x++) raw[y * cw + x] = (raw[y * cw + x] + raw[y * cw + x - 1]) & 255;
      if (comp === 3 && bps === 2) for (let y = 0; y < chh; y++) for (let x = 1; x < cw; x++) { // deltas of 16-bit samples
        const o = 2 * (y * cw + x), v = (((raw[o] << 8) | raw[o + 1]) + ((raw[o - 2] << 8) | raw[o - 1])) & 0xffff;
        raw[o] = v >> 8; raw[o + 1] = v & 255;
      }
    } else throw new Error(`unknown channel compression ${comp}`);
  }
  if (bps === 1) return raw;
  const plane = new Uint8Array(cw * chh); // 16-bit samples -> 8-bit, rounded
  for (let i = 0; i < plane.length; i++) plane[i] = Math.round(((raw[2 * i] << 8) | raw[2 * i + 1]) / 257);
  return plane;
}

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
// colour planes -> RGBA (RGB, grayscale / duotone, CMYK (stored as 255 - ink), indexed)
function toRgba(planes, n, mode, palette, alpha) {
  const rgba = new Uint8Array(n * 4);
  // a missing plane reads as its "nothing" value (0, or no ink for CMYK); one tight loop per mode
  const plane = (c, v) => planes[c] && planes[c].length >= n ? planes[c] : new Uint8Array(n).fill(v);
  if (mode === 3 && LITTLE && rgba.byteOffset % 4 === 0) { // the common case: four bytes at once
    const r = plane(0, 0), g = plane(1, 0), b = plane(2, 0), a = alpha && alpha.length >= n ? alpha : null, out = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
    if (a) for (let i = 0; i < n; i++) out[i] = (r[i] | (g[i] << 8) | (b[i] << 16) | (a[i] << 24)) >>> 0;
    else for (let i = 0; i < n; i++) out[i] = (r[i] | (g[i] << 8) | (b[i] << 16) | (alpha ? 0 : 0xff000000)) >>> 0;
    if (a || !alpha) return rgba;
  } else if (mode === 3) {
    const r = plane(0, 0), g = plane(1, 0), b = plane(2, 0);
    for (let i = 0, o = 0; i < n; i++, o += 4) { rgba[o] = r[i]; rgba[o + 1] = g[i]; rgba[o + 2] = b[i]; }
  } else if (mode === 4) {
    const c = plane(0, 255), m = plane(1, 255), y = plane(2, 255), k = plane(3, 255);
    for (let i = 0, o = 0; i < n; i++, o += 4) { const kk = k[i]; rgba[o] = (c[i] * kk) / 255; rgba[o + 1] = (m[i] * kk) / 255; rgba[o + 2] = (y[i] * kk) / 255; }
  } else if (mode === 2 && palette) {
    const v = plane(0, 0);
    for (let i = 0, o = 0; i < n; i++, o += 4) { const q = v[i]; rgba[o] = palette[q]; rgba[o + 1] = palette[256 + q]; rgba[o + 2] = palette[512 + q]; }
  } else {
    const v = plane(0, 0);
    for (let i = 0, o = 0; i < n; i++, o += 4) { const q = v[i]; rgba[o] = q; rgba[o + 1] = q; rgba[o + 2] = q; }
  }
  if (alpha && alpha.length >= n) for (let i = 0, o = 3; i < n; i++, o += 4) rgba[o] = alpha[i];
  else if (alpha) for (let i = 0, o = 3; i < n; i++, o += 4) rgba[o] = alpha[i] ?? 0;
  else for (let o = 3; o < 4 * n; o += 4) rgba[o] = 255;
  return rgba;
}

// the merged picture at the end of the file, as one layer
function* readComposite(r, { width, height, depth, mode, channels, palette, big, alpha, opts }) {
  if (r.p + 2 > r.b.length || !width || !height) return null;
  const comp = r.u16(), bps = depth / 8, ncol = mode === 3 ? 3 : mode === 4 ? 4 : 1, n = width * height;
  const want = Math.min(channels, ncol + (alpha ? 1 : 0)), planes = [];
  if (comp === 1) { // all the row lengths first, every channel's
    const counts = []; for (let c = 0; c < channels * height; c++) counts.push(big ? r.u32() : r.u16());
    for (let c = 0; c < want; c++) planes.push(yield* readPlane(r, 1, width, height, bps, big, r.b.length, opts, counts.slice(c * height, (c + 1) * height)));
  } else if (comp === 0) for (let c = 0; c < want; c++) planes.push(yield* readPlane(r, 0, width, height, bps, big, r.b.length, opts));
  else { // ZIP: every channel in one stream
    const all = yield* readPlane(r, comp, width, height * channels, bps, big, r.b.length, opts);
    for (let c = 0; c < want; c++) planes.push(all.subarray(c * n, (c + 1) * n));
  }
  return { name: 'image', groupObjs: [], left: 0, top: 0, width, height, visible: true, opacity: 1, blend: 'normal', clipping: 0, kind: 'pixel', effects: false,
    rgba: toRgba(planes, n, mode, palette, want > ncol ? planes[ncol] : null) };
}

// the layer records and their channel data (Adobe: "Layer info"), from the layer count on
function* readLayerInfo(ctx) {
  const { r, big, len, depth, mode, width, height, opts, note, notes } = ctx;
  const layers = [], bps = depth / 8; // bytes per sample
  const signed = r.i16(), count = Math.abs(signed);
  ctx.alpha = signed < 0; // the merged picture's first extra channel is its transparency
  const recs = [];
  for (let i = 0; i < count; i++) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    const nch = r.u16(), channels = [];
    for (let c = 0; c < nch; c++) channels.push({ id: r.i16(), length: len() });
    if (r.str(4) !== '8BIM') throw new Error('bad layer record');
    const key = r.str(4).trim(), opacity = r.u8(), clipping = r.u8(), flags = r.u8();
    r.u8();
    const extraEnd = r.p + 4 + r.v.getUint32(r.p); r.p += 4;
    let mask = null;
    { // layer mask: box, colour outside the box, flags (2 = disabled)
      const n = r.u32(), at = r.p;
      if (n >= 18) { const t = r.i32(), l = r.i32(), b = r.i32(), rt = r.i32(); mask = { top: t, left: l, bottom: b, right: rt, outside: r.u8(), disabled: !!(r.u8() & 2) }; }
      r.p = at + n;
    }
    r.p += 4 + r.v.getUint32(r.p); // blending ranges
    const nameLen = r.u8();
    let name = new TextDecoder('latin1').decode(r.bytes(nameLen));
    r.p += (4 - ((nameLen + 1) % 4)) % 4;
    let section = 0, fill = 255, vector = null;
    const keys = new Set(), adjust = {}, fxBlocks = {};
    while (r.p + 12 <= extraEnd) {
      const sig = r.str(4);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const k = r.str(4);
      const n = big && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(k) ? r.u64() : r.u32();
      const at = r.p;
      keys.add(k);
      if ((k === 'lfx2' || k === 'lmfx') && !fxBlocks[k]) fxBlocks[k] = r.b.slice(at, at + n); // layer effects (tools/layer_effects.mjs reads them)
      if (ADJUSTMENT.includes(k) && !adjust[k]) adjust[k] = r.b.slice(at, at + n); // an adjustment layer's settings (tools/adjustments.mjs reads them)
      if (k === 'luni') { const c = r.u32(); let s = ''; for (let j = 0; j < c; j++) s += String.fromCharCode(r.u16()); name = s.replace(/\0+$/, ''); }
      else if (k === 'lsct' || k === 'lsdk') section = r.u32();
      else if (k === 'iOpa') fill = r.u8();
      else if (k === 'vmsk' || k === 'vsms') vector = readVectorMask(r, at + n, width, height);
      r.p = at + n;
    }
    r.p = extraEnd;
    recs.push({ top, left, bottom, right, channels, blend: BLEND[key] || key, opacity, clipping, visible: !(flags & 2), name, section, fill, mask, vector, kind: layerKind(keys), adjust, effects: keys.has('lfx2') || keys.has('lrFX') || keys.has('lmfx'), fxBytes: fxBlocks.lmfx || fxBlocks.lfx2 || null });
  }
  // where each record's channel data starts (they follow each other in record order)
  let at = r.p;
  for (const rec of recs) { rec.dataAt = at; at += rec.channels.reduce((sum, ch) => sum + ch.length, 0); rec.dataEnd = at; }
  const endAll = at;
  // folders: bottom first, a folder's end marker (3) comes before its layers, the folder (1, 2) after
  const stack = [];
  for (const rec of recs) {
    if (rec.section === 3) { stack.push({ name: '', visible: true, opacity: 255, blend: 'passThrough' }); continue; }
    rec.path = stack.slice();
    if (rec.section === 1 || rec.section === 2) {
      const g = stack.pop();
      if (g) Object.assign(g, { name: rec.name, visible: rec.visible, opacity: rec.opacity, blend: rec.blend, masks: rec }); // a folder's masks cut all its layers
    }
  }
  // the folders' masks first (their data comes after their layers'), then each layer on its own:
  // read, its masks, cut down, its folders' masks, scaled; only one layer's full-size pixels at a time
  const env = { bps, big, mode, scale: ctx.scale, opts };
  for (const rec of recs) if ((rec.section === 1 || rec.section === 2) && rec.mask && rec.channels.some((ch) => ch.id === -2)) yield* decodeRec(r, rec, true, env);
  if (opts.coverage) { // psdMaskCoverage: one layer's masks over a box, nothing else read
    const { index, left, top, width: cw, height: ch } = opts.coverage, rec = recs.filter((x) => !x.section)[index];
    if (!rec) return [];
    yield* decodeRec(r, rec, true, env);
    const box = { left, top, right: left + cw, bottom: top + ch, rgba: new Uint8Array(cw * ch * 4).fill(255) };
    applyMasks(box, rec);
    for (const g of rec.path) if (g.masks && (g.masks.maskPlane || g.masks.vector)) applyMasks(box, g.masks);
    ctx.coverage = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) ctx.coverage[i] = box.rgba[i * 4 + 3];
    return [];
  }
  const total = recs.filter((rec) => !rec.section).length, progress = opts.onProgress;
  let done = 0;
  for (const rec of recs) {
    if (rec.section) continue;
    const index = done++; // its place among the file's layers (folders not counted), kept when others are skipped
    if (progress) progress({ step: 'read', done: index, total }); // how far: the editor shows it
    const meta = { name: rec.name, groupObjs: rec.path, index };
    const rest = { visible: rec.visible, opacity: (rec.opacity / 255) * (rec.fill / 255), blend: rec.blend, clipping: rec.clipping, kind: rec.kind, effects: rec.effects };
    if (rec.fxBytes) Object.assign(rest, { fx: readEffects(rec.fxBytes), fill: rec.fill / 255, layerOpacity: rec.opacity / 255 }); // its effects, and its fill apart (the effects are not thinned by it)
    if (rec.kind === 'adjustment') { // its settings and what limits it (its mask, vector mask, its folders' masks): no pixels
      yield* decodeRec(r, rec, true, env);
      const masks = [{ mask: rec.mask, maskPlane: rec.maskPlane, vector: rec.vector }, ...rec.path.filter((g) => g.masks && (g.masks.maskPlane || g.masks.vector)).map((g) => g.masks)].filter((m) => m.maskPlane || m.vector);
      layers.push({ ...meta, left: 0, top: 0, width: 0, height: 0, ...rest, rgba: new Uint8Array(0), adjust: rec.adjust, adjustMasks: masks, scale: env.scale });
      rec.maskPlane = null;
      continue;
    }
    if (opts.within && !rec.fxBytes && !(rec.left < opts.within[2] && rec.right > opts.within[0] && rec.top < opts.within[3] && rec.bottom > opts.within[1])) {
      // replaceLayerPixels: only the layers over the area it draws again are read; the rest keep their place, no pixels
      layers.push({ ...meta, left: rec.left, top: rec.top, width: 0, height: 0, ...rest, rgba: new Uint8Array(0), outside: true });
      continue;
    }
    if (opts.jobs) { // importPsdParallel: the pixels are read elsewhere (layerJob, decodePsdLayer)
      layers.push({ ...meta, ...rest, job: layerJob(r, rec, env), noteAt: notes.length });
      continue;
    }
    const px = yield* layerPixels(r, rec, env);
    if (!px) { // named here, with its folders
      const where = [...rec.path.map((g) => g.name), rec.name].join('/');
      note('layerUnreadable', { layer: where }, `layer ${where}: its pixels could not be read (skipped)`);
      continue;
    }
    layers.push({ ...meta, left: px.left, top: px.top, width: px.width, height: px.height, ...rest, rgba: px.rgba });
  }
  if (progress && total) progress({ step: 'read', done: total, total });
  r.p = Math.min(endAll, r.b.length);
  return layers;
}

// one record's channels -> rec.rgba (and its pixel mask); a record that can't be read is left
// empty (and named). onlyMasks: a folder, whose own pixels are nothing
function* decodeRec(r, rec, onlyMasks, env) {
const { bps, big, mode, scale, opts } = env;
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  rec.rgba = new Uint8Array(0);
  if (rec.dataEnd > r.b.length || w < 0 || h < 0 || w * h > 4e8) { rec.broken = true; return; }
  r.p = rec.dataAt;
  try {
    const colour = [], n = w * h;
    let alpha = null;
    for (const ch of rec.channels) {
      const end = r.p + ch.length, isMask = ch.id < -1;
      if (onlyMasks && !isMask) { r.p = end; continue; }
      const cw = isMask && rec.mask ? rec.mask.right - rec.mask.left : w, chh = isMask && rec.mask ? rec.mask.bottom - rec.mask.top : h;
      const plane = yield* readPlane(r, r.u16(), cw, chh, bps, big, end, opts);
      r.p = end;
      if (isMask) { if (ch.id === -2 && rec.mask) rec.maskPlane = plane; continue; } // -3: the "real user mask" is not read
      if (ch.id === -1) alpha = plane;
      else if (ch.id >= 0 && ch.id < 4) colour[ch.id] = plane;
    }
    if (onlyMasks) return;
    // a big PSD's plain RGB layer (no masks of its own or its folders'): cut down and scaled
    // straight from its channels, without its full-size RGBA
    const masked = rec.maskPlane || rec.vector || rec.path.some((g) => g.masks && (g.masks.maskPlane || g.masks.vector));
    if (scale < 1 && mode === 3 && !masked && colour[0] && colour[1] && colour[2] && (!alpha || alpha.length >= n)) { rec.planes = { r: colour[0], g: colour[1], b: colour[2], a: alpha, w }; return; }
    rec.rgba = toRgba(colour, n, mode === 8 ? 1 : mode, null, alpha);
  } catch (e) {
    if (e.psd) throw e;
    rec.broken = true; rec.rgba = new Uint8Array(0);
  }
}

// one layer's pixels: read, its masks, cut down, its folders' masks, scaled (env.scale < 1).
// -> { left, top, width, height, rgba } or null (the pixels could not be read)
function* layerPixels(r, rec, env) {
  yield* decodeRec(r, rec, false, env);
  if (rec.broken) return null;
  if (rec.planes) { // the fast path: the box of the non-transparent pixels from the alpha plane
    const { a, w } = rec.planes, h = rec.bottom - rec.top;
    const box = a ? planeBox(a, w, h) : w && h ? [0, 0, w, h] : null;
    rec.planes.x0 = box ? box[0] : 0; rec.planes.y0 = box ? box[1] : 0;
    if (box) { rec.left += box[0]; rec.top += box[1]; rec.right = rec.left + box[2] - box[0]; rec.bottom = rec.top + box[3] - box[1]; }
    else { rec.right = rec.left; rec.bottom = rec.top; }
  } else {
    applyMasks(rec, rec); cropRec(rec);
    for (const g of rec.path) if (g.masks && (g.masks.maskPlane || g.masks.vector)) applyMasks(rec, g.masks);
  }
  let L = { left: rec.left, top: rec.top, width: Math.max(0, rec.right - rec.left), height: Math.max(0, rec.bottom - rec.top), rgba: rec.rgba };
  if (env.scale < 1 && L.width && L.height) L = scaleLayer(L, env.scale, rec.planes);
  else if (rec.planes) L.rgba = new Uint8Array(0);
  rec.rgba = null; rec.maskPlane = null; rec.planes = null;
  return L;
}

// a layer's work for decodePsdLayer (in a Worker): its channel data copied out of the file, its
// record and its folders' masks; `cost` is about the most bytes the work holds at once
function layerJob(r, rec, env) {
  const end = Math.min(rec.dataEnd, r.b.length);
  const bytes = Uint8Array.prototype.slice.call(r.b, Math.min(rec.dataAt, end), end).buffer; // a copy (a Node Buffer's slice is a view)
  const { top, left, bottom, right, channels, mask, vector, name } = rec;
  const folders = rec.path.filter((g) => g.masks && (g.masks.maskPlane || g.masks.vector))
    .map((g) => ({ masks: { mask: g.masks.mask, maskPlane: g.masks.maskPlane, vector: g.masks.vector } }));
  const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
  return { bytes, cut: rec.dataEnd > r.b.length, rec: { top, left, bottom, right, channels, mask, vector, name }, folders,
    env: { bps: env.bps, big: env.big, mode: env.mode, scale: env.scale }, kind: rec.kind, mesh: meshOptions(env.opts, env.scale), cost: w * h * (env.bps * 4 + 4) + bytes.byteLength };
}

/** A layer's pixels from a layerJob (see importPsdParallel); runs in a Worker as well. ZIP channels
 *  are inflated with opts.inflate (sync) or else DecompressionStream.
 *  Transferable: in the job only job.bytes (one ArrayBuffer, all the layer's channels); the folder
 *  masks in job.folders are shared by several jobs, so they are copied (structured clone). In the
 *  result only rgba.buffer (when rgba is not empty); tight and local are small.
 *  -> { left, top, width, height, rgba } or null (the pixels could not be read). */
export async function decodePsdLayer(job, opts = {}) {
  const b = new Uint8Array(job.bytes);
  const r = new Reader(b);
  const rec = { ...job.rec, path: job.folders, dataAt: 0, dataEnd: job.cut ? b.length + 1 : b.length };
  const px = await drive(layerPixels(r, rec, { ...job.env, opts }), opts);
  // and what importFromPsd would work out from the pixels: the box it keeps, the mesh in it
  if (px && job.mesh) {
    const { alphaMin, rim } = job.mesh;
    const tight = px.width && px.height ? opaqueBox(px.rgba, px.width, px.height, alphaMin) : null;
    px.tight = tight;
    if (tight && job.kind !== 'adjustment') px.local = localMesh(px, [tight[0] - rim, tight[1] - rim, tight[2] + rim, tight[3] + rim], job.mesh);
  }
  return px;
}

// the options importFromPsd builds the meshes with (decodePsdLayer builds them in a Worker)
function meshOptions(opts, scale) {
  const { spacing, cell, maxCells, mesh } = opts;
  return { spacing, cell, maxCells, mesh, alphaMin: opts.alphaMin || 8, margin: opts.margin ?? 2, rim: (opts.margin ?? 2) + 1, meshReduce: scale < 1 ? 2 : 1 };
}

// the box [x0, y0, x1, y1] of the non-zero samples of a w x h plane (null if none)
function planeBox(a, w, h) {
  let y0 = 0, y1 = h;
  const rowHas = (y) => { for (let i = y * w, e = i + w; i < e; i++) if (a[i]) return true; return false; };
  while (y0 < h && !rowHas(y0)) y0++;
  if (y0 === h) return null;
  while (!rowHas(y1 - 1)) y1--;
  let x0 = w, x1 = 0;
  for (let y = y0; y < y1; y++) {
    const o = y * w;
    for (let x = 0; x < x0; x++) if (a[o + x]) { x0 = x; break; }
    for (let x = w - 1; x >= x1; x--) if (a[o + x]) { x1 = x + 1; break; }
  }
  return [x0, y0, x1, y1];
}

// a layer's pixels cut down to where any is not fully transparent (big canvases: layers are
// often stored canvas-sized), its box moved with them
function cropRec(rec) {
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  if (w <= 0 || h <= 0) return;
  const b = opaqueBox(rec.rgba, w, h, 1);
  if (!b) { rec.rgba = new Uint8Array(0); rec.right = rec.left; rec.bottom = rec.top; return; }
  const [x0, y0, x1, y1] = b;
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return;
  const out = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(rec.rgba.subarray((y * w + x0) * 4, (y * w + x1) * 4), (y - y0) * (x1 - x0) * 4);
  rec.rgba = out; rec.left += x0; rec.top += y0; rec.right = rec.left + x1 - x0; rec.bottom = rec.top + y1 - y0;
}

// a layer scaled by s (< 1) on the canvas grid: each new pixel the area-weighted mean of the
// pixels it covers (premultiplied, so transparent pixels don't darken the edges). Each old row
// is resampled across once and added to the one to three new rows it falls in.
function scaleLayer(L, s, planes = null) {
  const X0 = Math.floor(L.left * s), Y0 = Math.floor(L.top * s), X1 = Math.ceil((L.left + L.width) * s), Y1 = Math.ceil((L.top + L.height) * s);
  const W = Math.max(0, X1 - X0), H = Math.max(0, Y1 - Y0), out = new Uint8Array(W * H * 4);
  const LW = L.width, LH = L.height;
  // per new column: the old columns in it and how much of each (a flat list; xa[X] is where X's start)
  const xa = new Int32Array(W + 1), wts = [], wx = [];
  for (let X = 0; X < W; X++) {
    const a = (X + X0) / s, b = (X + X0 + 1) / s;
    const i0 = Math.max(0, Math.floor(a) - L.left), i1 = Math.min(LW, Math.ceil(b) - L.left);
    xa[X] = wx.length;
    for (let i = i0; i < i1; i++) {
      const p = (i + L.left) * s, q = (i + 1 + L.left) * s;
      const w = Math.max(0, Math.min(q, X + X0 + 1) - Math.max(p, X + X0));
      if (w > 0) { wx.push(i); wts.push(w); }
    }
  }
  xa[W] = wx.length;
  const WX = Int32Array.from(wx), WT = Float64Array.from(wts);
  // per old row: the first new row it falls in, and how much of it in that one and the next two
  const share = (n, offset, start) => {
    const first = new Int32Array(n), parts = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i + offset) * s, b = (i + 1 + offset) * s, k0 = Math.floor(a);
      first[i] = k0 - start;
      for (let j = 0; j < 3; j++) parts[i * 3 + j] = Math.max(0, Math.min(b, k0 + j + 1) - Math.max(a, k0 + j));
    }
    return { first, parts };
  };
  const cy = share(LH, L.top, Y0);
  const line = new Float64Array(W * 4);
  const rows = new Map(), spare = [];
  const flush = (Y) => {
    const r = rows.get(Y), o0 = Y * W * 4;
    for (let X = 0, q = 0; X < W; X++, q += 4) {
      const a = r[q + 3], o = o0 + q;
      if (a > 0) { const ia = 1 / a; out[o] = Math.round(r[q] * ia); out[o + 1] = Math.round(r[q + 1] * ia); out[o + 2] = Math.round(r[q + 2] * ia); out[o + 3] = a >= 255 ? 255 : Math.round(a); }
    }
    rows.delete(Y); spare.push(r.fill(0)); // rows are reused: a big layer would otherwise make thousands of them
  };
  // the pixels: interleaved RGBA (L.rgba), or (planes) separate R, G, B, A planes of a wider
  // picture, L's box starting at planes.x0, planes.y0 in it (a big PSD's layer, read straight off its channels)
  const src = L.rgba, P = planes, PR = P?.r, PG = P?.g, PB = P?.b, PA = P?.a, PW = P?.w;
  let next = 0;
  for (let y = 0; y < LH; y++) {
    let lo = W, hi = -1;
    if (P) {
      const po = (y + P.y0) * PW + P.x0;
      for (let X = 0; X < W; X++) {
        let r = 0, g = 0, b = 0, al = 0;
        for (let k = xa[X], e = xa[X + 1]; k < e; k++) {
          const i = po + WX[k], a = PA ? PA[i] : 255;
          if (!a) continue;
          const w = WT[k] * a;
          r += PR[i] * w; g += PG[i] * w; b += PB[i] * w; al += w;
        }
        if (al) { const q = X * 4; line[q] = r; line[q + 1] = g; line[q + 2] = b; line[q + 3] = al; if (lo > X) lo = X; hi = X; }
      }
    } else {
      const o = y * LW * 4;
      for (let X = 0; X < W; X++) {
        let r = 0, g = 0, b = 0, al = 0;
        for (let k = xa[X], e = xa[X + 1]; k < e; k++) {
          const i = o + WX[k] * 4, a = src[i + 3];
          if (!a) continue;
          const w = WT[k] * a;
          r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; al += w;
        }
        if (al) { const q = X * 4; line[q] = r; line[q + 1] = g; line[q + 2] = b; line[q + 3] = al; if (lo > X) lo = X; hi = X; }
      }
    }
    const k = cy.first[y];
    for (; next < k; next++) if (rows.has(next)) flush(next);
    if (hi < lo) continue; // a fully transparent row adds nothing
    for (let j = 0; j < 3; j++) {
      const w = cy.parts[y * 3 + j], Y = k + j;
      if (!w || Y < 0 || Y >= H) continue;
      let r = rows.get(Y);
      if (!r) { r = spare.pop() || new Float64Array(W * 4); rows.set(Y, r); }
      for (let q = lo * 4, e = (hi + 1) * 4; q < e; q++) r[q] += line[q] * w;
    }
    line.fill(0, lo * 4, (hi + 1) * 4);
  }
  for (const Y of [...rows.keys()].sort((p, q) => p - q)) flush(Y);
  return { ...L, left: X0, top: Y0, width: W, height: H, rgba: out };
}

// alpha x a layer's or folder's masks (the pixel mask, in canvas space in its own box, and the vector mask)
function applyMasks(rec, from) {
  const w = rec.right - rec.left, h = rec.bottom - rec.top, m = from.mask;
  if (w <= 0 || h <= 0) return;
  if (from.maskPlane && !m.disabled) {
    const mw = m.right - m.left;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cx = x + rec.left - m.left, cy = y + rec.top - m.top;
      const v = cx >= 0 && cy >= 0 && cx < mw && cy < m.bottom - m.top ? from.maskPlane[cy * mw + cx] : m.outside;
      const i = (y * w + x) * 4 + 3;
      rec.rgba[i] = (rec.rgba[i] * v + 127) / 255;
    }
  }
  if (from.vector && !from.vector.disabled) {
    const cov = rasterizePaths(from.vector, rec.left, rec.top, w, h);
    for (let i = 0; i < w * h; i++) rec.rgba[i * 4 + 3] = Math.round((rec.rgba[i * 4 + 3] * cov[i]) / 255);
  }
}

// ---- vector masks ('vmsk' / 'vsms'): Bézier paths, in parts of the canvas (fixed point 8.24) ----
function readVectorMask(r, end, width, height) {
  r.u32(); // version
  const flags = r.u32(), subpaths = [];
  let cur = null, startFilled = false;
  while (r.p + 26 <= end) {
    const type = r.u16(), at = r.p;
    if (type === 0 || type === 3) { cur = { closed: type === 0, knots: [] }; subpaths.push(cur); }
    else if (type === 1 || type === 2 || type === 4 || type === 5) {
      const pt = () => { const y = r.i32() / 2 ** 24, x = r.i32() / 2 ** 24; return [x * width, y * height]; };
      const before = pt(), anchor = pt(), after = pt();
      if (cur) cur.knots.push({ before, anchor, after });
    } else if (type === 8) startFilled = r.u16() === 1;
    r.p = at + 24;
  }
  return { subpaths, invert: !!(flags & 1), disabled: !!(flags & 4), startFilled };
}

// coverage (0..255) of the paths over a w x h box at (left, top): flattened Béziers, non-zero
// winding, 4 x 4 samples per pixel
function rasterizePaths(vec, left, top, w, h) {
  const edges = [];
  for (const sp of vec.subpaths) {
    const k = sp.knots, n = k.length;
    if (n < 2) continue;
    const pts = [];
    for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
      const a = k[i], b = k[(i + 1) % n];
      for (let s = 0; s < 16; s++) {
        const t = s / 16, u = 1 - t;
        pts.push([u * u * u * a.anchor[0] + 3 * u * u * t * a.after[0] + 3 * u * t * t * b.before[0] + t * t * t * b.anchor[0],
          u * u * u * a.anchor[1] + 3 * u * u * t * a.after[1] + 3 * u * t * t * b.before[1] + t * t * t * b.anchor[1]]);
      }
    }
    if (!sp.closed) pts.push(k[n - 1].anchor);
    for (let i = 0; i < pts.length; i++) edges.push([pts[i], pts[(i + 1) % pts.length]]); // open paths are closed for filling
  }
  const S = 4, cov = new Uint8Array(w * h), hits = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let sy = 0; sy < S; sy++) {
    const py = top + y + (sy + 0.5) / S, xs = [];
    for (const [[x0, y0], [x1, y1]] of edges) {
      if ((y0 <= py) === (y1 <= py)) continue;
      xs.push([x0 + ((py - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    const row = new Float32Array(w);
    for (let sx = 0; sx < S; sx++) {
      let wind = 0, j = 0;
      for (let x = 0; x < w; x++) {
        const px = left + x + (sx + 0.5) / S;
        while (j < xs.length && xs[j][0] <= px) wind += xs[j++][1];
        let inside = wind !== 0;
        if (vec.startFilled) inside = !inside;
        if (vec.invert) inside = !inside;
        if (inside) row[x]++;
      }
    }
    for (let x = 0; x < w; x++) hits[y * w + x] += row[x];
  }
  for (let i = 0; i < w * h; i++) cov[i] = Math.round((hits[i] * 255) / (S * S));
  return cov;
}

// mesh over the opaque pixels: a grid of `cell`-sized squares, keeping the squares that hold any
function gridMesh(rgba, w, h, box, cell, alphaMin) {
  const [x0, y0, x1, y1] = box, nx = Math.ceil((x1 - x0) / cell), ny = Math.ceil((y1 - y0) / cell);
  const used = new Uint8Array(nx * ny);
  const sx0 = Math.max(0, x0), sx1 = Math.min(w, x1), col = new Int32Array(Math.max(0, sx1 - sx0));
  for (let x = sx0; x < sx1; x++) col[x - sx0] = Math.floor((x - x0) / cell);
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const row = Math.floor((y - y0) / cell) * nx;
    for (let x = sx0, i = (y * w + sx0) * 4 + 3; x < sx1; x++, i += 4) if (rgba[i] >= alphaMin) used[row + col[x - sx0]] = 1;
  }
  const index = new Map(), verts = [], tris = [];
  const vtx = (i, j) => {
    const k = j * (nx + 1) + i;
    if (!index.has(k)) { index.set(k, verts.length / 2); verts.push(Math.min(x1, x0 + i * cell), Math.min(y1, y0 + j * cell)); }
    return index.get(k);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (used[j * nx + i]) {
    const a = vtx(i, j), b = vtx(i + 1, j), c = vtx(i + 1, j + 1), d = vtx(i, j + 1);
    tris.push(a, b, c, a, c, d);
  }
  return { verts, tris };
}

// ---- contour mesh ------------------------------------------------------------------------
// Points on the outline of the opaque pixels (grown by `margin`), spaced about spacing / 2,
// plus a grid of inner points `spacing` apart; Delaunay triangles whose centre is inside.
// Every opaque pixel is checked to be covered; where one is not, points are added around it.

function delaunay(pts) { // Bowyer-Watson; pts = [x0, y0, x1, y1, ...] -> triangle index list
  const n = pts.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, pts[2 * i]); maxX = Math.max(maxX, pts[2 * i]); minY = Math.min(minY, pts[2 * i + 1]); maxY = Math.max(maxY, pts[2 * i + 1]); }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 10, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const P = [...pts, cx - d, cy - d, cx + d, cy - d, cx, cy + d];
  const circ = (a, b, c) => {
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], qx = P[2 * c], qy = P[2 * c + 1];
    const D = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - qy) + (bx * bx + by * by) * (qy - ay) + (qx * qx + qy * qy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (qx - bx) + (bx * bx + by * by) * (ax - qx) + (qx * qx + qy * qy) * (bx - ax)) / D;
    return [ux, uy, (ax - ux) ** 2 + (ay - uy) ** 2];
  };
  // Every triangle ever made keeps its number; the ones still alive, in number order, are the
  // list the plain algorithm keeps (it drops the bad ones in place and appends the new ones).
  // To find the triangles whose circle holds a point, each circle is listed in the cells of a
  // grid it overlaps (circles over many cells go in one list looked at every time).
  const T = [], alive = [], N = n + 3;
  const G = Math.max(1, Math.ceil(Math.sqrt(n))), gw = Math.max(maxX - minX, 1e-9) / G, gh = Math.max(maxY - minY, 1e-9) / G;
  const cells = Array.from({ length: G * G }, () => []), big = [];
  const make = (a, b, c) => {
    const [ux, uy, r2] = circ(a, b, c), id = T.length;
    T.push([a, b, c, ux, uy, r2]); alive.push(true);
    const r = Math.sqrt(r2 * (1 + 1e-9)) * (1 + 1e-6) + 1e-6;
    const i0 = Math.max(0, Math.floor((ux - r - minX) / gw)), i1 = Math.min(G - 1, Math.floor((ux + r - minX) / gw));
    const j0 = Math.max(0, Math.floor((uy - r - minY) / gh)), j1 = Math.min(G - 1, Math.floor((uy + r - minY) / gh));
    if (!(i1 >= i0 && j1 >= j0)) return; // the circle misses every point
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 16) big.push(id);
    else for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * G + i].push(id);
  };
  make(n, n + 1, n + 2);
  const bad = [];
  for (let i = 0; i < n; i++) {
    const x = P[2 * i], y = P[2 * i + 1], edges = new Map();
    const ci = Math.min(G - 1, Math.max(0, Math.floor((x - minX) / gw))), cj = Math.min(G - 1, Math.max(0, Math.floor((y - minY) / gh)));
    bad.length = 0;
    for (const list of [cells[cj * G + ci], big]) {
      let w = 0;
      for (let m = 0; m < list.length; m++) {
        const id = list[m];
        if (!alive[id]) continue; // dead ones leave the list
        list[w++] = id;
        const t = T[id];
        if ((x - t[3]) ** 2 + (y - t[4]) ** 2 < t[5] * (1 + 1e-9)) bad.push(id);
      }
      list.length = w;
    }
    bad.sort((p, q) => p - q);
    for (const id of bad) {
      const t = T[id];
      alive[id] = false;
      for (let e = 0; e < 3; e++) { // the edge's key: its two corners, smaller first
        const a = t[e], b = t[e === 2 ? 0 : e + 1], k = a < b ? a * N + b : b * N + a;
        edges.set(k, edges.has(k) ? null : [a, b]);
      }
    }
    for (const e of edges.values()) if (e) make(e[0], e[1], i);
  }
  const out = [];
  for (let id = 0; id < T.length; id++) {
    const t = T[id];
    if (!alive[id] || !(t[0] < n && t[1] < n && t[2] < n)) continue;
    const area = (P[2 * t[1]] - P[2 * t[0]]) * (P[2 * t[2] + 1] - P[2 * t[0] + 1]) - (P[2 * t[2]] - P[2 * t[0]]) * (P[2 * t[1] + 1] - P[2 * t[0] + 1]);
    if (Math.abs(area) > 1e-9) out.push(t[0], t[1], t[2]);
  }
  return out;
}

function contourMesh(rgba, w, h, box, { spacing = 24, alphaMin = 8, margin = 2, maxPoints = Infinity } = {}) {
  const [x0, y0, x1, y1] = box, bw = x1 - x0, bh = y1 - y0;
  spacing = Math.min(spacing, Math.max(6, Math.min(bw, bh) / 2.5)); // small pictures: finer
  const solid = new Uint8Array(bw * bh);
  { // the box's pixels inside the layer, row by row
    const sx0 = Math.max(0, x0), sx1 = Math.min(w, x1);
    for (let ly = Math.max(0, y0); ly < Math.min(h, y1); ly++) {
      const row = (ly - y0) * bw - x0;
      for (let lx = sx0, i = (ly * w + sx0) * 4 + 3; lx < sx1; lx++, i += 4) if (rgba[i] >= alphaMin) solid[row + lx] = 1;
    }
  }
  const grow = (src, r) => { // square dilation, rows then columns: 1 where any pixel within r is
    const a = new Uint8Array(bw * bh), b = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const o = y * bw;
      let last = -Infinity; // the last set pixel at or before x + r
      for (let x = 0; x < bw; x++) {
        if (x + r < bw && src[o + x + r]) last = x + r;
        else if (x === 0) for (let k = Math.min(bw - 1, r); k >= 0; k--) if (src[o + k]) { last = k; break; }
        if (last >= x - r) a[o + x] = 1;
      }
    }
    const last = new Float64Array(bw).fill(-Infinity); // per column: the last set row at or before y + r
    for (let k = 0; k <= Math.min(bh - 1, r); k++) for (let x = 0; x < bw; x++) if (a[k * bw + x]) last[x] = k;
    for (let y = 0; y < bh; y++) {
      if (y + r < bh) { const o = (y + r) * bw; for (let x = 0; x < bw; x++) if (a[o + x]) last[x] = y + r; }
      const o = y * bw;
      for (let x = 0; x < bw; x++) if (last[x] >= y - r) b[o + x] = 1;
    }
    return b;
  };
  const mask = grow(solid, margin), inMask = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && mask[y * bw + x] === 1;
  // the mask with a ring of 0 around it, so corners can be counted without bounds checks
  const PW = bw + 2, padded = new Uint8Array(PW * (bh + 2));
  for (let y = 0; y < bh; y++) padded.set(mask.subarray(y * bw, (y + 1) * bw), (y + 1) * PW + 1);
  // points, kept apart with a hash of cells
  const pts = [], cellSize = Math.max(1, spacing / 2);
  // a grid of cells (one ring more on every side), each a list of the points in it
  const CW = Math.floor(bw / cellSize) + 4, cells = new Array(CW * (Math.floor(bh / cellSize) + 4));
  const cellOf = (i, j) => (j + 1) * CW + i + 1;
  const near = (x, y, r) => {
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize), k = Math.ceil(r / cellSize), r2 = r * r;
    for (let j = cy - k; j <= cy + k; j++) for (let i = cx - k; i <= cx + k; i++) {
      const list = i >= -1 && j >= -1 && i < CW - 1 ? cells[cellOf(i, j)] : undefined;
      if (list) for (let m = 0; m < list.length; m++) { const q = list[m]; if ((pts[2 * q] - x) ** 2 + (pts[2 * q + 1] - y) ** 2 < r2) return true; }
    }
    return false;
  };
  const add = (x, y, r) => {
    if (r > 0 && near(x, y, r)) return;
    if (r === 0 && near(x, y, 0.01)) return;
    const c = cellOf(Math.floor(x / cellSize), Math.floor(y / cellSize));
    (cells[c] ||= []).push(pts.length / 2); pts.push(x, y);
  };
  // outline: pixel corners where the mask meets the outside; outer corners first (1 of the 4
  // pixels inside), then inner corners (3), then straight runs (2), so shapes keep their corners
  const outline = [], byCount = [null, [], [], []]; // corners with 1, 2 or 3 of their 4 pixels inside, in row order
  for (let y = 0; y <= bh; y++) for (let x = 0, o = y * PW; x <= bw; x++, o++) { // pixels (x - 1, y - 1) .. (x, y) are padded (x, y) .. (x + 1, y + 1)
    const c = padded[o] + padded[o + 1] + padded[o + PW] + padded[o + PW + 1];
    if (c > 0 && c < 4) byCount[c].push(x, y);
  }
  for (const want of [1, 3, 2]) { const list = byCount[want]; for (let k = 0; k < list.length; k += 2) { outline.push(list[k], list[k + 1]); add(list[k], list[k + 1], spacing / 2); } }
  // the outline points by cell, in outline order, for finding the nearest one (a line drawing has hundreds of
  // thousands: looking through all of them for each uncovered pixel took minutes)
  const OG = 8, OCW = Math.floor(bw / OG) + 1, OCH = Math.floor(bh / OG) + 1, ocells = new Array(OCW * OCH);
  for (let k = 0; k < outline.length; k += 2) (ocells[Math.min(OCH - 1, Math.floor(outline[k + 1] / OG)) * OCW + Math.min(OCW - 1, Math.floor(outline[k] / OG))] ||= []).push(k);
  const nearestOutline = (x, y) => { // the nearest outline point not already a point (the first in outline order of equals), or -1
    const cx = Math.min(OCW - 1, Math.floor(x / OG)), cy = Math.min(OCH - 1, Math.floor(y / OG)), far = Math.max(cx, OCW - 1 - cx, cy, OCH - 1 - cy);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= far; r++) {
      for (let j = cy - r; j <= cy + r; j++) {
        if (j < 0 || j >= OCH) continue;
        const step = j === cy - r || j === cy + r ? 1 : 2 * r; // the ring only
        for (let i = cx - r; i <= cx + r; i += step || 1) {
          const list = i >= 0 && i < OCW ? ocells[j * OCW + i] : undefined;
          if (!list) continue;
          let keep = 0;
          for (let m = 0; m < list.length; m++) {
            const k = list[m];
            // already a point: it stays one (points are only added), so it leaves the list for good
            if (near(outline[k], outline[k + 1], 0.01)) continue;
            list[keep++] = k;
            const d = (outline[k] - x) ** 2 + (outline[k + 1] - y) ** 2;
            if (d < bd || (d === bd && k < best)) { bd = d; best = k; }
          }
          list.length = keep;
        }
      }
      if (bd < (r * OG) ** 2) break; // anything further out is further away than this
    }
    return best;
  };
  // inside: a grid, away from the outline
  for (let y = spacing / 2; y < bh; y += spacing) for (let x = spacing / 2; x < bw; x += spacing)
    if (inMask(Math.floor(x), Math.floor(y))) add(x, y, spacing / 2);

  for (let round = 0; round < 8; round++) {
    if (pts.length > maxPoints) return null; // more points than the caller would take: it uses the grid (points are only added)
    const tris = pts.length >= 6 ? delaunay(pts) : [], kept = [];
    for (let t = 0; t < tris.length; t += 3) {
      const cx = (pts[2 * tris[t]] + pts[2 * tris[t + 1]] + pts[2 * tris[t + 2]]) / 3, cy = (pts[2 * tris[t] + 1] + pts[2 * tris[t + 1] + 1] + pts[2 * tris[t + 2] + 1]) / 3;
      if (inMask(Math.floor(cx), Math.floor(cy))) kept.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    // which opaque pixel centres are covered
    const cover = new Uint8Array(bw * bh);
    for (let t = 0; t < kept.length; t += 3) {
      const ax = pts[2 * kept[t]], ay = pts[2 * kept[t] + 1], bx = pts[2 * kept[t + 1]], by = pts[2 * kept[t + 1] + 1], qx = pts[2 * kept[t + 2]], qy = pts[2 * kept[t + 2] + 1];
      for (let y = Math.max(0, Math.floor(Math.min(ay, by, qy))); y < Math.min(bh, Math.ceil(Math.max(ay, by, qy))); y++)
        for (let x = Math.max(0, Math.floor(Math.min(ax, bx, qx))); x < Math.min(bw, Math.ceil(Math.max(ax, bx, qx))); x++) {
          if (cover[y * bw + x] || !solid[y * bw + x]) continue; // only opaque pixels are asked about
          const px = x + 0.5, py = y + 0.5; // which side of each edge (the same sums as before, written out)
          const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d2 = (qx - bx) * (py - by) - (qy - by) * (px - bx), d3 = (ax - qx) * (py - qy) - (ay - qy) * (px - qx);
          if ((d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) || (d1 <= 1e-9 && d2 <= 1e-9 && d3 <= 1e-9)) cover[y * bw + x] = 1;
        }
    }
    const missing = [];
    for (let i = 0; i < bw * bh; i++) if (solid[i] && !cover[i]) missing.push(i);
    if (!missing.length) return { verts: pts.map((v, i) => v + (i % 2 ? y0 : x0)), tris: kept };
    // add the outline point nearest to each uncovered pixel (later rounds: the corners of the
    // grown square around it, which lie inside the mask)
    for (const i of missing) {
      const x = i % bw + 0.5, y = (i - (i % bw)) / bw + 0.5;
      if (round < 4) {
        const best = nearestOutline(x, y);
        if (best >= 0) add(outline[best], outline[best + 1], 0);
        if (pts.length > maxPoints) return null;
      } else {
        const px = Math.floor(x), py = Math.floor(y);
        for (const [cx, cy] of [[px - margin, py - margin], [px + 1 + margin, py - margin], [px + 1 + margin, py + 1 + margin], [px - margin, py + 1 + margin]])
          add(Math.min(bw, Math.max(0, cx)), Math.min(bh, Math.max(0, cy)), 0);
      }
    }
  }
  return null; // could not cover: the caller falls back to the grid
}

/** Mesh for one layer of importPsd()'s result (layer-local pixels -> model and atlas coordinates).
 *  opts: mesh ('auto': the contour mesh unless it needs 1.5 times the grid's vertices; 'contour' | 'grid' | 'none': the picture's rectangle, 4 points), spacing (px, default 24;
 *  pictures wider or taller than maxCells (default 48) x spacing get a wider spacing), alphaMin, margin (px grown around the
 *  picture, default 2), plus atlasWidth, atlasHeight, originX, originY (from the result). */
export function meshFromLayer(layer, opts) {
  if (opts.atlases) opts = { ...opts, atlas: opts.atlases[layer.atlas.page || 0] }; // the layer's atlas page
  if (!layer.rgba) layer = layerFromAtlas(layer, opts.atlas); // saved meta (no pixels): read them back from the atlas
  const { atlasWidth: AW = opts.atlas?.width, atlasHeight: AH = opts.atlas?.height, originX: ox, originY: oy } = opts, a = layer.atlas;
  const box = [a.left - layer.left, a.top - layer.top, a.left - layer.left + a.width, a.top - layer.top + a.height];
  const m = opts.local || localMesh(layer, box, opts); // importPsdParallel: made with the pixels, in a Worker
  const spacing = m.spacing;
  const vertices = [], uvs = [];
  for (let i = 0; i < m.verts.length; i += 2) {
    const lx = m.verts[i], ly = m.verts[i + 1];
    vertices.push(layer.left + lx - ox, layer.top + ly - oy);
    uvs.push(...atlasUv(a, lx - box[0], ly - box[1], AW, AH));
  }
  return { vertices, uvs, triangles: m.tris, spacing };
}

// a picture's mesh in its own pixels: box (in them) is its area in the atlas -> { verts (in the
// layer's pixels), tris, spacing }. The part of meshFromLayer that needs no atlas
function localMesh(layer, box, opts) {
  // mesh 'none': the area's rectangle, 4 points (a mesh is built later, when one is wanted)
  if (opts.mesh === 'none') return { verts: [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]], tris: [0, 1, 2, 0, 2, 3], spacing: opts.spacing || opts.cell || 24 };
  // big pictures (a full-canvas background on a 8000 px canvas) get a coarser mesh: at most
  // about maxCells cells across, so the mesh stays light to draw and quick to build
  const want = opts.spacing || opts.cell || 24, maxCells = opts.maxCells || 48;
  const spacing = Math.max(want, Math.ceil(Math.max(box[2] - box[0], box[3] - box[1]) / maxCells)), alphaMin = opts.alphaMin || 8;
  // a coarser mesh is built on a smaller copy of the picture (each q x q block opaque if any of
  // its pixels is), then scaled back: the outline is then q px coarse, and q x q times quicker
  const q = Math.max(1, Math.floor(spacing / want), opts.meshReduce || 1); // meshReduce: a big PSD's outlines at a coarser grain
  let src = layer.rgba, sw = layer.width, sh = layer.height, sbox = box, margin = opts.margin ?? 2;
  if (q > 1) {
    sw = Math.ceil((box[2] - box[0]) / q); sh = Math.ceil((box[3] - box[1]) / q); sbox = [0, 0, sw, sh]; margin = Math.max(1, Math.ceil(margin / q));
    src = new Uint8Array(sw * sh * 4);
    for (let y = Math.max(0, box[1]); y < Math.min(layer.height, box[3]); y++) for (let x = Math.max(0, box[0]); x < Math.min(layer.width, box[2]); x++) {
      const v = layer.rgba[(y * layer.width + x) * 4 + 3], k = ((((y - box[1]) / q) | 0) * sw + (((x - box[0]) / q) | 0)) * 4 + 3;
      if (v > src[k]) src[k] = v;
    }
  }
  const g = gridMesh(src, sw, sh, sbox, spacing / q, alphaMin), grid = { verts: g.verts, tris: g.tris };
  // 'auto' takes the contour mesh only with at most 1.5 times the grid's points: past that it can stop building it
  let m = opts.mesh === 'grid' ? null : contourMesh(src, sw, sh, sbox, { spacing: spacing / q, alphaMin, margin, maxPoints: opts.mesh === 'contour' ? Infinity : 1.5 * grid.verts.length });
  // thin or ragged pictures (lines, combs) can need many outline points: the grid is lighter there
  if (!m || (opts.mesh !== 'contour' && m.verts.length > 1.5 * grid.verts.length)) m = grid;
  if (q > 1) m = { tris: m.tris, verts: m.verts.map((v, i) => Math.min(box[i % 2 ? 3 : 2], box[i % 2] + v * q)) };
  return { verts: m.verts, tris: m.tris, spacing };
}

/** A layer's description without its pixels, safe to keep as JSON with the document
 *  (meshFromLayer can then take it with opts.atlas = { width, height, rgba }). */
export function layerMeta(layer) {
  const { rgba, ...meta } = layer;
  return JSON.parse(JSON.stringify(meta));
}

// the pixels of a layer's atlas area, as a layer of its own (the area is the picture + its rim)
function layerFromAtlas(meta, atlas) {
  if (!atlas) throw new Error('meshFromLayer: the layer has no pixels; pass opts.atlas = { width, height, rgba }');
  const a = meta.atlas, rgba = new Uint8Array(a.width * a.height * 4);
  if (a.angle) { // turned by a.angle in the atlas: read back by the inverse turn (nearest pixel; the mesh needs only the shape)
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const [qx, qy] = angledPoint(a, x + 0.5, y + 0.5), X = Math.floor(qx), Y = Math.floor(qy);
      if (X < 0 || Y < 0 || X >= a.atlasArea[0] || Y >= a.atlasArea[1]) continue;
      const s = ((a.y + Y) * atlas.width + a.x + X) * 4, o = (y * a.width + x) * 4;
      for (let k = 0; k < 4; k++) rgba[o + k] = atlas.rgba[s + k];
    }
  } else if (!a.turned) for (let y = 0; y < a.height; y++) rgba.set(atlas.rgba.subarray(((a.y + y) * atlas.width + a.x) * 4, ((a.y + y) * atlas.width + a.x + a.width) * 4), y * a.width * 4);
  else { // turned 90° clockwise in the atlas: the area's (x, y) is the atlas's (a.x + height - 1 - y, a.y + x)
    const out = new Uint32Array(rgba.buffer), src = new Uint32Array(atlas.rgba.buffer, atlas.rgba.byteOffset, atlas.rgba.length >> 2);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) out[y * a.width + x] = src[(a.y + x) * atlas.width + a.x + a.height - 1 - y];
  }
  return { ...meta, left: a.left, top: a.top, width: a.width, height: a.height, rgba };
}

/** A layer's pixels read back from its atlas page, in the PSD's own pixels: for writing them back
 *  (replaceLayerPixels in tools/psd_add_layer.mjs takes the result as it is).
 *  meta: one of importPsd's layers (or layerMeta of it); atlas: its page { width, height, rgba }
 *  (straight alpha: the page as importPsd gives it, or the editor's redrawn copy);
 *  opts.scale: the import's scale (importPsd's `scale`; below 1 when a big PSD was read smaller).
 *  -> { left, top, width, height, rgba } in PSD coordinates. A picture lying turned 90° comes back
 *  upright as it was; one turned by its own angle (atlasAnyAngle) and a scaled one are resampled
 *  (bilinear, colours weighted by their transparency), so they come back close, not exact. */
export function layerPixelsFromAtlas(meta, atlas, opts = {}) {
  const a = meta.atlas, scale = opts.scale ?? 1;
  if (!a || !atlas?.rgba) throw new Error('layerPixelsFromAtlas: needs the layer\'s atlas box and its page { width, height, rgba }');
  // the area in the import's pixels, upright
  let area;
  if (!a.angle) area = layerFromAtlas(meta, atlas).rgba;
  else {
    area = new Uint8Array(a.width * a.height * 4);
    const [cw, ch] = a.atlasArea;
    const page = (X, Y, k) => (X < 0 || Y < 0 || X >= cw || Y >= ch ? 0 : atlas.rgba[((a.y + Y) * atlas.width + a.x + X) * 4 + k]);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const [qx, qy] = angledPoint(a, x + 0.5, y + 0.5);
      sample(page, qx - 0.5, qy - 0.5, area, (y * a.width + x) * 4);
    }
  }
  if (scale === 1) return { left: a.left, top: a.top, width: a.width, height: a.height, rgba: area };
  // back to the PSD's size: each PSD pixel's middle, in the import's pixels
  const left = Math.floor(a.left / scale), top = Math.floor(a.top / scale);
  const width = Math.ceil((a.left + a.width) / scale) - left, height = Math.ceil((a.top + a.height) / scale) - top;
  const rgba = new Uint8Array(width * height * 4), w = a.width, h = a.height;
  const src = (X, Y, k) => (X < 0 || Y < 0 || X >= w || Y >= h ? 0 : area[(Y * w + X) * 4 + k]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    sample(src, (left + x + 0.5) * scale - a.left - 0.5, (top + y + 0.5) * scale - a.top - 0.5, rgba, (y * width + x) * 4);
  return { left, top, width, height, rgba };
}
// bilinear: at(X, Y, k) -> a channel; colours weighted by their transparency (no dark rims)
function sample(at, sx, sy, out, o) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
  const wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy], P = [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
  let r = 0, g = 0, b = 0, al = 0;
  for (let k = 0; k < 4; k++) {
    const t = at(P[k][0], P[k][1], 3) * wts[k];
    if (!t) continue;
    r += at(P[k][0], P[k][1], 0) * t; g += at(P[k][0], P[k][1], 1) * t; b += at(P[k][0], P[k][1], 2) * t; al += t;
  }
  if (!(al > 0)) return;
  out[o] = Math.round(r / al); out[o + 1] = Math.round(g / al); out[o + 2] = Math.round(b / al); out[o + 3] = Math.round(al);
}

// a point (lx, ly) of a picture's area (in its pixels, from the area's corner) -> its UV on the
// atlas page (AW x AH): straight, or turned 90° clockwise (atlas.turned)
function atlasUv(a, lx, ly, AW, AH) {
  if (a.angle) { const [qx, qy] = angledPoint(a, lx, ly); return [(a.x + qx) / AW, (a.y + qy) / AH]; }
  return a.turned ? [(a.x + a.height - ly) / AW, (a.y + lx) / AH] : [(a.x + lx) / AW, (a.y + ly) / AH];
}
// a picture turned by a.angle degrees about its area's middle (atlasAnyAngle): its area's (lx, ly)
// -> the point in its turned copy (a.atlasArea = [width, height, x, y]: the copy's size, and where
// the area's middle lands in it)
function angledPoint(a, lx, ly) {
  const t = (a.angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), dx = lx - a.width / 2, dy = ly - a.height / 2;
  return [c * dx - s * dy + a.atlasArea[2], s * dx + c * dy + a.atlasArea[3]];
}

// the turn (degrees) that makes the box around the opaque pixels of `rgba` (w x h) smallest: the
// convex hull of the pixels' corners, and each of its edges laid flat (rotating calipers) ->
// { angle, w, h, box: [x0, y0, x1, y1] } of the turned opaque box, about (cx, cy)
// (angle 0 if no turn of 1° or more beats it)
function bestAngle(rgba, w, h, alphaMin, cx, cy) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4) if (rgba[i] >= alphaMin) { if (x0 < 0) x0 = x; x1 = x; }
    if (x0 >= 0) pts.push([x0, y], [x0, y + 1], [x1 + 1, y], [x1 + 1, y + 1]);
  }
  if (pts.length < 3) return { angle: 0, w, h, box: [0, 0, w, h] };
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const boxAt = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of hull) { const X = c * (x - cx) - s * (y - cy), Y = s * (x - cx) + c * (y - cy); if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
    return [x1 - x0, y1 - y0, [x0, y0, x1, y1]];
  };
  const b0 = boxAt(0);
  let best = { angle: 0, w: b0[0], h: b0[1], box: b0[2] };
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    let t = -Math.atan2(by - ay, bx - ax); // lays this edge flat
    t -= Math.round(t / (Math.PI / 2)) * (Math.PI / 2); // within ±45°: a quarter turn more is the same box
    const [bw, bh, rb] = boxAt(t);
    if (Math.abs(t) * 180 / Math.PI >= 1 && bw * bh < best.w * best.h) best = { angle: (t * 180) / Math.PI, w: bw, h: bh, box: rb };
  }
  return best;
}

// the picture (rgba, w x h) turned by `angle` degrees about its middle into a new one of tw x th,
// its middle landing at (mx, my) (bilinear, on premultiplied colours, so the edges do not darken)
function turnPicture(rgba, w, h, angle, tw, th, mx, my) {
  const t = (angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), out = new Uint8Array(tw * th * 4);
  const at = (x, y, k) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : rgba[(y * w + x) * 4 + k]);
  for (let Y = 0; Y < th; Y++) for (let X = 0; X < tw; X++) {
    // the source point of this pixel's middle (the inverse turn)
    const dx = X + 0.5 - mx, dy = Y + 0.5 - my, sx = c * dx + s * dy + w / 2 - 0.5, sy = -s * dx + c * dy + h / 2 - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    if (x0 < -1 || y0 < -1 || x0 >= w || y0 >= h) continue;
    const wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy], P = [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < 4; k++) {
      const al = at(P[k][0], P[k][1], 3) * wts[k];
      if (!al) continue;
      r += at(P[k][0], P[k][1], 0) * al; g += at(P[k][0], P[k][1], 1) * al; b += at(P[k][0], P[k][1], 2) * al; a += al;
    }
    if (!(a > 0)) continue;
    const o = (Y * tw + X) * 4;
    out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a);
  }
  return out;
}

const opaqueBox = (rgba, w, h, alphaMin) => {
  const hit = (x, y) => rgba[(y * w + x) * 4 + 3] >= alphaMin;
  let y0 = 0, y1 = h;
  const rowHas = (y) => { for (let i = y * w * 4 + 3, e = (y + 1) * w * 4; i < e; i += 4) if (rgba[i] >= alphaMin) return true; return false; };
  while (y0 < h && !rowHas(y0)) y0++;
  if (y0 === h) return null;
  while (!rowHas(y1 - 1)) y1--;
  // columns: each row only needs looking at outside the box found so far
  let x0 = w, x1 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < x0; x++) if (hit(x, y)) { x0 = x; break; }
    for (let x = w - 1; x >= x1; x--) if (hit(x, y)) { x1 = x + 1; break; }
  }
  return [x0, y0, x1, y1];
};

// give fully transparent pixels the colour of their opaque neighbours (alpha stays 0), so
// filtering at the edges does not pull in black
function bleed(rgba, w, h, passes, area = [0, 0, w, h]) {
  const X0 = Math.max(0, area[0]), Y0 = Math.max(0, area[1]), X1 = Math.min(w, area[2]), Y1 = Math.min(h, area[3]), aw = X1 - X0, ah = Y1 - Y0;
  if (aw <= 0 || ah <= 0) return;
  const done = new Uint8Array(aw * ah), seen = new Uint8Array(aw * ah);
  let add = new Int32Array(64), n = 0;
  const push = (i) => { if (n === add.length) { const b = new Int32Array(2 * n); b.set(add); add = b; } add[n++] = i; };
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) done[(y - Y0) * aw + x - X0] = rgba[(y * w + x) * 4 + 3] > 0 ? 1 : 0;
  // the first pass looks at every pixel; later ones only around the pixels the pass before filled
  for (let y = 0, i = 0; y < ah; y++) for (let x = 0; x < aw; x++, i++)
    if (!done[i] && ((x > 0 && done[i - 1] === 1) || (x + 1 < aw && done[i + 1] === 1) || (y > 0 && done[i - aw] === 1) || (y + 1 < ah && done[i + aw] === 1))) push(i);
  for (let pass = 0; pass < passes && n; pass++) {
    const colours = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) {
      const i = add[k], x = i % aw, y = (i - x) / aw;
      let r = 0, g = 0, b = 0, c = 0, j;
      if (x + 1 < aw && done[i + 1] === 1) { j = ((Y0 + y) * w + X0 + x + 1) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
      if (x > 0 && done[i - 1] === 1) { j = ((Y0 + y) * w + X0 + x - 1) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
      if (y + 1 < ah && done[i + aw] === 1) { j = ((Y0 + y + 1) * w + X0 + x) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
      if (y > 0 && done[i - aw] === 1) { j = ((Y0 + y - 1) * w + X0 + x) * 4; r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; c++; }
      colours[3 * k] = r / c; colours[3 * k + 1] = g / c; colours[3 * k + 2] = b / c;
    }
    for (let k = 0; k < n; k++) {
      const i = add[k], x = i % aw, j = ((Y0 + (i - x) / aw) * w + X0 + x) * 4;
      rgba[j] = colours[3 * k]; rgba[j + 1] = colours[3 * k + 1]; rgba[j + 2] = colours[3 * k + 2];
      done[i] = 1;
    }
    if (pass + 1 >= passes) break;
    // the next pass: the not yet filled neighbours of what was just filled
    const last = add.subarray(0, n).slice();
    n = 0;
    for (const i of last) {
      const x = i % aw, y = (i - x) / aw;
      for (const q of [x + 1 < aw ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < ah ? i + aw : -1, y > 0 ? i - aw : -1])
        if (q >= 0 && !done[q] && seen[q] !== pass + 1) { seen[q] = pass + 1; push(q); }
    }
  }
}

/** Pack rectangles (shelves, tallest first) into pages of at most maxSize x maxSize.
 *  -> { pages: [{ width, height }], at: [[x, y, page], ...] } */
// The pictures (w x h each, `pad` px apart and from the edges) on atlas pages up to maxSize:
// MaxRects (each picture into the free rectangle it fits best, the free rectangles kept as they
// are cut), tried with three rules and the page widths from the pictures' up to maxSize; the
// fewest pages, then the least area, wins. With turn, a picture may lie turned 90° clockwise
// (its pixels moved as they are: nothing is resampled). -> { pages: [{ width, height }], at: [[x, y, page, turned]] }
function pack(sizes, pad, maxSize, { turn = false, upright = null } = {}) {
  const canTurn = (i) => turn && !upright?.has(i);
  const n = sizes.length, wide = Math.max(...sizes.map(([w, h], i) => (canTurn(i) ? Math.min(w, h) : w) + 2 * pad));
  const order = sizes.map((_, i) => i).sort((a, b) => Math.max(...sizes[b]) - Math.max(...sizes[a]) || sizes[b][0] * sizes[b][1] - sizes[a][0] * sizes[a][1] || a - b);
  const RULES = ['bssf', 'baf', 'bl'];
  const page1 = (left, W, H, rule) => { // one page: the pictures of `left` that fit, in turn
    let free = [[pad, pad, W, H]]; // [x0, y0, x1, y1]: a picture takes w + pad by h + pad
    const placed = new Map(), rest = [];
    for (const i of left) {
      let best = null;
      for (const t of canTurn(i) && sizes[i][0] !== sizes[i][1] ? [0, 1] : [0]) {
        const w = sizes[i][t] + pad, h = sizes[i][1 - t] + pad;
        for (const f of free) {
          const fw = f[2] - f[0], fh = f[3] - f[1];
          if (w > fw || h > fh) continue;
          const s1 = rule === 'bssf' ? Math.min(fw - w, fh - h) : rule === 'baf' ? fw * fh - w * h : f[1] + h;
          const s2 = rule === 'bssf' ? Math.max(fw - w, fh - h) : rule === 'baf' ? Math.min(fw - w, fh - h) : f[0];
          if (!best || s1 < best[0] || (s1 === best[0] && s2 < best[1])) best = [s1, s2, f[0], f[1], w, h, t];
        }
      }
      if (!best) { rest.push(i); continue; }
      const [, , x, y, w, h, t] = best;
      placed.set(i, [x, y, t]);
      const cut = [];
      for (const f of free) {
        if (x >= f[2] || x + w <= f[0] || y >= f[3] || y + h <= f[1]) { cut.push(f); continue; }
        if (x > f[0]) cut.push([f[0], f[1], x, f[3]]);
        if (x + w < f[2]) cut.push([x + w, f[1], f[2], f[3]]);
        if (y > f[1]) cut.push([f[0], f[1], f[2], y]);
        if (y + h < f[3]) cut.push([f[0], y + h, f[2], f[3]]);
      }
      // drop the free rectangles inside another (of two equal ones, keep the first)
      free = cut.filter((r, k) => !cut.some((o, j) => j !== k && o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3]
        && (j < k || o[0] !== r[0] || o[1] !== r[1] || o[2] !== r[2] || o[3] !== r[3])));
    }
    return { placed, rest };
  };
  const tryOne = (W, rule) => {
    const at = [], pages = [];
    let left = order;
    while (left.length) {
      const { placed, rest } = page1(left, W, maxSize, rule);
      if (!placed.size) { // a picture taller than a page: on a page of its own
        const i = left[0], [w, h] = sizes[i];
        at[i] = [pad, pad, pages.length, false]; pages.push({ width: Math.max(W, w + 2 * pad), height: h + 2 * pad }); left = left.slice(1); continue;
      }
      let height = 0;
      for (const [i, [x, y, t]] of placed) { at[i] = [x, y, pages.length, !!t]; height = Math.max(height, y + sizes[i][t ? 0 : 1] + pad); }
      pages.push({ width: W, height });
      left = rest;
    }
    return { pages, at, area: pages.reduce((sum, p) => sum + p.width * p.height, 0) };
  };
  const widths = [];
  for (let W = 64; W < maxSize; W *= 2) if (W >= wide) widths.push(W);
  widths.push(Math.max(maxSize, wide));
  let best = null;
  for (const W of widths) for (const rule of n > 400 ? ['bssf'] : RULES) { // many pictures: one rule (the time stays near linear in the widths)
    const r = tryOne(W, rule);
    if (!best || r.pages.length < best.pages.length || (r.pages.length === best.pages.length && r.area < best.area)) best = r;
  }
  return best;
}

/** PSD bytes -> { model, atlas: { width, height, rgba }, groups, layers, warnings, notes }.
 *  notes: the warnings as { code, vars, level, text } (tools/notes.mjs), for the editor to word.
 *  opts: spacing (mesh point spacing in px, default 24), mesh ('auto' | 'contour' | 'grid' | 'none': each part the
 *  rectangle of its picture, 4 points), margin (px of
 *  transparent edge kept around each picture, default 2), alphaMin (1..255, default 8), padding (atlas, default 2),
 *  atlasName (default 'atlas.png'), maxAtlasSize (default 4096), maxCanvas (canvases larger than this are
 *  scaled down to it; default 4080, 0 = never; the result's `scale` says by how much), scale (a fixed scale, over
 *  maxCanvas: pass the first import's `scale` when reading a redrawn PSD again; 1 = never scaled), inflate (for ZIP layers),
 *  groupBones (a bone per group, its parts bound to it; default: every part on the root bone),
 *  atlasTurn (false: no picture lies turned 90° in the atlas), atlasAnyAngle (true: slanted pictures are turned by their best
 *  angle and resampled, a smaller atlas but slightly blurred pictures; default off),
 *  atlasPage ('tight' (default: as small as the pictures need) | 'pow2' (each side a power of two) | 'square' (a power-of-two
 *  square), for engines and GPUs that want such sizes. Every picture keeps a transparent rim (margin) whose colour is
 *  bled from its edge, so no picture's edge needs extruding),
 *  keepPixels (layers[].rgba: default kept unless the PSD is scaled down), onProgress({ step: 'read' | 'mesh',
 *  done, total }) (called before each layer is read and each picture is placed and meshed, and once at each step's end). */
export function importPsd(bytes, opts = {}) {
  return importFromPsd(readPsd(bytes, { ...opts, scaleFor: (w, h) => canvasScale(w, h, opts) }), opts);
}

/** importPsd in the browser: ZIP channels are inflated with DecompressionStream, the PSD is read once. */
export async function importPsdAsync(bytes, opts = {}) {
  return importFromPsd(await readPsdAsync(bytes, { ...opts, scaleFor: (w, h) => canvasScale(w, h, opts) }), opts);
}

/** importPsdAsync with the layers' pixels read side by side: run(job) -> Promise of
 *  decodePsdLayer(job) (the editor runs it in a pool of Workers; job.bytes can be transferred,
 *  and so can the result's rgba). The PSD is read once; the layers are handed out in order, with
 *  no more than opts.maxInFlightBytes (default 512 MiB, counted as the layers' full-size pixels)
 *  out at a time. Same result as importPsdAsync. Without run, the layers are read here one by one. */
export async function importPsdParallel(bytes, opts = {}, run = null) {
  run ||= (job) => decodePsdLayer(job, opts);
  const psd = await readPsdAsync(bytes, { ...opts, onProgress: null, jobs: true, scaleFor: (w, h) => canvasScale(w, h, opts) });
  const pending = psd.layers.filter((L) => L.job);
  if (pending.length) {
    const limit = opts.maxInFlightBytes ?? 512 * 2 ** 20, total = pending.length, progress = opts.onProgress;
    let next = 0, finished = 0, inFlight = 0;
    if (progress) progress({ step: 'read', done: 0, total });
    await new Promise((resolve, reject) => {
      let failed = false;
      const pump = () => {
        if (failed) return;
        if (finished === total) { resolve(); return; }
        while (next < total && (inFlight === 0 || inFlight + pending[next].job.cost <= limit)) {
          const L = pending[next++], cost = L.job.cost;
          inFlight += cost;
          Promise.resolve().then(() => run(L.job)).then((px) => { L.px = px || null; }, (e) => {
            if (e && e.psd) { failed = true; reject(e); }
            L.px = null; // read as a layer whose pixels could not be read
          }).then(() => {
            inFlight -= cost; finished++;
            if (progress && !failed) progress({ step: 'read', done: finished, total });
            pump();
          });
        }
      };
      pump();
    });
    // in the file's order, with the notes of unreadable layers where reading them one by one puts them
    const out = [], late = [];
    for (const L of psd.layers) {
      if (!L.job) { out.push(L); continue; }
      const { job, noteAt, px, ...meta } = L;
      L.px = null; // only `out` holds the pixels now, so importFromPsd can let go of them
      if (!px) { const where = [...meta.groupObjs.map((g) => g.name), meta.name].join('/'); late.push([noteAt, where]); continue; }
      const { visible, opacity, blend, clipping, kind, effects, fx, fill, layerOpacity } = meta;
      out.push({ name: meta.name, groupObjs: meta.groupObjs, index: meta.index, left: px.left, top: px.top, width: px.width, height: px.height, visible, opacity, blend, clipping, kind, effects, ...(fx !== undefined ? { fx, fill, layerOpacity } : {}), rgba: px.rgba, tight: px.tight, local: px.local });
    }
    if (!out.length) return importPsdAsync(bytes, opts); // nothing readable: the merged picture instead (read again)
    for (let i = late.length - 1; i >= 0; i--) {
      const [at, where] = late[i], text = `layer ${where}: its pixels could not be read (skipped)`;
      psd.notes.splice(at, 0, { code: 'layerUnreadable', vars: { layer: where }, level: 'warn', text });
      psd.warnings.splice(at, 0, text);
    }
    psd.layers = out;
  }
  return importFromPsd(psd, opts);
}

// canvases larger than 4080 px are scaled down, so a canvas-sized picture fits a 4096 atlas page
// (the model is then in the scaled pixels); opts.maxCanvas sets the limit, 0 keeps the size;
// opts.scale fixes it (reading a redrawn PSD again at the first import's scale)
/** Layers read from another layered file (tools/import_layers.mjs: Krita, OpenRaster, a set of PNG):
 *  doc = { width, height, layers (bottom first, as readPsd gives them: name, groupObjs, left, top, width,
 *  height, visible, opacity 0..1, blend, clipping, kind, rgba), notes } -> the same as importPsd. */
export function importLayerStack(doc, opts = {}) {
  const s = canvasScale(doc.width, doc.height, opts);
  const layers = s < 1 ? doc.layers.map((L) => (L.width && L.height ? scaleLayer(L, s) : L)) : doc.layers;
  return importFromPsd({ ...doc, layers, notes: doc.notes || [], scale: s }, opts);
}
function canvasScale(w, h, opts) {
  const limit = opts.maxCanvas ?? 4080, fixed = opts.scale > 0 ? Math.min(1, opts.scale) : 0;
  return fixed || (limit > 0 && Math.max(w, h) > limit ? limit / Math.max(w, h) : 1);
}

// Clipped layers with a blend mode Ugo9 does not draw (overlay, soft light, colour dodge, hue...):
// painted into their base layer's pixels, as Photoshop draws a clipping group ("blend clipped layers
// as group": each over the base's own colours, the base's transparency kept). They move with their
// base, so the picture holds when it moves. The clipped layers below the last such one are painted
// in too (the order of the group stays right); the ones above it stay parts of their own.
// -> the layers painted in (skipped by the import), with a note each
// Layer effects (tools/layer_effects.mjs): painted into the pixels of the layers that have them, on a box
// grown to hold them, after adjustments and clipped layers (a clip group's effects follow its base's
// shape). The layer keeps its opacity; its fill thins its own pixels only. -> L.effectsPainted
function bakeEffects(layers, baked, k) {
  for (const L of layers) {
    if (!L.fx || baked.has(L) || L.kind === 'adjustment' || !L.rgba || !L.width || !L.height) continue;
    const { effects, skipped } = L.fx;
    if (!effects.length) { L.effectsPainted = { kinds: [], close: false, skipped }; continue; }
    const r = paintEffects(L, L.fx, k, L.fill ?? 1);
    Object.assign(L, { left: r.left, top: r.top, width: r.width, height: r.height, rgba: r.rgba, tight: undefined, local: undefined });
    if (L.layerOpacity !== undefined) L.opacity = L.layerOpacity;
    L.effectsPainted = { kinds: r.kinds, close: r.close, skipped };
  }
}

function bakeClipped(layers, note) {
  const baked = new Set();
  const folderOf = (L) => L.groupObjs[L.groupObjs.length - 1] || null;
  for (let i = 0; i < layers.length; i++) {
    const B = layers[i];
    if (B.clipping || B.kind === 'adjustment' || !B.rgba || !B.width || !B.height) continue;
    let end = i + 1;
    while (end < layers.length && layers[end].clipping && folderOf(layers[end]) === folderOf(B)) end++;
    const shown = (L) => L.visible && L.kind !== 'adjustment' && L.rgba && L.width && L.height;
    let last = -1;
    for (let k = i + 1; k < end; k++) if (shown(layers[k]) && !RUNTIME_BLENDS.has(layers[k].blend) && BLEND_FUNCTIONS[layers[k].blend]) last = k;
    if (last < 0) continue;
    const clips = layers.slice(i + 1, last + 1).filter(shown), W = B.width, rgba = B.rgba;
    for (let y = 0; y < B.height; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, ab = rgba[o + 3] / 255;
      if (!ab) continue;
      let c = [rgba[o] / 255, rgba[o + 1] / 255, rgba[o + 2] / 255], a = ab;
      for (const S of clips) {
        const sx = B.left + x - S.left, sy = B.top + y - S.top;
        if (sx < 0 || sy < 0 || sx >= S.width || sy >= S.height) continue;
        const q = (sy * S.width + sx) * 4, as = (S.rgba[q + 3] / 255) * S.opacity;
        if (!as) continue;
        const cs = [S.rgba[q] / 255, S.rgba[q + 1] / 255, S.rgba[q + 2] / 255], f = BLEND_FUNCTIONS[S.blend] || BLEND_FUNCTIONS.normal, m = f(c, cs), ao = as + a - as * a;
        c = c.map((cb, k) => (as * (1 - a) * cs[k] + as * a * m[k] + (1 - as) * a * cb) / ao);
        a = ao;
      }
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.max(0, Math.min(255, Math.round(c[k] * 255)));
    }
    const baseWhere = [...B.groupObjs.map((g) => g.name), B.name].join('/');
    for (const S of clips) {
      baked.add(S);
      const where = [...S.groupObjs.map((g) => g.name), S.name].join('/');
      note('layerBlendBaked', { layer: where, base: baseWhere, blend: S.blend }, `layer ${where}: ${S.blend}, clipped to ${baseWhere}: painted into ${baseWhere}`, 'info');
    }
  }
  return baked;
}

// Adjustment layers (levels, curves, hue / saturation, colour balance, brightness / contrast,
// invert): applied to the pixels of the layers they reach, before the import: clipped, the clip
// group below them (its base and the clipped layers under them); else every layer below them in
// their folder (and below the folder too where it passes through); limited by their own masks and
// their folders' masks, at their opacity. Each layer is changed on its own (not the pictures
// together): the same where layers do not overlap half-transparently. -> notes; the layers' pixels change
function bakeAdjustments(layers, note) {
  const folderOf = (L) => L.groupObjs[L.groupObjs.length - 1] || null;
  for (let i = 0; i < layers.length; i++) {
    const A = layers[i];
    if (A.kind !== 'adjustment') continue;
    const where = [...A.groupObjs.map((g) => g.name), A.name].join('/');
    const adj = A.adjustment || (A.adjust && adjustment(A.adjust)); // read elsewhere (a Krita filter layer) or from the PSD's blocks
    if (!adj) { note('layerAdjustment', { layer: where }, `layer ${where}: adjustment layers are not applied (skipped); merge it into the layers below in the drawing app`); continue; }
    if (!A.visible || A.groupObjs.some((g) => !g.visible) || !(A.opacity > 0)) continue;
    // the layers it reaches
    const targets = [];
    if (A.clipping) {
      let k = i - 1;
      while (k >= 0 && layers[k].clipping && folderOf(layers[k]) === folderOf(A)) { targets.push(layers[k]); k--; }
      if (k >= 0 && folderOf(layers[k]) === folderOf(A)) targets.push(layers[k]);
    } else {
      // up through the folders that pass through: the scope is the first one that does not
      let scope = A.groupObjs.length;
      while (scope > 0 && A.groupObjs[scope - 1].blend === 'passThrough') scope--;
      const inScope = (L) => scope === 0 || L.groupObjs[scope - 1] === A.groupObjs[scope - 1];
      for (let k = 0; k < i; k++) if (inScope(layers[k])) targets.push(layers[k]);
    }
    let n = 0;
    for (const L of targets) {
      if (L.kind === 'adjustment' || !L.rgba || !L.width || !L.height) continue;
      // its masks, over this layer's box (in the PSD's pixels: the layers may be read smaller)
      const s = A.scale || 1, box = { left: Math.floor(L.left / s), top: Math.floor(L.top / s), right: Math.ceil((L.left + L.width) / s), bottom: Math.ceil((L.top + L.height) / s) };
      let cover = null;
      if (A.adjustMasks?.length) {
        const bw = box.right - box.left, bh = box.bottom - box.top, fake = { ...box, rgba: new Uint8Array(bw * bh * 4).fill(255) };
        for (const m of A.adjustMasks) applyMasks(fake, m);
        cover = (x, y) => { const X = Math.min(bw - 1, Math.floor((L.left + x) / s) - box.left), Y = Math.min(bh - 1, Math.floor((L.top + y) / s) - box.top); return (fake.rgba[(Y * bw + X) * 4 + 3] / 255) * A.opacity; };
      }
      applyAdjustment(adj, L.rgba, L.width, L.height, cover || (() => A.opacity));
      n++;
    }
    note('layerAdjustmentBaked', { layer: where, kind: adj.kind, layers: n, exact: adj.exact }, `layer ${where}: ${adj.kind} applied to the pixels of ${n} layer(s) below it${adj.exact ? '' : ' (close to Photoshop, not exact)'}`, 'info');
  }
}

function importFromPsd(psd, opts) {
  const atlasName = (i) => { const n = opts.atlasName || 'atlas.png'; return i ? n.replace(/(\.png)?$/i, `_${i + 1}.png`) : n; };
  const alphaMin = opts.alphaMin || 8, rim = (opts.margin ?? 2) + 1, padding = opts.padding ?? 2;
  const { warnings, notes, note } = makeNotes();
  for (const n of psd.notes) note(n.code, n.vars, n.text, n.level);
  const maxSize = opts.maxAtlasSize || opts.maxAtlasWidth || 4096, limit = opts.maxCanvas ?? 4080;
  const fixed = opts.scale > 0 ? Math.min(1, opts.scale) : 0;
  const scale = psd.scale ?? 1; // the layers are scaled already (as they were read)
  if (fixed && Math.max(psd.width, psd.height) * scale > 4080)
    note('psdLargeCanvas', { width: Math.round(psd.width * scale), height: Math.round(psd.height * scale) }, `the canvas is ${Math.round(psd.width * scale)}x${Math.round(psd.height * scale)} at the fixed scale: larger than 4080 px, its pictures may need several atlas pages`, 'info');
  if (scale < 1) {
    note('psdScaledDown', { scale: +scale.toFixed(4), width: Math.round(psd.width * scale), height: Math.round(psd.height * scale), fromWidth: psd.width, fromHeight: psd.height },
      `the canvas ${psd.width}x${psd.height} is larger than ${limit} px: imported at ${(scale * 100).toFixed(1)}% (${Math.round(psd.width * scale)}x${Math.round(psd.height * scale)})`, 'info');
  }
  const W = Math.round(psd.width * scale), H = Math.round(psd.height * scale), ox = W / 2, oy = H; // model origin: bottom centre of the canvas

  // ids: layer name, numbered when repeated; groups likewise
  const taken = new Set(opts.groupBones ? ['root'] : []), unique = (name) => { let id = name || 'layer', k = 2; while (taken.has(id)) id = `${name}_${k++}`; taken.add(id); return id; };
  const groupIds = new Map(), groups = [];
  const groupOf = (objs) => {
    let parent = null;
    for (const g of objs) {
      if (!groupIds.has(g)) { const id = unique(boneTag(g.name).name); groupIds.set(g, id); groups.push({ id, name: g.name, parent, parts: [], visible: g.visible, opacity: g.opacity / 255, blend: g.blend }); }
      parent = groupIds.get(g);
    }
    return parent;
  };

  // clipping: a clipped layer is drawn only inside the nearest unclipped layer below it in the
  // same folder (its base); that becomes the part's mask (format 0.4)
  // A folder can be the base too (the clipped layer sits right above it): then the clipped layer is
  // drawn inside all the folder's unclipped layers. opts.clipping false: no masks (clipped layers
  // drawn as they are, as before format 0.4)
  const kept = [], baseIn = new Map(), keptOf = new Map(), seenFolder = new Set(), saidBlend = new Set(), clipOn = opts.clipping !== false;
  const BLEND_OF = { normal: 'normal', passThrough: 'normal', multiply: 'multiply', screen: 'screen', add: 'add' };
  const keptInFolder = (g) => kept.filter((e) => !e.L.clipping && e.L.groupObjs.includes(g));
  // clipped layers in blend modes Ugo9 does not draw: painted into their base (opts.bakeBlends false: drawn as normal, as before)
  // adjustment layers: applied to the pixels below them (opts.bakeAdjustments false: skipped with a note, as before)
  // [メッシュ=…] / [mesh=…]: the layer's own (else its innermost tagged folder's) mesh style; a mesh made ahead in a
  // worker with the import's style is then not used
  const meshOf = (L) => {
    const own = meshTag(L.name) || [...L.groupObjs].reverse().map((g) => meshTag(g.name)).find(Boolean);
    return own ? { mesh: own } : { local: L.local };
  };
  // [無視] / [ignore]: the layer, or everything in the folder, is not read
  const tagged = (n, kind) => nameTags(n).tags.some((t) => t.kind === kind);
  {
    const gone = psd.layers.filter((L) => tagged(L.name, 'ignore') || L.groupObjs.some((g) => tagged(g.name, 'ignore')));
    if (gone.length) {
      psd = { ...psd, layers: psd.layers.filter((L) => !gone.includes(L)) };
      note('psdTagIgnored', { count: gone.length, layers: gone.map((L) => [...L.groupObjs.map((g) => g.name), L.name].join('/')).slice(0, 8).join(', ') }, `${gone.length} layer(s) tagged [無視] / [ignore] (or in such a folder) not read`, 'info');
    }
  }
  if (opts.bakeAdjustments !== false) bakeAdjustments(psd.layers, note);
  const baked = opts.bakeBlends === false || opts.clipping === false ? new Set() : bakeClipped(psd.layers, note);
  if (opts.bakeEffects !== false) bakeEffects(psd.layers, baked, scale);
  // [結合] / [merge] folders: their layers drawn together (as the drawing app shows the folder) into one layer, which
  // takes the folder's place, name, opacity, blend and visibility (the outermost tagged folder when they nest)
  {
    const folders = [...new Set(psd.layers.flatMap((L) => L.groupObjs))].filter((g) => tagged(g.name, 'merge'));
    let layers = psd.layers;
    for (const g of folders) {
      const inside = layers.filter((L) => L.groupObjs.includes(g) && !baked.has(L));
      if (!inside.length || inside[0].groupObjs.slice(0, inside[0].groupObjs.indexOf(g)).some((o) => folders.includes(o))) continue; // inside another merged folder
      const depth = inside[0].groupObjs.indexOf(g), sub = inside.map((L) => ({ ...L, groupObjs: L.groupObjs.slice(depth + 1) }));
      const shown = sub.filter((L) => L.visible && L.rgba && L.width && L.height && L.kind !== 'adjustment');
      const at = layers.indexOf(inside[0]);
      layers = layers.filter((L) => !inside.includes(L));
      if (!shown.length) { note('psdTagMerged', { folder: g.name, layers: inside.length }, `folder ${g.name} [merge]: nothing shown in it (left out)`, 'info'); continue; }
      const x0 = Math.min(...shown.map((L) => L.left)), y0 = Math.min(...shown.map((L) => L.top)), x1 = Math.max(...shown.map((L) => L.left + L.width)), y1 = Math.max(...shown.map((L) => L.top + L.height));
      const drawn = drawArea(sub, [x0, y0, x1, y1]), w = x1 - x0, h = y1 - y0, rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = drawn[i * 4 + 3];
        if (a <= 0) continue;
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round((drawn[i * 4 + c] / a) * 255)));
        rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
      layers.splice(at, 0, { name: g.name, groupObjs: inside[0].groupObjs.slice(0, depth), left: x0, top: y0, width: w, height: h, rgba, visible: g.visible, opacity: (g.opacity ?? 255) / 255,
        blend: g.blend === 'passThrough' ? 'normal' : g.blend, clipping: false, kind: 'pixel', index: inside[0].index });
      note('psdTagMerged', { folder: g.name, layers: inside.length }, `folder ${g.name} [merge]: its ${inside.length} layer(s) drawn together into one part`, 'info');
    }
    if (layers !== psd.layers) psd = { ...psd, layers };
  }
  for (const L of psd.layers) {
    if (baked.has(L)) continue;
    const folder = L.groupObjs[L.groupObjs.length - 1] || null;
    // a folder met for the first time is the item above what came before it in its parent folder
    L.groupObjs.forEach((g, k) => { if (!seenFolder.has(g)) { seenFolder.add(g); baseIn.set(k ? L.groupObjs[k - 1] : null, g); } });
    if (!L.clipping) baseIn.set(folder, L);
    const base = L.clipping && clipOn ? baseIn.get(folder) : null;
    const tight = L.tight !== undefined ? L.tight : L.width && L.height ? opaqueBox(L.rgba, L.width, L.height, alphaMin) : null; // tight: worked out in a Worker
    // a few transparent pixels more on every side (margin + 1): texture filtering then fades out
    // beyond the picture's edge instead of eating into its outermost pixels, and the outline
    // mesh, which runs `margin` px outside the picture, still samples this picture
    const box = tight && [tight[0] - rim, tight[1] - rim, tight[2] + rim, tight[3] + rim];
    const where = [...L.groupObjs.map((g) => g.name), L.name].join('/');
    if (L.kind === 'adjustment') { if (opts.bakeAdjustments === false) note('layerAdjustment', { layer: where }, `layer ${where}: adjustment layers are not applied (skipped); merge it into the layers below in the drawing app`); continue; }
    if (!box) { note('layerEmpty', { layer: where }, `layer ${where}: empty (skipped)`); continue; }
    if (L.kind === 'text' || L.kind === 'smartObject' || L.kind === 'fill') note('layerKind', { layer: where, kind: L.kind }, `layer ${where}: ${L.kind === 'text' ? 'text' : L.kind === 'fill' ? 'fill' : 'smart object'} layer: imported as the pixels the PSD keeps for it`);
    if (L.effectsPainted) {
      const { kinds, close, skipped } = L.effectsPainted;
      if (kinds.length) note('layerEffectsPainted', { layer: where, effects: kinds.join(', '), close }, `layer ${where}: layer effects painted into its picture (${kinds.join(', ')})${close ? '; close to Photoshop, not exact (an effect in another blend than normal is painted in normal)' : ''}`, 'info');
      if (skipped.length) note('layerEffectsSkipped', { layer: where, effects: skipped.join(', ') }, `layer ${where}: layer effects not painted (${skipped.join(', ')}); rasterize them in the drawing app`);
    } else if (L.effects) note('layerEffects', { layer: where }, `layer ${where}: layer effects (shadow, stroke, glow...) are not drawn; rasterize them in the drawing app`);
    if (!BLEND_OF[L.blend]) note('layerBlend', { layer: where, blend: L.blend }, `layer ${where}: blend mode ${L.blend} is drawn as normal (Ugo9 has normal, multiply, screen and add)`);
    if (L.clipping && clipOn && !base) note('layerClipNoBase', { layer: where }, `layer ${where}: clipped, but there is no layer below it to clip to (drawn unclipped)`);
    const hiddenBy = L.groupObjs.find((g) => !g.visible);
    if (!L.visible || hiddenBy) note('layerHidden', { layer: where }, `layer ${where}: hidden in the PSD (imported with opacity 0)`);
    for (const g of L.groupObjs) if (g.blend !== 'passThrough' && g.blend !== 'normal' && !saidBlend.has(g) && saidBlend.add(g)) note('groupBlend', { group: g.name, blend: g.blend }, `group ${g.name}: blend mode ${g.blend} not applied`);
    const entry = { L, box, where, visible: L.visible && !hiddenBy, base, psdIndex: L.index };
    if (base && !(base.groupObjs ? keptOf.has(base) : keptInFolder(base).length)) { note('layerClipEmptyBase', { layer: where }, `layer ${where}: its clipping base is empty, so it shows nothing (opacity 0)`); entry.visible = false; entry.base = null; }
    kept.push(entry);
    keptOf.set(L, entry);
  }

  // atlasAnyAngle (makes the atlas smaller, the pictures a little blurred): a slanted picture whose
  // box gets at least a fifth smaller is turned by the angle that makes it smallest, resampled
  if (opts.atlasAnyAngle) for (const entry of kept) {
    const { L, box } = entry;
    if (!L.rgba || !L.width || !L.height) continue;
    const bw = box[2] - box[0], bh = box[3] - box[1], best = bestAngle(L.rgba, L.width, L.height, alphaMin, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
    // the turned opaque box, with the rim (and a pixel for the resampling) on every side
    const tw = Math.ceil(best.w) + 2 * rim + 2, th = Math.ceil(best.h) + 2 * rim + 2, mx = rim + 1 - best.box[0], my = rim + 1 - best.box[1];
    if (!best.angle || tw * th > 0.8 * bw * bh) continue;
    // the turned copy of the area (box) about its middle
    const area = new Uint8Array(bw * bh * 4);
    for (let y = Math.max(0, box[1]); y < Math.min(L.height, box[3]); y++) {
      const x0 = Math.max(0, box[0]), x1 = Math.min(L.width, box[2]);
      if (x1 > x0) area.set(L.rgba.subarray((y * L.width + x0) * 4, (y * L.width + x1) * 4), ((y - box[1]) * bw + x0 - box[0]) * 4);
    }
    entry.angled = { angle: best.angle, w: tw, h: th, mx, my, area };
  }
  const sizes = kept.map(({ box, angled }) => (angled ? [angled.w, angled.h] : [box[2] - box[0], box[3] - box[1]]));
  const upright = new Set(kept.map((e, k) => (e.angled ? k : -1)).filter((k) => k >= 0));
  const { pages, at } = kept.length ? pack(sizes, padding, maxSize, { turn: opts.atlasTurn !== false, upright }) : { pages: [{ width: 1, height: 1 }], at: [] };
  // the pages' sizes by opts.atlasPage (the pictures stay where they are; the rest of a page is transparent)
  const pow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
  if (opts.atlasPage === 'pow2' || opts.atlasPage === 'square') for (const p of pages) {
    p.width = pow2(p.width); p.height = pow2(p.height);
    if (opts.atlasPage === 'square') p.width = p.height = Math.max(p.width, p.height);
  } else if (opts.atlasPage && opts.atlasPage !== 'tight') note('atlasPageUnknown', { value: String(opts.atlasPage) }, `atlasPage ${opts.atlasPage}: not known (tight, pow2 or square); tight`);
  const atlases = pages.map(({ width, height }) => ({ width, height, rgba: null })); // each page made when it is first filled
  if (pages.length > 1) note('atlasPages', { pages: pages.length, size: maxSize, textures: pages.map((_, i) => atlasName(i)) }, `the pictures need ${pages.length} atlas pages of up to ${maxSize}x${maxSize} (textures ${pages.map((_, i) => atlasName(i)).join(', ')})`);
  for (const p of pages) if (p.width > 8192 || p.height > 8192) note('atlasTooLarge', { width: p.width, height: p.height }, `atlas page ${p.width}x${p.height}: a picture larger than many GPUs allow (8192)`);

  // ids and groups in drawing order; then page by page (in drawing order on each page): the
  // pictures into the atlas, their meshes. A big PSD (scaled down, or opts.keepPixels false) lets
  // go of each layer's pixels as soon as they are in the atlas, so they and the atlas pages are
  // not all held at once (meshFromLayer reads them back from the atlas when asked)
  const dropPixels = opts.keepPixels === false || (opts.keepPixels !== true && scale < 1);
  kept.forEach((entry) => {
    entry.id = unique(boneTag(entry.L.name).name); entry.group = groupOf(entry.L.groupObjs);
    if (entry.group) groups.find((g) => g.id === entry.group).parts.push(entry.id);
  });
  let placed = 0;
  for (let page = 0; page < pages.length; page++) kept.forEach((entry, k) => {
    if (at[k][2] !== page) return;
    if (opts.onProgress) opts.onProgress({ step: 'mesh', done: placed++, total: kept.length });
    const { L, box, visible, id, group } = entry;
    const [bx0, by0, bx1, by1] = box, [ax, ay, , turned] = at[k], bw = bx1 - bx0, bh = by1 - by0;
    const A = atlases[page];
    A.rgba ||= new Uint8Array(A.width * A.height * 4);
    const { width: AW, height: AH, rgba: atlas } = A;
    const x0 = Math.max(0, bx0), x1 = Math.min(L.width, bx1); // the part of the area inside the layer's pixels
    const ang = entry.angled;
    if (ang) { // turned by its angle: the resampled copy as it is
      const pic = turnPicture(ang.area, bw, bh, ang.angle, ang.w, ang.h, ang.mx, ang.my);
      for (let y = 0; y < ang.h; y++) atlas.set(pic.subarray(y * ang.w * 4, (y + 1) * ang.w * 4), ((ay + y) * AW + ax) * 4);
      ang.area = null;
    } else if (x1 > x0 && !turned) for (let ly = Math.max(0, by0); ly < Math.min(L.height, by1); ly++)
      atlas.set(L.rgba.subarray((ly * L.width + x0) * 4, (ly * L.width + x1) * 4), ((ay + ly - by0) * AW + ax + x0 - bx0) * 4);
    else if (x1 > x0) { // turned 90° clockwise: the area's row ly becomes the atlas column ax + bh - 1 - ly
      const px = new Uint32Array(atlas.buffer, atlas.byteOffset, atlas.length >> 2), src = new Uint32Array(L.rgba.buffer, L.rgba.byteOffset, L.rgba.length >> 2);
      for (let ly = Math.max(0, by0); ly < Math.min(L.height, by1); ly++) {
        const X = ax + bh - 1 - (ly - by0);
        for (let lx = x0; lx < x1; lx++) px[(ay + lx - bx0) * AW + X] = src[ly * L.width + lx];
      }
    }
    const [tw, th] = ang ? [ang.w, ang.h] : turned ? [bh, bw] : [bw, bh]; // the area's size in the atlas
    bleed(atlas, AW, AH, padding + 1, [ax - padding, ay - padding, ax + tw + padding, ay + th + padding]);
    // width / height: the picture's area (as in the PSD); turned: it lies turned 90° clockwise in the atlas
    const atlasBox = { x: ax, y: ay, width: bw, height: bh, left: L.left + bx0, top: L.top + by0, ...(page ? { page } : {}), ...(turned ? { turned: true } : {}), ...(ang ? { angle: ang.angle, atlasArea: [ang.w, ang.h, ang.mx, ang.my] } : {}) };
    const { vertices, uvs, triangles, spacing } = meshFromLayer({ ...L, atlas: atlasBox }, { ...opts, atlasWidth: AW, atlasHeight: AH, originX: ox, originY: oy, meshReduce: scale < 1 ? 2 : 1, ...meshOf(L) });
    entry.spacing = spacing;
    entry.part = { id, texture: page, opacity: visible ? +L.opacity.toFixed(4) : 0, vertices, uvs, triangles, bone: 'root' };
    if (BLEND_OF[L.blend] && BLEND_OF[L.blend] !== 'normal') entry.part.blend = BLEND_OF[L.blend];
    if (entry.base) entry.part.mask = entry.base.groupObjs ? [keptOf.get(entry.base).id] : keptInFolder(entry.base).map((e) => e.id);
    entry.layer = { part: id, name: L.name, group, path: [...L.groupObjs.map((g) => g.name), L.name], psdIndex: entry.psdIndex, ...(L.effectsPainted?.kinds.length ? { effects: L.effectsPainted.kinds } : {}), left: L.left, top: L.top, width: L.width, height: L.height, visible: L.visible, opacity: L.opacity, blend: L.blend,
      clipping: !!L.clipping, rgba: dropPixels ? null : L.rgba, atlas: atlasBox };
    if (dropPixels) L.rgba = null;
  });
  if (opts.onProgress && kept.length) opts.onProgress({ step: 'mesh', done: kept.length, total: kept.length });
  for (const A of atlases) A.rgba ||= new Uint8Array(A.width * A.height * 4);
  for (const entry of kept) if (entry.spacing > (opts.spacing || 24)) note('meshCoarser', { layer: entry.where, spacing: entry.spacing }, `layer ${entry.where}: a big picture, so its mesh points are ${entry.spacing} px apart`, 'info');
  const parts = kept.map((e) => e.part), layers = kept.map((e) => e.layer);

  const model = {
    format: 'ugo9', version: '0.4',
    canvas: { width: W, height: H, originX: ox, originY: oy },
    textures: pages.map((_, i) => atlasName(i)),
    parameters: [], bones: [{ id: 'root' }, ...(opts.groupBones ? groupBones(parts, groups) : [])], parts, deformers: [], animations: [],
  };
  if (opts.boneTags !== false) tagBones(model, kept, note, !!opts.groupBones, rim, ox, oy);
  // atlas: the first page (most PSDs need one); atlases: every page, as model.textures names them
  return { model, atlas: atlases[0], atlases, groups, layers, scale, warnings, notes };
}

// Bones from layer and folder names (2026-11-10, the user's choice): a name ending in a tag in square brackets
// whose first word is 骨 or bone, e.g. 「腕 [骨]」「前腕 [骨 親=腕]」「髪 [bone root=top]」. The words, in Japanese or
// English (either, whatever the editor's language): 親 / parent = the parent bone's name; 根元 / root = 上 下 左 右 中 /
// top bottom left right center: where on the picture the bone starts (default 上 / top), pointing across it (from the
// top downwards, from the left rightwards...; 中 / center: no direction, length 0). Full-width ［］＝ and spaces are
// the same as half-width; letters in any case. The tag is not part of the part's or bone's name. A tagged layer is
// bound to its bone; every layer in a tagged folder to the folder's bone (a tagged layer in it: a child bone).
// Brackets whose first word is not 骨 / bone are left in the name as they are.
const TAG_BONE = new Set(['骨', 'bone']), TAG_PARENT = new Set(['親', 'parent']), TAG_ROOT = new Set(['根元', 'root']);
const ROOT_AT = { 上: 'top', top: 'top', 下: 'bottom', bottom: 'bottom', 左: 'left', left: 'left', 右: 'right', right: 'right', 中: 'center', 中央: 'center', center: 'center', centre: 'center', middle: 'center' };
// More tags (2026-11-10, 機能の比べ #14): [無視] / [ignore] (the layer, or everything in the folder, is not read),
// [結合] / [merge] (a folder: its layers drawn together into one part, as the drawing app shows the folder),
// [メッシュ=格子|輪郭|四角|自動] / [mesh=grid|contour|quad|auto] (how the layer's mesh is made; on a folder: its layers').
// A name may end in several tags (「腕 [骨] [メッシュ=格子]」); each is taken off the name.
const TAG_IGNORE = new Set(['無視', 'ignore']), TAG_MERGE = new Set(['結合', 'merge']), TAG_MESH = new Set(['メッシュ', 'mesh']);
const MESH_OF = { 格子: 'grid', grid: 'grid', 輪郭: 'contour', contour: 'contour', 四角: 'none', quad: 'none', none: 'none', 自動: 'auto', auto: 'auto' };
const tagFirst = (w) => { const k = w.split('=')[0].toLowerCase(); return TAG_BONE.has(k) ? 'bone' : TAG_IGNORE.has(k) ? 'ignore' : TAG_MERGE.has(k) ? 'merge' : TAG_MESH.has(k) ? 'mesh' : null; };
/** a name -> { name (the known tags taken off), tags: [{ kind: 'bone' | 'ignore' | 'merge' | 'mesh', words }] } (the tags from the end) */
export function nameTags(raw) {
  let s = String(raw ?? '').replace(/［/g, '[').replace(/］/g, ']').replace(/＝/g, '=').replace(/\u3000/g, ' ');
  const tags = [];
  for (;;) {
    const m = /^(.*?)\s*\[([^\[\]]*)\]\s*$/.exec(s);
    if (!m) break;
    const words = m[2].trim().split(/[\s,、]+/).filter(Boolean), kind = words.length ? tagFirst(words[0]) : null;
    if (!kind) break; // brackets that are not a tag stay in the name
    tags.unshift({ kind, words });
    s = m[1];
  }
  return { name: tags.length ? s.trim() || String(raw) : raw, tags };
}
/** a layer's or folder's name -> its mesh style from a [mesh=...] tag, or null */
export function meshTag(raw) {
  const t = nameTags(raw).tags.find((x) => x.kind === 'mesh');
  if (!t) return null;
  const v = (t.words[0].split('=')[1] || t.words[1] || '').toLowerCase();
  return MESH_OF[v] || null;
}

/** a layer's or folder's name -> { name (without the tags), tag: { parent, root, unknown: [words] } or null } */
export function boneTag(raw) {
  const { name, tags } = nameTags(raw), bt = tags.find((x) => x.kind === 'bone');
  if (!bt) return { name: tags.length ? name : raw, tag: null };
  const words = bt.words, m = [null, name];
  const tag = { parent: null, root: 'top', unknown: [] };
  for (const w of words.slice(1)) {
    const eq = w.indexOf('='), k = eq > 0 ? w.slice(0, eq).toLowerCase() : w.toLowerCase(), v = eq > 0 ? w.slice(eq + 1) : '';
    if (TAG_PARENT.has(k) && v) tag.parent = v;
    else if (TAG_ROOT.has(k) && ROOT_AT[v.toLowerCase()]) tag.root = ROOT_AT[v.toLowerCase()];
    else tag.unknown.push(w);
  }
  return { name: m[1] || raw, tag };
}
function tagBones(model, kept, note, groupBonesOn, rim, ox, oy) {
  const items = []; // { key (the layer entry or the folder object), name, tag, parts: [part], folderDepth }
  const folders = new Map();
  for (const e of kept) {
    const own = boneTag(e.L.name);
    if (own.tag) items.push({ key: e, name: own.name, tag: own.tag, where: e.where, parts: [e.part], folders: e.L.groupObjs });
    e.L.groupObjs.forEach((g, depth) => {
      const t = boneTag(g.name);
      if (!t.tag) return;
      if (!folders.has(g)) { const it = { key: g, name: t.name, tag: t.tag, where: e.L.groupObjs.slice(0, depth + 1).map((x) => x.name).join('/'), parts: [], folders: e.L.groupObjs.slice(0, depth) }; folders.set(g, it); items.push(it); }
      folders.get(g).parts.push(e.part);
    });
  }
  if (!items.length) return;
  if (groupBonesOn) { note('psdBoneTagsIgnored', { count: items.length }, `${items.length} bone tag(s) in layer names: not used with a bone per group (groupBones)`); return; }
  // ids: the names, unique among the bones
  const taken = new Set(model.bones.map((b) => b.id));
  for (const it of items) { let id = it.name, k = 2; while (taken.has(id)) id = `${it.name}_${k++}`; taken.add(id); it.id = id; }
  const byName = new Map(); for (const it of items) if (!byName.has(it.name)) byName.set(it.name, it);
  // parents: the one named, else the nearest tagged folder around it, else root
  for (const it of items) {
    for (const w of it.tag.unknown) note('psdBoneTagWord', { layer: it.where, word: w }, `${it.where}: "${w}" in its bone tag is not understood (left out)`);
    let parent = null;
    if (it.tag.parent) { parent = byName.get(it.tag.parent) || null; if (!parent) note('psdBoneParentMissing', { layer: it.where, parent: it.tag.parent }, `${it.where}: no bone named ${it.tag.parent} for its parent (put under the nearest one around it)`); }
    if (!parent) for (let d = it.folders.length - 1; d >= 0 && !parent; d--) parent = folders.get(it.folders[d]) || null;
    if (parent === it) parent = null;
    it.parent = parent;
  }
  // no circles: a parent named further down is cut off
  for (const it of items) { const seen = new Set([it]); for (let p = it.parent; p; p = p.parent) { if (seen.has(p)) { note('psdBoneParentCircle', { layer: it.where }, `${it.where}: its bone's parents go round in a circle (put under root)`); it.parent = null; break; } seen.add(p); } }
  // where each bone starts and which way it points (model space, y down), from the box of its pictures' visible pixels
  const pictureBox = new Map(kept.map((e) => [e.part, [e.L.left + e.box[0] + rim - ox, e.L.top + e.box[1] + rim - oy, e.L.left + e.box[2] - rim - ox, e.L.top + e.box[3] - rim - oy]]));
  for (const it of items) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of it.parts) { const q = pictureBox.get(p); b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]); }
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, w = b[2] - b[0], h = b[3] - b[1];
    const at = { top: [cx, b[1], 90, h], bottom: [cx, b[3], -90, h], left: [b[0], cy, 0, w], right: [b[2], cy, 180, w], center: [cx, cy, 0, 0] }[it.tag.root];
    [it.wx, it.wy, it.wa, it.length] = at;
  }
  // in its parent's space (bones here neither scale nor shear: turn and move only)
  const order = []; const visit = (it) => { if (order.includes(it)) return; if (it.parent) visit(it.parent); order.push(it); }; items.forEach(visit);
  for (const it of order) {
    const p = it.parent, pa = p ? p.wa : 0, px = p ? p.wx : 0, py = p ? p.wy : 0, r = (-pa * Math.PI) / 180, dx = it.wx - px, dy = it.wy - py;
    model.bones.push({ id: it.id, parent: p ? p.id : 'root', x: +(dx * Math.cos(r) - dy * Math.sin(r)).toFixed(3), y: +(dx * Math.sin(r) + dy * Math.cos(r)).toFixed(3), rotation: +(((it.wa - pa + 540) % 360) - 180).toFixed(3), length: +it.length.toFixed(3) });
  }
  // binding: a part to its own tag's bone, else to its nearest tagged folder's
  for (const e of kept) {
    const own = items.find((it) => it.key === e);
    if (own) { e.part.bone = own.id; continue; }
    for (let d = e.L.groupObjs.length - 1; d >= 0; d--) { const f = folders.get(e.L.groupObjs[d]); if (f) { e.part.bone = f.id; break; } }
  }
  note('psdBones', { count: items.length }, `${items.length} bone(s) from bone tags in layer and folder names`, 'info');
}

// opts.groupBones: a bone per group (nested groups -> child bones), at the bottom centre of the
// group's pictures, pointing up, half their height long; each part is bound to its own group's bone, so turning a group's bone turns
// everything in it. Bone ids are the group ids.
function groupBones(parts, groups) {
  const box = new Map(), byId = new Map(groups.map((g) => [g.id, g]));
  const grow = (gid, p) => {
    for (let g = byId.get(gid); g; g = byId.get(g.parent)) {
      const b = box.get(g.id) || [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.vertices.length; i += 2) {
        b[0] = Math.min(b[0], p.vertices[i]); b[1] = Math.min(b[1], p.vertices[i + 1]);
        b[2] = Math.max(b[2], p.vertices[i]); b[3] = Math.max(b[3], p.vertices[i + 1]);
      }
      box.set(g.id, b);
    }
  };
  for (const g of groups) for (const id of g.parts) grow(g.id, parts.find((p) => p.id === id));
  const pivot = (g) => { const b = box.get(g.id); return b ? [(b[0] + b[2]) / 2, b[3]] : [0, 0]; };
  for (const g of groups) for (const id of g.parts) parts.find((p) => p.id === id).bone = g.id;
  return groups.map((g) => {
    const [x, y] = pivot(g), [px, py] = g.parent ? pivot(byId.get(g.parent)) : [0, 0];
    const b = box.get(g.id), length = b ? +((b[3] - b[1]) / 2).toFixed(3) : 0;
    // pointing up into the group's pictures (rotation -90 with y down), half their height long:
    // easy to pick in the editor and to make into a chain
    // the parent group's bone points up (rotated -90°): its local axes are (dx, dy) -> (-dy, dx)
    const dx = x - px, dy = y - py, [lx, ly] = g.parent ? [-dy, dx] : [dx, dy];
    return { id: g.id, parent: g.parent || 'root', x: +lx.toFixed(3), y: +ly.toFixed(3), rotation: g.parent ? 0 : -90, length }; // every bone points up
  });
}

/** Read a PSD again after the pictures changed, for a document made from an earlier import.
 *  doc: { canvas: { originX, originY }, parts: [{ id, vertices }], layers: [layerMeta of the earlier import] }.
 *  Layers are matched by their group path and name (the n-th of the same name with the n-th).
 *  Matched parts keep their mesh (and so their keyforms and weights): only the atlas and the
 *  UVs change. -> { atlas, layers, uvs: { partId: [...] }, outside: { partId: vertices whose
 *  picture point is outside the new picture's area }, added: [{ layer, part }], removed: [partId], warnings }.
 *  `added` holds new layers with a fresh mesh; parts with `outside` vertices may want a new mesh
 *  (meshFromLayer) with the keyforms carried over by the editor. */
export function reimportPsd(bytes, doc, opts = {}) {
  return matchReimport(importPsd(bytes, opts), doc);
}
/** reimportPsd in the browser (ZIP channels inflated with DecompressionStream, the PSD read once). */
export async function reimportPsdAsync(bytes, doc, opts = {}) {
  return matchReimport(await importPsdAsync(bytes, opts), doc);
}
function matchReimport(res, doc) {
  const ox = doc.canvas.originX, oy = doc.canvas.originY;
  const key = (l) => JSON.stringify(l.path || [l.name]);
  const oldByKey = new Map(), seen = new Map();
  for (const l of doc.layers) { const k = key(l); if (!oldByKey.has(k)) oldByKey.set(k, []); oldByKey.get(k).push(l); }
  const uvs = {}, outside = {}, added = [], matched = new Set(), { warnings, notes, note } = makeNotes();
  for (const n of res.notes) note(n.code, n.vars, n.text, n.level);
  res.layers.forEach((l, i) => {
    const k = key(l), n = seen.get(k) || 0, old = (oldByKey.get(k) || [])[n];
    seen.set(k, n + 1);
    const part = old && doc.parts.find((p) => p.id === old.part);
    if (!part) { added.push({ layer: l, part: res.model.parts[i] }); return; }
    matched.add(part.id);
    const a = l.atlas, u = [], { width: AW, height: AH } = res.atlases[a.page || 0];
    let out = 0;
    for (let v = 0; v < part.vertices.length; v += 2) {
      const px = part.vertices[v] + ox - a.left, py = part.vertices[v + 1] + oy - a.top; // in the new picture's atlas area
      if (px < 0 || py < 0 || px > a.width || py > a.height) out++;
      u.push(...atlasUv(a, Math.min(a.width, Math.max(0, px)), Math.min(a.height, Math.max(0, py)), AW, AH));
    }
    uvs[part.id] = u;
    if (out) { outside[part.id] = out; note('reimportOutside', { part: part.id, count: out }, `part ${part.id}: ${out} vertices are outside the new picture (the picture moved or shrank; a new mesh may be needed)`); }
    l.part = part.id;
  });
  const removed = doc.parts.filter((p) => doc.layers.some((l) => l.part === p.id) && !matched.has(p.id)).map((p) => p.id);
  for (const id of removed) note('reimportRemoved', { part: id }, `part ${id}: its layer is no longer in the PSD`);
  // a matched part on another atlas page than before: its part.texture must change too (textures)
  const textures = Object.fromEntries(res.layers.filter((l) => l.part in uvs).map((l) => [l.part, l.atlas.page || 0]));
  return { atlas: res.atlas, atlases: res.atlases, textureNames: res.model.textures, layers: res.layers, groups: res.groups, uvs, textures, outside, added, removed, warnings, notes };
}

/** importPsd for the browser: ZIP layers are inflated with DecompressionStream (async). */
// ---- CLI --------------------------------------------------------------------------------------
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const fs = await import('node:fs'), path = await import('node:path'), zlib = await import('node:zlib');
  const { encodePng } = await import('./png.mjs');
  const { compileUgo } = await import('./compile.mjs');
  const args = process.argv.slice(2);
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--group-bones', '--no-clipping'].includes(args[i - 1])));
  const [psdPath, outDir = 'build/psd'] = files;
  if (!psdPath) { console.error('usage: node tools/import_psd.mjs picture.psd outDir [--spacing 24] [--mesh auto|contour|grid] [--alpha 8] [--group-bones] [--no-clipping] [--padding 2] [--atlas-page tight|pow2|square] [--max-atlas 4096]'); process.exit(2); }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const res = importPsd(fs.readFileSync(psdPath), { groupBones: args.includes('--group-bones'), clipping: !args.includes('--no-clipping'), spacing: opt('--spacing', opt('--cell', 24)), mesh: args.includes('--mesh') ? args[args.indexOf('--mesh') + 1] : 'auto', alphaMin: opt('--alpha', 8), padding: opt('--padding', 2), maxAtlasSize: opt('--max-atlas', 4096),
    atlasPage: args.includes('--atlas-page') ? args[args.indexOf('--atlas-page') + 1] : 'tight', inflate: (b) => zlib.inflateSync(b) });
  fs.mkdirSync(outDir, { recursive: true });
  res.atlases.forEach((a, i) => fs.writeFileSync(path.join(outDir, res.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(res.model, null, 1));
  const bin = compileUgo(res.model);
  fs.writeFileSync(path.join(outDir, 'model.ug9'), new Uint8Array(bin));
  const nv = res.model.parts.reduce((s, p) => s + p.vertices.length / 2, 0);
  console.log(`${path.basename(psdPath)} -> ${outDir}/model.ug9: ${res.model.parts.length} parts, ${res.groups.length} groups, ${nv} vertices, atlas ${res.atlases.map((a) => `${a.width}x${a.height}`).join(' + ')}, ${bin.byteLength} bytes`);
  for (const w of res.warnings) console.log(`warning: ${w}`);
}
