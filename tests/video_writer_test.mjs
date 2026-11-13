// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// createWriter (web/encoders.js): video written frame by frame in Chromium, read back by ffmpeg.
// Transparent PNG frames in a ZIP (pixel for pixel), WebM with transparency (VP9 colour + VP9 alpha
// in the block additions: ffmpeg's libvpx decoder reads the alpha), QuickTime with PNG frames
// (pixel for pixel, with transparency), WebM / MP4 at 29.97 and 60 fps (frame count, rate,
// length), and 4K (3840×2160) through the same writers.
//   node tests/video_writer_test.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readZip, decodePng } from '../tools/import_layers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'video_writer');
fs.mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const port = 8131;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const node = { inflate: (b) => zlib.inflateSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };

// the frames: a disc moving over a transparent canvas, soft at its edge, with a half-transparent band
const W = 161, H = 121, N = 24;
const frame = (i, w = W, h = H) => {
  const f = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, d = Math.hypot(x - (w * 0.2 + i * w * 0.025), y - h / 2), r = h * 0.25;
    if (d < r + 2) f.set([220, (x * 3) & 255, 60 + (y & 63), d < r ? 255 : Math.round((r + 2 - d) * 127)], o);
    else if (y > h * 0.8) f.set([30, 90, 200, 100], o);
  }
  return f;
};
const ffmpegRaw = (file, fmt, extra = []) => execFileSync('ffmpeg', ['-v', 'error', ...extra, '-i', file, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 1 << 30 });
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/`);
  await page.exposeFunction('frameFor', (i, w, h) => Buffer.from(frame(i, w, h)).toString('base64'));
  const run = (format, fps, w = W, h = H, n = N) => page.evaluate(async ([format, fps, w, h, n]) => {
    const enc = await import('/web/encoders.js');
    const t0 = performance.now(), wr = await enc.createWriter(format, w, h, fps, { background: [0, 0, 0] });
    for (let i = 0; i < n; i++) { const b = atob(await window.frameFor(i, w, h)), f = new Uint8Array(b.length); for (let k = 0; k < b.length; k++) f[k] = b.charCodeAt(k); await wr.add(f); }
    const blob = await wr.finish(), bytes = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(s), ext: wr.extension, ms: Math.round(performance.now() - t0) };
  }, [format, fps, w, h, n]);
  const save = (r, name) => { const f = path.join(out, `${name}.${r.ext}`); fs.writeFileSync(f, Buffer.from(r.b64, 'base64')); return f; };

  // PNG frames in a ZIP: every frame pixel for pixel
  {
    const r = await run('png-zip', 30), file = save(r, 'frames'), zip = readZip(fs.readFileSync(file));
    const all = [...zip.entries.keys()], names = all.filter((n) => n.endsWith('.png'));
    let bad = 0;
    names.forEach((n, i) => { const e = zip.entries.get(n), d = zip.bytes.subarray(e.local + 30 + zip.bytes[e.local + 26] + (zip.bytes[e.local + 27] << 8) + zip.bytes[e.local + 28] + (zip.bytes[e.local + 29] << 8)).subarray(0, e.csize), png = decodePng(d, node); if (Buffer.compare(Buffer.from(png.rgba), Buffer.from(frame(i))) !== 0) bad++; });
    const unz = (() => { try { execFileSync('unzip', ['-tq', file], { stdio: 'ignore' }); return 'unzip -t ok'; } catch { return 'unzip -t failed'; } })();
    check(names.length === N && names[0] === 'frame_00000.png' && bad === 0 && unz === 'unzip -t ok' && all.includes('import_to_after_effects.jsx'), `PNG frames in a ZIP: ${names.length} frames, transparent, pixel for pixel (${bad} differ; ${unz}; ${r.ms} ms), with the After Effects script`);
  }
  // part groups as layers (createLayerSetWriter): a folder of frames per group, or a MOV per group,
  // with the After Effects script, the FCP 7 XML and layers.json
  const groups = [{ name: '体' }, { name: '影', blend: 'multiply', opacity: 0.6 }, { name: '光', blend: 'screen' }];
  const layerSet = (movies) => page.evaluate(async ([groups, movies, W, H]) => {
    const enc = await import('/web/encoders.js'), wr = await enc.createLayerSetWriter(groups, W, H, 24, { name: 'mira', movies });
    for (let i = 0; i < 6; i++) { const pics = []; for (let k = 0; k < groups.length; k++) { const b = atob(await window.frameFor(i + k * 10, W, H)), f = new Uint8Array(b.length); for (let j = 0; j < b.length; j++) f[j] = b.charCodeAt(j); pics.push(f); } await wr.add(pics); }
    const bytes = new Uint8Array(await (await wr.finish()).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(s), ext: 'zip', ms: 0 };
  }, [groups, movies, W, H]);
  const entry = (zip, name) => { const e = zip.entries.get(name), b = zip.bytes; return b.subarray(e.local + 30 + b[e.local + 26] + (b[e.local + 27] << 8) + b[e.local + 28] + (b[e.local + 29] << 8)).subarray(0, e.csize); };
  {
    const file = save(await layerSet(false), 'layers'), zip = readZip(fs.readFileSync(file)), names = [...zip.entries.keys()];
    const frames = names.filter((n) => n.endsWith('.png')), info = JSON.parse(Buffer.from(entry(zip, 'layers.json')).toString());
    const second = decodePng(entry(zip, '02_影/frame_00003.png'), node);
    check(frames.length === 18 && names.includes('01_体/frame_00005.png') && names.includes('import_to_after_effects.jsx') && names.includes('ugo9_layers.xml')
      && info.layers.map((l) => l.folder).join() === '01_体,02_影,03_光' && info.frames === 6 && Buffer.compare(Buffer.from(second.rgba), Buffer.from(frame(3 + 10))) === 0,
      `part groups as layers: 3 folders of 6 transparent frames (pixel for pixel), the After Effects script, the FCP 7 XML, layers.json (${info.layers.map((l) => `${l.folder} ${l.blend || 'normal'}`).join(', ')})`);
  }
  if (hasFfmpeg) {
    const file = save(await layerSet(true), 'layers_movies'), zip = readZip(fs.readFileSync(file)), movs = [...zip.entries.keys()].filter((n) => n.endsWith('.mov'));
    const probes = movs.map((n) => { const f = path.join(out, `layer_${movs.indexOf(n)}.mov`); fs.writeFileSync(f, entry(zip, n)); return probe(f).streams[0]; });
    check(movs.join() === '01_体.mov,02_影.mov,03_光.mov' && probes.every((s) => s.codec_name === 'png' && Number(s.nb_read_frames) === 6 && s.r_frame_rate === '24/1'),
      `part groups as movies: ${movs.join(', ')}, each PNG in MOV, 6 frames at 24 fps (ffprobe)`);
  }
  if (!hasFfmpeg) console.log('skip the video checks: ffmpeg is not installed');
  else {
    // QuickTime with PNG frames: lossless with transparency
    {
      const r = await run('mov-png', 29.97), file = save(r, 'png'), p = probe(file), s = p.streams[0];
      const raw = ffmpegRaw(file, 'rgba');
      let bad = 0; for (let i = 0; i < N; i++) if (Buffer.compare(raw.subarray(i * W * H * 4, (i + 1) * W * H * 4), Buffer.from(frame(i))) !== 0) bad++;
      check(s.codec_name === 'png' && Number(s.nb_read_frames) === N && s.r_frame_rate === '30000/1001' && bad === 0,
        `MOV (PNG): ${s.codec_name}, ${s.nb_read_frames} frames at ${s.r_frame_rate}, every frame pixel for pixel with its transparency (${bad} differ; ${r.ms} ms)`);
    }
    // WebM with transparency
    {
      const r = await run('webm-alpha', 30), file = save(r, 'alpha'), p = probe(file), s = p.streams[0];
      const raw = ffmpegRaw(file, 'rgba', ['-c:v', 'libvpx-vp9']);
      let se = 0, sa = 0, n = 0, na = 0;
      for (let i = 0; i < N; i++) { const f = frame(i); for (let k = 0; k < (W - 1) * (H - 1); k++) { const x = k % (W - 1), y = Math.floor(k / (W - 1)), o = (y * W + x) * 4, q = i * (W + 1) * (H + 1) * 4 + (y * (W + 1) + x) * 4; sa += (raw[q + 3] - f[o + 3]) ** 2; na++; if (f[o + 3] > 200) { for (let c = 0; c < 3; c++) se += (raw[q + c] - f[o + c]) ** 2; n += 3; } } }
      const psnr = (e, m) => 10 * Math.log10((255 * 255) / (e / m));
      check(raw.length === N * (W + 1) * (H + 1) * 4 && Number(s.nb_read_frames) === N && psnr(sa, na) > 30 && psnr(se, n) > 28,
        `WebM with transparency: ${s.codec_name}, ${s.nb_read_frames} frames; read back with its alpha (alpha PSNR ${psnr(sa, na).toFixed(1)} dB, colour PSNR ${psnr(se, n).toFixed(1)} dB; ${r.ms} ms)`);
    }
    // the frame rates
    for (const [format, fps, want] of [['webm', 60, '60/1'], ['mp4', 29.97, '30000/1001'], ['webm', 24, '24/1']]) {
      let r;
      try { r = await run(format, fps); } catch (e) { console.log(`skip ${format}: ${String(e).split('\n')[0]}`); continue; }
      const file = save(r, `${format}_${fps}`), p = probe(file), s = p.streams[0];
      const dur = Number(p.format.duration), rate = s.r_frame_rate, [a, b] = rate.split('/').map(Number);
      check(Number(s.nb_read_frames) === N && Math.abs(a / b - fps) < 0.05 && Math.abs(dur - N / fps) < 0.1,
        `${format} at ${fps} fps: ${s.nb_read_frames} frames, ${rate} (want ${want}), ${dur.toFixed(3)} s`);
    }
    // 4K
    for (const format of ['webm-alpha', 'mov-png', 'mp4']) {
      let r;
      try { r = await run(format, 30, 3840, 2160, 4); } catch (e) { check(format === 'mp4', `4K ${format}: ${String(e).split('\n')[0]}`); continue; }
      const file = save(r, `4k_${format}`), s = probe(file).streams[0];
      check(s.width >= 3840 && s.height >= 2160 && Number(s.nb_read_frames) === 4, `4K ${format}: ${s.codec_name} ${s.width}×${s.height}, ${s.nb_read_frames} frames (${r.ms} ms, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
    }
  }
  check(errors.length === 0, `no errors ${errors.join(' ')}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall video writer checks passed');
process.exit(failures ? 1 : 0);
