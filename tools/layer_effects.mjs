// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Photoshop layer effects (layer styles), read from a layer's 'lfx2' or 'lmfx' block and painted into
// its pixels at import: drop shadow, outer glow, stroke (a colour), colour overlay, inner shadow and
// inner glow. Written from Adobe's "Photoshop File Formats Specification" (the blocks' layout and the
// descriptor structure) and the effects' settings as Photoshop's layer style window shows them.
//
//   readEffects(bytes) -> { scale, effects: [{ kind, blend, color, opacity, ... }], skipped: [kinds] } or null
//   paintEffects(layer, fx, k) -> { left, top, width, height, rgba, kinds, close } (k: the pixels' scale)
//
// Close to Photoshop, not the same: the blur of shadows and glows (three box blurs over the size),
// noise and contour are not drawn, and an effect that blends with what lies under the layer (a
// shadow in multiply) is painted in normal blend under it (the layer's own part cannot reach the
// layers below). Bevel and emboss, satin, gradient and pattern overlays and gradient strokes are
// not painted (said by name).

// ---- the descriptor (Adobe's "Descriptor structure") ----

/** bytes from a descriptor's start (its class name) -> { key: value }; throws on what it cannot read. */
export function readDescriptor(b, p = 0) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (n) => { if (p + n > b.length) throw new Error('descriptor: cut short'); };
  const u32 = () => { need(4); const x = v.getUint32(p); p += 4; return x; };
  const uni = () => { const n = u32(); need(2 * n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint16(p + 2 * i)); p += 2 * n; return s.replace(/\0+$/, ''); };
  const id = () => { const n = u32(), m = n || 4; need(m); const s = String.fromCharCode(...b.subarray(p, p + m)); p += m; return s; };
  const id4 = () => { need(4); const s = String.fromCharCode(...b.subarray(p, p + 4)); p += 4; return s; };
  const f64 = () => { need(8); const x = v.getFloat64(p); p += 8; return x; };
  const value = (type) => {
    switch (type) {
      case 'long': { need(4); const x = v.getInt32(p); p += 4; return x; }
      case 'comp': { need(8); p += 8; return null; }
      case 'doub': return f64();
      case 'UntF': { const unit = id4(); return { unit, value: f64() }; }
      case 'UnFl': { const unit = id4(), n = u32(), list = []; for (let i = 0; i < n; i++) list.push(f64()); return { unit, list }; }
      case 'bool': { need(1); return !!b[p++]; }
      case 'TEXT': return uni();
      case 'enum': { id(); return id(); }
      case 'type': case 'GlbC': { uni(); return id(); }
      case 'Objc': case 'GlbO': return obj();
      case 'VlLs': { const n = u32(), out = []; for (let i = 0; i < n; i++) out.push(value(id4())); return out; }
      case 'tdta': case 'alis': { const n = u32(); need(n); p += n; return null; }
      case 'obj ': { // a reference: its items are skipped
        const n = u32();
        for (let i = 0; i < n; i++) {
          const form = id4();
          if (form === 'prop') { uni(); id(); id(); } else if (form === 'Clss') { uni(); id(); } else if (form === 'Enmr') { uni(); id(); id(); id(); }
          else if (form === 'rele') { uni(); id(); u32(); } else if (form === 'Idnt' || form === 'indx') u32(); else if (form === 'name') { uni(); id(); uni(); }
          else throw new Error(`descriptor: reference form ${form} is not read`);
        }
        return null;
      }
      default: throw new Error(`descriptor: item type ${type} is not read`);
    }
  };
  function obj() {
    uni(); id();
    const n = u32(), out = {};
    for (let i = 0; i < n; i++) { const k = id(); out[k] = value(id4()); }
    return out;
  }
  return obj();
}

// ---- the effects ----

const num = (x, d = 0) => (typeof x === 'number' ? x : x && typeof x.value === 'number' ? x.value : d);
const BLEND = { Nrml: 'normal', Mltp: 'multiply', Scrn: 'screen', 'Lnr ': 'add', lddg: 'add', linearDodge: 'add', 'Dslv': 'normal' };
function colourOf(c) {
  if (!c) return [0, 0, 0];
  if ('Rd  ' in c) return [num(c['Rd  ']), num(c['Grn ']), num(c['Bl  '])].map((x) => Math.max(0, Math.min(255, x)) / 255);
  if ('Gry ' in c) { const g = 1 - num(c['Gry ']) / 100; return [g, g, g]; }
  if ('H   ' in c) { // hue (degrees), saturation and brightness (percent)
    const h = ((num(c['H   ']) % 360) + 360) % 360 / 60, s = num(c.Strt) / 100, b = num(c.Brgh) / 100, i = Math.floor(h), f = h - i;
    const q = [b, b * (1 - s * f), b * (1 - s), b * (1 - s * (1 - f))];
    return [[0, 3, 2], [1, 0, 2], [2, 0, 3], [2, 1, 0], [3, 2, 0], [0, 2, 1]][i % 6].map((k) => q[k]);
  }
  return [0, 0, 0];
}
// the descriptor's effect keys: one effect each, and the lists newer Photoshop writes (several of a kind)
const KINDS = { DrSh: 'dropShadow', OrGl: 'outerGlow', FrFX: 'stroke', SoFi: 'colorOverlay', IrSh: 'innerShadow', IrGl: 'innerGlow', ebbl: 'bevel', ChFX: 'satin', GrFl: 'gradientOverlay', patternFill: 'patternOverlay' };
const MULTI = { dropShadowMulti: 'DrSh', frameFXMulti: 'FrFX', solidFillMulti: 'SoFi', innerShadowMulti: 'IrSh', gradientFillMulti: 'GrFl' };

/** a layer's 'lfx2' or 'lmfx' block -> its effects (the switched-on ones), or null when it cannot be read. */
export function readEffects(bytes) {
  if (!bytes || bytes.length < 8) return null;
  let d;
  try { d = readDescriptor(bytes, 8); } catch { return null; } // version (0), descriptor version (16), the descriptor
  if (d.masterFXSwitch === false) return { scale: 1, effects: [], skipped: [] };
  const scale = num(d['Scl '], 100) / 100 || 1, effects = [], skipped = [];
  const items = [];
  for (const [key, val] of Object.entries(d)) {
    if (KINDS[key] && val && typeof val === 'object' && !Array.isArray(val)) items.push([key, val]);
    else if (MULTI[key] && Array.isArray(val)) for (const x of val) if (x && typeof x === 'object') items.push([MULTI[key], x]);
  }
  for (const [key, e] of items) {
    if (e.enab === false || e.present === false) continue;
    const kind = KINDS[key];
    const base = { kind, blend: BLEND[e['Md  ']] || (e['Md  '] ? 'other' : 'normal'), color: colourOf(e['Clr ']), opacity: num(e.Opct, 100) / 100 };
    if (kind === 'dropShadow' || kind === 'innerShadow') effects.push({ ...base, angle: num(e.lagl, 120), distance: num(e.Dstn, 0), spread: num(e.Ckmt, 0), size: num(e.blur, 0) });
    else if (kind === 'outerGlow' || kind === 'innerGlow') {
      if (e.Grad && !e['Clr ']) { skipped.push(`${kind}Gradient`); continue; }
      effects.push({ ...base, spread: num(e.Ckmt, 0), size: num(e.blur, 0), source: e.glwS === 'SrcC' ? 'center' : 'edge' });
    } else if (kind === 'stroke') {
      if (e.PntT && e.PntT !== 'SClr') { skipped.push('strokeGradient'); continue; }
      effects.push({ ...base, size: num(e['Sz  '], 3), position: e.Styl === 'InsF' ? 'inside' : e.Styl === 'CtrF' ? 'center' : 'outside' });
    } else if (kind === 'colorOverlay') effects.push(base);
    else skipped.push(kind);
  }
  return { scale, effects, skipped };
}

// ---- painting ----

// squared distance from every pixel to the nearest pixel of `inside` (1D passes: Felzenszwalb and Huttenlocher)
function distance2(inside, w, h) {
  const INF = 1e20, d = new Float64Array(w * h), f = new Float64Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1), vv = new Int32Array(Math.max(w, h)), out = new Float64Array(Math.max(w, h));
  for (let i = 0; i < w * h; i++) d[i] = inside[i] ? 0 : INF;
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; vv[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) { const r = vv[k]; s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { vv[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
      k++; vv[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = vv[k]; out[q] = (q - r) * (q - r) + f[r]; }
    for (let q = 0; q < n; q++) set(q, out[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (q) => d[q * w + x], (q, val) => { d[q * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (q) => d[y * w + q], (q, val) => { d[y * w + q] = val; });
  return d;
}
// coverage within `r` pixels of the shape (alpha 0..1, its edge at one half; pixel centres are one pixel
// apart, so a pixel next to the shape is half a pixel past its edge), smooth over one pixel
function grow(alpha, w, h, r) {
  if (r <= 0) return alpha.slice();
  const ins = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ins[i] = alpha[i] >= 0.5 ? 1 : 0;
  const d = distance2(ins, w, h), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.max(alpha[i], Math.min(1, Math.max(0, r + 1 - Math.sqrt(d[i]))));
  return out;
}
// how far inside the shape each pixel is, as coverage of a band `r` wide along the inside of its edge
function band(alpha, w, h, r) {
  const outs = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) outs[i] = alpha[i] < 0.5 ? 1 : 0;
  const d = distance2(outs, w, h), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.min(alpha[i], Math.min(1, Math.max(0, r + 1 - Math.sqrt(d[i]))));
  return out;
}
// one box blur `r` pixels each way, across (dx 1) or down (dx w)
function boxPass(src, w, h, r, across) {
  const out = new Float32Array(w * h), len = across ? w : h, lines = across ? h : w, step = across ? 1 : w, next = across ? w : 1;
  for (let l = 0; l < lines; l++) {
    const o = l * next;
    let sum = 0;
    for (let i = 0; i <= r && i < len; i++) sum += src[o + i * step];
    for (let i = 0; i < len; i++) {
      out[o + i * step] = sum / (2 * r + 1);
      if (i + r + 1 < len) sum += src[o + (i + r + 1) * step];
      if (i - r >= 0) sum -= src[o + (i - r) * step];
    }
  }
  return out;
}
// three box blurs whose reaches add up to `size` pixels (close to a Gaussian over the size)
function blur(a, w, h, size) {
  const r = Math.round(size / 3);
  if (r < 1) return a;
  let x = a;
  for (let pass = 0; pass < 3; pass++) x = boxPass(boxPass(x, w, h, r, true), w, h, r, false);
  return x;
}
const shift = (a, w, h, dx, dy) => {
  const out = new Float32Array(w * h), ix = Math.round(dx), iy = Math.round(dy);
  for (let y = 0; y < h; y++) { const sy = y - iy; if (sy < 0 || sy >= h) continue; for (let x = 0; x < w; x++) { const sx = x - ix; if (sx >= 0 && sx < w) out[y * w + x] = a[sy * w + sx]; } }
  return out;
};
const MIX = { normal: (b, c) => c, multiply: (b, c) => b * c, screen: (b, c) => 1 - (1 - b) * (1 - c), add: (b, c) => Math.min(1, b + c) };

/**
 * layer { left, top, width, height, rgba (straight, 0..255) } with effects fx (readEffects) at k (the pixels'
 * scale: the PSD read smaller) and fill (0..1, the layer's fill: its own pixels only) -> the layer's
 * pixels with the effects painted in, on a box grown to hold them; kinds: what was painted; close: true
 * where a blend could not be followed (an effect under the layer in another blend than normal).
 */
export function paintEffects(layer, fx, k = 1, fill = 1) {
  const s = (fx.scale || 1) * k, list = fx.effects;
  let pad = 1;
  for (const e of list) {
    if (e.kind === 'dropShadow') pad = Math.max(pad, (e.distance + e.size) * s + 2);
    if (e.kind === 'outerGlow') pad = Math.max(pad, e.size * s + 2);
    if (e.kind === 'stroke' && e.position !== 'inside') pad = Math.max(pad, e.size * s + 2);
  }
  pad = Math.ceil(pad);
  const w = layer.width + 2 * pad, h = layer.height + 2 * pad, n = w * h;
  const A = new Float32Array(n), shape = new Float32Array(n), C = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
    const i = (y * layer.width + x) * 4, j = (y + pad) * w + x + pad;
    shape[j] = layer.rgba[i + 3] / 255; // the effects follow the pixels' own shape (fill does not thin them)
    A[j] = shape[j] * fill;
    for (let c = 0; c < 3; c++) C[c][j] = layer.rgba[i + c] / 255;
  }
  const kinds = [];
  let close = false;
  const of = (kind) => list.filter((e) => e.kind === kind);
  // the result, straight: start empty, put things over it from the bottom up
  const R = new Float32Array(n), G = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const over = (alpha, colour) => { // colour: [r, g, b] or (j) -> [r, g, b]
    for (let j = 0; j < n; j++) {
      const a = alpha[j];
      if (!(a > 0)) continue;
      const col = typeof colour === 'function' ? colour(j) : colour, ab = R[j], ao = a + ab * (1 - a);
      for (let c = 0; c < 3; c++) G[c][j] = (col[c] * a + G[c][j] * ab * (1 - a)) / ao;
      R[j] = ao;
    }
  };
  for (const e of of('dropShadow')) {
    const sz = e.size * s, sp = Math.min(1, e.spread / 100) * sz, rad = (e.angle * Math.PI) / 180;
    let a = shift(shape, w, h, -Math.cos(rad) * e.distance * s, Math.sin(rad) * e.distance * s);
    a = blur(grow(a, w, h, sp), w, h, sz - sp);
    for (let j = 0; j < n; j++) a[j] *= e.opacity;
    over(a, e.color); kinds.push(e.kind); if (e.blend !== 'normal') close = true;
  }
  for (const e of of('outerGlow')) {
    const sz = e.size * s, sp = Math.min(1, e.spread / 100) * sz;
    const a = blur(grow(shape, w, h, sp), w, h, sz - sp);
    for (let j = 0; j < n; j++) a[j] *= e.opacity;
    over(a, e.color); kinds.push(e.kind); if (e.blend !== 'normal') close = true;
  }
  // the layer's own pixels, coloured by its overlay and inner effects (they stay inside its shape)
  const body = [C[0].slice(), C[1].slice(), C[2].slice()];
  const tint = (amount, e) => { // amount 0..1 per pixel of e.color, in e's blend, over the body's colour
    const f = MIX[e.blend] || MIX.normal;
    if (!MIX[e.blend]) close = true;
    for (let j = 0; j < n; j++) {
      const t = amount[j] * e.opacity;
      if (!(t > 0)) continue;
      for (let c = 0; c < 3; c++) body[c][j] = body[c][j] * (1 - t) + f(body[c][j], e.color[c]) * t;
    }
    kinds.push(e.kind);
  };
  const ones = new Float32Array(n).fill(1);
  for (const e of of('colorOverlay')) tint(ones, e);
  for (const e of of('innerGlow')) {
    const sz = e.size * s, sp = Math.min(1, e.spread / 100) * sz, outside = new Float32Array(n);
    for (let j = 0; j < n; j++) outside[j] = 1 - shape[j];
    let a = blur(grow(outside, w, h, sp), w, h, sz - sp);
    if (e.source === 'center') a = a.map((x) => 1 - x);
    tint(a, e);
  }
  for (const e of of('innerShadow')) {
    const sz = e.size * s, sp = Math.min(1, e.spread / 100) * sz, rad = (e.angle * Math.PI) / 180, outside = new Float32Array(n);
    for (let j = 0; j < n; j++) outside[j] = 1 - shape[j];
    const a = blur(grow(shift(outside, w, h, -Math.cos(rad) * e.distance * s, Math.sin(rad) * e.distance * s), w, h, sp), w, h, sz - sp);
    tint(a, e);
  }
  over(A, (j) => [body[0][j], body[1][j], body[2][j]]);
  for (const e of of('stroke')) {
    const sz = e.size * s;
    let a;
    if (e.position === 'outside') { a = grow(shape, w, h, sz); for (let j = 0; j < n; j++) a[j] = Math.max(0, a[j] - shape[j]); }
    else if (e.position === 'inside') a = band(shape, w, h, sz);
    else { const out = grow(shape, w, h, sz / 2), inn = band(shape, w, h, sz / 2); a = new Float32Array(n); for (let j = 0; j < n; j++) a[j] = Math.max(0, out[j] - shape[j]) + inn[j]; }
    for (let j = 0; j < n; j++) a[j] *= e.opacity;
    if (e.blend !== 'normal') close = true;
    over(a, e.color); kinds.push(e.kind);
  }
  const rgba = new Uint8Array(n * 4);
  for (let j = 0; j < n; j++) {
    rgba[j * 4 + 3] = Math.round(Math.min(1, R[j]) * 255);
    for (let c = 0; c < 3; c++) rgba[j * 4 + c] = Math.round(Math.min(1, Math.max(0, G[c][j])) * 255);
  }
  return { left: layer.left - pad, top: layer.top - pad, width: w, height: h, rgba, kinds: [...new Set(kinds)], close };
}
