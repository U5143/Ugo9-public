// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// One more layer in a PSD, the rest left as it is (wish 5: a mask drawn in the editor goes back
// into the artist's PSD as a layer of its own). Plain ES module, no Node API.
//
//   import { addLayerToPsd } from '../tools/psd_add_layer.mjs';
//   const out = addLayerToPsd(psdBytes, { name: 'マスク 目', left: 40, top: 60, width: 120, height: 80, rgba });
//
// The new layer goes on top of the others (last in the file's records, which run bottom to top),
// outside any folder, as a normal layer: 8-bit RGBA, RLE (PackBits) channels, its name in the
// Pascal name and in a 'luni' block (Unicode). Everything else is copied byte for byte: the header,
// the colour mode data, the image resources, the other layers' records and channel data, the
// global layer mask info and the additional blocks after the layers, and the merged picture at the
// end (which then does not show the new layer: Photoshop draws from the layers; apps that only
// read the merged picture show it without the new layer). Written from Adobe's published
// "Photoshop File Formats Specification". Reads 8-bit RGB PSD and PSB with their layers in the
// layer info (16-bit files keep theirs in an 'Lr16' block: not written to yet).

const enc = new TextEncoder();

export function packBits(row) { // PackBits, one row
  const out = [];
  for (let i = 0; i < row.length;) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run > 1) { out.push(257 - run, row[i]); i += run; continue; }
    let lit = 1;
    while (i + lit < row.length && lit < 128 && !(i + lit + 1 < row.length && row[i + lit] === row[i + lit + 1])) lit++;
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(row[i + k]);
    i += lit;
  }
  return out;
}

// a PSD that can't take a layer here: an Error with a code and values for the editor to word
function addError(code, vars, text) { const e = new Error(text); e.code = code; e.vars = vars; e.psd = true; throw e; }

export const BLENDS = { normal: 'norm', multiply: 'mul ', screen: 'scrn', add: 'lddg' };

/**
 * bytes: the PSD (Uint8Array or ArrayBuffer). layer: { name, left, top, width, height, rgba
 * (width × height × 4, straight alpha), opacity (0..1, default 1), hidden (default false),
 * blend ('normal' | 'multiply' | 'screen' | 'add', default 'normal') } -> the new PSD's bytes.
 * Errors (with .code): psdAddNotPsd, psdAddDepth (not 8-bit), psdAddMode (not RGB), psdAddNoLayerInfo
 * (the layers are kept elsewhere, as 16-bit files do), psdAddNoLayers (a flat picture), psdAddBadLayer (the
 * rgba does not fit the size).
 */
export function addLayerToPsd(bytes, layer) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 26 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== '8BPS') addError('psdAddNotPsd', {}, 'not a PSD file');
  const version = v.getUint16(4), big = version === 2;
  if (version !== 1 && version !== 2) addError('psdAddNotPsd', {}, `unknown PSD version ${version}`);
  const depth = v.getUint16(22), mode = v.getUint16(24);
  if (depth !== 8) addError('psdAddDepth', { depth }, `only 8-bit PSD takes a new layer here (this one is ${depth}-bit)`);
  if (mode !== 3) addError('psdAddMode', { mode }, 'only RGB PSD takes a new layer here');
  const { name = 'layer', left = 0, top = 0, width, height, rgba, opacity = 1, hidden = false, blend = 'normal' } = layer;
  if (!(width > 0 && height > 0) || !rgba || rgba.length !== width * height * 4) addError('psdAddBadLayer', { width, height }, 'the layer needs width × height × 4 bytes of rgba');

  let p = 26;
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const len = () => (big ? (u32() * 2 ** 32 + u32()) : u32());
  p += 4 + v.getUint32(p); // colour mode data
  p += 4 + v.getUint32(p); // image resources
  const lmAt = p, lmLen = len(), lmBody = p, lmEnd = lmBody + lmLen;
  // the layer info: its length, the layer count, the records, the channel data
  let liLen = 0, liBody = p, count = 0, signed = 0, recsAt = p, recsEnd = p, dataEnd = p;
  if (lmLen > 0) {
    liLen = len(); liBody = p;
    if (liLen > 0) {
      signed = v.getInt16(p); count = Math.abs(signed); p += 2; recsAt = p;
      let data = 0;
      for (let i = 0; i < count; i++) {
        p += 16;
        const nch = v.getUint16(p); p += 2;
        for (let c = 0; c < nch; c++) { p += 2; data += len(); }
        p += 12; // signature, blend key, opacity, clipping, flags, filler
        p += 4 + v.getUint32(p); // extra data
      }
      recsEnd = p; dataEnd = p + data;
      if (dataEnd > liBody + liLen) addError('psdAddNoLayerInfo', {}, 'the layer records do not fit their section (a broken file)');
    } else if (lmLen > (big ? 8 : 4)) {
      // no layers here: a 16-bit file keeps them in an 'Lr16' block after the global mask info
      const at = liBody + liLen, gm = v.getUint32(at), blocks = at + 4 + gm;
      if (blocks + 8 <= lmEnd && /Lr16|Lr32|Layr/.test(String.fromCharCode(...b.subarray(blocks + 4, blocks + 8)))) addError('psdAddNoLayerInfo', {}, 'the layers are kept in an additional block (16- or 32-bit), not written to yet');
    }
  }
  // a PSD without layers (one flat picture): a layer added would hide that picture in Photoshop
  if (!count) addError('psdAddNoLayers', {}, 'the PSD has no layers (a flat picture): a new layer would hide it');
  const after = liBody + liLen; // the global layer mask info and the blocks after the layers

  // the new layer's channels: -1 (transparency), 0, 1, 2; RLE, row byte counts first
  const chData = [];
  for (const [id, k] of [[-1, 3], [0, 0], [1, 1], [2, 2]]) {
    const counts = [], rows = [];
    const plane = new Uint8Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) plane[x] = rgba[(y * width + x) * 4 + k];
      const packed = packBits(plane); counts.push(packed.length); rows.push(packed);
    }
    const cw = big ? 4 : 2, total = 2 + height * cw + counts.reduce((s, c) => s + c, 0);
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint16(0, 1); // RLE
    let o = 2;
    for (const c of counts) { if (big) dv.setUint32(o, c); else dv.setUint16(o, c); o += cw; }
    for (const r of rows) { out.set(r, o); o += r.length; }
    chData.push([id, out]);
  }
  // the record
  const nameBytes = Array.from(enc.encode(name)).filter((c) => c < 128).slice(0, 255); // the Pascal name: its ASCII part
  const pascal = [nameBytes.length, ...nameBytes];
  while (pascal.length % 4) pascal.push(0);
  const luniData = [], u16 = (x) => [x >> 8, x & 255], u32b = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
  luniData.push(...u32b(name.length));
  for (let i = 0; i < name.length; i++) luniData.push(...u16(name.charCodeAt(i)));
  if (luniData.length % 2) luniData.push(0);
  const luni = [...enc.encode('8BIMluni'), ...u32b(luniData.length), ...luniData];
  const extra = [...u32b(0), ...u32b(0), ...pascal, ...luni]; // no layer mask, no blending ranges
  const rec = [...u32b(top), ...u32b(left), ...u32b(top + height), ...u32b(left + width), ...u16(4)];
  for (const [id, d] of chData) { rec.push(...u16(id & 0xffff)); if (big) rec.push(...u32b(Math.floor(d.length / 2 ** 32)), ...u32b(d.length >>> 0)); else rec.push(...u32b(d.length)); }
  rec.push(...enc.encode('8BIM'), ...enc.encode(BLENDS[blend] || 'norm'), Math.round(Math.max(0, Math.min(1, opacity)) * 255), 0,
    8 | (hidden ? 2 : 0), 0, ...u32b(extra.length), ...extra); // flags: bit 3 set means bit 4 is meaningful (Photoshop 5+)

  // the new layer info: count (keeping the sign: negative = the merged picture's first extra channel is its alpha)
  const newCount = signed < 0 ? -(count + 1) : count + 1;
  const parts = [new Uint8Array(u16(newCount & 0xffff)), b.subarray(recsAt, recsEnd), new Uint8Array(rec), b.subarray(recsEnd, dataEnd), ...chData.map(([, d]) => d)];
  let liSize = parts.reduce((s, x) => s + x.length, 0);
  const pad = (big ? 4 : 2) - (liSize % (big ? 4 : 2) || (big ? 4 : 2));
  liSize += pad;
  const lenBytes = (x) => (big ? [...u32b(Math.floor(x / 2 ** 32)), ...u32b(x >>> 0)] : u32b(x));
  const rest = b.subarray(after, lmEnd), lmSize = (big ? 8 : 4) + liSize + rest.length;
  const out = [b.subarray(0, lmAt), new Uint8Array(lenBytes(lmSize)), new Uint8Array(lenBytes(liSize)), ...parts, new Uint8Array(pad), rest, b.subarray(lmEnd)];
  const total = out.reduce((s, x) => s + x.length, 0), res = new Uint8Array(total);
  let o = 0;
  for (const x of out) { res.set(x, o); o += x.length; }
  return res;
}

// ---- replacing a layer's pixels ---------------------------------------------------------------
//
//   import { replaceLayerPixels } from '../tools/psd_add_layer.mjs';
//   const out = replaceLayerPixels(psdBytes, '顔/目', { left, top, width, height, rgba }, { inflate });
//
// The pixels in the box { left, top, width, height } (canvas coordinates, straight alpha) take the
// place of the layer's own there (transparent ones erase); the layer's pixels outside the box stay.
// A box reaching past the layer makes the layer bigger. Everything else in its record is kept as it
// is (name, opacity, fill, blend, clipping, visibility, its masks and their data, every block), and
// so is every other layer, folder, block and resource, byte for byte. The merged picture at the end
// is drawn again inside the area the layer covered before and covers now (outside it, it does not
// change), from the layers: normal and the usual blend modes, opacity, clipping, folders (isolated
// unless pass-through), layer and folder masks, as Photoshop stores it (over white where it has
// transparency). Adjustment layers and layer effects are not drawn there.
// which: the layer's path ('folder/name', or ['folder', 'name']), or { index } (the n-th layer,
// folders not counted, bottom first: as importPsd's layers). opts: inflate (zlib's inflate, sync:
// for ZIP-compressed channels), unmask (default true: the pixels are taken as seen through the
// layer's masks, as importPsd gives them, and divided back by them; where the masks hide all, the
// layer's old pixels stay. false: written as they are), merged (false: leave the merged picture as it is), notes (an array:
// psdEditMaskHides { layer } is pushed when the layer's mask hides part of the new pixels).
// Errors (with .code): psdEditNotPsd, psdEditDepth (not 8-bit), psdEditMode (not RGB),
// psdEditNoLayerInfo, psdEditNoLayer (no such layer), psdEditAmbiguous (two layers on that path:
// give { index }; a folder is not a layer here), psdEditKind (a text, smart object, fill or adjustment layer: its pixels
// are made from other data), psdEditBadPixels, psdEditNeedsInflate.

import { readPsd, psdMaskCoverage } from './import_psd.mjs';

function editError(code, vars, text) { const e = new Error(text); e.code = code; e.vars = vars; e.psd = true; throw e; }
const ADJUSTMENT = ['levl', 'curv', 'brit', 'blnc', 'hue ', 'hue2', 'selc', 'mixr', 'grdm', 'phfl', 'expA', 'vibA', 'thrs', 'nvrt', 'post', 'blwh', 'clrL'];
const u16b = (x) => [(x >> 8) & 255, x & 255], u32b = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];

// one channel's data (compression, then the data) -> its plane (w × h), 8-bit
function readChannel(b, at, end, w, h, big, inflate) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), comp = v.getUint16(at), out = new Uint8Array(w * h);
  let p = at + 2;
  if (!w || !h) return out;
  if (comp === 0) out.set(b.subarray(p, p + w * h));
  else if (comp === 1) {
    const counts = [];
    for (let y = 0; y < h; y++) { counts.push(big ? v.getUint32(p) : v.getUint16(p)); p += big ? 4 : 2; }
    for (let y = 0; y < h; y++) { unpack(b, p, p + counts[y], out, y * w, w); p += counts[y]; }
  } else if (comp === 2 || comp === 3) {
    if (!inflate) editError('psdEditNeedsInflate', {}, 'ZIP-compressed channels need opts.inflate');
    const raw = new Uint8Array(inflate(b.subarray(p, end)));
    out.set(raw.subarray(0, w * h));
    if (comp === 3) for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) out[y * w + x] = (out[y * w + x] + out[y * w + x - 1]) & 255;
  } else editError('psdEditNoLayerInfo', { compression: comp }, `unknown channel compression ${comp}`);
  return out;
}
function unpack(src, p, end, out, at, n) { // PackBits, one row
  let o = at;
  end = Math.min(end, src.length); // broken counts: stop at the data's end
  while (p < end && o < at + n) {
    const c = src[p++];
    if (c < 128) { out.set(src.subarray(p, p + c + 1), o); p += c + 1; o += c + 1; }
    else if (c > 128) { out.fill(src[p++], o, o + 257 - c); o += 257 - c; }
  }
}
// a plane -> one channel's data, RLE
function rleChannel(plane, w, h, big) {
  const counts = [], rows = [];
  for (let y = 0; y < h; y++) { const r = packBits(plane.subarray(y * w, (y + 1) * w)); counts.push(r.length); rows.push(r); }
  const cw = big ? 4 : 2, out = new Uint8Array(2 + h * cw + counts.reduce((s, c) => s + c, 0)), dv = new DataView(out.buffer);
  dv.setUint16(0, 1);
  let o = 2;
  for (const c of counts) { if (big) dv.setUint32(o, c); else dv.setUint16(o, c); o += cw; }
  for (const r of rows) { out.set(r, o); o += r.length; }
  return out;
}

// the separable blend modes on straight colours (0..1); the others draw as normal
const BLENDS_F = {
  normal: (b, s) => s, multiply: (b, s) => b * s, screen: (b, s) => b + s - b * s, add: (b, s) => Math.min(1, b + s),
  subtract: (b, s) => Math.max(0, b - s), darken: Math.min, lighten: Math.max, difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s, linearBurn: (b, s) => Math.max(0, b + s - 1),
  hardLight: (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1)),
  overlay: (b, s) => (b <= 0.5 ? s * 2 * b : s + (2 * b - 1) - s * (2 * b - 1)),
  softLight: (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b)),
  colorDodge: (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  colorBurn: (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  divide: (b, s) => (s === 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
};
// premultiplied RGBA buffers (Float32, the area's size): source over backdrop with a blend mode
function blendInto(dst, src, mode) {
  const f = BLENDS_F[mode] || BLENDS_F.normal;
  for (let i = 0; i < dst.length; i += 4) {
    const as = src[i + 3];
    if (!as) continue;
    const ab = dst[i + 3];
    for (let c = 0; c < 3; c++) {
      const cs = src[i + c] / as, cb = ab ? dst[i + c] / ab : 0;
      dst[i + c] = as * (1 - ab) * cs + as * ab * f(cb, cs) + (1 - as) * dst[i + c];
    }
    dst[i + 3] = as + ab * (1 - as);
  }
}
// the layers (readPsd's, bottom first) drawn in the area [x0, y0, x1, y1): premultiplied Float32 RGBA
/** The layers (readPsd's, with their folders) drawn together over an area [x0, y0, x1, y1] of the canvas, as Photoshop
 *  draws them -> premultiplied RGBA floats (0..1). Also used by importPsd for a [merge] folder. */
export function drawArea(layers, area) {
  const [x0, y0, x1, y1] = area, W = x1 - x0, H = y1 - y0;
  // the folders as a tree, in the order their first layer comes
  const root = { kids: [] }, nodeOf = new Map([[null, root]]);
  for (const L of layers) {
    let parent = root;
    for (const g of L.groupObjs) {
      if (!nodeOf.has(g)) { const n = { folder: g, kids: [] }; parent.kids.push(n); nodeOf.set(g, n); }
      parent = nodeOf.get(g);
    }
    parent.kids.push({ layer: L });
  }
  const pixels = (L) => { // the layer's own pixels in the area, premultiplied (no opacity yet)
    const out = new Float32Array(W * H * 4);
    for (let y = Math.max(y0, L.top); y < Math.min(y1, L.top + L.height); y++) for (let x = Math.max(x0, L.left); x < Math.min(x1, L.left + L.width); x++) {
      const i = ((y - L.top) * L.width + x - L.left) * 4, o = ((y - y0) * W + x - x0) * 4, a = L.rgba[i + 3] / 255;
      out[o] = (L.rgba[i] / 255) * a; out[o + 1] = (L.rgba[i + 1] / 255) * a; out[o + 2] = (L.rgba[i + 2] / 255) * a; out[o + 3] = a;
    }
    return out;
  };
  const scale = (buf, k) => { if (k !== 1) for (let i = 0; i < buf.length; i++) buf[i] *= k; return buf; };
  const shownLayer = (L) => L.visible && L.kind !== 'adjustment' && !!L.rgba;
  // a clipping group as Photoshop draws it by default ("blend clipped layers as group"): each
  // clipped layer blends onto its base's own pixels and keeps the base's transparency; the group
  // then goes onto what is below with the base's opacity and blend mode
  const clipGroup = (base, clips) => {
    const list = clips.filter(shownLayer).map((L) => ({ src: pixels(L), k: L.opacity, f: BLENDS_F[L.blend] || BLENDS_F.normal }));
    if (!list.length) return;
    // the clipped layers composited over the base as usual (the coverage grows from one to the next,
    // as psd-tools does), their colour kept and the base's transparency
    for (let i = 0; i < base.length; i += 4) {
      const ab0 = base[i + 3];
      if (!ab0) continue;
      let r = base[i] / ab0, g = base[i + 1] / ab0, bl = base[i + 2] / ab0, a = ab0;
      for (const { src, k, f } of list) {
        const as = src[i + 3] * k;
        if (!as) continue;
        const sa = src[i + 3], ao = as + a - as * a, mix = (cb, cs) => (as * (1 - a) * cs + as * a * f(cb, cs) + (1 - as) * a * cb) / ao;
        r = mix(r, src[i] / sa); g = mix(g, src[i + 1] / sa); bl = mix(bl, src[i + 2] / sa); a = ao;
      }
      base[i] = ab0 * r; base[i + 1] = ab0 * g; base[i + 2] = ab0 * bl;
    }
  };
  const draw = (node, target) => {
    const kids = node.kids;
    for (let k = 0; k < kids.length; k++) {
      const kid = kids[k];
      // the clipped layers right above it
      let n = k + 1;
      while (n < kids.length && kids[n].layer?.clipping) n++;
      const clips = kids.slice(k + 1, n).map((c) => c.layer);
      if (kid.layer?.clipping) continue; // no base below it in its folder: nothing to show through (as psd-tools draws it)
      let buf, opacity, blend;
      if (kid.layer) {
        const L = kid.layer;
        if (!shownLayer(L)) { k = n - 1; continue; } // a hidden base hides its clipped layers
        buf = pixels(L); opacity = L.opacity; blend = L.blend;
      } else {
        const g = kid.folder;
        if (!g.visible) { k = n - 1; continue; }
        if (g.blend === 'passThrough' && g.opacity >= 255 && !clips.length) { draw(kid, target); continue; }
        buf = new Float32Array(W * H * 4);
        draw(kid, buf);
        opacity = g.opacity / 255; blend = g.blend === 'passThrough' ? 'normal' : g.blend;
      }
      clipGroup(buf, clips);
      blendInto(target, scale(buf, opacity), blend);
      k = n - 1;
    }
  };
  const out = new Float32Array(W * H * 4);
  draw(root, out);
  return out;
}

// a layer's effect blocks (the old and the object-based ones, and several of a kind)
const EFFECT_KEYS = ['lfx2', 'lrFX', 'lmfx'];

/** bytes: the PSD; which: 'folder/name' | ['folder', 'name'] | { index }; pic: { left, top, width, height, rgba }
 *  (straight alpha); opts: { inflate, merged, notes, dropEffects } -> the new PSD's bytes.
 *  opts.dropEffects: the layer's effects (drop shadow, stroke, glow, ...: its 'lfx2', 'lrFX' and 'lmfx' blocks) are
 *  taken off, for pixels that already have the effects drawn in (importPsd draws them: tools/layer_effects.mjs), so
 *  that Photoshop does not draw them a second time. Said in opts.notes (psdEditEffectsDropped, with the blocks). */
export function replaceLayerPixels(bytes, which, pic, opts = {}) {
  // a plain Uint8Array view (a Node Buffer's slice() shares its memory: the input must not change)
  const b = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 26 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== '8BPS') editError('psdEditNotPsd', {}, 'not a PSD file');
  const version = v.getUint16(4), big = version === 2;
  if (version !== 1 && version !== 2) editError('psdEditNotPsd', {}, `unknown PSD version ${version}`);
  const nc = v.getUint16(12), H = v.getUint32(14), W = v.getUint32(18), depth = v.getUint16(22), mode = v.getUint16(24);
  if (depth !== 8) editError('psdEditDepth', { depth }, `only 8-bit PSD layers can be redrawn here (this one is ${depth}-bit)`);
  if (mode !== 3) editError('psdEditMode', { mode }, 'only RGB PSD layers can be redrawn here');
  const { left: nl, top: nt, width: nw, height: nh, rgba } = pic || {};
  if (!(nw > 0 && nh > 0) || !rgba || rgba.length !== nw * nh * 4 || !Number.isInteger(nl) || !Number.isInteger(nt)) editError('psdEditBadPixels', { width: nw, height: nh }, 'the pixels need whole left / top and width × height × 4 bytes of rgba');

  // the sections, as addLayerToPsd reads them
  let p = 26;
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const len = () => (big ? (u32() * 2 ** 32 + u32()) : u32());
  p += 4 + v.getUint32(p); p += 4 + v.getUint32(p);
  const lmAt = p, lmLen = len(), lmEnd = p + lmLen;
  if (!lmLen) editError('psdEditNoLayerInfo', {}, 'the PSD has no layers');
  const liLen = len(), liBody = p;
  if (!liLen) editError('psdEditNoLayerInfo', {}, 'the layers are not in the layer info (a 16- or 32-bit file, or no layers)');
  const signed = v.getInt16(p), count = Math.abs(signed);
  p += 2;
  const recsAt = p, recs = [];
  for (let i = 0; i < count; i++) {
    const at = p, top = v.getInt32(p), left = v.getInt32(p + 4), bottom = v.getInt32(p + 8), right = v.getInt32(p + 12);
    p += 16;
    const nch = v.getUint16(p); p += 2;
    const channels = [];
    for (let c = 0; c < nch; c++) { const id = v.getInt16(p); p += 2; channels.push({ id, length: len() }); }
    const restAt = p;
    p += 12;
    const extraEnd = p + 4 + v.getUint32(p); p += 4;
    let mask = null;
    { const n = v.getUint32(p); if (n >= 18) mask = { top: v.getInt32(p + 4), left: v.getInt32(p + 8), bottom: v.getInt32(p + 12), right: v.getInt32(p + 16), outside: b[p + 20], disabled: !!(b[p + 21] & 2) }; p += 4 + n; } // the layer mask
    p += 4 + v.getUint32(p); // the blending ranges
    const nameLen = b[p];
    let name = String.fromCharCode(...b.subarray(p + 1, p + 1 + nameLen));
    p += (nameLen + 4) & ~3;
    let section = 0;
    const keys = new Set(), blocks = [], blocksAt = p;
    while (p + 12 <= extraEnd) {
      const blockAt = p;
      const sig = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const k = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      p += 8;
      const n = big && ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'].includes(k) ? len() : u32();
      keys.add(k);
      if (k === 'luni') { const c = v.getUint32(p); name = ''; for (let j = 0; j < c; j++) name += String.fromCharCode(v.getUint16(p + 4 + 2 * j)); name = name.replace(/\0+$/, ''); }
      if (k === 'lsct' || k === 'lsdk') section = v.getUint32(p);
      p += n;
      blocks.push({ key: k, at: blockAt, end: p });
    }
    p = extraEnd;
    recs.push({ at, end: p, restAt, top, left, bottom, right, channels, name, section, keys, mask, blocks, blocksAt });
  }
  const recsEnd = p;
  let data = recsEnd;
  for (const r of recs) { r.dataAt = data; data += r.channels.reduce((s, c) => s + c.length, 0); r.dataEnd = data; }
  const dataEnd = data, after = liBody + liLen;
  if (dataEnd > after) editError('psdEditNoLayerInfo', {}, 'the layer records do not fit their section (a broken file)');

  // the paths, as importPsd gives them (folders: their end marker comes first, the folder after)
  const layers = recs.filter((r) => !r.section);
  { // a folder's name comes after its layers: each level is named when its folder record comes
    const open = [];
    for (const r of recs) {
      if (r.section === 3) { open.push([]); continue; }
      if (r.section === 1 || r.section === 2) { const kids = open.pop(); for (const k of kids) k.path.unshift(r.name); if (open.length) open[open.length - 1].push(...kids); continue; }
      r.path = [r.name];
      if (open.length) open[open.length - 1].push(r);
    }
  }
  let target;
  if (which && typeof which === 'object' && !Array.isArray(which)) {
    target = layers[which.index];
    if (!target) editError('psdEditNoLayer', { index: which.index }, `there is no layer ${which.index}`);
  } else {
    const want = (Array.isArray(which) ? which : String(which).split('/')).join('/');
    const found = layers.filter((r) => r.path.join('/') === want);
    if (!found.length) editError('psdEditNoLayer', { layer: want }, `there is no layer ${want}`);
    if (found.length > 1) editError('psdEditAmbiguous', { layer: want, count: found.length }, `${found.length} layers are named ${want}: give { index }`);
    target = found[0];
  }
  const where = target.path.join('/');
  const kind = target.keys.has('TySh') ? 'text' : ['SoLd', 'PlLd', 'SoLE'].some((k) => target.keys.has(k)) ? 'smartObject'
    : ['SoCo', 'GdFl', 'PtFl'].some((k) => target.keys.has(k)) ? 'fill' : ADJUSTMENT.some((k) => target.keys.has(k)) ? 'adjustment' : 'pixel';
  if (kind !== 'pixel') editError('psdEditKind', { layer: where, kind }, `layer ${where}: a ${kind} layer's pixels are made from its other data; rasterize it in the drawing app first`);

  // a layer mask that hides all outside its box hides the new pixels that reach past it: said in opts.notes
  const m = target.mask;
  if (m && !m.disabled && m.outside === 0 && Array.isArray(opts.notes) && (nl < m.left || nt < m.top || nl + nw > m.right || nt + nh > m.bottom))
    opts.notes.push({ code: 'psdEditMaskHides', vars: { layer: where }, text: `layer ${where}: its mask hides everything outside ${m.left},${m.top}–${m.right},${m.bottom}, so the new pixels past it do not show` });
  // the layer's new pixels: its old ones in the union of both boxes, the new box over them
  const ow = target.right - target.left, oh = target.bottom - target.top, had = ow > 0 && oh > 0;
  const L0 = had ? Math.min(target.left, nl) : nl, T0 = had ? Math.min(target.top, nt) : nt;
  const R0 = had ? Math.max(target.right, nl + nw) : nl + nw, B0 = had ? Math.max(target.bottom, nt + nh) : nt + nh;
  const UW = R0 - L0, UH = B0 - T0, planes = [0, 1, 2, 3].map(() => new Uint8Array(UW * UH));
  // outside its old box the layer starts transparent; inside it, opaque if it had no transparency channel
  if (had && !target.channels.some((c) => c.id === -1)) for (let y = 0; y < oh; y++) planes[3].fill(255, (target.top - T0 + y) * UW + target.left - L0, (target.top - T0 + y) * UW + target.left - L0 + ow);
  let at = target.dataAt;
  const kept = new Map();
  for (const ch of target.channels) {
    const end = at + ch.length;
    const k = { [-1]: 3, 0: 0, 1: 1, 2: 2 }[ch.id];
    if (k !== undefined && had) {
      const plane = readChannel(b, at, end, ow, oh, big, opts.inflate);
      for (let y = 0; y < oh; y++) planes[k].set(plane.subarray(y * ow, (y + 1) * ow), (target.top - T0 + y) * UW + target.left - L0);
    } else if (k === undefined) kept.set(ch.id, b.subarray(at, end)); // masks and the rest: as they are
    at = end;
  }
  // the pixels came through the layer's masks (importPsd applies them): divided back by what the
  // masks let show, so Photoshop's masking gives them again; where the masks hide all, the old
  // pixels stay (opts.unmask false: written as they are)
  const cover = opts.unmask === false ? null : psdMaskCoverage(b, layers.indexOf(target), { left: nl, top: nt, width: nw, height: nh }, { inflate: opts.inflate });
  const masked = cover && cover.some((m) => m < 255);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const s = (y * nw + x) * 4, o = (nt - T0 + y) * UW + nl - L0 + x, m = masked ? cover[y * nw + x] : 255;
    if (!m) continue;
    planes[0][o] = rgba[s]; planes[1][o] = rgba[s + 1]; planes[2][o] = rgba[s + 2];
    planes[3][o] = m === 255 ? rgba[s + 3] : Math.min(255, Math.round((rgba[s + 3] * 255) / m));
  }
  // its record: the box, the channels (the transparency first if it had none), the rest as it was
  const ids = target.channels.map((c) => c.id);
  if (!ids.includes(-1)) ids.unshift(-1);
  for (const id of [0, 1, 2]) if (!ids.includes(id)) ids.push(id);
  const chData = ids.map((id) => [id, kept.get(id) ?? rleChannel(planes[{ [-1]: 3, 0: 0, 1: 1, 2: 2 }[id]], UW, UH, big)]);
  const head = [...u32b(T0), ...u32b(L0), ...u32b(B0), ...u32b(R0), ...u16b(ids.length)];
  for (const [id, d] of chData) { head.push(...u16b(id & 0xffff)); if (big) head.push(...u32b(Math.floor(d.length / 2 ** 32)), ...u32b(d.length >>> 0)); else head.push(...u32b(d.length)); }
  const parts = [b.subarray(liBody, recsAt)];
  // the rest of its record as it was; without the effect blocks when asked
  let targetRest = b.subarray(target.restAt, target.end);
  const fx = opts.dropEffects ? target.blocks.filter((k) => EFFECT_KEYS.includes(k.key)) : [];
  if (fx.length) {
    const keep = [b.subarray(target.restAt + 16, target.blocksAt), ...target.blocks.filter((k) => !fx.includes(k)).map((k) => b.subarray(k.at, k.end)), b.subarray(target.blocks.at(-1).end, target.end)];
    const extraLen = keep.reduce((sum, x) => sum + x.length, 0);
    targetRest = new Uint8Array(16 + extraLen);
    targetRest.set(b.subarray(target.restAt, target.restAt + 12), 0); // signature, blend, opacity, clipping, flags, filler
    new DataView(targetRest.buffer).setUint32(12, extraLen);
    let q = 16;
    for (const x of keep) { targetRest.set(x, q); q += x.length; }
    if (Array.isArray(opts.notes)) opts.notes.push({ code: 'psdEditEffectsDropped', vars: { layer: where, blocks: fx.map((k) => k.key) }, text: `layer ${where}: its effects (${fx.map((k) => k.key).join(', ')}) were taken off; the pixels have them drawn in` });
  }
  for (const r of recs) parts.push(r === target ? new Uint8Array(head) : b.subarray(r.at, r.restAt), r === target ? targetRest : b.subarray(r.restAt, r.end));
  for (const r of recs) if (r === target) parts.push(...chData.map(([, d]) => d)); else parts.push(b.subarray(r.dataAt, r.dataEnd));
  let liSize = parts.reduce((s, x) => s + x.length, 0);
  const unit = big ? 4 : 2, pad = (unit - (liSize % unit)) % unit;
  liSize += pad;
  const lenBytes = (x) => (big ? [...u32b(Math.floor(x / 2 ** 32)), ...u32b(x >>> 0)] : u32b(x));
  const rest = b.subarray(after, lmEnd), lmSize = (big ? 8 : 4) + liSize + rest.length;
  const join = (list) => { const t = list.reduce((s, x) => s + x.length, 0), res = new Uint8Array(t); let o = 0; for (const x of list) { res.set(x, o); o += x.length; } return res; };
  const front = join([b.subarray(0, lmAt), new Uint8Array(lenBytes(lmSize)), new Uint8Array(lenBytes(liSize)), ...parts, new Uint8Array(pad), rest]);
  const merged = b.subarray(lmEnd);
  if (opts.merged === false || merged.length < 2) return join([front, merged]);

  // the merged picture: drawn again where the layer was or is now
  const area = [Math.max(0, L0), Math.max(0, T0), Math.min(W, R0), Math.min(H, B0)];
  if (!(area[2] > area[0] && area[3] > area[1])) return join([front, merged]);
  const psd = readPsd(join([front, merged]), { inflate: opts.inflate, within: area }); // only the layers over the area
  const drawn = drawArea(psd.layers, area);
  const mv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength), comp = mv.getUint16(0);
  const mplanes = [];
  if (comp === 0) for (let c = 0; c < nc; c++) mplanes.push(merged.slice(2 + c * W * H, 2 + (c + 1) * W * H));
  else if (comp === 1) {
    const cw = big ? 4 : 2, counts = [];
    let q = 2;
    for (let i = 0; i < nc * H; i++) { counts.push(big ? mv.getUint32(q) : mv.getUint16(q)); q += cw; }
    for (let c = 0; c < nc; c++) {
      const plane = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) { const n = counts[c * H + y]; unpack(merged, q, q + n, plane, y * W, W); q += n; }
      mplanes.push(plane);
    }
  } else return join([front, merged]); // a ZIP merged picture (rare): left as it is
  const alpha = signed < 0 && nc >= 4;
  const [ax0, ay0, ax1, ay1] = area, AW = ax1 - ax0;
  for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) {
    const i = ((y - ay0) * AW + x - ax0) * 4, o = y * W + x, a = drawn[i + 3];
    // over white (Photoshop's merged picture, with or without its transparency)
    for (let c = 0; c < 3; c++) mplanes[c][o] = Math.max(0, Math.min(255, Math.round((drawn[i + c] + 1 - a) * 255)));
    if (alpha) mplanes[3][o] = Math.round(a * 255);
  }
  // RLE: every channel's row lengths first, then the rows
  const counts = [], rows = [];
  for (let c = 0; c < nc; c++) for (let y = 0; y < H; y++) { const r = packBits(mplanes[c].subarray(y * W, (y + 1) * W)); counts.push(r.length); rows.push(r); }
  const cw = big ? 4 : 2, mout = new Uint8Array(2 + counts.length * cw + counts.reduce((s, c) => s + c, 0)), md = new DataView(mout.buffer);
  md.setUint16(0, 1);
  let o = 2;
  for (const c of counts) { if (big) md.setUint32(o, c); else md.setUint16(o, c); o += cw; }
  for (const r of rows) { mout.set(r, o); o += r.length; }
  return join([front, mout]);
}
