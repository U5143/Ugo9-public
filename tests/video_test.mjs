// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Browser video (web/encoders.js): WebCodecs + our WebM and MP4 writers. Frames made here are
// encoded in Chromium, then ffprobe / ffmpeg (when installed) read the files back: the frame
// count, size and length must match and the pictures must be close to the frames.
//   node tests/video_test.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'video');
fs.mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const port = 8128;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const W = 161, H = 121, FPS = 24, N = 30; // odd size: the encoders pad to even
const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] }); // a small /dev/shm ends pages ("Target crashed")
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/`);
  const res = await page.evaluate(async ([W, H, FPS, N]) => {
    const enc = await import('/web/encoders.js');
    const frames = [];
    for (let i = 0; i < N; i++) { // a moving disc over a gradient, half transparent at the right
      const f = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, inDisc = (x - 20 - i * 4) ** 2 + (y - 60) ** 2 < 400;
        f[o] = inDisc ? 220 : x; f[o + 1] = inDisc ? 40 : y * 2; f[o + 2] = inDisc ? 60 : 128; f[o + 3] = x > 140 ? 128 : 255;
      }
      frames.push(f);
    }
    const support = await enc.videoSupport(W, H, FPS);
    const b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const all = await enc.encodeAll(frames, W, H, FPS, ['gif', 'apng', ...(support.webm ? ['webm'] : []), ...(support.mp4 ? ['mp4'] : [])], { background: [0, 0, 0] });
    const files = {};
    for (const [k, v] of Object.entries(all)) files[k] = await b64(v);
    // the frames over black, to compare with what ffmpeg decodes
    const ref = frames.map((f) => { const r = new Uint8Array(W * H * 3); for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) r[3 * i + c] = Math.round(f[4 * i + c] * f[4 * i + 3] / 255); return r; });
    return { support, files, ref: await b64(new Blob(ref)) };
  }, [W, H, FPS, N]);
  check(res.support.webm, `this Chromium encodes WebM (VP9 / VP8); MP4 (H.264): ${res.support.mp4}`);
  for (const [k, v] of Object.entries(res.files)) fs.writeFileSync(path.join(out, `test.${k}`), Buffer.from(v, 'base64'));
  check(['gif', 'apng', 'webm'].every((k) => res.files[k]), `encodeAll: one set of frames -> ${Object.keys(res.files).join(', ')}`);
  const ref = Buffer.from(res.ref, 'base64');
  for (const k of ['webm', 'mp4']) {
    if (!res.files[k]) { console.log(`skip ${k}: not supported by this browser`); continue; }
    if (!hasFfmpeg) { console.log(`skip reading ${k} back: ffprobe not installed`); continue; }
    const file = path.join(out, `test.${k}`);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());
    const s = probe.streams[0];
    check(Number(s.nb_read_frames) === N && s.width === W + 1 && s.height === H + 1 && Math.abs(Number(probe.format.duration) - N / FPS) < 0.06,
      `${k}: ffprobe reads ${s.codec_name}, ${s.nb_read_frames} frames, ${s.width}x${s.height}, ${Number(probe.format.duration).toFixed(3)} s`);
    // compare the even-sized top-left part (ffmpeg crops 4:2:0 video to even sizes)
    const cw = W & ~1, chh = H & ~1;
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${cw}:${chh}:0:0`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    let se = 0, n = 0;
    for (let f = 0; f < N; f++) for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) for (let c = 0; c < 3; c++, n++)
      se += (raw[((f * chh + y) * cw + x) * 3 + c] - ref[((f * H + y) * W + x) * 3 + c]) ** 2;
    const psnr = 10 * Math.log10((255 * 255) / (se / n));
    check(raw.length === N * cw * chh * 3 && psnr > 30, `${k}: the decoded frames match the frames (PSNR ${psnr.toFixed(1)} dB)`);
  }
  // APNG: each frame after the first is only its drawn box, cleared before the next (frames on a
  // transparent canvas, one empty); the deflating runs in Workers. ffmpeg reads every frame back
  // as it was, pixel for pixel
  const ap = await page.evaluate(async ([W, H]) => {
    const enc = await import('/web/encoders.js');
    const frames = [];
    for (let i = 0; i < 12; i++) {
      const f = new Uint8Array(W * H * 4);
      if (i !== 7) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, d = (x - 15 - i * 11) ** 2 + (y - 30 - i * 5) ** 2;
        if (d < 300) { f[o] = 200; f[o + 1] = x; f[o + 2] = y; f[o + 3] = d < 200 ? 255 : 90; }
      }
      frames.push(f);
    }
    const blob = await enc.encodeAPNG(frames, W, H, 12), b = new Uint8Array(await blob.arrayBuffer());
    const keep = window.Worker; window.Worker = undefined; // the same without Workers (one by one, here)
    const alone = new Uint8Array(await (await enc.encodeAPNG(frames, W, H, 12)).arrayBuffer());
    window.Worker = keep;
    const eq = (p, q) => p.length === q.length && p.every((x, i) => x === q[i]);
    const sameBytes = eq(alone, b);
    // GIF: the frames coded in Workers give the bytes encodeGIF gives here
    const g1 = new Uint8Array(await (await enc.encodeGIFAsync(frames, W, H, 12)).arrayBuffer()), g0 = new Uint8Array(await enc.encodeGIF(frames, W, H, 12).arrayBuffer());
    const gifSame = eq(g1, g0) && g0.length > 100;
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    let r = ''; for (const f of frames) for (let i = 0; i < f.length; i += 0x8000) r += String.fromCharCode(...f.subarray(i, i + 0x8000));
    return { file: btoa(s), frames: btoa(r), cores: navigator.hardwareConcurrency, sameBytes, gifSame };
  }, [W, H]);
  const apFile = path.join(out, 'boxes.png');
  fs.writeFileSync(apFile, Buffer.from(ap.file, 'base64'));
  const want = Buffer.from(ap.frames, 'base64'), apb = Buffer.from(ap.file, 'base64');
  let boxes = 0; for (let p = 8; p < apb.length;) { const len = apb.readUInt32BE(p); if (apb.toString('latin1', p + 4, p + 8) === 'fcTL' && apb.readUInt32BE(p + 12) < W) boxes++; p += 12 + len; }
  if (!hasFfmpeg) console.log('skip reading the APNG back: ffmpeg not installed');
  else {
    const got = execFileSync('ffmpeg', ['-v', 'error', '-i', apFile, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 });
    let bad = 0;
    for (let i = 0; i < want.length; i += 4) if (got[i + 3] !== want[i + 3] || (want[i + 3] && [0, 1, 2].some((c) => got[i + c] !== want[i + c]))) bad++;
    check(got.length === want.length && bad === 0 && boxes >= 10 && ap.sameBytes, `APNG: ${boxes} of 12 frames written as their drawn box only; ffmpeg reads all 12 back pixel for pixel (${bad} pixels differ; ${apb.length} bytes; ${ap.cores} cores; the same bytes without Workers: ${ap.sameBytes})`);
  }
  check(ap.gifSame, 'GIF: the frames coded in Workers (encodeGIFAsync, what encodeAll uses) give the same bytes as encodeGIF');
  check(errors.length === 0, `no errors ${errors.join(' ')}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall video checks passed');
process.exit(failures ? 1 : 0);
