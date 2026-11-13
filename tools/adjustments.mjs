// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Photoshop adjustment layers read from their settings blocks, as functions on a colour:
// adjustment(blocks) -> { kind, exact, apply(r, g, b) -> [r, g, b] } (straight colours 0..255), or
// null for a kind not read. Written from Adobe's "Photoshop File Formats Specification" (the blocks'
// layouts; 'blnc' and the 'CgEd' descriptor as psd-tools reads them) and the usual formulas (levels
// and curves as psd-tools draws them: each channel's curve, then the master's).
//   exact: true where the result is Photoshop's own (invert, levels, curves); false where it is close
//   (hue / saturation colour ranges, colour balance, brightness / contrast): said in a note.

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// a curve -> a table of 256 values (0..1)
const table = (f) => { const t = new Float64Array(256); for (let i = 0; i < 256; i++) t[i] = clamp01(f(i / 255)); return t; };
const lookup = (t, v) => t[Math.max(0, Math.min(255, Math.round(v)))] * 255;
// channel curves, then the master's (index 0)
function curves(tables) {
  return (r, g, b) => {
    let c = [r, g, b].map((v, k) => (tables[k + 1] ? lookup(tables[k + 1], v) : v));
    if (tables[0]) c = c.map((v) => lookup(tables[0], v));
    return c;
  };
}

// natural cubic spline through points [[x, y]...] (0..1), flat outside them
function spline(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]), n = p.length;
  if (n < 2) return (x) => x;
  const x = p.map((q) => q[0]), y = p.map((q) => q[1]), h = x.slice(1).map((v, i) => v - x[i] || 1e-9);
  const m = new Float64Array(n); // second derivatives (natural: 0 at both ends)
  if (n > 2) {
    const a = new Float64Array(n), bb = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) { a[i] = h[i - 1]; bb[i] = 2 * (h[i - 1] + h[i]); c[i] = h[i]; d[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]); }
    for (let i = 2; i < n - 1; i++) { const w = a[i] / bb[i - 1]; bb[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
    for (let i = n - 2; i >= 1; i--) m[i] = (d[i] - c[i] * m[i + 1]) / bb[i];
  }
  return (v) => {
    const t = Math.max(x[0], Math.min(x[n - 1], v));
    let i = 0; while (i < n - 2 && t > x[i + 1]) i++;
    const A = (x[i + 1] - t) / h[i], B = (t - x[i]) / h[i];
    return A * y[i] + B * y[i + 1] + ((A ** 3 - A) * m[i] + (B ** 3 - B) * m[i + 1]) * (h[i] ** 2) / 6;
  };
}

// HSL (0..1). Photoshop's hue / saturation works in HSL: the hue turns, the saturation scales, the lightness
// is a line over 0..255 applied first (the forms only: no table of measured values is used here)
function rgb2hsl(r, g, b) {
  const x = Math.max(r, g, b), n = Math.min(r, g, b), l = (x + n) / 2;
  if (x === n) return [0, 0, l];
  const d = x - n, s = l > 0.5 ? d / (2 - x - n) : d / (x + n);
  const h = x === r ? (g - b) / d + (g < b ? 6 : 0) : x === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hsl2rgb(h, s, l) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const lightness = (v, l) => (l > 0 ? v * (1 - l) + l : l < 0 ? v * (1 + l) : v);
const saturate = (s, k) => clamp01(k > 0 ? (k >= 1 ? (s > 0 ? 1 : 0) : s / (1 - k)) : s * (1 + k)); // up: S / (1 − a), down: S × (1 + a)
// Photoshop's hue / saturation lightness: a straight line over 0..255 (up: towards white, down: towards black), cut to whole values
const lightness255 = (v, l) => Math.floor(l > 0 ? v * (1 - l) + 255 * l : l < 0 ? v * (1 + l) : v);

// a Photoshop descriptor (the 'CgEd' block's): { key: value } of its items
function descriptor(b, p = 0) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const uni = () => { const n = u32(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint16(p + 2 * i)); p += 2 * n; return s.replace(/\0+$/, ''); };
  const id = () => { const n = u32(), s = String.fromCharCode(...b.subarray(p, p + (n || 4))); p += n || 4; return s; };
  const value = (type) => {
    if (type === 'long') { const x = v.getInt32(p); p += 4; return x; }
    if (type === 'doub') { const x = v.getFloat64(p); p += 8; return x; }
    if (type === 'UntF') { p += 4; const x = v.getFloat64(p); p += 8; return x; }
    if (type === 'bool') return !!b[p++];
    if (type === 'TEXT') return uni();
    if (type === 'enum') { id(); return id(); }
    if (type === 'Objc' || type === 'GlbO') return obj();
    if (type === 'VlLs') { const n = u32(), out = []; for (let i = 0; i < n; i++) out.push(value(id4())); return out; }
    if (type === 'tdta') { const n = u32(); p += n; return null; }
    throw new Error(`descriptor: item type ${type} is not read`);
  };
  const id4 = () => { const s = String.fromCharCode(...b.subarray(p, p + 4)); p += 4; return s; };
  function obj() {
    uni(); id();
    const n = u32(), out = {};
    for (let i = 0; i < n; i++) { const k = id(); out[k] = value(id4()); }
    return out;
  }
  return obj();
}

/** blocks: { key: Uint8Array } of one adjustment layer -> its adjustment, or null (a kind not read). */
export function adjustment(blocks) {
  try { return read(blocks); } catch { return null; } // broken settings: not applied (said)
}
function read(blocks) {
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  if ('nvrt' in blocks) return { kind: 'invert', exact: true, apply: (r, g, b) => [255 - r, 255 - g, 255 - b] };
  if (blocks.levl) {
    if (blocks.levl.length < 12) return null; // the version and at least the master's record
    const v = view(blocks.levl), tables = [];
    for (let k = 0; k < 4 && 2 + k * 10 + 10 <= blocks.levl.length; k++) {
      const [inB, inW, outB, outW, gm] = [0, 1, 2, 3, 4].map((i) => v.getInt16(2 + k * 10 + i * 2));
      if (inB === 0 && inW === 255 && outB === 0 && outW === 255 && gm === 100) continue;
      const gamma = Math.min(9.99, Math.max(0.01, gm / 100)), span = Math.abs(inW - inB) > 1e-6 ? (inW - inB) / 255 : 1;
      tables[k] = table((t) => clamp01(clamp01((t - inB / 255) / span) ** (1 / gamma)) * (outW - outB) / 255 + outB / 255);
    }
    return { kind: 'levels', exact: true, apply: curves(tables) };
  }
  if (blocks.curv) {
    const b = blocks.curv, v = view(b);
    if (b.length < 7) return null;
    const isMap = b[0], version = v.getUint16(1), countMap = v.getUint32(3);
    let p = 7;
    const base = [], channels = [];
    if (version === 1) for (let i = 0; i < 32; i++) if (countMap & (1 << i)) channels.push(i);
    const count = version === 1 ? channels.length : countMap;
    for (let c = 0; c < count; c++) {
      if (isMap) { base.push({ map: b.subarray(p, p + 256) }); p += 256; continue; }
      const n = v.getUint16(p); p += 2; const pts = [];
      for (let i = 0; i < n; i++) { pts.push([v.getUint16(p + 2) / 255, v.getUint16(p) / 255]); p += 4; }
      base.push({ pts });
    }
    const tables = [];
    const put = (ch, item) => { if (ch < 4) tables[ch] = item.map ? table((t) => item.map[Math.round(t * 255)] / 255) : table(spline(item.pts)); };
    // the extra section ('Crv ', version 4) gives each curve its channel; else the bitmap's order
    if (version === 1 && p + 10 <= b.length && String.fromCharCode(...b.subarray(p, p + 4)) === 'Crv ') {
      p += 6; const n = v.getUint32(p); p += 4;
      for (let k = 0; k < n; k++) {
        const ch = v.getUint16(p), m = v.getUint16(p + 2); p += 4;
        if (isMap) { put(ch, { map: b.subarray(p, p + 256) }); p += 256; continue; }
        const pts = []; for (let i = 0; i < m; i++) { pts.push([v.getUint16(p + 2) / 255, v.getUint16(p) / 255]); p += 4; }
        put(ch, { pts });
      }
    } else base.forEach((item, k) => put(version === 1 ? channels[k] : k, item));
    return { kind: 'curves', exact: true, apply: curves(tables) };
  }
  if (blocks.hue2) {
    if (blocks.hue2.length < 16 + 6 * 14) return null;
    const v = view(blocks.hue2), colorize = blocks.hue2[2] === 1, s16 = (at) => v.getInt16(at);
    const cz = [s16(4), s16(6), s16(8)], master = [s16(10), s16(12), s16(14)], ranges = [];
    for (let k = 0; k < 6; k++) { const at = 16 + k * 14; ranges.push({ range: [0, 1, 2, 3].map((i) => s16(at + i * 2)), hsl: [s16(at + 8), s16(at + 10), s16(at + 12)] }); }
    if (colorize) {
      const [H, S, L] = [((cz[0] / 360) % 1 + 1) % 1, cz[1] / 100, cz[2] / 100];
      return { kind: 'hueSaturation', exact: true, apply: (r, g, b) => { const [, , l] = rgb2hsl(r / 255, g / 255, b / 255); return hsl2rgb(H, S, clamp01(lightness(l, L))).map((x) => x * 255); } };
    }
    const used = ranges.filter((x) => x.hsl.some(Boolean));
    // a colour range's weight at a hue (degrees): 1 inside [range[1], range[2]], fading to 0 at range[0] / range[3]
    const weight = (h, [a, b, c, d]) => {
      const in_ = (lo, hi, x) => { const span = ((hi - lo) % 360 + 360) % 360; return ((x - lo) % 360 + 360) % 360 <= span; };
      if (in_(b, c, h)) return 1;
      if (in_(a, b, h)) { const span = ((b - a) % 360 + 360) % 360 || 1; return (((h - a) % 360 + 360) % 360) / span; }
      if (in_(c, d, h)) { const span = ((d - c) % 360 + 360) % 360 || 1; return 1 - (((h - c) % 360 + 360) % 360) / span; }
      return 0;
    };
    const [mh, ms, ml] = [master[0] / 360, master[1] / 100, master[2] / 100];
    return {
      kind: 'hueSaturation', exact: !used.length, apply: (r, g, b) => {
        const c = [r, g, b].map((x) => lightness255(x, ml) / 255); // lightness first, then hue and saturation
        let [h, s, l] = rgb2hsl(...c);
        let rh = 0, rs = 0, rl = 0;
        for (const { range, hsl } of used) { const w = weight(h * 360, range); rh += (hsl[0] / 360) * w; rs += (hsl[1] / 100) * w; rl += (hsl[2] / 100) * w; }
        h = (((h + mh + rh) % 1) + 1) % 1;
        s = saturate(saturate(s, ms), Math.max(-1, Math.min(1, rs)));
        l = clamp01(lightness(l, Math.max(-1, Math.min(1, rl))));
        return hsl2rgb(h, s, l).map((x) => x * 255);
      },
    };
  }
  if (blocks.blnc && blocks.blnc.length >= 19) {
    // shadows, midtones, highlights: cyan-red, magenta-green, yellow-blue (-100..100); preserve luminosity
    const v = view(blocks.blnc), set = (k) => [0, 1, 2].map((i) => v.getInt16(k * 6 + i * 2) / 100), [sh, mid, hi] = [0, 1, 2].map(set), keep = blocks.blnc[18];
    const band = (x) => clamp01(x);
    return {
      kind: 'colorBalance', exact: false, apply: (r, g, b) => {
        const c0 = [r / 255, g / 255, b / 255], [, , l] = rgb2hsl(...c0);
        // how much each tone range touches this lightness (shadows below a third, highlights above two thirds)
        const ws = band((0.333 - l) / 0.25 + 0.5) * 0.7, wh = band((l - 0.667) / 0.25 + 0.5) * 0.7, wm = band((l - 0.333) / 0.25 + 0.5) * band((0.667 - l) / 0.25 + 0.5) * 0.7;
        let c = c0.map((x, k) => clamp01(x + sh[k] * ws + mid[k] * wm + hi[k] * wh));
        if (keep) { const [h, s] = rgb2hsl(...c); c = hsl2rgb(h, s, l); }
        return c.map((x) => x * 255);
      },
    };
  }
  if (blocks.post && blocks.post.length >= 2) { // posterize: the number of levels (2..255)
    const levels = Math.max(2, Math.min(255, view(blocks.post).getUint16(0)));
    return { kind: 'posterize', exact: true, apply: curves([table((t) => Math.floor((255 / 256) * t * levels) / (levels - 1))]) };
  }
  if (blocks.thrs && blocks.thrs.length >= 2) { // threshold: white where the luminosity is above the level (1..255)
    const level = view(blocks.thrs).getUint16(0), cut = (level - 1 / 255) * (255 / 256);
    return { kind: 'threshold', exact: true, apply: (r, g, b) => { const v = Math.round(0.3 * r + 0.59 * g + 0.11 * b) > cut ? 255 : 0; return [v, v, v]; } };
  }
  if (blocks.expA && blocks.expA.length >= 14) { // exposure: in linear light (sRGB taken as gamma 2.2), then its own gamma
    const v = view(blocks.expA), exposure = v.getFloat32(2), offset = v.getFloat32(6), gamma = Math.min(9.99, Math.max(0.01, v.getFloat32(10)));
    return { kind: 'exposure', exact: false, apply: curves([table((t) => clamp01(clamp01(t ** 2.2 * 2 ** exposure + offset) ** (1 / gamma)) ** (1 / 2.2))]) };
  }
  if (blocks.grdm && blocks.grdm.length >= 8) { // gradient map: the luminosity picks a colour on the gradient
    const b = blocks.grdm, v = view(b);
    const version = v.getUint16(0), reversed = b[2];
    let p = 4 + (version === 3 ? 4 : 0);
    p += 4 + 2 * v.getUint32(p); // the gradient's name
    const n = v.getUint16(p); p += 2;
    const stops = [];
    for (let i = 0; i < n; i++) { stops.push({ at: v.getUint32(p) / 4096, mid: v.getUint32(p + 4) / 100, rgb: [0, 1, 2].map((k) => v.getUint16(p + 10 + k * 2) / 65535) }); p += 20; }
    if (!stops.length) return null;
    stops.sort((x, y) => x.at - y.at);
    const colourAt = (t) => {
      if (reversed) t = 1 - t;
      if (t <= stops[0].at) return stops[0].rgb;
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i], c = stops[i + 1];
        if (t > c.at) continue;
        let u = (t - a.at) / Math.max(1e-9, c.at - a.at), m = Math.min(0.99, Math.max(0.01, c.mid ?? 0.5));
        u = u < m ? (0.5 * u) / m : 0.5 + (0.5 * (u - m)) / (1 - m); // the midpoint: where the two colours are half and half
        return a.rgb.map((x, k) => x + (c.rgb[k] - x) * u);
      }
      return stops[stops.length - 1].rgb;
    };
    const lut = Array.from({ length: 256 }, (_, i) => colourAt(i / 255).map((x) => x * 255));
    return { kind: 'gradientMap', exact: false, apply: (r, g, bb) => lut[Math.max(0, Math.min(255, Math.round(0.3 * r + 0.59 * g + 0.11 * bb)))] };
  }
  if (blocks.blwh) { // black & white: how light each of the six colours turns (%), and a tint
    const d = descriptor(blocks.blwh, 4), w = { r: (d['Rd  '] ?? 40) / 100, y: (d.Yllw ?? 60) / 100, g: (d['Grn '] ?? 40) / 100, c: (d['Cyn '] ?? 60) / 100, b: (d['Bl  '] ?? 20) / 100, m: (d.Mgnt ?? 80) / 100 };
    const tint = d.useTint && d.tintColor ? [d.tintColor['Rd  '] ?? 255, d.tintColor['Grn '] ?? 255, d.tintColor['Bl  '] ?? 255].map((x) => x / 255) : null;
    return {
      kind: 'blackWhite', exact: false, apply: (r, g, b) => {
        // the grey: the smallest channel, plus the part shared by the two largest (a secondary colour), plus the largest's own part
        const c = [r, g, b], order = [0, 1, 2].sort((i, j) => c[j] - c[i]), [hi, mid, lo] = order.map((i) => c[i]);
        const primary = [w.r, w.g, w.b][order[0]], key = [order[0], order[1]].sort().join(), secondary = { '0,1': w.y, '1,2': w.c, '0,2': w.m }[key];
        const grey = clamp01((lo + (mid - lo) * secondary + (hi - mid) * primary) / 255);
        if (!tint) return [grey * 255, grey * 255, grey * 255];
        const [h, sat] = rgb2hsl(...tint);
        return hsl2rgb(h, sat, grey).map((x) => x * 255);
      },
    };
  }
  if (blocks.phfl && blocks.phfl.length >= 17) { // photo filter: towards a colour by its density (as a multiply), luminosity kept or not
    const v = view(blocks.phfl), version = v.getUint16(0);
    let colour, p;
    if (version === 3) { const [X, Y, Z] = [0, 1, 2].map((k) => v.getInt32(2 + k * 4) / 65536 / 100); colour = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z].map((x) => clamp01(x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); p = 14; }
    else { colour = [0, 1, 2].map((k) => v.getUint16(4 + k * 2) / 65535); p = 12; }
    const density = v.getUint32(p) / 100, keep = blocks.phfl[p + 4];
    return {
      kind: 'photoFilter', exact: false, apply: (r, g, b) => {
        const c0 = [r / 255, g / 255, b / 255];
        let c = c0.map((x, k) => x * (1 - density) + x * colour[k] * density);
        if (keep) { const [h, sat] = rgb2hsl(...c), [, , l] = rgb2hsl(...c0); c = hsl2rgb(h, sat, l); }
        return c.map((x) => x * 255);
      },
    };
  }
  if (blocks.CgEd || blocks.brit) { // brightness / contrast (the newer one in a descriptor)
    let br = 0, ct = 0, legacy = false;
    try {
      if (blocks.CgEd) { const d = descriptor(blocks.CgEd, 4); br = d.Brgh ?? 0; ct = d.Cntr ?? 0; legacy = !!d.useLegacy; }
      else { if (blocks.brit.length < 4) return null; const v = view(blocks.brit); br = v.getInt16(0); ct = v.getInt16(2); legacy = true; }
    } catch { return null; }
    const t = legacy
      ? table((x) => { const y = x + br / 255; return (y - 0.5) * (ct >= 0 ? 1 / Math.max(0.01, 1 - ct / 100) : 1 + ct / 100) + 0.5; })
      : table((x) => { // brightness bends the curve (more in the middle), contrast steepens it about the middle
        const y = x + (br / 150) * 0.5 * x * (1 - x) * 4 * 0.5;
        return (y - 0.5) * Math.tan(((ct / 100 + 1) * Math.PI) / 4) + 0.5;
      });
    return { kind: 'brightnessContrast', exact: false, apply: curves([t]) };
  }
  return null;
}

/** pixels (straight RGBA, w × h) changed by an adjustment where cover(x, y) (0..1, its masks × its opacity) lets it */
export function applyAdjustment(adj, rgba, w, h, cover) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (!rgba[o + 3]) continue;
    const k = cover(x, y);
    if (k <= 0) continue;
    const out = adj.apply(rgba[o], rgba[o + 1], rgba[o + 2]);
    for (let c = 0; c < 3; c++) rgba[o + c] = Math.max(0, Math.min(255, Math.round(rgba[o + c] + (out[c] - rgba[o + c]) * k)));
  }
}

/** A Krita filter layer: filtername and its <param name="..."> values -> an adjustment, or null (not read).
 *  Krita's own settings mapped onto the same colour functions: all close to Krita, not exact. */
export function kritaFilter(name, params) {
  const num = (k, d = 0) => (params[k] == null || params[k] === '' ? d : Number(params[k]));
  const be16 = (v) => [(v >> 8) & 255, v & 255];
  const close = (a) => (a ? { ...a, exact: false } : null);
  if (name === 'invert') return { kind: 'invert', exact: true, apply: (r, g, b) => [255 - r, 255 - g, 255 - b] };
  if (name === 'desaturate') return { kind: 'desaturate', exact: false, apply: (r, g, b) => { const v = 0.3 * r + 0.59 * g + 0.11 * b; return [v, v, v]; } };
  if (name === 'levels') { // the legacy keys (Krita writes them next to its newer "lightness" one): one curve for all channels
    const rec = [num('blackvalue', 0), num('whitevalue', 255), num('outblackvalue', 0), num('outwhitevalue', 255), Math.round(num('gammavalue', 1) * 100)];
    return close(adjustment({ levl: Uint8Array.from([0, 2, ...rec.flatMap(be16)]) }));
  }
  if (name === 'hsvadjustment') { // h −180..180, s and v −100..100 (HSV / HSL: types 0 and 1); colorize
    const type = num('type', 1), colorize = params.colorize === 'true';
    if (type > 1 && !colorize) return null;
    const hsl = [num('h'), num('s'), num('v')].map(Math.round), z = [0, 0, 0];
    const block = [0, 2, colorize ? 1 : 0, 0, ...(colorize ? hsl : z).flatMap(be16), ...(colorize ? z : hsl).flatMap(be16), ...Array(84).fill(0)];
    return close(adjustment({ hue2: Uint8Array.from(block) }));
  }
  if (name === 'colorbalance') {
    const set = ['shadows', 'midtones', 'highlights'].flatMap((t) => ['cyan_red', 'magenta_green', 'yellow_blue'].map((c) => Math.round(num(`${c}_${t}`))));
    return close(adjustment({ blnc: Uint8Array.from([...set.flatMap(be16), params.preserve_luminosity === 'true' ? 1 : 0]) }));
  }
  if (name === 'posterize') return close(adjustment({ post: Uint8Array.from([...be16(num('steps', 16)), 0, 0]) }));
  if (name === 'threshold') return close(adjustment({ thrs: Uint8Array.from([...be16(num('threshold', 128)), 0, 0]) }));
  return null;
}
