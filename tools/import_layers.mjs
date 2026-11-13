// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Layered pictures other than PSD, read into the same model PSD gives (tools/import_psd.mjs does
// the rest: atlas, meshes, clipping, groups, notes). Plain ES module, no Node API.
//
//   import { importKraAsync, importOraAsync, importPngSetAsync } from '../tools/import_layers.mjs';
//   const { model, atlas, atlases, groups, layers, notes } = await importOraAsync(bytes, { spacing: 24 });
//   await importPngSetAsync([{ path: 'body.png', bytes }, { path: 'face/eye.png', bytes }]) // bottom first
//
// Node: importKra / importOra / importPngSet with opts.inflate (zlib.inflateSync) and
// opts.inflateRaw (zlib.inflateRawSync). The browser versions use DecompressionStream.
//   .ora  OpenRaster (Krita, GIMP, MyPaint...): a ZIP, stack.xml and a PNG per layer
//   .kra  Krita: a ZIP, maindoc.xml and each paint layer's tiles (64×64, LZF), 8- or 16-bit RGBA / grey
//   PNG   a set of PNG files, one per layer, bottom first; folders in the path become groups
//   .procreate  Procreate: a ZIP, Document.archive (NSKeyedArchiver plist) and each layer's tiles (LZO1X or LZ4)
//   .aseprite / .ase  Aseprite: its own chunks; the first frame's cels (RGBA, grey or indexed, zlib or raw)
// Written from the OpenRaster specification (freedesktop.org), the PNG specification (W3C), the
// ZIP application note (PKWARE), the LZF format (liblzf's description) and what Krita's .kra
// files hold (their maindoc.xml and layer files, read as data). Aseprite: from its published file
// format description (Aseprite's public documents).
// Errors (with .code and .vars): layersNotZip, layersNoStack (an .ora without stack.xml),
// layersNoMaindoc (a .kra without maindoc.xml), layersKraOld (Krita 1), layersZip64, layersZipMethod, pngBad, pngUnsupported,
// layersNone (no layers at all).

import { importLayerStack } from './import_psd.mjs';
import { kritaFilter } from './adjustments.mjs';

function layersError(code, vars, text) { const e = new Error(text); e.code = code; e.vars = vars; e.psd = true; throw e; }
const dec = new TextDecoder();

// ---- running a reader: it yields { raw, data } (deflate data to inflate), gets the bytes back ----
function runSync(gen, opts) {
  let r = gen.next();
  while (!r.done) {
    const f = r.value.raw ? opts.inflateRaw : opts.inflate;
    if (!f) layersError('layersNeedsInflate', {}, `opts.${r.value.raw ? 'inflateRaw' : 'inflate'} is needed to read this file`);
    let out;
    try { out = new Uint8Array(f(r.value.data)); } catch (e) { r = gen.throw(e); continue; } // the reader may say which part did not inflate
    r = gen.next(out);
  }
  return r.value;
}
async function runAsync(gen, opts) {
  const stream = (kind) => async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream(kind))).arrayBuffer());
  const inflate = opts.inflate ? async (b) => opts.inflate(b) : stream('deflate'), raw = opts.inflateRaw ? async (b) => opts.inflateRaw(b) : stream('deflate-raw');
  let r = gen.next();
  while (!r.done) {
    let out;
    try { out = new Uint8Array(await (r.value.raw ? raw : inflate)(r.value.data)); } catch (e) { r = gen.throw(e); continue; }
    r = gen.next(out);
  }
  return r.value;
}

// ---- ZIP: the central directory; stored and deflated entries ----
export function readZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) layersError('layersNotZip', {}, 'not a ZIP file (.kra and .ora are ZIP files)');
  const count = v.getUint16(e + 10, true), size = v.getUint32(e + 12, true), at = v.getUint32(e + 16, true);
  if (count === 0xffff || at === 0xffffffff) layersError('layersZip64', {}, 'a ZIP64 file (over 4 GB or 65535 files) is not read');
  const entries = new Map();
  for (let p = at, k = 0; k < count && p + 46 <= at + size; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    entries.set(name, { name, method, csize, usize, local });
    p += 46 + nl + xl + cl;
  }
  return { bytes: b, entries };
}
function* zipEntry(zip, name) { // -> the entry's bytes, or null when there is no such entry
  const en = zip.entries.get(name);
  if (!en) return null;
  const b = zip.bytes, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(en.local, true) !== 0x04034b50) layersError('layersNotZip', { entry: name }, `ZIP entry ${name}: its header is missing`);
  const start = en.local + 30 + v.getUint16(en.local + 26, true) + v.getUint16(en.local + 28, true), data = b.subarray(start, start + en.csize);
  if (en.method === 0) return data;
  if (en.method === 8) return yield { raw: true, data };
  layersError('layersZipMethod', { entry: name, method: en.method }, `ZIP entry ${name}: compression method ${en.method} is not read (only stored and deflate)`);
}

// ---- PNG: every colour type and bit depth, Adam7 interlacing; straight-alpha RGBA, 8 bits ----
function* pngGen(bytes, name = 'PNG') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33 || v.getUint32(0) !== 0x89504e47 || v.getUint32(4) !== 0x0d0a1a0a) layersError('pngBad', { file: name }, `${name}: not a PNG file`);
  let p = 8, w = 0, h = 0, depth = 0, type = 0, lace = 0, pal = null, trns = null;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = v.getUint32(p), kind = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), d = b.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = v.getUint32(p + 8); h = v.getUint32(p + 12); depth = d[8]; type = d[9]; lace = d[12]; }
    else if (kind === 'PLTE') pal = d; else if (kind === 'tRNS') trns = d; else if (kind === 'IDAT') idat.push(d); else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!w || !h || !ch || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && !pal)) layersError('pngUnsupported', { file: name, type, depth }, `${name}: PNG colour type ${type}, ${depth}-bit is not read`);
  const all = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let o = 0; for (const d of idat) { all.set(d, o); o += d.length; }
  const raw = yield { raw: false, data: all };
  const bpp = Math.max(1, (ch * depth) >> 3), out = new Uint8Array(w * h * 4), max = (1 << depth) - 1;
  const tv = trns && type === 0 ? (trns[0] << 8) | trns[1] : -1, tc = trns && type === 2 ? [0, 2, 4].map((i) => (trns[i] << 8) | trns[i + 1]) : null;
  const passes = lace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let q = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * ch * depth) / 8);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      if (q + 1 + stride > raw.length) layersError('pngBad', { file: name }, `${name}: the picture data is cut short`);
      const f = raw[q++];
      cur.set(raw.subarray(q, q + stride)); q += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        if (f === 1) cur[i] += a; else if (f === 2) cur[i] += up; else if (f === 3) cur[i] += (a + up) >> 1;
        else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); cur[i] += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      }
      const sample = (k) => { // the k-th sample of the row, at full precision
        if (depth === 8) return cur[k]; if (depth === 16) return (cur[2 * k] << 8) | cur[2 * k + 1];
        const bit = k * depth; return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
      };
      const to8 = (s) => (depth === 16 ? s >> 8 : depth === 8 ? s : Math.round((s * 255) / max));
      for (let x = 0; x < pw; x++) {
        const at = ((y0 + y * dy) * w + x0 + x * dx) * 4;
        if (type === 3) { const k = sample(x); out[at] = pal[k * 3]; out[at + 1] = pal[k * 3 + 1]; out[at + 2] = pal[k * 3 + 2]; out[at + 3] = trns && k < trns.length ? trns[k] : 255; }
        else if (type === 0 || type === 4) { const g = sample(x * ch); out[at] = out[at + 1] = out[at + 2] = to8(g); out[at + 3] = type === 4 ? to8(sample(x * ch + 1)) : g === tv ? 0 : 255; }
        else { const r = sample(x * ch), g = sample(x * ch + 1), bl = sample(x * ch + 2); out[at] = to8(r); out[at + 1] = to8(g); out[at + 2] = to8(bl); out[at + 3] = type === 6 ? to8(sample(x * ch + 3)) : tc && r === tc[0] && g === tc[1] && bl === tc[2] ? 0 : 255; }
      }
      [prev, cur] = [cur, prev];
    }
    prev.fill(0);
  }
  return { width: w, height: h, rgba: out };
}
/** PNG bytes -> { width, height, rgba } (8-bit straight alpha). opts.inflate: zlib's inflate (sync). */
export const decodePng = (bytes, opts = {}) => runSync(pngGen(bytes), opts);
export const decodePngAsync = (bytes, opts = {}) => runAsync(pngGen(bytes), opts);

// ---- a small XML reader: elements, attributes, entities (enough for stack.xml and maindoc.xml) ----
function parseXml(text) {
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]));
  const root = { tag: '', attrs: {}, children: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (!m[2]) continue;
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = ent(a[2] ?? a[3]);
    const el = { tag: m[2].replace(/^.*:/, ''), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}
const find = (el, tag) => el && el.children.find((c) => c.tag === tag);

// a layer as tools/import_psd.mjs reads it from a PSD
const BLEND = { 'svg:src-over': 'normal', 'svg:multiply': 'multiply', 'svg:screen': 'screen', 'svg:plus': 'add', normal: 'normal', multiply: 'multiply', screen: 'screen', add: 'add' };
const layer = (name, groupObjs, pic, more) => ({ name, groupObjs, left: pic.left, top: pic.top, width: pic.width, height: pic.height, visible: true, opacity: 1, blend: 'normal', clipping: 0, kind: 'pixel', effects: false, rgba: pic.rgba, ...more });

// ---- OpenRaster ----
function* oraGen(bytes, opts) {
  const zip = readZip(bytes), xml = yield* zipEntry(zip, 'stack.xml');
  if (!xml) layersError('layersNoStack', {}, 'not an OpenRaster file: stack.xml is missing');
  const image = find(parseXml(dec.decode(xml)), 'image');
  if (!image) layersError('layersNoStack', {}, 'stack.xml has no image');
  const width = +image.attrs.w, height = +image.attrs.h, layers = [], notes = [];
  const note = (code, vars, text) => notes.push({ code, vars, text });
  function* walk(stackEl, groupObjs) { // the first child is the top: bottom first here
    for (const el of [...stackEl.children].reverse()) {
      const a = el.attrs, name = a.name ?? '', visible = a.visibility !== 'hidden', opacity = a.opacity != null ? Math.max(0, Math.min(1, +a.opacity)) : 1;
      const op = a['composite-op'] || 'svg:src-over', blend = BLEND[op] || op.replace(/^svg:/, '');
      if (el.tag === 'stack') {
        const g = { name, visible, opacity: Math.round(opacity * 255), blend: a.isolation === 'isolate' || op !== 'svg:src-over' ? blend : 'passThrough' };
        yield* walk(el, [...groupObjs, g]);
      } else if (el.tag === 'layer') {
        const where = [...groupObjs.map((g) => g.name), name].join('/');
        const src = a.src && (yield* zipEntry(zip, a.src));
        if (!src) { note('layerNoPixels', { layer: where, kind: 'missing' }, `layer ${where}: its picture ${a.src || ''} is not in the file (skipped)`); continue; }
        if (!/\.png$/i.test(a.src)) { note('layerNoPixels', { layer: where, kind: 'notPng' }, `layer ${where}: ${a.src} is not a PNG (skipped)`); continue; }
        const pic = yield* pngGen(src, a.src);
        layers.push(layer(name, groupObjs, { left: Math.round(+a.x || 0), top: Math.round(+a.y || 0), ...pic }, { visible, opacity, blend }));
      }
    }
  }
  const top = find(image, 'stack');
  if (top) yield* walk(top, []);
  return { width, height, layers, notes };
}

// ---- Krita ----
function lzf(src, s, end, out) { // LZF: literal runs and back references
  let o = 0;
  while (s < end) {
    const c = src[s++];
    if (c < 32) { out.set(src.subarray(s, s + c + 1), o); s += c + 1; o += c + 1; continue; }
    let len = c >> 5;
    if (len === 7) len += src[s++];
    let ref = o - ((c & 31) << 8) - src[s++] - 1;
    for (len += 2; len > 0; len--) out[o++] = out[ref++];
  }
  return o;
}
// a paint device file: a text head (VERSION 2, TILEWIDTH, TILEHEIGHT, PIXELSIZE, DATA n), then per
// tile "x,y,LZF,size\n" and size bytes (first byte 1: LZF, 0: as it is); a tile's pixels lie channel
// by channel (all of the first channel, then the next...)
function readTiles(b, ps, fill) {
  let p = 0;
  const line = () => { const e = b.indexOf(10, p); const s = dec.decode(b.subarray(p, e < 0 ? b.length : e)); p = e < 0 ? b.length : e + 1; return s; };
  const head = {};
  while (p < b.length) { const [k, x] = line().split(' '); head[k] = +x; if (k === 'DATA') break; }
  const tw = head.TILEWIDTH || 64, th = head.TILEHEIGHT || 64, size = head.PIXELSIZE || ps, tiles = [];
  for (let k = 0; k < (head.DATA || 0) && p < b.length; k++) {
    const [x, y, , n] = line().split(','), at = p;
    p += +n;
    tiles.push([+x, +y, at, +n]);
  }
  if (!tiles.length && !fill) return null;
  return { tw, th, size, tiles };
}
function kraPixels(b, ps, def, toRgba, canvas) { // -> { left, top, width, height, rgba } (the layer's own coordinates)
  const t = readTiles(b, ps, def);
  if (!t) return null;
  const { tw, th, size, tiles } = t, defOn = def && def[def.length - 1] !== 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of tiles) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + tw); y1 = Math.max(y1, y + th); }
  if (defOn) [x0, y0, x1, y1] = [canvas[0], canvas[1], canvas[2], canvas[3]]; // a filled layer: the canvas
  else [x0, y0, x1, y1] = [Math.max(x0, canvas[0]), Math.max(y0, canvas[1]), Math.min(x1, canvas[2]), Math.min(y1, canvas[3])];
  if (!(x1 > x0 && y1 > y0)) return null;
  const W = x1 - x0, H = y1 - y0, rgba = new Uint8Array(W * H * 4), px = new Uint8Array(size);
  if (defOn) { const c = toRgba(def, 0, 1); for (let i = 0; i < W * H; i++) rgba.set(c, i * 4); }
  const raw = new Uint8Array(tw * th * size);
  for (const [tx, ty, at, n] of tiles) {
    if (tx >= x1 || ty >= y1 || tx + tw <= x0 || ty + th <= y0) continue;
    if (b[at] === 1) lzf(b, at + 1, at + n, raw); else raw.set(b.subarray(at + 1, at + n));
    const plane = tw * th;
    for (let y = Math.max(0, y0 - ty); y < Math.min(th, y1 - ty); y++) for (let x = Math.max(0, x0 - tx); x < Math.min(tw, x1 - tx); x++) {
      const i = y * tw + x;
      for (let c = 0; c < size; c++) px[c] = raw[c * plane + i];
      rgba.set(toRgba(px, 0, 1), ((ty + y - y0) * W + tx + x - x0) * 4);
    }
  }
  return { left: x0, top: y0, width: W, height: H, rgba };
}
// Krita's colour spaces (the channel order its pixels keep): 8 / 16 bits, RGBA (blue first) and grey
const u16 = (p, i) => Math.round((p[i] | (p[i + 1] << 8)) / 257); // 16-bit little-endian -> 8 bits
const SPACES = {
  RGBA: { ps: 4, px: (p) => [p[2], p[1], p[0], p[3]] },
  RGBA16: { ps: 8, px: (p) => [u16(p, 4), u16(p, 2), u16(p, 0), u16(p, 6)] },
  GRAYA: { ps: 2, px: (p) => [p[0], p[0], p[0], p[1]] },
  GRAYA16: { ps: 4, px: (p) => { const g = u16(p, 0); return [g, g, g, u16(p, 2)]; } },
};
function* kraGen(bytes, opts) {
  const zip = readZip(bytes), xml = yield* zipEntry(zip, 'maindoc.xml');
  if (!xml) layersError('layersNoMaindoc', {}, 'not a Krita file: maindoc.xml is missing');
  const doc = find(parseXml(dec.decode(xml)), 'DOC'), image = find(doc, 'IMAGE');
  if (doc && +doc.attrs.syntaxVersion < 2) layersError('layersKraOld', { version: +doc.attrs.syntaxVersion }, 'a Krita 1 file: open it in a current Krita and save it again');
  if (!image) layersError('layersNoMaindoc', {}, 'maindoc.xml has no IMAGE');
  const width = +image.attrs.width, height = +image.attrs.height, dir = `${image.attrs.name}/layers/`, layers = [], notes = [];
  const note = (code, vars, text) => notes.push({ code, vars, text });
  const canvas = [0, 0, width, height];
  function* walk(el, groupObjs) {
    for (const n of [...(find(el, 'layers')?.children || [])].reverse()) {
      const a = n.attrs, name = a.name ?? '', visible = a.visible !== '0', opacity = (+a.opacity || 0) / 255, blend = BLEND[a.compositeop] || a.compositeop || 'normal';
      const where = [...groupObjs.map((g) => g.name), name].join('/'), type = a.nodetype;
      if (type === 'grouplayer') { yield* walk(n, [...groupObjs, { name, visible, opacity: +a.opacity || 0, blend: a.passthrough === '1' ? 'passThrough' : blend }]); continue; }
      if (n.tag === 'mask' || type === 'selectionmask') continue; // the image's selection: not a picture
      if (type === 'adjustmentlayer') { // a filter layer: its settings (layerN.filterconfig, <param name="...">) applied to the layers below at import
        const conf = yield* zipEntry(zip, `${dir}${a.filename}.filterconfig`), params = {};
        if (conf) for (const m of dec.decode(conf).matchAll(/<param[^>]*name="([^"]+)"[^>]*>(?:<!\[CDATA\[)?([^<\]]*)/g)) params[m[1]] = m[2];
        const adjustment = kritaFilter(a.filtername, params);
        layers.push(layer(name, groupObjs, { left: 0, top: 0, width: 0, height: 0, rgba: null }, { kind: 'adjustment', visible, opacity, adjustment }));
        continue;
      }
      if (type !== 'paintlayer') { note('layerNoPixels', { layer: where, kind: type }, `layer ${where}: a ${type} keeps no pixels in the file (skipped); turn it into a paint layer in Krita`); continue; }
      const space = SPACES[a.colorspacename || image.attrs.colorspacename];
      if (!space) { note('layerColorSpace', { layer: where, space: a.colorspacename }, `layer ${where}: colour space ${a.colorspacename} is not read (skipped); convert the image to 8- or 16-bit RGBA in Krita`); continue; }
      const data = yield* zipEntry(zip, dir + a.filename);
      if (!data) { note('layerNoPixels', { layer: where, kind: 'missing' }, `layer ${where}: its pixels are not in the file (skipped)`); continue; }
      const def = yield* zipEntry(zip, `${dir}${a.filename}.defaultpixel`);
      const ox = Math.round(+a.x || 0), oy = Math.round(+a.y || 0);
      const toRgba = (p) => space.px(p);
      const pic = kraPixels(data, space.ps, def, toRgba, [-ox, -oy, width - ox, height - oy]);
      if (!pic) { layers.push(layer(name, groupObjs, { left: 0, top: 0, width: 0, height: 0, rgba: new Uint8Array(0) }, { visible, opacity, blend })); continue; }
      // transparency masks: their alpha times the layer's (other masks are left out, said)
      for (const m of find(n, 'masks')?.children || []) {
        const kind = m.attrs.nodetype;
        if (kind === 'selectionmask') continue;
        if (kind !== 'transparencymask') { note('layerMaskSkipped', { layer: where, kind }, `layer ${where}: its ${kind} is not applied`); continue; }
        if (m.attrs.visible === '0') continue;
        const md = yield* zipEntry(zip, `${dir}${m.attrs.filename}.pixelselection`), mdef = yield* zipEntry(zip, `${dir}${m.attrs.filename}.pixelselection.defaultpixel`);
        const mx = Math.round(+m.attrs.x || 0), my = Math.round(+m.attrs.y || 0), mask = new Uint8Array(pic.width * pic.height).fill(mdef ? mdef[0] : 0);
        // a mask's tiles sit at its own offset in the image, as a layer's do
        const dx = ox - mx, dy = oy - my;
        const mp = md && kraPixels(md, 1, null, (p) => [p[0], 0, 0, 255], [pic.left + dx, pic.top + dy, pic.left + pic.width + dx, pic.top + pic.height + dy]);
        if (mp) for (let y = 0; y < mp.height; y++) for (let x = 0; x < mp.width; x++) mask[(mp.top - dy - pic.top + y) * pic.width + mp.left - dx - pic.left + x] = mp.rgba[(y * mp.width + x) * 4];
        for (let i = 0; i < mask.length; i++) pic.rgba[i * 4 + 3] = Math.round((pic.rgba[i * 4 + 3] * mask[i]) / 255);
      }
      layers.push(layer(name, groupObjs, { ...pic, left: pic.left + ox, top: pic.top + oy }, { visible, opacity, blend }));
    }
  }
  yield* walk(image, []);
  return { width, height, layers, notes };
}

// ---- a set of PNG: one per layer, bottom first; 'face/eye.png' goes in the group face ----
function* pngSetGen(files) {
  const layers = [], folders = new Map();
  let width = 0, height = 0;
  for (const f of files) {
    const parts = f.path.replace(/\\/g, '/').split('/').filter(Boolean), name = parts.pop().replace(/\.png$/i, '');
    const groupObjs = [];
    parts.forEach((g, i) => { const key = parts.slice(0, i + 1).join('/'); if (!folders.has(key)) folders.set(key, { name: g, visible: true, opacity: 255, blend: 'passThrough' }); groupObjs.push(folders.get(key)); });
    const pic = yield* pngGen(f.bytes, f.path);
    width = Math.max(width, pic.width + (f.left || 0)); height = Math.max(height, pic.height + (f.top || 0));
    layers.push(layer(name, groupObjs, { left: f.left || 0, top: f.top || 0, ...pic }, { visible: f.visible !== false, opacity: f.opacity ?? 1, blend: f.blend || 'normal' }));
  }
  return { width, height, layers, notes: [] };
}

// ---- Procreate (.procreate) ----
// A ZIP: Document.archive (an NSKeyedArchiver binary plist), each layer's tiles in
// {UUID}/{col}~{row}.chunk (LZO1X) or .lz4 (Apple's "bv41" LZ4 blocks), premultiplied RGBA (a mask:
// one grey channel), the edge tiles cut to the canvas; QuickLook/Thumbnail.png. From the public
// notes of the silicate and mica projects (the format is not published by its maker).

// binary plist (bplist00): Apple's CoreFoundation format, as its public notes give it
function parseBplist(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dec.decode(b.subarray(0, 8)) !== 'bplist00') layersError('procreateBadArchive', {}, 'Document.archive is not a binary plist');
  const t = b.length - 32, offSize = b[t + 6], refSize = b[t + 7];
  const num = Number(v.getBigUint64(t + 8)), top = Number(v.getBigUint64(t + 16)), tableAt = Number(v.getBigUint64(t + 24));
  const uint = (at, n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + b[at + i]; return x; };
  const offsets = Array.from({ length: num }, (_, i) => uint(tableAt + i * offSize, offSize));
  const cache = new Map();
  const obj = (i) => {
    if (cache.has(i)) return cache.get(i);
    let at = offsets[i];
    const m = b[at] >> 4, low = b[at] & 15;
    const count = () => { if (low < 15) { at += 1; return low; } const n = 1 << (b[at + 1] & 15), c = uint(at + 2, n); at += 2 + n; return c; };
    let out;
    if (m === 0) out = low === 8 ? false : low === 9 ? true : null;
    else if (m === 1) { const n = 1 << low; out = n === 8 ? Number(v.getBigInt64(at + 1)) : uint(at + 1, n); }
    else if (m === 2) out = low === 2 ? v.getFloat32(at + 1) : v.getFloat64(at + 1);
    else if (m === 3) out = v.getFloat64(at + 1);
    else if (m === 4) { const n = count(); out = b.slice(at, at + n); }
    else if (m === 5) { const n = count(); out = String.fromCharCode(...b.subarray(at, at + n)); }
    else if (m === 6) { const n = count(); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(v.getUint16(at + 2 * k)); out = s; }
    else if (m === 8) out = { uid: uint(at + 1, low + 1) };
    else if (m === 10 || m === 12) { const n = count(); out = []; cache.set(i, out); for (let k = 0; k < n; k++) out.push(obj(uint(at + k * refSize, refSize))); return out; }
    else if (m === 13) {
      const n = count(); out = {}; cache.set(i, out);
      for (let k = 0; k < n; k++) out[obj(uint(at + k * refSize, refSize))] = obj(uint(at + (n + k) * refSize, refSize));
      return out;
    } else layersError('procreateBadArchive', { type: m }, `Document.archive: plist object type ${m} is not read`);
    cache.set(i, out);
    return out;
  };
  return obj(top);
}
// NSKeyedArchiver: values point into $objects by UID; arrays are { NS.objects }, strings may be { NS.string }
function keyed(plist) {
  const objects = plist.$objects;
  const val = (x) => {
    if (x && typeof x === 'object' && 'uid' in x && Object.keys(x).length === 1) x = objects[x.uid];
    if (x === '$null') return null;
    if (x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Uint8Array)) {
      if ('NS.objects' in x) return x['NS.objects'].map(val);
      if ('NS.string' in x) return x['NS.string'];
      if ('NS.bytes' in x) return x['NS.bytes'];
    }
    return x;
  };
  const get = (o, k) => (o && k in o ? val(o[k]) : undefined);
  const className = (o) => { const c = o && o.$class && val(o.$class); return c && c.$classname; };
  return { root: val(plist.$top.root), get, className };
}

// LZO1X (the stream format as the Linux kernel's LZO documentation describes it)
function lzo1x(src, out) {
  let ip = 0, op = 0, state = 0;
  const lit = (n) => { out.set(src.subarray(ip, ip + n), op); ip += n; op += n; };
  const copy = (dist, n) => { let r = op - dist; if (r < 0) throw new Error('LZO: a match before the start'); for (; n > 0; n--) out[op++] = out[r++]; };
  const ext = (base) => { let n = 0; while (src[ip] === 0) { n += 255; ip++; } return base + n + src[ip++]; };
  if (src[0] > 17) { const n = src[ip++] - 17; lit(n); state = n < 4 ? n : 4; }
  while (ip < src.length) {
    const t = src[ip++];
    if (t < 16) {
      if (state === 0) { const n = (t === 0 ? ext(15) : t) + 3; lit(n); state = 4; continue; }
      const h = src[ip++], len = state === 4 ? 3 : 2, dist = state === 4 ? (h << 2) + ((t >> 2) & 3) + 2049 : (h << 2) + ((t >> 2) & 3) + 1;
      copy(dist, len);
      state = t & 3; lit(state);
      continue;
    }
    let len, dist, s;
    if (t >= 64) { len = t >= 128 ? 5 + ((t >> 5) & 3) : 3 + ((t >> 5) & 1); dist = (src[ip++] << 3) + ((t >> 2) & 7) + 1; s = t & 3; }
    else if (t >= 32) { len = (t & 31 ? t & 31 : ext(31)) + 2; const d = src[ip] | (src[ip + 1] << 8); ip += 2; dist = (d >> 2) + 1; s = d & 3; }
    else { // 16..31: a far match, or the end
      len = (t & 7 ? t & 7 : ext(7)) + 2; const d = src[ip] | (src[ip + 1] << 8); ip += 2; dist = 16384 + ((t & 8) << 11) + (d >> 2); s = d & 3;
      if (dist === 16384) return op; // end of stream
    }
    copy(dist, len);
    state = s; lit(s);
  }
  return op;
}
// LZ4 blocks in Apple's framing: 'bv41' decoded size, encoded size, a block (it may reach back into
// the block before), 'bv4-' size and raw bytes, 'bv4$' the end
function lz4Apple(src, out) {
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  let ip = 0, op = 0;
  while (ip + 4 <= src.length) {
    const tag = String.fromCharCode(src[ip], src[ip + 1], src[ip + 2], src[ip + 3]);
    if (tag === 'bv4$') break;
    if (tag === 'bv4-') { const n = v.getUint32(ip + 4, true); out.set(src.subarray(ip + 8, ip + 8 + n), op); op += n; ip += 8 + n; continue; }
    if (tag !== 'bv41') throw new Error(`LZ4: unknown block ${tag}`);
    const n = v.getUint32(ip + 4, true), m = v.getUint32(ip + 8, true);
    let p = ip + 12;
    const end = p + m, stop = op + n;
    while (p < end) { // tokens: literals, then a match (offset, length) except at the block's end
      const tok = src[p++];
      let l = tok >> 4;
      if (l === 15) { let k; do { k = src[p++]; l += k; } while (k === 255); }
      out.set(src.subarray(p, p + l), op); p += l; op += l;
      if (p >= end || op >= stop) break;
      const off = src[p] | (src[p + 1] << 8); p += 2;
      let ml = (tok & 15) + 4;
      if ((tok & 15) === 15) { let k; do { k = src[p++]; ml += k; } while (k === 255); }
      for (let r = op - off; ml > 0; ml--) out[op++] = out[r++];
    }
    ip = end;
  }
  return op;
}

const PROCREATE_BLEND = ['normal', 'multiply', 'screen', 'add', 'lighten', 'exclusion', 'difference', 'subtract', 'linearBurn', 'colorDodge', 'colorBurn', 'overlay', 'hardLight', 'color', 'luminosity', 'hue', 'saturation', 'softLight', 'normal', 'darken', 'hardMix', 'vividLight', 'linearLight', 'pinLight', 'lighterColor', 'darkerColor', 'divide'];

function* procreateGen(bytes, opts) {
  const zip = readZip(bytes), arch = yield* zipEntry(zip, 'Document.archive');
  if (!arch) layersError('procreateNoArchive', {}, 'not a Procreate file: Document.archive is missing');
  const { root, get, className } = keyed(parseBplist(arch));
  const size = /\{\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(get(root, 'size') || '');
  if (!size) layersError('procreateBadArchive', {}, 'Document.archive has no canvas size');
  const W = +size[1], H = +size[2], tile = get(root, 'tileSize') || 256, cols = Math.ceil(W / tile), rows = Math.ceil(H / tile);
  const notes = [], note = (code, vars, text) => notes.push({ code, vars, text });
  const names = [...zip.entries.keys()];
  // a layer's tiles -> its canvas-sized pixels (straight RGBA), or a mask's grey plane
  function* tilesOf(uuid, grey) {
    const ch = grey ? 1 : 4, out = new Uint8Array(W * H * ch);
    let any = false;
    for (const name of names) {
      const m = name.startsWith(`${uuid}/`) && /^(\d+)~(\d+)\.(chunk|lz4)$/.exec(name.slice(uuid.length + 1));
      if (!m) continue;
      const col = +m[1], row = +m[2];
      if (col >= cols || row >= rows) continue;
      const tw = Math.min(tile, W - col * tile), th = Math.min(tile, H - row * tile), data = yield* zipEntry(zip, name), px = new Uint8Array(tw * th * ch);
      try { (m[3] === 'lz4' ? lz4Apple : lzo1x)(data, px); } catch (e) { note('layerUnreadable', { layer: uuid }, `layer ${uuid}: tile ${col}~${row} could not be read (${e.message})`); continue; }
      for (let y = 0; y < th; y++) out.set(px.subarray(y * tw * ch, (y + 1) * tw * ch), ((row * tile + y) * W + col * tile) * ch);
      any = true;
    }
    if (!grey) for (let i = 0; i < out.length; i += 4) { const a = out[i + 3]; if (a && a < 255) for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((out[i + c] * 255) / a)); } // premultiplied -> straight
    return any || grey ? out : null;
  }
  const layers = [];
  function* walk(list, groupObjs) { // top first in the file: bottom first here
    for (const node of [...(list || [])].reverse()) {
      if (!node) continue;
      const name = get(node, 'name') ?? '', where = [...groupObjs.map((g) => g.name), name].join('/');
      if (className(node) === 'SilicaGroup' || get(node, 'children')) {
        yield* walk(get(node, 'children'), [...groupObjs, { name, visible: !get(node, 'isHidden'), opacity: 255, blend: 'passThrough' }]);
        continue;
      }
      const uuid = get(node, 'UUID'), pixels = uuid && (yield* tilesOf(uuid, false));
      const blendNo = get(node, 'extendedBlend') ?? get(node, 'blend') ?? 0, blend = PROCREATE_BLEND[blendNo] || `procreate${blendNo}`;
      if (!pixels) { layers.push(layer(name, groupObjs, { left: 0, top: 0, width: 0, height: 0, rgba: new Uint8Array(0) }, { visible: !get(node, 'hidden') })); continue; }
      const mask = get(node, 'mask'), mu = mask && get(mask, 'UUID');
      if (mu) { const plane = yield* tilesOf(mu, true); for (let i = 0; i < W * H; i++) pixels[i * 4 + 3] = Math.round((pixels[i * 4 + 3] * plane[i]) / 255); }
      layers.push(layer(name, groupObjs, { left: 0, top: 0, width: W, height: H, rgba: pixels }, { visible: !get(node, 'hidden'), opacity: Math.max(0, Math.min(1, get(node, 'opacity') ?? 1)), blend, clipping: get(node, 'clipped') ? 1 : 0 }));
      void where;
    }
  }
  yield* walk(get(root, 'unwrappedLayers'), []);
  // the background colour (when shown), as the bottom layer
  const bgBytes = get(root, 'backgroundColor');
  if (get(root, 'backgroundHidden') === false && bgBytes?.length >= 16) {
    const f = new DataView(bgBytes.buffer, bgBytes.byteOffset, bgBytes.byteLength), c = [0, 4, 8].map((k) => Math.round(Math.max(0, Math.min(1, f.getFloat32(k, true))) * 255));
    const rgba = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) rgba.set([...c, 255], i * 4);
    layers.unshift(layer('background', [], { left: 0, top: 0, width: W, height: H, rgba }, {}));
  }
  // which way the rows run: the layers over each other against the file's own thumbnail, as they
  // are and upside down (the public notes do not say; the thumbnail does)
  const thumbBytes = yield* zipEntry(zip, 'QuickLook/Thumbnail.png');
  if (thumbBytes && opts.checkRows !== false) {
    const th = yield* pngGen(thumbBytes, 'Thumbnail.png'), diff = (flip) => {
      let e = 0, n = 0;
      for (let ty = 0; ty < th.height; ty += 2) for (let tx = 0; tx < th.width; tx += 2) {
        const x = Math.min(W - 1, Math.floor(((tx + 0.5) * W) / th.width)), y0 = Math.min(H - 1, Math.floor(((ty + 0.5) * H) / th.height)), y = flip ? H - 1 - y0 : y0;
        let r = 0, g = 0, bl = 0, a = 0;
        for (const L of layers) { if (!L.visible || !L.width) continue; const i = (y * W + x) * 4, la = (L.rgba[i + 3] / 255) * L.opacity; r = r * (1 - la) + L.rgba[i] * la; g = g * (1 - la) + L.rgba[i + 1] * la; bl = bl * (1 - la) + L.rgba[i + 2] * la; a = a * (1 - la) + la; }
        const t = (ty * th.width + tx) * 4, ta = th.rgba[t + 3] / 255;
        e += Math.abs(r - th.rgba[t] * ta) + Math.abs(g - th.rgba[t + 1] * ta) + Math.abs(bl - th.rgba[t + 2] * ta) + 255 * Math.abs(a - ta); n++;
      }
      return e / Math.max(1, n);
    };
    const asIs = diff(false), flipped = diff(true);
    if (flipped < asIs * 0.7) {
      for (const L of layers) if (L.width) { const row = W * 4, tmp = new Uint8Array(row); for (let y = 0; y < H >> 1; y++) { const a = y * row, b2 = (H - 1 - y) * row; tmp.set(L.rgba.subarray(a, a + row)); L.rgba.copyWithin(a, b2, b2 + row); L.rgba.set(tmp, b2); } }
      notes.push({ code: 'procreateRowsFlipped', vars: {}, text: 'the tiles\' rows run bottom up in this file (the thumbnail says so): read upside down', level: 'info' });
    }
  }
  return { width: W, height: H, layers, notes };
}

// ---- Aseprite (.aseprite / .ase) ----
const ASE_BLEND = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'colorDodge', 'colorBurn', 'hardLight', 'softLight', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add', 'subtract', 'divide'];
function* aseGen(bytes, opts = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const broken = (what) => layersError('aseBroken', { what }, `the Aseprite file is broken (${what})`);
  if (b.length < 128 || dv.getUint16(4, true) !== 0xa5e0) layersError('aseNotAseprite', {}, 'not an Aseprite file (no 0xA5E0 in its header)');
  const frames = dv.getUint16(6, true), W = dv.getUint16(8, true), H = dv.getUint16(10, true), depth = dv.getUint16(12, true), flags = dv.getUint32(14, true);
  const transparent = b[28], pw = b[34], ph = b[35];
  if (![32, 16, 8].includes(depth)) layersError('aseDepth', { depth }, `Aseprite colour depth ${depth} is not read (32, 16 or 8)`);
  if (!W || !H || !frames) broken('size');
  const notes = [], note = (code, vars, text, level = 'warn') => notes.push({ code, vars, text, level });
  const bpp = depth / 8;
  const animate = opts.frames === 'animate';
  const layerRecs = [], celsByFrame = [], durations = [], tags = [];
  let palette = null, oldPalette = null;
  const str = (o, end) => { if (o + 2 > end) broken('string'); const n = dv.getUint16(o, true); if (o + 2 + n > end) broken('string'); return [dec.decode(b.subarray(o + 2, o + 2 + n)), o + 2 + n]; };
  let o = 128;
  for (let f = 0; f < frames; f++) {
    if (o + 16 > b.length) broken('frame');
    const fsize = dv.getUint32(o, true);
    if (dv.getUint16(o + 4, true) !== 0xf1fa) broken('frame');
    if (fsize < 16 || o + fsize > b.length) broken('frame');
    const old = dv.getUint16(o + 6, true), neu = dv.getUint32(o + 12, true), count = neu || old;
    durations[f] = dv.getUint16(o + 8, true) || dv.getUint16(18, true) || 100;
    const cels = celsByFrame[f] = new Map();
    const fend = o + fsize;
    let c = o + 16;
    for (let k = 0; k < count && c < fend; k++) {
      if (c + 6 > fend) broken('chunk');
      const csize = dv.getUint32(c, true), type = dv.getUint16(c + 4, true), end = c + csize;
      if (csize < 6 || end > fend) broken('chunk');
      const d = c + 6;
      if (f === 0 && type === 0x2004) { // layer
        if (d + 16 > end) broken('layer');
        const [name, after] = str(d + 16, end);
        layerRecs.push({ flags: dv.getUint16(d, true), type: dv.getUint16(d + 2, true), level: dv.getUint16(d + 4, true), blend: dv.getUint16(d + 10, true), opacity: b[d + 12], name });
        void after;
      } else if ((f === 0 || animate) && type === 0x2005) { // cel
        if (d + 16 > end) broken('cel');
        const li = dv.getUint16(d, true), x = dv.getInt16(d + 2, true), y = dv.getInt16(d + 4, true), op = b[d + 6], ct = dv.getUint16(d + 7, true), z = dv.getInt16(d + 9, true);
        const cel = { x, y, opacity: op, type: ct, z };
        if (ct === 0 || ct === 2) {
          if (d + 20 > end) broken('cel');
          cel.width = dv.getUint16(d + 16, true); cel.height = dv.getUint16(d + 18, true);
          const n = cel.width * cel.height * bpp, data = b.subarray(d + 20, end);
          if (ct === 0) { if (data.length < n) broken('cel'); cel.pixels = data.subarray(0, n); }
          else {
            let px;
            try { px = yield { data }; } catch { broken('cel data'); }
            if (px.length < n) broken('cel data');
            cel.pixels = px.subarray(0, n);
          }
        } else if (ct === 1) cel.link = dv.getUint16(d + 16, true);
        cels.set(li, cel);
      } else if (type === 0x2019) { // palette
        if (d + 20 > end) broken('palette');
        const total = dv.getUint32(d, true), first = dv.getUint32(d + 4, true), last = dv.getUint32(d + 8, true);
        if (total > 65536 || last < first || last >= Math.max(total, 1)) broken('palette');
        palette ||= new Uint8Array(Math.max(256, total) * 4);
        let q = d + 20;
        for (let i = first; i <= last; i++) {
          if (q + 6 > end) broken('palette');
          const ef = dv.getUint16(q, true);
          palette.set(b.subarray(q + 2, q + 6), i * 4);
          q += 6;
          if (ef & 1) q = str(q, end)[1];
        }
      } else if ((type === 0x0004 || type === 0x0011) && f === 0) { // old palettes (used only when there is no new one)
        oldPalette ||= new Uint8Array(256 * 4);
        const packets = dv.getUint16(d, true);
        let q = d + 2, at = 0;
        for (let p = 0; p < packets; p++) {
          if (q + 2 > end) broken('palette');
          at += b[q]; const n = b[q + 1] || 256; q += 2;
          for (let i = 0; i < n; i++, at++) {
            if (q + 3 > end) broken('palette');
            if (at < 256) for (let k2 = 0; k2 < 3; k2++) oldPalette[at * 4 + k2] = type === 0x0011 ? Math.round((b[q + k2] * 255) / 63) : b[q + k2];
            if (at < 256) oldPalette[at * 4 + 3] = 255;
            q += 3;
          }
        }
      } else if (type === 0x2018) { // tags
        if (d + 10 > end) broken('tags');
        const n = dv.getUint16(d, true);
        let q = d + 10;
        for (let t = 0; t < n; t++) {
          if (q + 17 > end) broken('tags');
          const from = dv.getUint16(q, true), to = dv.getUint16(q + 2, true), dir = b[q + 4], repeat = dv.getUint16(q + 5, true);
          const [name, next] = str(q + 17, end);
          if (from <= to && to < frames) tags.push({ name, from, to, dir, repeat }); else note('aseTagRange', { tag: name, from, to }, `tag ${name}: frames ${from + 1}–${to + 1} are not in the file (skipped)`);
          q = next;
        }
      }
      c = end;
    }
    o = fend;
  }
  const pal = palette || oldPalette;
  if (depth === 8 && !pal) layersError('aseNoPalette', {}, 'an indexed Aseprite file without a palette');
  // a cel's pixels as straight RGBA (cel opacity in the alpha)
  const rgbaOf = (cel, background) => {
    const n = cel.width * cel.height, rgba = new Uint8Array(n * 4), px = cel.pixels;
    for (let p = 0; p < n; p++) {
      if (depth === 32) rgba.set(px.subarray(p * 4, p * 4 + 4), p * 4);
      else if (depth === 16) { const v = px[p * 2]; rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = px[p * 2 + 1]; }
      else { const ix = px[p]; if (ix === transparent && !background) continue; rgba.set(pal.subarray(ix * 4, ix * 4 + 4), p * 4); if (!palette) rgba[p * 4 + 3] = 255; }
      if (cel.opacity < 255) rgba[p * 4 + 3] = Math.round((rgba[p * 4 + 3] * cel.opacity) / 255);
    }
    return rgba;
  };
  // the cel of a layer in a frame, links followed (to an earlier frame)
  const celAt = (f, i, seen = 0) => {
    const c = celsByFrame[f]?.get(i);
    if (!c || c.type !== 1) return c || null;
    return c.link < f && seen < frames ? celAt(c.link, i, seen + 1) : null;
  };
  // a picture's key: two cels with the same place and the same pixels are one picture
  const keyOf = (c) => {
    let h = 2166136261;
    for (let k = 0; k < c.pixels.length; k++) h = Math.imul(h ^ c.pixels[k], 16777619);
    return `${c.x},${c.y},${c.width},${c.height},${c.opacity},${c.pixels.length},${h >>> 0}`;
  };
  const shown = (c) => c && (c.type === 0 || c.type === 2) && c.width && c.height;
  // animate: each layer's pictures over the frames (null where it has none); too many -> the first frame only
  let anim = null;
  if (animate) {
    const maxParts = opts.maxFrameParts ?? 512;
    const perLayer = layerRecs.map((L, i) => {
      if (L.type !== 0 || L.flags & 64) return null;
      const keys = [], pics = new Map();
      for (let f = 0; f < frames; f++) { const c = celAt(f, i); if (!shown(c)) { keys.push(null); continue; } const k = keyOf(c); if (!pics.has(k)) pics.set(k, { cel: c, first: f }); keys.push(k); }
      return { keys, pics };
    });
    const count = perLayer.reduce((n, x) => n + (x ? x.pics.size : 0), 0);
    if (count > maxParts) note('aseFramesTooMany', { parts: count, max: maxParts }, `the frames hold ${count} different pictures, more than ${maxParts}: only the first frame is read (raise opts.maxFrameParts to read them all)`);
    else anim = { perLayer, parts: count };
  }
  // layers: bottom first; child level -> the groups above it
  const layers = [], groupAt = [], frameParts = [];
  layerRecs.forEach((L, i) => {
    const groupObjs = groupAt.slice(0, L.level).filter(Boolean);
    const where = [...groupObjs.map((g) => g.name), L.name].join('/');
    const visible = !!(L.flags & 1);
    if (L.type === 1) {
      const valid = flags & 2, blend = ASE_BLEND[L.blend] || 'normal';
      const g = { name: L.name, visible, opacity: valid ? L.opacity : 255, blend: valid && (blend !== 'normal' || L.opacity < 255) ? blend : 'passThrough' };
      groupAt[L.level] = g; groupAt.length = L.level + 1;
      return;
    }
    groupAt.length = L.level;
    if (L.type === 2) { note('aseTilemap', { layer: where }, `layer ${where}: tilemap layers are not read (skipped)`); return; }
    if (L.flags & 64) { note('aseReference', { layer: where }, `layer ${where}: a reference layer (skipped)`, 'info'); return; }
    const blend = ASE_BLEND[L.blend] || 'normal', opacity = flags & 1 ? L.opacity / 255 : 1, background = !!(L.flags & 8);
    for (let f = 0; f < (anim ? frames : 1); f++) {
      const c = celsByFrame[f]?.get(i);
      if (c?.type === 3) { note('aseTilemap', { layer: where }, `layer ${where}: a tilemap cel (skipped)`); break; }
      if (c?.z) { note('aseZIndex', { layer: where, z: c.z }, `layer ${where}: its cel is drawn ${c.z} layer(s) ${c.z > 0 ? 'later' : 'earlier'} in Aseprite; here in the layer's own place`); break; }
    }
    const per = anim?.perLayer[i];
    if (per && per.pics.size > 1) {
      // several pictures: a group named after the layer, a part per picture ("name#frame", the
      // frame where it first shows, counted from 1 as Aseprite does)
      const g = { name: L.name, visible, opacity: 255, blend: 'passThrough', aseFrames: true };
      for (const [k, { cel, first }] of per.pics) {
        const token = { layer: i, key: k, opacity, visible };
        layers.push(layer(`${L.name}#${first + 1}`, [...groupObjs, g], { left: cel.x, top: cel.y, width: cel.width, height: cel.height, rgba: rgbaOf(cel, background) }, { visible, opacity, blend, index: frameParts.push(token) - 1 }));
      }
      return;
    }
    let cel = per ? (per.pics.size ? [...per.pics.values()][0].cel : null) : celsByFrame[0].get(i);
    if (!per && cel?.type === 1) { note('aseLinkedLater', { layer: where }, `layer ${where}: its first cel links to another frame (empty here)`); cel = null; }
    if (!shown(cel)) { layers.push(layer(L.name, groupObjs, { left: 0, top: 0, width: 0, height: 0, rgba: new Uint8Array(0) }, { visible, opacity, blend })); return; }
    const more = { visible, opacity, blend };
    if (per && per.keys.some((k) => k === null)) more.index = frameParts.push({ layer: i, key: [...per.pics.keys()][0], opacity, visible }) - 1; // shown in some frames only
    layers.push(layer(L.name, groupObjs, { left: cel.x, top: cel.y, width: cel.width, height: cel.height, rgba: rgbaOf(cel, background) }, more));
  });
  if (anim) {
    // the animations: one per tag (the whole file without tags), the frames in the tag's direction
    // and repeats, each frame's duration in seconds
    const list = tags.length ? tags : [{ name: 'frames', from: 0, to: frames - 1, dir: 0, repeat: 0 }];
    const order = (t) => {
      const fw = []; for (let f = t.from; f <= t.to; f++) fw.push(f);
      const bw = [...fw].reverse();
      const once = t.dir === 1 ? bw : t.dir === 2 ? [...fw, ...bw.slice(1, -1)] : t.dir === 3 ? [...bw, ...fw.slice(1, -1)] : fw;
      const times = Math.max(1, t.repeat || 1), seq = [];
      for (let r = 0; r < times; r++) seq.push(...once);
      if ((t.dir === 2 || t.dir === 3) && t.repeat) seq.push(t.dir === 2 ? t.from : t.to); // a counted ping-pong ends where it started
      return seq;
    };
    anim.animations = list.map((t) => ({ name: t.name, loop: !t.repeat, frames: order(t) }));
    anim.durations = durations;
    note('aseAnimated', { animations: anim.animations.map((a) => a.name), frames, parts: anim.parts }, `${frames} frames read as ${anim.animations.length} animation(s) (${anim.animations.map((a) => a.name).join(', ')}): ${anim.parts} pictures`, 'info');
  } else {
    if (frames > 1) note('aseFrames', { frames }, `the file has ${frames} frames: the first is read (read them as animations with opts.frames 'animate')`);
    if (tags.length) note('aseTags', { tags: tags.map((t) => t.name), frames: tags.map((t) => [t.from, t.to]) }, `tags (animations in Aseprite) are not read: ${tags.map((t) => `${t.name} (frames ${t.from + 1}–${t.to + 1})`).join(', ')}`);
  }
  if (pw && ph && pw !== ph) note('asePixelRatio', { width: pw, height: ph }, `the pixels are ${pw}:${ph} in Aseprite: read square`);
  note('aseNearest', {}, 'pixel art: draw and export it with the nearest texel (no blending), so the dots stay sharp', 'info');
  return { width: W, height: H, layers, notes, aseAnim: anim && { ...anim, frameParts } };
}

// the frame pictures' parts shown and hidden over time: opacity keys that step at each frame
function aseAnimations(res, doc) {
  const A = doc.aseAnim;
  if (!A) return res;
  const partOf = new Map(res.layers.filter((l) => l.psdIndex !== undefined).map((l) => [l.psdIndex, l.part]));
  const restKey = (tok) => A.perLayer[tok.layer].keys[0];
  // in the rest pose (no animation) the first frame shows
  A.frameParts.forEach((tok, k) => {
    const id = partOf.get(k), part = id && res.model.parts.find((p) => p.id === id);
    if (part && tok.visible && restKey(tok) !== tok.key) part.opacity = 0;
  });
  for (const a of A.animations) {
    const out = { id: a.name, duration: 0, loop: a.loop, opacity: {} };
    const starts = [];
    let t = 0;
    for (const f of a.frames) { starts.push(t); t += A.durations[f] / 1000; }
    out.duration = +t.toFixed(6);
    A.frameParts.forEach((tok, k) => {
      const id = partOf.get(k);
      if (!id || !tok.visible) return;
      const keys = [];
      let last = null;
      a.frames.forEach((f, j) => {
        const v = A.perLayer[tok.layer].keys[f] === tok.key ? +tok.opacity.toFixed(4) : 0;
        if (v !== last) { keys.push([+starts[j].toFixed(6), v, 'step']); last = v; }
      });
      if (keys.length === 1 && keys[0][1] === (restKey(tok) === tok.key ? +tok.opacity.toFixed(4) : 0)) return; // the same as the rest pose all through
      keys.push([out.duration, last, 'step']);
      out.opacity[id] = keys;
    });
    res.model.animations.push(out);
  }
  // the frame groups: say which they are, so the editor can fold them
  for (const g of res.groups) if (doc.layers.some((L) => L.groupObjs.some((o) => o.aseFrames && o.name === g.name))) g.frames = true;
  return res;
}


function finish(doc, opts) {
  if (!doc.layers.some((L) => L.kind !== 'adjustment')) layersError('layersNone', { reasons: [...new Set(doc.notes.map((n) => n.code))] }, `the file has no layers that can be read${doc.notes.length ? ` (${doc.notes[0].text})` : ''}`);
  doc.notes = doc.notes.map((n) => ({ level: 'warn', ...n }));
  return importLayerStack(doc, opts);
}
/** A Krita .kra -> the same as importPsd ({ model, atlas, atlases, groups, layers, scale, warnings, notes }). Node: opts.inflate and opts.inflateRaw. */
export const importKra = (bytes, opts = {}) => finish(runSync(kraGen(bytes, opts), opts), opts);
export const importKraAsync = async (bytes, opts = {}) => finish(await runAsync(kraGen(bytes, opts), opts), opts);
/** An OpenRaster .ora -> the same as importPsd. */
export const importOra = (bytes, opts = {}) => finish(runSync(oraGen(bytes, opts), opts), opts);
export const importOraAsync = async (bytes, opts = {}) => finish(await runAsync(oraGen(bytes, opts), opts), opts);
/** PNG files, one per layer, bottom first: [{ path ('eye.png', 'face/eye.png'), bytes, left?, top?, visible?, opacity?, blend? }].
 *  The canvas is the largest of them (pictures exported at the canvas size line up as they are). */
export const importPngSet = (files, opts = {}) => finish(runSync(pngSetGen(files), opts), opts);
export const importPngSetAsync = async (files, opts = {}) => finish(await runAsync(pngSetGen(files), opts), opts);
/** LZO1X: src -> out (its decompressed size known); -> the bytes written. */
export const lzo1xDecompress = (src, out) => lzo1x(src, out);
/** A Procreate .procreate -> the same as importPsd. Node: opts.inflate and opts.inflateRaw. opts.checkRows false: no thumbnail check. */
export const importProcreate = (bytes, opts = {}) => finish(runSync(procreateGen(bytes, opts), opts), opts);
export const importProcreateAsync = async (bytes, opts = {}) => finish(await runAsync(procreateGen(bytes, opts), opts), opts);
/** An Aseprite .aseprite / .ase -> the same as importPsd (its first frame). Node: opts.inflate. */
// opts.frames 'animate': every frame, the tags as animations (default: the first frame only)
export const importAseprite = (bytes, opts = {}) => { const doc = runSync(aseGen(bytes, opts), opts); return aseAnimations(finish(doc, opts), doc); };
export const importAsepriteAsync = async (bytes, opts = {}) => { const doc = await runAsync(aseGen(bytes, opts), opts); return aseAnimations(finish(doc, opts), doc); };
/** Which of these a file is, by its bytes: 'kra' | 'ora' | 'procreate' | 'aseprite' | 'png' | 'psd' | null. */
export function layeredKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), s = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (s(0, 4) === '8BPS') return 'psd';
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'png';
  if (b.length >= 128 && b[4] === 0xe0 && b[5] === 0xa5) return 'aseprite';
  if (s(0, 4) !== 'PK\x03\x04') return null;
  if (s(30, 8) === 'mimetype') { const m = s(38, 40); if (/image\/openraster/.test(m)) return 'ora'; if (/application\/x-krita/.test(m)) return 'kra'; }
  try { const z = readZip(b); return z.entries.has('maindoc.xml') ? 'kra' : z.entries.has('stack.xml') ? 'ora' : z.entries.has('Document.archive') ? 'procreate' : null; } catch { return null; }
}

// ---- CLI: node tools/import_layers.mjs picture.kra|picture.ora|picture.procreate|folder-of-png outDir [the options of import_psd.mjs] ----
// A folder: its PNG files (sub-folders become groups) bottom first by name ('01 body.png' under
// '02 face.png'), or in the order of an order.txt in it (one path a line, the top first, as a layer panel lists them).
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const fs = await import('node:fs'), path = await import('node:path'), zlib = await import('node:zlib');
  const { encodePng } = await import('./png.mjs');
  const { compileUgo } = await import('./compile.mjs');
  const args = process.argv.slice(2), flags = ['--group-bones', '--no-clipping'];
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !flags.includes(args[i - 1])));
  const [src, outDir = 'build/layers'] = files;
  if (!src) { console.error('usage: node tools/import_layers.mjs picture.kra|picture.ora|picture.procreate|picture.aseprite|folder outDir [--spacing 24] [--mesh auto|contour|grid] [--alpha 8] [--group-bones] [--no-clipping] [--padding 2] [--atlas-page tight|pow2|square] [--max-atlas 4096]'); process.exit(2); }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const opts = { groupBones: args.includes('--group-bones'), clipping: !args.includes('--no-clipping'), spacing: opt('--spacing', 24), mesh: args.includes('--mesh') ? args[args.indexOf('--mesh') + 1] : 'auto',
    alphaMin: opt('--alpha', 8), padding: opt('--padding', 2), maxAtlasSize: opt('--max-atlas', 4096),
    atlasPage: args.includes('--atlas-page') ? args[args.indexOf('--atlas-page') + 1] : 'tight', inflate: (b) => zlib.inflateSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };
  let res;
  if (fs.statSync(src).isDirectory()) {
    const list = [];
    const walk = (dir) => { for (const e of fs.readdirSync(path.join(src, dir), { withFileTypes: true })) { const rel = dir ? `${dir}/${e.name}` : e.name; if (e.isDirectory()) walk(rel); else if (/\.png$/i.test(e.name)) list.push(rel); } };
    walk('');
    const orderFile = path.join(src, 'order.txt');
    if (fs.existsSync(orderFile)) {
      const order = fs.readFileSync(orderFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).reverse();
      const missing = order.filter((p) => !list.includes(p));
      if (missing.length) { console.error(`order.txt names files that are not there: ${missing.join(', ')}`); process.exit(1); }
      list.splice(0, list.length, ...order);
    } else list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    res = importPngSet(list.map((p) => ({ path: p, bytes: fs.readFileSync(path.join(src, p)) })), opts);
  } else {
    const bytes = fs.readFileSync(src), kind = layeredKind(bytes);
    if (!['kra', 'ora', 'procreate', 'aseprite'].includes(kind)) { console.error(`${src}: not a Krita (.kra), OpenRaster (.ora), Procreate (.procreate) or Aseprite (.aseprite) file${kind === 'psd' ? ' (a PSD: use tools/import_psd.mjs)' : ''}`); process.exit(1); }
    res = ({ kra: importKra, ora: importOra, procreate: importProcreate, aseprite: importAseprite })[kind](bytes, opts);
  }
  fs.mkdirSync(outDir, { recursive: true });
  res.atlases.forEach((a, i) => fs.writeFileSync(path.join(outDir, res.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(res.model, null, 1));
  const bin = compileUgo(res.model);
  fs.writeFileSync(path.join(outDir, 'model.ug9'), new Uint8Array(bin));
  const nv = res.model.parts.reduce((s, p) => s + p.vertices.length / 2, 0);
  console.log(`${path.basename(src)} -> ${outDir}/model.ug9: ${res.model.parts.length} parts, ${res.groups.length} groups, ${nv} vertices, atlas ${res.atlases.map((a) => `${a.width}x${a.height}`).join(' + ')}, ${bin.byteLength} bytes`);
  for (const w of res.warnings) console.log(`warning: ${w}`);
}
