// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Curve keys (format 1.1): tables 41-43, the core's expansion of them, and the tools around it.
//
//   table 41 tracks (12 bytes): target u32, base f32, step f32 (step 0: no keys, the value is base)
//   table 42 keys (4-byte words): for each track with keys, a count word (2 or more), then its keys (t u16, v u16)
//   table 43 curves (16 bytes): key u32 (the index in table 42 of the key the segment starts at), n u16 (2..256),
//                               cx1, cy1, cx2, cy2 u16, reserved u16 (0)
//
// A curve makes the segment from its key (t0, v0) to the next key (t1, v1) a cubic Bezier from (0, v0) over
// (cx1 / 65535, cy1), (cx2 / 65535, cy2) to (1, v1): x is the fraction of the segment's time, y is in key
// value units (0..65535, as v). The core turns it into n straight pieces at load: the points at s = i / n
// (i = 1..n-1), time t0 + x(s) (t1 - t0) and value y(s), each rounded half up, exactly in integers; a point
// not later than the key before it, or not before t1, is dropped. expandTracks() here gives the same keys,
// bit for bit (tests/curve_keys_test.mjs compares them with the core's).
//
// Plain ES module: the compiler, import_ug9, the editor and the tests use it.

export const TABLE_TRACKS11 = 41, TABLE_KEYS11 = 42, TABLE_CURVES = 43; // TB_TRACKS11.. in core/src/ugo_internal.h
export const CURVE_MAX_PIECES = 256; // UGO_CURVE_MAX_PIECES
export const CURVE_FORMAT_MINOR = 1; // a file with these tables is 1.1 (they are written with flag 2: a 1.0 core refuses it)

const div = (x, d) => (2n * x + d) / (2n * d); // x / d rounded half up (BigInt: exact)

/**
 * The points the core puts inside one curved segment: [[t, v], ...] (whole ticks and value units),
 * from key a = [t0, v0] to key b = [t1, v1] with curve c = { n, cx1, cy1, cx2, cy2 } (all whole numbers).
 */
export function curvePoints(a, b, c) {
  const n = BigInt(c.n), n3 = n * n * n, span = BigInt(b[0] - a[0]);
  const [cx1, cy1, cx2, cy2, v0, v1] = [c.cx1, c.cy1, c.cx2, c.cy2, a[1], b[1]].map(BigInt);
  const out = [];
  let last = a[0];
  for (let s = 1n; s < n; s++) {
    const u = n - s;
    const x = 3n * u * u * s * cx1 + 3n * u * s * s * cx2 + s * s * s * 65535n;
    const y = u * u * u * v0 + 3n * u * u * s * cy1 + 3n * u * s * s * cy2 + s * s * s * v1;
    const t = a[0] + Number(div(x * span, 65535n * n3));
    if (t <= last || t >= b[0]) continue;
    out.push([t, Number(div(y, n3))]);
    last = t;
  }
  return out;
}

/** The exact curve at s (0..1), unrounded: [time, value] (for measuring how far the pieces are from it). */
export function curveAt(a, b, c, s) {
  const u = 1 - s, w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s;
  return [a[0] + (w1 * c.cx1 / 65535 + w2 * c.cx2 / 65535 + w3) * (b[0] - a[0]), w0 * a[1] + w1 * c.cy1 + w2 * c.cy2 + w3 * b[1]];
}

const lerpAt = (pts, t) => { // straight pieces through pts (sorted by time) at time t
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1][0] <= t) i++;
  const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
  return t1 > t0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : v1;
};

/** How far (in value units) the core's pieces for this curve are from the exact curve, at worst. */
export function curveError(a, b, c) {
  const pts = [a, ...curvePoints(a, b, c), b];
  let worst = 0;
  const N = 64 * c.n;
  for (let i = 0; i <= N; i++) {
    const [t, v] = curveAt(a, b, c, i / N);
    worst = Math.max(worst, Math.abs(lerpAt(pts, t) - v));
  }
  return worst;
}

/**
 * The fewest pieces (2..256) that keep the segment within `tolerance` value units of the exact curve
 * (the compiler's choice of n). c is { cx1, cy1, cx2, cy2 } (its n is ignored).
 */
export function curvePieces(a, b, c, tolerance = 32) {
  for (let n = 2; n < CURVE_MAX_PIECES; n++) if (curveError(a, b, { ...c, n }) <= tolerance) return n;
  return CURVE_MAX_PIECES;
}

class CurveError extends Error {
  constructor(msg, code) { super(`ugo curve keys: ${msg}`); this.code = code; }
}

/**
 * Tables 41-43 -> the tracks and keys as the core expands them (the 1.0 shapes):
 *   tracks11 [{ target, base, step }], words (Uint32Array or array of table 42), curves [{ key, n, cx1, cy1, cx2, cy2, reserved }]
 *   -> { tracks: [[target, firstKey, keyCount, base, step]], keys: [[t, v]] }
 * Checks what the core checks of these tables (throws an Error with .code 'range' or 'value', as UGO_ERR_RANGE / _VALUE).
 */
export function expandTracks(tracks11, words, curves = []) {
  const key = (j) => [words[j] & 0xffff, words[j] >>> 16];
  const tracks = [], keys = [];
  let at = 0, ci = 0;
  for (const tr of tracks11) {
    if (tr.step === 0) { tracks.push([tr.target >>> 0, 0, 1, tr.base, 0]); continue; }
    if (at >= words.length) throw new CurveError('a track has no keys left in table 42', 'range');
    const c = words[at] >>> 0, first = at + 1, last = at + c;
    if (c < 2 || c > words.length - at - 1) throw new CurveError(`a key count of ${c} at word ${at}`, 'range');
    const firstKey = keys.length;
    for (let j = first; j <= last; j++) {
      keys.push(key(j));
      if (ci < curves.length && curves[ci].key < last && curves[ci].key === j) {
        const cv = curves[ci];
        if (ci && cv.key <= curves[ci - 1].key) throw new CurveError('curves must be in key order, one per segment', 'range');
        if (!(cv.n >= 2 && cv.n <= CURVE_MAX_PIECES) || cv.reserved) throw new CurveError(`a curve of ${cv.n} pieces`, 'value');
        if (tr.target >>> 31 || key(j + 1)[0] < key(j)[0]) throw new CurveError('a curve on a smooth track, or keys out of order', 'value');
        keys.push(...curvePoints(key(j), key(j + 1), cv));
        ci++;
      }
    }
    if (ci < curves.length && curves[ci].key < last) throw new CurveError(`a curve on word ${curves[ci].key}, which is not a key starting a segment`, 'range');
    tracks.push([tr.target >>> 0, firstKey, keys.length - firstKey, tr.base, tr.step]);
    at = last + 1;
  }
  if (at !== words.length) throw new CurveError('words left over in table 42', 'value');
  if (ci !== curves.length) throw new CurveError('a curve not on a segment', 'range');
  return { tracks, keys };
}

/**
 * 1.0 tracks and keys -> tables 41-43 (what a compiler writes):
 *   tracks [[target, firstKey, keyCount, base, step]], keys [[t, v]],
 *   curves [{ track, key (the key's index within its track), n, cx1, cy1, cx2, cy2 }]
 *   -> { tracks11: [{ target, base, step }], words: Uint32Array, curves: [{ key, n, cx1, cy1, cx2, cy2, reserved: 0 }] }
 */
export function packTracks(tracks, keys, curves = []) {
  const tracks11 = [], words = [], out = [];
  const byTrack = new Map();
  for (const c of curves) byTrack.set(`${c.track}:${c.key}`, c);
  tracks.forEach(([target, firstKey, n, base, step], ti) => {
    if (n <= 1) { tracks11.push({ target, base, step: 0 }); return; }
    tracks11.push({ target, base, step });
    words.push(n);
    for (let k = 0; k < n; k++) {
      const c = byTrack.get(`${ti}:${k}`);
      if (c) {
        if (k === n - 1) throw new CurveError(`track ${ti}: a curve on its last key`, 'range');
        out.push({ key: words.length, n: c.n, cx1: c.cx1, cy1: c.cy1, cx2: c.cx2, cy2: c.cy2, reserved: 0 });
      }
      const [t, v] = keys[firstKey + k];
      words.push((t | (v << 16)) >>> 0);
    }
  });
  return { tracks11, words: Uint32Array.from(words), curves: out };
}

// ---- whole files ----

const TOC_NEED = 2;

/** The tables of a .ug9: { major, minor, headerSize, canvas bytes, tables: Map(kind -> { bytes, count, recSize, flags }) }. */
export function readTables(buffer) {
  const u8 = new Uint8Array(buffer), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hsize = dv.getUint32(12, true), ntoc = dv.getUint32(32, true), tables = new Map();
  for (let i = 0; i < ntoc; i++) {
    const e = hsize + 16 * i, kind = dv.getUint32(e, true), at = dv.getUint32(e + 4, true), count = dv.getUint32(e + 8, true);
    const w = dv.getUint32(e + 12, true), recSize = w & 0xffff, flags = w >>> 16;
    tables.set(kind, { bytes: u8.slice(at, at + count * recSize), count, recSize, flags });
  }
  return { major: dv.getUint16(4, true), minor: dv.getUint16(6, true), header: u8.slice(0, hsize), tables };
}

/** Tables -> a .ug9 (the header's fixed fields kept, the table of contents and the layout written anew). */
export function writeTables({ major, minor, header, tables }) {
  const list = [...tables.entries()];
  const hsize = header.length, body = hsize + 16 * list.length;
  let size = body;
  const at = list.map(([, t]) => { const a = size; size += (t.bytes.length + 3) & ~3; return a; });
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set(header);
  dv.setUint16(4, major, true); dv.setUint16(6, minor, true);
  dv.setUint32(8, size, true); dv.setUint32(12, hsize, true); dv.setUint32(32, list.length, true);
  list.forEach(([kind, t], i) => {
    const e = hsize + 16 * i;
    dv.setUint32(e, kind, true); dv.setUint32(e + 4, at[i], true); dv.setUint32(e + 8, t.count, true);
    dv.setUint32(e + 12, (t.recSize | (t.flags << 16)) >>> 0, true);
    out.set(t.bytes, at[i]);
  });
  return out;
}

/**
 * A 1.0 .ug9 -> the same model as 1.1 (tables 21 and 22 replaced by 41-43, with the curves given:
 * [{ track, key, n, cx1, cy1, cx2, cy2 }], track = the index in table 21, key = within the track).
 */
export function toCurveFile(buffer, curves = []) {
  const f = readTables(buffer);
  const tr = f.tables.get(21), ky = f.tables.get(22);
  const tdv = tr ? new DataView(tr.bytes.buffer) : null, kdv = ky ? new DataView(ky.bytes.buffer) : null;
  const tracks = Array.from({ length: tr ? tr.count : 0 }, (_, i) => [0, 4, 8].map((o) => tdv.getUint32(20 * i + o, true))
    .concat([12, 16].map((o) => tdv.getFloat32(20 * i + o, true))));
  const keys = Array.from({ length: ky ? ky.count : 0 }, (_, i) => [kdv.getUint16(4 * i, true), kdv.getUint16(4 * i + 2, true)]);
  const p = packTracks(tracks, keys, curves);
  const t11 = new DataView(new ArrayBuffer(12 * p.tracks11.length));
  p.tracks11.forEach((t, i) => { t11.setUint32(12 * i, t.target, true); t11.setFloat32(12 * i + 4, t.base, true); t11.setFloat32(12 * i + 8, t.step, true); });
  const cv = new DataView(new ArrayBuffer(16 * p.curves.length));
  p.curves.forEach((c, i) => {
    cv.setUint32(16 * i, c.key, true);
    [c.n, c.cx1, c.cy1, c.cx2, c.cy2, 0].forEach((v, k) => cv.setUint16(16 * i + 4 + 2 * k, v, true));
  });
  f.tables.delete(21); f.tables.delete(22);
  if (p.tracks11.length) {
    f.tables.set(TABLE_TRACKS11, { bytes: new Uint8Array(t11.buffer), count: p.tracks11.length, recSize: 12, flags: TOC_NEED });
    f.tables.set(TABLE_KEYS11, { bytes: new Uint8Array(p.words.buffer), count: p.words.length, recSize: 4, flags: TOC_NEED });
    if (p.curves.length) f.tables.set(TABLE_CURVES, { bytes: new Uint8Array(cv.buffer), count: p.curves.length, recSize: 16, flags: TOC_NEED });
  }
  return writeTables({ ...f, minor: Math.max(f.minor, CURVE_FORMAT_MINOR) });
}

/** A 1.1 .ug9's tables 41-43 as the core expands them: { tracks, keys } (see expandTracks), or null for a file without them. */
export function readCurveTracks(buffer) {
  const f = readTables(buffer), tr = f.tables.get(TABLE_TRACKS11);
  if (!tr) return null;
  const tdv = new DataView(tr.bytes.buffer), wk = f.tables.get(TABLE_KEYS11), cvt = f.tables.get(TABLE_CURVES);
  const tracks11 = Array.from({ length: tr.count }, (_, i) => ({ target: tdv.getUint32(12 * i, true), base: tdv.getFloat32(12 * i + 4, true), step: tdv.getFloat32(12 * i + 8, true) }));
  const words = wk ? new Uint32Array(wk.bytes.buffer, 0, wk.count) : new Uint32Array(0);
  const cdv = cvt ? new DataView(cvt.bytes.buffer) : null;
  const curves = Array.from({ length: cvt ? cvt.count : 0 }, (_, i) => {
    const g = (k) => cdv.getUint16(16 * i + 4 + 2 * k, true);
    return { key: cdv.getUint32(16 * i, true), n: g(0), cx1: g(1), cy1: g(2), cx2: g(3), cy2: g(4), reserved: g(5) };
  });
  return expandTracks(tracks11, words, curves);
}
