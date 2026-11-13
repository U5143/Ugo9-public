// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animated GIF and APNG encoders for the browser (same approach as cli/encoders.c), and
// WebM / MP4 video through WebCodecs.
// frames: array of Uint8Array (w*h*4 RGBA, straight alpha).

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (v) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function chunk(type, ...data) {
  const t = ascii(type);
  const len = data.reduce((s, d) => s + d.length, 0);
  return [be32(len), t, ...data, be32(crc32([t, ...data]))];
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// PNG filter type 4 (Paeth) on every row: compresses smooth artwork well.
function paethFilter(rgba, w, h) {
  const stride = w * 4, out = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), r = y * stride;
    out[o] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[r + x - 4] : 0;
      const b = y > 0 ? rgba[r - stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[r - stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[o + 1 + x] = (rgba[r + x] - pred) & 255;
    }
  }
  return out;
}

// Each frame's PNG data: Paeth-filtered rows, deflated (CompressionStream). Done in a few Workers
// side by side where the browser has them (deflate is most of an APNG's time), else here.
const PNG_JOB = `const paeth = ${paethFilter.toString()};
onmessage = async (e) => { const { i, rgba, w, h } = e.data;
  const b = new Uint8Array(await new Response(new Blob([paeth(rgba, w, h)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  postMessage({ i, b }, [b.buffer]); };`;
async function pngData(jobs) { // jobs: [{ rgba, w, h }] -> deflated filtered data, in order
  const out = new Array(jobs.length);
  let pool = [];
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1, n = Math.min(8, cores - 1, jobs.length);
  if (n >= 2 && typeof Worker !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([PNG_JOB], { type: 'text/javascript' }));
      pool = Array.from({ length: n }, () => new Worker(url));
      URL.revokeObjectURL(url);
    } catch { pool = []; } // no Workers from a Blob here (a strict page): one by one
  }
  if (!pool.length) {
    for (let i = 0; i < jobs.length; i++) out[i] = await deflate(paethFilter(jobs[i].rgba, jobs[i].w, jobs[i].h));
    return out;
  }
  let next = 0;
  try {
    await Promise.all(pool.map((wk) => new Promise((ok, fail) => {
      wk.onerror = (e) => fail(e.error || new Error(e.message || 'PNG worker failed'));
      wk.onmessage = (e) => { out[e.data.i] = e.data.b; give(); };
      const give = () => { if (next >= jobs.length) return ok(); const i = next++, j = jobs[i]; wk.postMessage({ i, rgba: j.rgba, w: j.w, h: j.h }); };
      give();
    })));
  } finally { for (const wk of pool) wk.terminate(); }
  return out;
}

// the box [x0, y0, x1, y1) of a frame's pixels that are not fully transparent (null: none)
function drawnBox(f, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  const px = new Uint32Array(f.buffer, f.byteOffset, (f.byteLength >> 2)), big = new Uint8Array(new Uint32Array([1]).buffer)[0] === 0;
  const opaque = big ? 0xff : 0xff000000;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    let a = 0;
    while (a < w && !(px[r + a] & opaque)) a++;
    if (a === w) continue;
    let b = w - 1;
    while (!(px[r + b] & opaque)) b--;
    if (a < x0) x0 = a; if (b + 1 > x1) x1 = b + 1;
    if (y < y0) y0 = y; y1 = y + 1;
  }
  return x1 > x0 ? [x0, y0, x1, y1] : null;
}

/** RGBA frames -> APNG Blob. Every frame after the first is written as the box of its drawn
 *  pixels only (the frame before is cleared first: dispose to background, blend source). */
export async function encodeAPNG(frames, w, h, fps) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(w), 0); ihdr.set(be32(h), 4); ihdr[8] = 8; ihdr[9] = 6;
  parts.push(...chunk('IHDR', ihdr));
  parts.push(...chunk('acTL', be32(frames.length), be32(0)));
  const intFps = Number.isInteger(fps) && fps <= 65535, tb = timeBase(fps), ntsc = !intFps && tb.delta === 1001 && tb.scale <= 65535;
  const num = intFps ? 1 : ntsc ? 1001 : Math.round(1000 / fps), den = intFps ? fps : ntsc ? tb.scale : 1000; // 29.97: 1001/30000
  // the first frame is the whole picture (the default image); the others their drawn box (a
  // fully transparent frame: one transparent pixel)
  const jobs = frames.map((f, i) => {
    const [x0, y0, x1, y1] = i === 0 ? [0, 0, w, h] : drawnBox(f, w, h) || [0, 0, 1, 1];
    const bw = x1 - x0, bh = y1 - y0;
    if (bw === w && bh === h) return { x: 0, y: 0, w, h, rgba: f.slice() };
    const rgba = new Uint8Array(bw * bh * 4);
    for (let y = 0; y < bh; y++) rgba.set(f.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1) * 4), y * bw * 4);
    return { x: x0, y: y0, w: bw, h: bh, rgba };
  });
  const boxes = jobs.map(({ x, y, w: bw, h: bh }) => [x, y, bw, bh]);
  const data = await pngData(jobs);
  let seq = 0;
  for (let i = 0; i < frames.length; i++) {
    const [x, y, bw, bh] = boxes[i], fctl = new Uint8Array(26);
    fctl.set(be32(seq++), 0); fctl.set(be32(bw), 4); fctl.set(be32(bh), 8); fctl.set(be32(x), 12); fctl.set(be32(y), 16);
    fctl[20] = num >> 8; fctl[21] = num & 255; fctl[22] = den >> 8; fctl[23] = den & 255;
    fctl[24] = 1; fctl[25] = 0; // dispose to background (cleared before the next frame), blend source
    parts.push(...chunk('fcTL', fctl));
    if (i === 0) parts.push(...chunk('IDAT', data[i]));
    else parts.push(...chunk('fdAT', be32(seq++), data[i]));
  }
  parts.push(...chunk('IEND'));
  return new Blob(parts, { type: 'image/apng' });
}

// ---- GIF -----------------------------------------------------------------

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  push(...values) { for (const v of values) this.byte(v); }
  byte(v) {
    if (this.len === this.buf.length) { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.len++] = v;
  }
  bytes(a) { // several at once
    if (this.len + a.length > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + a.length)); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
    this.buf.set(a, this.len); this.len += a.length;
  }
  result() { return this.buf.subarray(0, this.len); }
}

function medianCut(samples, want) {
  const boxes = [[0, samples.length]];
  const channel = (c, k) => (c >> (16 - 8 * k)) & 255;
  while (boxes.length < want) {
    let best = -1, bestRange = 0, bestAxis = 0;
    boxes.forEach(([lo, hi], i) => {
      if (hi - lo < 2) return;
      for (let k = 0; k < 3; k++) {
        let mn = 255, mx = 0;
        for (let j = lo; j < hi; j++) { const v = channel(samples[j], k); if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mx - mn > bestRange) { bestRange = mx - mn; best = i; bestAxis = k; }
      }
    });
    if (best < 0) break;
    const [lo, hi] = boxes[best];
    // equal on the axis: the whole value decides (the same order as cli/encoders.c on every C library)
    const sorted = samples.subarray(lo, hi).sort((a, b) => channel(a, bestAxis) - channel(b, bestAxis) || (a >>> 0) - (b >>> 0));
    samples.set(sorted, lo);
    const mid = (lo + hi) >> 1;
    boxes[best] = [lo, mid];
    boxes.push([mid, hi]);
  }
  return boxes.map(([lo, hi]) => {
    const acc = [0, 0, 0];
    for (let j = lo; j < hi; j++) for (let k = 0; k < 3; k++) acc[k] += channel(samples[j], k);
    return acc.map((v) => Math.round(v / Math.max(1, hi - lo)));
  });
}

// LZW for GIF (8-bit codes). table: { tree, stamp, gen } kept from frame to frame: tree[cur * 256 + k]
// is the code for cur followed by k where stamp[...] is the table's generation (a clear, or a new
// frame, starts a new generation instead of emptying 2 MB)
function lzwTable() { return { tree: new Uint16Array(4096 * 256), stamp: new Uint16Array(4096 * 256), gen: 0 }; }
function lzw(out, idx, table = lzwTable()) {
  const minCode = 8, clear = 256, eoi = 257, { tree, stamp } = table;
  const fresh = () => { if (++table.gen === 65536) { stamp.fill(0); table.gen = 1; } return table.gen; };
  let gen = fresh(), codeSize = minCode + 1, maxCode = eoi, cur = -1;
  let bits = 0, nbits = 0, n = 0;
  const block = new Uint8Array(255);
  const flush = () => { if (n) { out.byte(n); out.bytes(block.subarray(0, n)); n = 0; } };
  const write = (code, size) => {
    bits |= code << nbits; nbits += size;
    while (nbits >= 8) { block[n++] = bits & 255; bits >>>= 8; nbits -= 8; if (n === 255) flush(); }
  };
  out.byte(minCode);
  write(clear, codeSize);
  for (let i = 0; i < idx.length; i++) {
    const k = idx[i];
    if (cur < 0) { cur = k; continue; }
    const at = (cur << 8) | k;
    if (stamp[at] === gen) { cur = tree[at]; continue; }
    write(cur, codeSize);
    tree[at] = ++maxCode; stamp[at] = gen;
    if (maxCode >= 1 << codeSize) codeSize++;
    if (maxCode === 4095) { write(clear, codeSize); gen = fresh(); codeSize = minCode + 1; maxCode = eoi; }
    cur = k;
  }
  if (cur >= 0) write(cur, codeSize);
  write(eoi, codeSize);
  if (nbits > 0) write(0, 8 - nbits);
  flush();
  out.byte(0);
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// the palette for all frames: median cut of a sample of their pixels; one entry left for
// transparency when some pixel is under half opaque
function gifPalette(frames, w, h) {
  const npx = w * h, total = npx * frames.length;
  const step = Math.floor(total / 262144) + 1;
  const samples = [];
  let transparent = false;
  for (let i = 0; i < total; i += step) {
    const f = frames[Math.floor(i / npx)], p = 4 * (i % npx);
    if (f[p + 3] >= 128) samples.push((f[p] << 16) | (f[p + 1] << 8) | f[p + 2]);
  }
  for (const f of frames) { for (let p = 3; p < f.length; p += 4) if (f[p] < 128) { transparent = true; break; } if (transparent) break; }
  const pal = samples.length ? medianCut(Uint32Array.from(samples), transparent ? 255 : 256) : [[0, 0, 0]];
  const tIndex = transparent ? pal.length : -1;
  while (pal.length < 256) pal.push([0, 0, 0]);
  return { pal, tIndex };
}

// one frame -> its LZW data (the image data of a GIF frame). The nearest colours and the LZW
// table are kept from frame to frame. Self-contained (with BAYER, ByteWriter, lzwTable, lzw):
// the Workers of encodeGIFAsync run it too.
function gifFrameCoder(pal, tIndex, w, h, dither) {
  const lut = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (lut[key] < 0) {
      const cr = (r & ~7) | 4, cg = (g & ~7) | 4, cb = (b & ~7) | 4;
      let best = 0, bd = Infinity;
      for (let k = 0; k < 256; k++) {
        if (k === tIndex) continue;
        const dr = cr - pal[k][0], dg = cg - pal[k][1], db = cb - pal[k][2];
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bd) { bd = d; best = k; }
      }
      lut[key] = best;
    }
    return lut[key];
  };
  // per place in the 4×4 dither pattern: a value -> its 5 bits after the dither (clamped)
  const q5 = new Uint8Array(16 * 256);
  for (let k = 0; k < 16; k++) { const d = dither ? (BAYER[k] - 8) >> 1 : 0; for (let v = 0; v < 256; v++) q5[k * 256 + v] = Math.min(255, Math.max(0, v + d)) >> 3; }
  const idx = new Uint8Array(w * h), table = lzwTable();
  return (f) => {
    for (let y = 0, p = 0, o = 0; y < h; y++) {
      const row = (y & 3) << 10;
      for (let x = 0; x < w; x++, p += 4, o++) {
        if (tIndex >= 0 && f[p + 3] < 128) { idx[o] = tIndex; continue; }
        const t = row | ((x & 3) << 8), r = q5[t | f[p]], g = q5[t | f[p + 1]], b = q5[t | f[p + 2]], c = lut[(r << 10) | (g << 5) | b];
        idx[o] = c >= 0 ? c : nearest(r << 3, g << 3, b << 3);
      }
    }
    const out = new ByteWriter();
    lzw(out, idx, table);
    return out.result();
  };
}

function gifFile(w, h, fps, { pal, tIndex }, data) {
  const out = new ByteWriter();
  out.push(...ascii('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf7, Math.max(0, tIndex), 0);
  for (const c of pal) out.push(...c);
  out.push(0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  let tPrev = 0;
  data.forEach((d, fi) => {
    const tNext = (100 * (fi + 1)) / fps;
    const delay = Math.max(1, Math.round(tNext) - Math.round(tPrev));
    tPrev = tNext;
    out.push(0x21, 0xf9, 4, (tIndex >= 0 ? 1 : 0) | ((tIndex >= 0 ? 2 : 1) << 2), delay & 255, delay >> 8, Math.max(0, tIndex), 0);
    out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);
    out.bytes(d);
  });
  out.byte(0x3b);
  return new Blob([out.result()], { type: 'image/gif' });
}

// matte ([r, g, b] 0..255, the colour of the page the GIF goes on): a GIF pixel is either opaque or not,
// so a half-transparent edge drawn as it is shows the picture's own edge colour as a dark or light rim on
// the page. Each pixel at least a quarter opaque is mixed with the matte by its alpha and made opaque;
// the rest becomes transparent (as cli/ugo_export.c --matte)
export function matteFrames(frames, matte) {
  if (!matte) return frames;
  const [mr, mg, mb] = matte;
  return frames.map((f) => {
    const o = new Uint8Array(f.length);
    for (let p = 0; p < f.length; p += 4) {
      const a = f[p + 3];
      if (a < 64) continue;
      o[p] = Math.round((f[p] * a + mr * (255 - a)) / 255); o[p + 1] = Math.round((f[p + 1] * a + mg * (255 - a)) / 255); o[p + 2] = Math.round((f[p + 2] * a + mb * (255 - a)) / 255); o[p + 3] = 255;
    }
    return o;
  });
}

export function encodeGIF(frames, w, h, fps, { dither = true, matte = null } = {}) {
  frames = matteFrames(frames, matte);
  const p = gifPalette(frames, w, h), code = gifFrameCoder(p.pal, p.tIndex, w, h, dither);
  return gifFile(w, h, fps, p, frames.map((f) => code(f).slice()));
}

const GIF_JOB = `const BAYER = ${JSON.stringify(BAYER)};
${ByteWriter.toString()}
${lzwTable.toString()}
${lzw.toString()}
${gifFrameCoder.toString()}
let code = null;
onmessage = (e) => {
  if (e.data.start) { const { pal, tIndex, w, h, dither } = e.data.start; code = gifFrameCoder(pal, tIndex, w, h, dither); return; }
  const b = code(e.data.f).slice();
  postMessage({ i: e.data.i, b }, [b.buffer]);
};`;
/** encodeGIF with the frames coded in a few Workers side by side (the same bytes); one by one
 *  here where the browser has no Workers for it. */
export async function encodeGIFAsync(frames, w, h, fps, { dither = true, matte = null } = {}) {
  frames = matteFrames(frames, matte);
  const p = gifPalette(frames, w, h);
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1, n = Math.min(8, cores - 1, frames.length);
  let pool = [];
  if (n >= 2 && typeof Worker !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([GIF_JOB], { type: 'text/javascript' }));
      pool = Array.from({ length: n }, () => new Worker(url));
      URL.revokeObjectURL(url);
    } catch { pool = []; }
  }
  if (!pool.length) return encodeGIF(frames, w, h, fps, { dither });
  // each Worker keeps its own colour table and LZW table: the codes do not depend on them
  const data = new Array(frames.length);
  let next = 0;
  try {
    await Promise.all(pool.map((wk) => new Promise((ok, fail) => {
      wk.onerror = (e) => fail(e.error || new Error(e.message || 'GIF worker failed'));
      wk.onmessage = (e) => { data[e.data.i] = e.data.b; give(); };
      const give = () => { if (next >= frames.length) return ok(); const i = next++; wk.postMessage({ i, f: frames[i] }); };
      wk.postMessage({ start: { pal: p.pal, tIndex: p.tIndex, w, h, dither } });
      give();
    })));
  } finally { for (const wk of pool) wk.terminate(); }
  return gifFile(w, h, fps, p, data);
}

// ---- video: WebCodecs + small WebM and MP4 writers -------------------------
// The browser's VideoEncoder compresses (VP9 or VP8 for WebM, H.264 for MP4); the containers
// are written here. Frames are drawn over `background` (browsers' encoders here keep no alpha:
// for transparency use APNG, or ugo_export's WebM). Width and height are rounded up to even
// numbers (H.264 needs them), the extra row / column filled with the background.

const WEBM_CODECS = [['vp09.00.40.08', 'V_VP9'], ['vp8', 'V_VP8']];
const MP4_CODECS = ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];

async function pickCodec(list, w, h, fps, extra = {}) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const c of list) {
    const codec = Array.isArray(c) ? c[0] : c;
    const config = { codec, width: w, height: h, framerate: fps, bitrate: Math.max(1e6, Math.round(w * h * fps * 0.15)), ...extra };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, entry: c }; } catch { /* next */ }
  }
  return null;
}

/** Which video formats this browser can write: { webm, mp4 } (true / false). */
export async function videoSupport(w = 320, h = 240, fps = 30) {
  const W = w + (w & 1), H = h + (h & 1); // as the encoders pad them
  return { webm: !!(await pickCodec(WEBM_CODECS, W, H, fps)), mp4: !!(await pickCodec(MP4_CODECS, W, H, fps, { avc: { format: "avc" } })) };
}

// encode RGBA frames -> [{ data, key, time (µs) }], decoderConfig
async function encodeFrames(frames, w, h, fps, config, background, keyEvery) {
  const W = w + (w & 1), H = h + (h & 1), chunks = [];
  let decoderConfig = null, failure = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, key: chunk.type === 'key', time: chunk.timestamp });
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => { failure = e; },
  });
  enc.configure({ ...config, width: W, height: H });
  const [br, bg, bb] = background, px = new Uint8Array(W * H * 4);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x >= w || y >= h) { px[o] = br; px[o + 1] = bg; px[o + 2] = bb; px[o + 3] = 255; continue; }
      const s = (y * w + x) * 4, a = f[s + 3] / 255;
      px[o] = f[s] * a + br * (1 - a); px[o + 1] = f[s + 1] * a + bg * (1 - a); px[o + 2] = f[s + 2] * a + bb * (1 - a); px[o + 3] = 255;
    }
    const vf = new VideoFrame(px, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    if (failure) break;
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  return { chunks, decoderConfig, W, H };
}

// EBML (Matroska / WebM): element = id, size (variable-length integer), payload
const cat = (parts) => { const n = parts.reduce((s, p) => s + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const vint = (n) => { let len = 1; while (n >= 2 ** (7 * len) - 1) len++; const o = new Uint8Array(len); for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) o[i] = v & 255; o[0] |= 0x80 >> (len - 1); return o; };
const idBytes = (id) => { const o = []; for (let v = id; v > 0; v = Math.floor(v / 256)) o.unshift(v & 255); return new Uint8Array(o); };
const el = (id, ...payload) => { const p = cat(payload); return cat([idBytes(id), vint(p.length), p]); };
const uintEl = (id, n) => { const o = []; do { o.unshift(n & 255); n = Math.floor(n / 256); } while (n > 0); return el(id, new Uint8Array(o)); };
const strEl = (id, s) => el(id, new TextEncoder().encode(s));
const f64El = (id, x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return el(id, b); };

/** RGBA frames -> WebM (VP9, or VP8) Blob. opts: background [r, g, b] 0..255 (default white), keyEvery (frames, default 2 s). */
export async function encodeWebM(frames, w, h, fps, { background = [255, 255, 255], keyEvery } = {}) {
  const pick = await pickCodec(WEBM_CODECS, w + (w & 1), h + (h & 1), fps);
  if (!pick) throw new Error('this browser cannot encode VP9 or VP8 video (WebCodecs)');
  const { chunks, W, H } = await encodeFrames(frames, w, h, fps, pick.config, background, keyEvery || Math.max(1, Math.round(fps * 2)));
  const ms = (t) => Math.round(t / 1000), clusters = [];
  for (let i = 0; i < chunks.length;) { // one cluster per key frame (block times are 16-bit, relative)
    const start = ms(chunks[i].time), blocks = [];
    do {
      const c = chunks[i], rel = ms(c.time) - start, head = new Uint8Array(4);
      head[0] = 0x81; head[1] = (rel >> 8) & 255; head[2] = rel & 255; head[3] = c.key ? 0x80 : 0;
      blocks.push(el(0xa3, head, c.data));
      i++;
    } while (i < chunks.length && !chunks[i].key && ms(chunks[i].time) - start < 32000);
    clusters.push(el(0x1f43b675, uintEl(0xe7, start), ...blocks));
  }
  const header = el(0x1a45dfa3, uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), strEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2));
  const info = el(0x1549a966, uintEl(0x2ad7b1, 1000000), strEl(0x4d80, 'Ugo9'), strEl(0x5741, 'Ugo9'), f64El(0x4489, (frames.length * 1000) / fps));
  const track = el(0xae, uintEl(0xd7, 1), uintEl(0x73c5, 1), uintEl(0x83, 1), strEl(0x86, pick.entry[1]), uintEl(0x9c, 0),
    uintEl(0x23e383, Math.round(1e9 / fps)), el(0xe0, uintEl(0xb0, W), uintEl(0xba, H)));
  return new Blob([header, el(0x18538067, info, el(0x1654ae6b, track), ...clusters)], { type: 'video/webm' });
}

// ISO BMFF (MP4) boxes
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
const box = (type, ...payload) => { const p = cat(payload); return cat([u32(8 + p.length), new TextEncoder().encode(type), p]); };
const full = (type, version, flags, ...payload) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payload);
const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** RGBA frames -> MP4 (H.264) Blob. opts: background [r, g, b] 0..255 (default white), keyEvery (frames, default 2 s). */
export async function encodeMP4(frames, w, h, fps, { background = [255, 255, 255], keyEvery } = {}) {
  const pick = await pickCodec(MP4_CODECS, w + (w & 1), h + (h & 1), fps, { avc: { format: 'avc' } });
  if (!pick) throw new Error('this browser cannot encode H.264 video (WebCodecs)');
  const { chunks, decoderConfig, W, H } = await encodeFrames(frames, w, h, fps, pick.config, background, keyEvery || Math.max(1, Math.round(fps * 2)));
  return mp4File(w, h, W, H, fps, chunks, decoderConfig);
}
// an MP4 (H.264) file from the encoder's chunks
function mp4File(w, h, W, H, fps, chunks, decoderConfig) {
  if (!decoderConfig?.description) throw new Error('the H.264 encoder gave no decoder configuration (avcC)');
  const scale = Number.isInteger(fps) ? fps * 1000 : 90000, delta = Math.round(scale / fps), duration = delta * chunks.length;
  const avcC = box('avcC', new Uint8Array(decoderConfig.description instanceof ArrayBuffer ? decoderConfig.description : decoderConfig.description.buffer.slice(decoderConfig.description.byteOffset, decoderConfig.description.byteOffset + decoderConfig.description.byteLength)));
  const avc1 = box('avc1', new Uint8Array(6), u16(1), new Uint8Array(16), u16(W), u16(H), u32(0x480000), u32(0x480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff), avcC);
  const sync = chunks.map((c, i) => (c.key ? i + 1 : 0)).filter(Boolean);
  const moov = (offset) => box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(scale), u32(duration), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
    box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(w * 65536), u32(h * 65536)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(scale), u32(duration), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), new TextEncoder().encode('vide'), new Uint8Array(12), new TextEncoder().encode('Ugo9\0')),
        box('minf',
          full('vmhd', 0, 1, new Uint8Array(8)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), avc1),
            full('stts', 0, 0, u32(1), u32(chunks.length), u32(delta)),
            full('stss', 0, 0, u32(sync.length), ...sync.map(u32)),
            full('stsc', 0, 0, u32(1), u32(1), u32(chunks.length), u32(1)),
            full('stsz', 0, 0, u32(0), u32(chunks.length), ...chunks.map((c) => u32(c.data.length))),
            full('stco', 0, 0, u32(1), u32(offset)))))));
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso2avc1mp41'));
  const offset = ftyp.length + moov(0).length + 8; // the samples start after mdat's header
  return new Blob([ftyp, moov(offset), u32(8 + chunks.reduce((s, c) => s + c.data.length, 0)), new TextEncoder().encode('mdat'), ...chunks.map((c) => c.data)], { type: 'video/mp4' });
}

/** Draw once, write several formats: formats ⊂ ['gif', 'apng', 'webm', 'mp4'] -> { format: Blob }.
 *  opts: background for the videos ([r, g, b] 0..255), dither for GIF. */
export async function encodeAll(frames, w, h, fps, formats, opts = {}) {
  const out = {};
  for (const f of formats) {
    if (f === 'gif') out.gif = await encodeGIFAsync(frames, w, h, fps, opts);
    else if (f === 'apng') out.apng = await encodeAPNG(frames, w, h, fps);
    else if (f === 'webm') out.webm = await encodeWebM(frames, w, h, fps, opts);
    else if (f === 'mp4') out.mp4 = await encodeMP4(frames, w, h, fps, opts);
    else throw new Error(`unknown format ${f}`);
  }
  return out;
}

/** The formats that hold every frame before they are written (encodeAll), and the memory above which that is
 *  stopped before drawing (a tab is often killed somewhere past 2 GB). */
export const HELD_FORMATS = ['gif', 'apng'];
export const HELD_LIMIT = 1.5 * 2 ** 30;
/** The formats createWriter writes frame by frame, transparent first. */
export const STREAMED_FORMATS = ['webm-alpha', 'mov-png', 'png-zip', 'mp4', 'webm'];

/** Will GIF / APNG fit in memory? Ask before drawing (利用者の声 #390: a 70 s 1080p GIF holds about 17 GB and the tab
 *  dies with no word). bytes: the frames held (width × height × 4 × frames; GIF with a matte holds a second copy).
 *  -> { bytes, limit, tooBig, held: [the formats asked that hold frames], instead: [the formats written frame by
 *  frame (createWriter), transparent first, to offer instead] } */
export function heldMemory(formats, w, h, frames, { limit = HELD_LIMIT, matte = null } = {}) {
  const held = formats.filter((f) => HELD_FORMATS.includes(f));
  const one = w * h * 4 * frames, bytes = held.length ? one * (held.includes('gif') && matte ? 2 : 1) : 0;
  return { bytes, limit, tooBig: bytes > limit, held, instead: STREAMED_FORMATS };
}

// ---- writing frame by frame (long or 4K exports: the frames are not all held) -----------------
//
//   const w = await createWriter('webm-alpha', width, height, fps);   // see FORMATS below
//   for (...) await w.add(rgba);                                        // straight-alpha RGBA, one frame
//   const blob = await w.finish();
//
// formats: 'png-zip' (a ZIP of transparent PNG frames, frame_00000.png...), 'webm' (VP9 / VP8 over
// the background), 'webm-alpha' (VP9 with its transparency: the colour and the transparency as two
// streams, the second in each block's additions, as WebM keeps alpha), 'mp4' (H.264 over the
// background), 'mov-png' (QuickTime with PNG frames: lossless, with transparency; After Effects,
// Premiere and Final Cut read it). fps: any (24, 30, 60, 29.97...). Nothing outside the browser.

export const WRITER_FORMATS = ['png-zip', 'webm', 'webm-alpha', 'mp4', 'mov-png'];

/** A sink for createWriter's opts.sink from a file handle picked with showSaveFilePicker (File System Access): the
 *  file is written as the frames come (the browser keeps it on disk, not in memory). null where it cannot be had.
 *    const handle = await showSaveFilePicker({ suggestedName: 'idle.mov' });
 *    const w = await createWriter('mov-png', w, h, fps, { sink: await fileSink(handle) }); */
export async function fileSink(handle) {
  if (!handle?.createWritable) return null;
  const f = await handle.createWritable();
  let at = 0; // FileSystemWritableFileStream writes at its position; the mov's head is written again at 0
  return {
    write: async (bytes) => { await f.write({ type: 'write', position: at, data: bytes }); at += bytes.length; },
    seek: async (position) => { at = position; },
    close: () => f.close(),
  };
}

// PNG frames in a few Workers (filter + deflate), in order
class PngQueue {
  constructor(w, h) {
    this.w = w; this.h = h; this.pending = []; this.workers = []; this.next = 0;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1, n = Math.min(8, cores - 1);
    if (n >= 2 && typeof Worker !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([PNG_JOB], { type: 'text/javascript' }));
        this.workers = Array.from({ length: n }, () => { const wk = new Worker(url); wk.waiting = new Map(); wk.onmessage = (e) => { const r = wk.waiting.get(e.data.i); wk.waiting.delete(e.data.i); r(e.data.b); }; return wk; });
        URL.revokeObjectURL(url);
      } catch { this.workers = []; }
    }
  }
  // -> a Promise of the frame's whole PNG file
  encode(rgba) {
    const { w, h } = this, i = this.next++;
    const data = this.workers.length
      ? new Promise((ok) => { const wk = this.workers[i % this.workers.length]; wk.waiting.set(i, ok); const copy = rgba.slice(); wk.postMessage({ i, rgba: copy, w, h }, [copy.buffer]); })
      : deflate(paethFilter(rgba, w, h));
    return data.then((d) => pngFile(w, h, d));
  }
  close() { for (const wk of this.workers) wk.terminate(); }
}
function pngFile(w, h, data) {
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(w), 0); ihdr.set(be32(h), 4); ihdr[8] = 8; ihdr[9] = 6;
  return cat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk('IHDR', ihdr), ...chunk('IDAT', data), ...chunk('IEND')]);
}

// ZIP (stored: PNG is compressed already), ZIP64 where it grows past 4 GB. With a sink (see createWriter) each file goes
// out as it is added and only the directory is kept; finish() then writes the directory and closes the sink.
function zipWriter(sink) {
  const parts = [], dir = [];
  let off = 0, out = Promise.resolve();
  const put = (...bytes) => { if (sink) { out = out.then(async () => { for (const b of bytes) await sink.write(b); }); } else parts.push(...bytes); };
  const le = (n, k) => { const b = new Uint8Array(k); for (let i = 0; i < k; i++) b[i] = Math.floor(n / 2 ** (8 * i)) & 255; return b; };
  return {
    add(name, data) {
      const nm = new TextEncoder().encode(name), crc = crc32([data]), big = off + data.length + 30 + nm.length >= 0xffffffff;
      const z64 = big ? cat([le(1, 2), le(16, 2), le(data.length, 8), le(data.length, 8)]) : new Uint8Array(0);
      const head = cat([le(0x04034b50, 4), le(big ? 45 : 20, 2), le(0x800, 2), le(0, 2), le(0, 4), le(crc, 4), le(big ? 0xffffffff : data.length, 4), le(big ? 0xffffffff : data.length, 4), le(nm.length, 2), le(z64.length, 2), nm, z64]);
      dir.push({ nm, crc, size: data.length, off });
      put(head, data);
      off += head.length + data.length;
      return out;
    },
    finish() {
      const cd = [], start = off;
      for (const e of dir) {
        const big = e.off >= 0xffffffff || e.size >= 0xffffffff;
        const z64 = big ? cat([le(1, 2), le(24, 2), le(e.size, 8), le(e.size, 8), le(e.off, 8)]) : new Uint8Array(0);
        cd.push(cat([le(0x02014b50, 4), le(45, 2), le(big ? 45 : 20, 2), le(0x800, 2), le(0, 2), le(0, 4), le(e.crc, 4), le(big ? 0xffffffff : e.size, 4), le(big ? 0xffffffff : e.size, 4),
          le(e.nm.length, 2), le(z64.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(big ? 0xffffffff : e.off, 4), e.nm, z64]));
      }
      const cdSize = cd.reduce((s, x) => s + x.length, 0), tail = [];
      const many = dir.length >= 0xffff || start >= 0xffffffff || cdSize >= 0xffffffff;
      if (many) { // the ZIP64 end records
        const at = start + cdSize;
        tail.push(cat([le(0x06064b50, 4), le(44, 8), le(45, 2), le(45, 2), le(0, 4), le(0, 4), le(dir.length, 8), le(dir.length, 8), le(cdSize, 8), le(start, 8)]),
          cat([le(0x07064b50, 4), le(0, 4), le(at, 8), le(1, 4)]));
      }
      tail.push(cat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(many ? 0xffff : dir.length, 2), le(many ? 0xffff : dir.length, 2), le(many ? 0xffffffff : cdSize, 4), le(many ? 0xffffffff : start, 4), le(0, 2)]));
      if (sink) return (async () => { put(...cd, ...tail); await out; await sink.close(); return { size: start + cdSize + tail.reduce((s, x) => s + x.length, 0) }; })();
      return new Blob([...parts, ...cd, ...tail], { type: 'application/zip' });
    },
  };
}

// a time base for fps: whole numbers, the NTSC ones (29.97 = 30000 / 1001...), else 90 kHz
function timeBase(fps) {
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return { scale: Math.round(fps) * 100, delta: 100 };
  const k = Math.round(fps * 1.001);
  if (Math.abs(fps - (k * 1000) / 1001) < 1e-3) return { scale: k * 1000, delta: 1001 };
  return { scale: 90000, delta: Math.round(90000 / fps) };
}

// the transparency as an I420 picture: its luma is the alpha as it is (full range), no colour
function alphaI420(rgba, w, h, W, H) {
  const out = new Uint8Array(W * H + 2 * (W >> 1) * (H >> 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * W + x] = rgba[(y * w + x) * 4 + 3];
  out.fill(128, W * H);
  return out;
}

// a VideoEncoder fed frame by frame -> its chunks { data, key, time }
function videoStream(config, keyEvery) {
  const chunks = [];
  let failure = null, decoderConfig = null, n = 0;
  const enc = new VideoEncoder({
    output: (c, meta) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, key: c.type === 'key', time: c.timestamp }); if (meta?.decoderConfig) decoderConfig = meta.decoderConfig; },
    error: (e) => { failure = e; },
  });
  enc.configure(config);
  return {
    chunks, get decoderConfig() { return decoderConfig; },
    async add(frame) {
      if (failure) throw failure;
      enc.encode(frame, { keyFrame: n++ % keyEvery === 0 });
      frame.close();
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    },
    async finish() { await enc.flush(); enc.close(); if (failure) throw failure; return chunks; },
  };
}

// a WebM file from chunks (and, for transparency, the alpha stream's chunks of the same frames)
function webmFile(codecId, W, H, fps, chunks, alphaChunks) {
  const ms = (t) => Math.round(t / 1000), clusters = [];
  const sint = (n) => { const o = new Uint8Array(2); new DataView(o.buffer).setInt16(0, n); return o; };
  for (let i = 0; i < chunks.length;) { // a cluster per key frame (block times are 16-bit, relative)
    const start = ms(chunks[i].time), blocks = [];
    let prev = null;
    do {
      const c = chunks[i], rel = ms(c.time) - start, head = new Uint8Array(4);
      head[0] = 0x81; head[1] = (rel >> 8) & 255; head[2] = rel & 255;
      if (!alphaChunks) { head[3] = c.key ? 0x80 : 0; blocks.push(el(0xa3, head, c.data)); }
      else { // a BlockGroup: the block, its alpha as BlockAdditional 1, a reference to the frame before unless key
        const a = alphaChunks[i];
        blocks.push(el(0xa0, el(0xa1, head, c.data), el(0x75a1, el(0xa6, uintEl(0xee, 1), el(0xa5, a.data))), ...(c.key ? [] : [el(0xfb, sint(prev - rel))])));
      }
      prev = rel;
      i++;
    } while (i < chunks.length && !chunks[i].key && ms(chunks[i].time) - start < 32000);
    clusters.push(el(0x1f43b675, uintEl(0xe7, start), ...blocks));
  }
  const header = el(0x1a45dfa3, uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), strEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2));
  const info = el(0x1549a966, uintEl(0x2ad7b1, 1000000), strEl(0x4d80, 'Ugo9'), strEl(0x5741, 'Ugo9'), f64El(0x4489, (chunks.length * 1000) / fps));
  const video = el(0xe0, uintEl(0xb0, W), uintEl(0xba, H), ...(alphaChunks ? [uintEl(0x53c0, 1)] : [])); // AlphaMode 1
  const track = el(0xae, uintEl(0xd7, 1), uintEl(0x73c5, 1), uintEl(0x83, 1), strEl(0x86, codecId), uintEl(0x9c, 0),
    ...(alphaChunks ? [uintEl(0x55ee, 1)] : []), uintEl(0x23e383, Math.round(1e9 / fps)), video);
  return new Blob([header, el(0x18538067, info, el(0x1654ae6b, track), ...clusters)], { type: 'video/webm' });
}

// QuickTime with PNG frames (the 'png ' sample description, 32-bit: with transparency). The parts in file order: the
// head (ftyp and the mdat box's header, its size from all the frames' bytes), the frames, the moov (their sizes and
// places). movPngFile puts them in a Blob; the writer with a sink sends the frames as they come.
function movPngFile(w, h, fps, frames) {
  const sizes = frames.map((f) => f.length), { head, moov } = movPngParts(w, h, fps, sizes);
  return new Blob([head, ...frames, moov], { type: 'video/quicktime' });
}
function movPngParts(w, h, fps, sizes) {
  const { scale, delta } = timeBase(fps), n = sizes.length, duration = delta * n;
  const u64 = (x) => cat([u32(Math.floor(x / 2 ** 32)), u32(x >>> 0)]);
  const name = new Uint8Array(32); const nm = new TextEncoder().encode('PNG'); name[0] = nm.length; name.set(nm, 1);
  const entry = box('png ', new Uint8Array(6), u16(1), u16(0), u16(0), new TextEncoder().encode('appl'), u32(0), u32(512), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1), name, u16(32), u16(0xffff));
  const ftyp = box('ftyp', new TextEncoder().encode('qt  '), u32(0x200), new TextEncoder().encode('qt  '));
  const total = sizes.reduce((s, x) => s + x, 0), mdatHead = cat([u32(1), new TextEncoder().encode('mdat'), u64(16 + total)]);
  const offsets = []; let o = ftyp.length + mdatHead.length; for (const x of sizes) { offsets.push(o); o += x; }
  const moov = box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(scale), u32(duration), u32(0x10000), u16(0x100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2)),
    box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(w * 65536), u32(h * 65536)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(scale), u32(duration), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, new TextEncoder().encode('mhlr'), new TextEncoder().encode('vide'), new Uint8Array(12), new Uint8Array([4]), new TextEncoder().encode('Ugo9')),
        box('minf',
          full('vmhd', 0, 1, new Uint8Array(8)),
          full('hdlr', 0, 0, new TextEncoder().encode('dhlr'), new TextEncoder().encode('alis'), new Uint8Array(12), new Uint8Array([0])),
          box('dinf', full('dref', 0, 0, u32(1), full('alis', 0, 1))),
          box('stbl',
            full('stsd', 0, 0, u32(1), entry),
            full('stts', 0, 0, u32(1), u32(n), u32(delta)),
            full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
            full('stsz', 0, 0, u32(0), u32(n), ...sizes.map((x) => u32(x))),
            full('co64', 0, 0, u32(n), ...offsets.map(u64)))))));
  return { head: cat([ftyp, mdatHead]), moov };
}

// an After Effects script (ExtendScript) put next to PNG frames: run it (File > Scripts > Run
// Script File) where the frames are, and it imports them as one footage item (straight alpha, the
// frame rate) and makes a comp of their size, rate and length with them in it.
// motion (optional, 利用者の声 #17): { params: [{ name, values }], points: [{ name, values: [[x, y]] }] }, one value
// per frame: a null layer "Ugo9 motion" in the comp with a Slider Control per parameter and a Point Control
// per point (comp pixels), keyed on every frame, so effects and other layers can follow the character
// (expressions: thisComp.layer("Ugo9 motion").effect("MouthOpen")("Slider"))
export function afterEffectsScript({ name = 'ugo9', width, height, fps, frames, first = 'frame_00000.png', motion = null }) {
  // ASCII only (\u escapes): After Effects on Windows may read a script's bytes in the system's code page
  const q = (x) => JSON.stringify(String(x)).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `// Ugo9: import ${frames} PNG frames into After Effects as a comp (${width}x${height}, ${fps} fps)
// File > Scripts > Run Script File..., then pick this file (it reads the frames next to it)
(function () {
  var name = ${q(name)}, width = ${width}, height = ${height}, fps = ${fps}, frames = ${frames};
  var here = File($.fileName).parent, first = new File(here.fsName + '/' + ${q(first)});
  if (!first.exists) { alert('Ugo9: ' + ${q(first)} + ' is not next to this script. Unzip the frames and the script into one folder.'); return; }
  app.beginUndoGroup('Ugo9 frames');
  var io = new ImportOptions(first);
  io.sequence = true;
  io.forceAlphabetical = true;
  var footage = app.project.importFile(io);
  footage.name = name + ' (frames)';
  footage.mainSource.conformFrameRate = fps;
  footage.mainSource.alphaMode = AlphaMode.STRAIGHT;
  var comp = app.project.items.addComp(name, width, height, 1, frames / fps, fps);
  comp.layers.add(footage);${motionPart(motion, q)}
  comp.openInViewer();
  app.endUndoGroup();
})();
`;
}
// the script's part that keys the motion: ES3, numbers rounded to 4 places
function motionPart(motion, q) {
  const params = motion?.params?.filter((m) => m.values?.length) || [], points = motion?.points?.filter((m) => m.values?.length) || [];
  if (!params.length && !points.length) return '';
  const r = (x) => Math.round(x * 1e4) / 1e4;
  const list = (items, val) => items.map((m) => `[${q(m.name)}, [${m.values.map(val).join(',')}]]`).join(',\n    ');
  return `
  // the motion: a null layer with a slider per parameter and a point per point, keyed on every frame
  var motion = comp.layers.addNull();
  motion.name = 'Ugo9 motion';
  var fx = motion.property('ADBE Effect Parade'), times = [], i, k;
  for (i = 0; i < frames; i++) times.push(i / fps);
  var sliders = [
    ${list(params, (v) => r(v))}];
  for (k = 0; k < sliders.length; k++) {
    var s = fx.addProperty('ADBE Slider Control');
    s.name = sliders[k][0];
    s.property('ADBE Slider Control-0001').setValuesAtTimes(times.slice(0, sliders[k][1].length), sliders[k][1]);
  }
  var points = [
    ${list(points, (v) => `[${r(v[0])},${r(v[1])}]`)}];
  for (k = 0; k < points.length; k++) {
    var p = fx.addProperty('ADBE Point Control');
    p.name = points[k][0];
    p.property('ADBE Point Control-0001').setValuesAtTimes(times.slice(0, points[k][1].length), points[k][1]);
  }`;
}

// ---- part groups as layers for compositing apps (After Effects, Premiere, DaVinci Resolve) ----
//
//   const w = await createLayerSetWriter([{ name: 'body' }, { name: 'shade', blend: 'multiply', opacity: 0.6 }, ...], width, height, fps, { name: 'mira_wave' });
//   for (...) await w.add([bodyRgba, shadeRgba, ...]);   // one picture per group (bottom first), each the group drawn alone
//   const zip = await w.finish();
//
// The ZIP: per group, its transparent PNG frames in a folder 01_body/frame_00000.png... (opts.movies:
// one 01_body.mov with PNG frames instead), layers.json (the groups, their blend modes and opacity),
// import_to_after_effects.jsx (a comp with one layer per group, in drawing order, with its blend mode
// and opacity) and ugo9_layers.xml (Final Cut Pro 7 XML, which Premiere Pro and DaVinci Resolve
// import: a sequence with one video track per group).

const AE_BLEND = { normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', add: 'ADD', overlay: 'OVERLAY', softLight: 'SOFT_LIGHT', hardLight: 'HARD_LIGHT', darken: 'DARKEN', lighten: 'LIGHTEN', difference: 'DIFFERENCE', colorDodge: 'COLOR_DODGE', colorBurn: 'COLOR_BURN', exclusion: 'EXCLUSION', subtract: 'SUBTRACT' };
const XML_BLEND = { normal: 'normal', multiply: 'multiply', screen: 'screen', add: 'add', overlay: 'overlay', softLight: 'softlight', hardLight: 'hardlight', darken: 'darken', lighten: 'lighten', difference: 'difference', subtract: 'subtract' };
const asciiString = (x) => JSON.stringify(String(x)).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const folderName = (i, name) => `${String(i + 1).padStart(2, '0')}_${String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'layer'}`;

// the After Effects script for a set of groups: each folder (or movie) next to the script becomes a layer
export function afterEffectsLayersScript({ name = 'ugo9', width, height, fps, frames, layers, movies = false }) {
  const list = layers.map((L, i) => `{ dir: ${asciiString(folderName(i, L.name))}, name: ${asciiString(L.name)}, blend: ${asciiString(AE_BLEND[L.blend] || 'NORMAL')}, opacity: ${Math.round((L.opacity ?? 1) * 1000) / 10} }`).join(',\n    ');
  return `// Ugo9: ${layers.length} part groups as layers of one After Effects comp (${width}x${height}, ${fps} fps, ${frames} frames)
// File > Scripts > Run Script File..., then pick this file (it reads the ${movies ? 'movies' : 'folders'} next to it)
(function () {
  var name = ${asciiString(name)}, width = ${width}, height = ${height}, fps = ${fps}, frames = ${frames}, movies = ${movies};
  var layers = [
    ${list}
  ];
  var here = File($.fileName).parent;
  var firstOf = function (L) { return new File(here.fsName + '/' + L.dir + (movies ? '.mov' : '/frame_00000.png')); };
  for (var i = 0; i < layers.length; i++) if (!firstOf(layers[i]).exists) { alert('Ugo9: ' + L_name(layers[i]) + ' is not next to this script. Unzip everything into one folder.'); return; }
  function L_name(L) { return L.dir + (movies ? '.mov' : '/'); }
  app.beginUndoGroup('Ugo9 layers');
  var folder = app.project.items.addFolder(name);
  var comp = app.project.items.addComp(name, width, height, 1, frames / fps, fps);
  for (var k = 0; k < layers.length; k++) { // bottom first: each new layer goes on top
    var L = layers[k], io = new ImportOptions(firstOf(L));
    if (!movies) { io.sequence = true; io.forceAlphabetical = true; }
    var footage = app.project.importFile(io);
    footage.name = L.name;
    footage.parentFolder = folder;
    footage.mainSource.conformFrameRate = fps;
    footage.mainSource.alphaMode = AlphaMode.STRAIGHT;
    var layer = comp.layers.add(footage);
    layer.name = L.name;
    layer.blendingMode = BlendingMode[L.blend];
    // Ugo9's multiply, screen and add change only the colour below (they add no alpha): in AE that
    // is "Preserve Underlying Transparency" (not on the lowest layer, which has nothing below it)
    if (L.blend !== 'NORMAL' && k > 0) layer.preserveTransparency = true;
    layer.transform.opacity.setValue(L.opacity);
  }
  comp.openInViewer();
  app.endUndoGroup();
})();
`;
}

// Final Cut Pro 7 XML (xmeml 4): a sequence, one video track per group (the first at the bottom)
export function fcpXml({ name = 'ugo9', width, height, fps, frames, layers, movies = false }) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ntsc = Math.abs(fps - Math.round(fps)) > 1e-6, timebase = Math.round(fps);
  const rate = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const sample = `<samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  const tracks = layers.map((L, i) => {
    const dir = folderName(i, L.name), file = movies ? `${dir}.mov` : `${dir}/frame_00000.png`;
    const opacity = Math.round((L.opacity ?? 1) * 1000) / 10;
    return `<track><clipitem id="clip-${i + 1}"><name>${esc(L.name)}</name><enabled>TRUE</enabled><duration>${frames}</duration>${rate}<start>0</start><end>${frames}</end><in>0</in><out>${frames}</out>
<file id="file-${i + 1}"><name>${esc(movies ? file : dir)}</name><pathurl>${esc(file.split('/').map(encodeURIComponent).join('/'))}</pathurl>${rate}<duration>${frames}</duration><media><video>${sample}</video></media></file>
<compositemode>${XML_BLEND[L.blend] || 'normal'}</compositemode>${opacity < 100 ? `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>opacity</parameterid><name>Opacity</name><valuemin>0</valuemin><valuemax>100</valuemax><value>${opacity}</value></parameter></effect></filter>` : ''}
</clipitem><enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1"><name>${esc(name)}</name><duration>${frames}</duration>${rate}
<media><video><format>${sample}</format>
${tracks}
</video></media></sequence>
</xmeml>
`;
}

/** Part groups written as layers for compositing apps: layers [{ name, blend, opacity }] bottom first;
 *  add(pictures) one straight-alpha RGBA per group, in the same order; opts: name (the comp's and
 *  sequence's), movies (true: one MOV with PNG frames per group instead of PNG folders).
 *  -> { add, finish(): Promise<Blob> (a ZIP), extension: 'zip' } */
export async function createLayerSetWriter(layers, w, h, fps, opts = {}) {
  const movies = !!opts.movies, name = opts.name || 'ugo9', zip = zipWriter(), q = new PngQueue(w, h);
  const waiting = [], perLayer = layers.map(() => []);
  let n = 0;
  const drain = async (all) => {
    while (waiting.length > (all ? 0 : 16)) {
      const [k, file, p] = waiting.shift(), png = await p;
      if (movies) perLayer[k].push(png); else zip.add(file, png);
    }
  };
  return {
    extension: 'zip',
    async add(pictures) {
      if (pictures.length !== layers.length) throw new Error(`createLayerSetWriter: ${layers.length} pictures a frame, ${pictures.length} given`);
      pictures.forEach((rgba, k) => waiting.push([k, `${folderName(k, layers[k].name)}/frame_${String(n).padStart(5, '0')}.png`, q.encode(rgba)]));
      n++;
      await drain(false);
    },
    async finish() {
      await drain(true); q.close();
      if (movies) for (let k = 0; k < layers.length; k++) zip.add(`${folderName(k, layers[k].name)}.mov`, new Uint8Array(await movPngFile(w, h, fps, perLayer[k]).arrayBuffer()));
      const info = { name, width: w, height: h, fps, frames: n, movies, layers };
      const te = new TextEncoder();
      zip.add('layers.json', te.encode(JSON.stringify({ ...info, layers: layers.map((L, i) => ({ ...L, folder: folderName(i, L.name) + (movies ? '.mov' : '') })) }, null, 1)));
      zip.add('import_to_after_effects.jsx', te.encode(afterEffectsLayersScript(info)));
      zip.add('ugo9_layers.xml', te.encode(fcpXml(info)));
      return zip.finish();
    },
  };
}

/** A writer fed frame by frame: format (WRITER_FORMATS), width, height, fps; opts: background
 *  [r, g, b] 0..255 (webm, mp4: default white), keyEvery (frames, default 2 s), name (png-zip: the
 *  comp's name in the After Effects script put with the frames), afterEffects (png-zip: false, no script).
 *  png-zip's add(rgba, motion) also takes the frame's { params: { name: value }, points: { name: [x, y] } }:
 *  the script then keys them on a null layer (afterEffectsScript's motion).
 *  opts.sink (png-zip, mov-png): where the file goes as it is written, so a long or 4K export holds no frames:
 *  { write(Uint8Array): Promise, seek(position): Promise (mov-png), close(): Promise } — fileSink(handle) makes one
 *  from a file picked with showSaveFilePicker. finish() then gives { size } (the bytes written) instead of a Blob.
 *  -> { add(rgba): Promise, finish(): Promise<Blob | { size }>, extension } */
export async function createWriter(format, w, h, fps, opts = {}) {
  const keyEvery = opts.keyEvery || Math.max(1, Math.round(fps * 2));
  if (format === 'png-zip') {
    const q = new PngQueue(w, h), zip = zipWriter(opts.sink), waiting = [], motion = { params: new Map(), points: new Map() };
    let n = 0;
    const drain = async (all) => { while (waiting.length > (all ? 0 : 16)) { const [name, p] = waiting.shift(); await zip.add(name, await p); } };
    return {
      extension: 'zip',
      // motion (optional): { params: { name: value }, points: { name: [x, y] } } of this frame, for the After Effects script
      async add(rgba, m) {
        if (m) for (const [kind, map] of [['params', motion.params], ['points', motion.points]]) for (const [k, v] of Object.entries(m[kind] || {})) { if (!map.has(k)) map.set(k, []); map.get(k)[n] = v; }
        waiting.push([`frame_${String(n++).padStart(5, '0')}.png`, q.encode(rgba)]); await drain(false);
      },
      async finish() {
        await drain(true); q.close();
        // the After Effects script that makes them a comp (opts.afterEffects false: left out)
        // a value missing on a frame: the one before it (or the first given)
        const fill = (arr) => { const first = arr.find((v) => v !== undefined); let last = first; return Array.from({ length: n }, (_, i) => (arr[i] !== undefined ? (last = arr[i]) : last)); };
        const m = { params: [...motion.params].map(([name, v]) => ({ name, values: fill(v) })), points: [...motion.points].map(([name, v]) => ({ name, values: fill(v) })) };
        if (opts.afterEffects !== false) zip.add('import_to_after_effects.jsx', new TextEncoder().encode(afterEffectsScript({ name: opts.name || 'ugo9', width: w, height: h, fps, frames: n, motion: m })));
        return zip.finish();
      },
    };
  }
  if (format === 'mov-png') {
    const q = new PngQueue(w, h), frames = [], sizes = [], waiting = [], sink = opts.sink;
    // with a sink: a head of the right length first (its mdat size written again at the end), then each frame as it comes
    let started = null;
    const keep = async (f) => {
      if (!sink) { frames.push(f); return; }
      if (!started) started = sink.write(movPngParts(w, h, fps, []).head);
      await started; await sink.write(f); sizes.push(f.length);
    };
    const drain = async (all) => { while (waiting.length > (all ? 0 : 16)) await keep(await waiting.shift()); };
    return {
      extension: 'mov',
      async add(rgba) { waiting.push(q.encode(rgba)); await drain(false); },
      async finish() {
        await drain(true); q.close();
        if (!sink) return movPngFile(w, h, fps, frames);
        if (!started) await sink.write(movPngParts(w, h, fps, []).head);
        const { head, moov } = movPngParts(w, h, fps, sizes), end = head.length + sizes.reduce((s, x) => s + x, 0);
        await sink.write(moov); await sink.seek(0); await sink.write(head); await sink.close();
        return { size: end + moov.length };
      },
    };
  }
  if (format === 'webm-alpha') {
    // both streams VP9 (the colour opaque; the alpha as the luma of the second); the same key frames
    const W = w + (w & 1), H = h + (h & 1), config = { codec: 'vp09.00.40.08', width: W, height: H, framerate: fps, bitrate: Math.max(1e6, Math.round(W * H * fps * 0.15)) };
    if (typeof VideoEncoder === 'undefined' || !(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('this browser cannot encode VP9 video (WebCodecs)');
    const colour = videoStream(config, keyEvery), alpha = videoStream({ ...config, bitrate: Math.round(config.bitrate / 2) }, keyEvery);
    let i = 0;
    return {
      extension: 'webm',
      async add(rgba) {
        const t = Math.round((i++ * 1e6) / fps), d = Math.round(1e6 / fps), opt = () => ({ format: 'I420', codedWidth: W, codedHeight: H, timestamp: t, duration: d });
        const px = new Uint8Array(W * H * 4); // the colour as it is (the browser turns it into YUV), opaque
        for (let y = 0; y < H; y++) px.set(rgba.subarray(Math.min(y, h - 1) * w * 4, Math.min(y, h - 1) * w * 4 + w * 4), y * W * 4);
        if (W > w) for (let y = 0; y < H; y++) px.copyWithin((y * W + w) * 4, (y * W + w - 1) * 4, (y * W + w) * 4);
        for (let k = 3; k < px.length; k += 4) px[k] = 255;
        await colour.add(new VideoFrame(px, { format: 'RGBX', codedWidth: W, codedHeight: H, timestamp: t, duration: d }));
        await alpha.add(new VideoFrame(alphaI420(rgba, w, h, W, H), opt()));
      },
      async finish() {
        const [c, a] = [await colour.finish(), await alpha.finish()];
        if (c.length !== a.length || c.some((x, k) => x.key !== a[k].key)) throw new Error('the colour and alpha streams do not line up');
        return webmFile('V_VP9', W, H, fps, c, a);
      },
    };
  }
  if (format === 'webm' || format === 'mp4') {
    const W = w + (w & 1), H = h + (h & 1), mp4 = format === 'mp4';
    const pick = mp4 ? await pickCodec(MP4_CODECS, W, H, fps, { avc: { format: 'avc' } }) : await pickCodec(WEBM_CODECS, W, H, fps);
    if (!pick) throw new Error(mp4 ? 'this browser cannot encode H.264 video (WebCodecs)' : 'this browser cannot encode VP9 or VP8 video (WebCodecs)');
    const s = videoStream({ ...pick.config, width: W, height: H }, keyEvery), [br, bg, bb] = opts.background || [255, 255, 255], px = new Uint8Array(W * H * 4);
    let i = 0;
    return {
      extension: format,
      async add(f) {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          if (x >= w || y >= h) { px[o] = br; px[o + 1] = bg; px[o + 2] = bb; px[o + 3] = 255; continue; }
          const q = (y * w + x) * 4, a = f[q + 3] / 255;
          px[o] = f[q] * a + br * (1 - a); px[o + 1] = f[q + 1] * a + bg * (1 - a); px[o + 2] = f[q + 2] * a + bb * (1 - a); px[o + 3] = 255;
        }
        await s.add(new VideoFrame(px, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: Math.round((i++ * 1e6) / fps), duration: Math.round(1e6 / fps) }));
      },
      async finish() {
        const chunks = await s.finish();
        return mp4 ? mp4File(w, h, W, H, fps, chunks, s.decoderConfig) : webmFile(pick.entry[1], W, H, fps, chunks, null);
      },
    };
  }
  throw new Error(`unknown format ${format}`);
}
