// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Compare reference frames (a PNG sequence drawn by another tool, e.g. Spine's image
// export) with ugo_export's frames of the same animation, and count the differences.
//
//   node tools/compare_frames.mjs --model build/spine/x/model.ug9 --anim idle --ref REF_DIR
//        [--fps 30] [--start 0] [--scale 1] [--align fixed|each] [--out build/visual/x_idle]
//
// The reference frames may be cropped anywhere (Spine crops to the animation's bounds):
// the offset is found from the pictures. With --align fixed (default) one offset is used
// for every frame (all frames the same size); --align each finds it per frame.
// Writes report.json and, for the frame 0 and the worst frames, ref | ours | diff PNGs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';
import { UgoRuntime } from '../web/ugo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THRESHOLD = 16; // a pixel differs if a premultiplied channel differs by more than this (0..255)

export function findExporter() {
  for (const p of ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe', 'build/Release/ugo_export'])
    if (fs.existsSync(path.join(ROOT, p))) return path.join(ROOT, p);
  throw new Error('ugo_export not found: build it first (cmake --build build)');
}

export function listFrames(dir) {
  const num = (f) => { const m = f.match(/(\d+)(?!.*\d)/); return m ? Number(m[1]) : 0; };
  return fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort((a, b) => num(a) - num(b) || a.localeCompare(b)).map((f) => path.join(dir, f));
}

async function canvasOf(ugoPath) { // read by the core itself: the header's layout changes between versions
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'web/ugo.wasm')), {})).instance.exports);
  return rt.loadModel(fs.readFileSync(ugoPath)).canvas;
}

const premul = (img) => {
  const o = new Uint8Array(img.rgba.length);
  for (let i = 0; i < o.length; i += 4) {
    const a = img.rgba[i + 3];
    o[i] = (img.rgba[i] * a + 127) / 255; o[i + 1] = (img.rgba[i + 1] * a + 127) / 255; o[i + 2] = (img.rgba[i + 2] * a + 127) / 255; o[i + 3] = a;
  }
  return { width: img.width, height: img.height, rgba: o };
};

// alpha cost of placing ref at (dx, dy) inside ours, sampled every `step` pixels
function alphaCost(ref, ours, dx, dy, step) {
  let c = 0;
  for (let y = 0; y < ref.height; y += step) {
    const oy = y + dy;
    for (let x = 0; x < ref.width; x += step) {
      const ox = x + dx, ra = ref.rgba[(y * ref.width + x) * 4 + 3];
      const oa = ox >= 0 && oy >= 0 && ox < ours.width && oy < ours.height ? ours.rgba[(oy * ours.width + ox) * 4 + 3] : 0;
      c += Math.abs(ra - oa);
    }
  }
  return c;
}
const centroid = (img) => {
  let sx = 0, sy = 0, s = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) { const a = img.rgba[(y * img.width + x) * 4 + 3]; sx += a * x; sy += a * y; s += a; }
  return s ? [sx / s, sy / s] : [img.width / 2, img.height / 2];
};

// offset (dx, dy) so that ref pixel (x, y) is ours pixel (x + dx, y + dy)
export function align(pairs) {
  const [r0, o0] = pairs[0];
  const cr = centroid(r0), co = centroid(o0);
  let best = [Math.round(co[0] - cr[0]), Math.round(co[1] - cr[1])];
  for (const [step, radius] of [[8, 96], [4, 12], [2, 6], [1, 3]]) {
    let bc = Infinity, b = best;
    for (let dy = best[1] - radius; dy <= best[1] + radius; dy += step >> 1 || 1)
      for (let dx = best[0] - radius; dx <= best[0] + radius; dx += step >> 1 || 1) {
        let c = 0;
        for (const [r, o] of pairs) c += alphaCost(r, o, dx, dy, step);
        if (c < bc) { bc = c; b = [dx, dy]; }
      }
    best = b;
  }
  return best;
}

// per-pixel difference; `tolerant` allows the match to be up to 1 pixel away (edges, rounding)
export function diffFrame(ref, ours, dx, dy) {
  const w = ref.width, h = ref.height, at = (x, y) => (x >= 0 && y >= 0 && x < ours.width && y < ours.height ? (y * ours.width + x) * 4 : -1);
  const strict = new Uint8Array(w * h), tolerant = new Uint8Array(w * h);
  let region = 0, nStrict = 0, nTol = 0, sum = 0, inter = 0, uni = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = ref.rgba;
    const dAt = (o) => (o < 0 ? Math.max(r[i], r[i + 1], r[i + 2], r[i + 3])
      : Math.max(Math.abs(r[i] - ours.rgba[o]), Math.abs(r[i + 1] - ours.rgba[o + 1]), Math.abs(r[i + 2] - ours.rgba[o + 2]), Math.abs(r[i + 3] - ours.rgba[o + 3])));
    const o = at(x + dx, y + dy), ra = r[i + 3] > 8, oa = o >= 0 && ours.rgba[o + 3] > 8;
    if (!ra && !oa) continue;
    region++; if (ra && oa) inter++; uni++;
    const d = dAt(o);
    let t = d;
    for (let ny = -1; ny <= 1 && t > THRESHOLD; ny++) for (let nx = -1; nx <= 1; nx++) t = Math.min(t, dAt(at(x + dx + nx, y + dy + ny)));
    strict[y * w + x] = d; tolerant[y * w + x] = t;
    sum += d; if (d > THRESHOLD) nStrict++; if (t > THRESHOLD) nTol++;
  }
  return { region, strict: region ? nStrict / region : 0, tolerant: region ? nTol / region : 0, mean: region ? sum / region : 0, iou: uni ? inter / uni : 1, tolMap: tolerant };
}

// ref | ours (cropped to the same place) | differences in red over a faded reference
export function sideBySide(ref, ours, dx, dy, tolMap, bg = [128, 128, 128]) {
  const w = ref.width, h = ref.height, out = new Uint8Array(w * 3 * h * 4);
  const over = (src, i) => [0, 1, 2].map((c) => src[i + c] + (bg[c] * (255 - src[i + 3])) / 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, ox = x + dx, oy = y + dy;
    const a = over(ref.rgba, i);
    const b = ox >= 0 && oy >= 0 && ox < ours.width && oy < ours.height ? over(ours.rgba, (oy * ours.width + ox) * 4) : bg;
    const g = (a[0] + a[1] + a[2]) / 3 * 0.35 + 140, t = tolMap[y * w + x];
    const c = t > THRESHOLD ? [255, 255 - Math.min(255, t * 2), 255 - Math.min(255, t * 2)] : [g, g, g];
    for (const [k, px] of [[0, a], [1, b], [2, c]]) {
      const o = (y * w * 3 + k * w + x) * 4;
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = 255;
    }
  }
  return encodePng(w * 3, h, out);
}

export async function compare({ model, anim, ref, fps = 30, start = 0, scale = 1, alignMode = 'fixed', out, exporter = findExporter(), images = 3, log = console.log }) {
  const files = listFrames(ref);
  if (!files.length) throw new Error(`no PNG frames in ${ref}`);
  fs.mkdirSync(out, { recursive: true });
  const refs = files.map((f) => premul(decodePng(fs.readFileSync(f))));
  const rw = Math.max(...refs.map((r) => r.width)), rh = Math.max(...refs.map((r) => r.height));
  const cv = await canvasOf(model);
  const pad = Math.ceil(Math.max(rw / scale - cv[0], rh / scale - cv[1], 0)) + 32;
  const ow = Math.round((cv[0] + 2 * pad) * scale), oh = Math.round((cv[1] + 2 * pad) * scale);
  const raw = path.join(out, 'ours.rgba');
  const args = [model, '--anim', anim, '--fps', String(fps), '--frames', String(refs.length), '--start', String(start), '--warmup', '0',
    '--pad', String(pad), '--size', `${ow}x${oh}`, '--ss', '2', '--format', 'raw', '--out', raw];
  execFileSync(exporter, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const fd = fs.openSync(raw, 'r'), frameBytes = ow * oh * 4;
  const ours = (i) => { const b = new Uint8Array(frameBytes); fs.readSync(fd, b, 0, frameBytes, i * frameBytes); return premul({ width: ow, height: oh, rgba: b }); }; // straight alpha, like PNG

  let fixed = null;
  if (alignMode === 'fixed') {
    const pick = [...new Set([0, Math.floor(refs.length / 3), Math.floor((2 * refs.length) / 3), refs.length - 1])];
    fixed = align(pick.map((i) => [refs[i], ours(i)]));
  }
  const frames = [];
  for (let i = 0; i < refs.length; i++) {
    const o = ours(i), [dx, dy] = fixed || align([[refs[i], o]]);
    const d = diffFrame(refs[i], o, dx, dy);
    frames.push({ frame: i, time: +(start + i / fps).toFixed(4), file: path.basename(files[i]), dx, dy, strict: d.strict, tolerant: d.tolerant, mean: d.mean, iou: d.iou });
    frames[i].keep = d;
  }
  const worst = [...frames].sort((a, b) => b.tolerant - a.tolerant).slice(0, images).map((f) => f.frame);
  for (const i of new Set([0, ...worst])) {
    const f = frames[i];
    fs.writeFileSync(path.join(out, `cmp_${String(i).padStart(4, '0')}.png`), sideBySide(refs[i], ours(i), f.dx, f.dy, f.keep.tolMap));
  }
  fs.closeSync(fd);
  fs.unlinkSync(raw);
  for (const f of frames) delete f.keep;
  const avg = (k) => frames.reduce((s, f) => s + f[k], 0) / frames.length;
  const summary = { model, anim, ref, fps, start, scale, align: fixed, frames: frames.length,
    tolerantMean: avg('tolerant'), tolerantMax: Math.max(...frames.map((f) => f.tolerant)), strictMean: avg('strict'), iouMin: Math.min(...frames.map((f) => f.iou)), worst };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ summary, frames }, null, 1));
  const pct = (v) => (100 * v).toFixed(2).padStart(6) + '%';
  log(`${anim}: ${frames.length} frames, offset ${fixed ? fixed.join(',') : 'per frame'}; differing pixels (1 px tolerance) mean ${pct(summary.tolerantMean)} max ${pct(summary.tolerantMax)}; strict mean ${pct(summary.strictMean)}; alpha IoU min ${summary.iouMin.toFixed(4)}`);
  for (const f of frames) if (f.frame === 0 || worst.includes(f.frame))
    log(`   frame ${String(f.frame).padStart(4)} t=${f.time.toFixed(3)}s  tolerant ${pct(f.tolerant)}  strict ${pct(f.strict)}  mean ${f.mean.toFixed(2)}  IoU ${f.iou.toFixed(4)}  offset ${f.dx},${f.dy}`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, '')] = a[i + 1];
  if (!opt.model || !opt.anim || !opt.ref) {
    console.error('usage: node tools/compare_frames.mjs --model M.ug9 --anim NAME --ref REF_DIR [--fps 30] [--start 0] [--scale 1] [--align fixed|each] [--out DIR]');
    process.exit(2);
  }
  await compare({ model: opt.model, anim: opt.anim, ref: opt.ref, fps: Number(opt.fps || 30), start: Number(opt.start || 0), scale: Number(opt.scale || 1),
    alignMode: opt.align || 'fixed', out: opt.out || path.join(ROOT, 'build', 'visual', `${path.basename(path.dirname(opt.model))}_${opt.anim}`) });
}
