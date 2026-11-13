// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// GIF with a matte (利用者の声 #12「GIF の透過で縁が出る」): a GIF pixel is opaque or not, so a
// half-transparent edge shows a rim on the page. With --matte (ugo_export) or { matte } (web/encoders.js),
// each pixel at least a quarter opaque is mixed with the page colour by its alpha and made opaque, the
// rest is transparent. Checked by decoding the GIFs: the transparent pixels are exactly those under a
// quarter, the colours are the mixed ones (within the palette's rounding); the preset's "matte" gives the
// same file as the flag; a bad colour is refused.
//   node tests/export_gif_matte_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExporter } from '../tools/compare_frames.mjs';
import { encodeGIF, matteFrames } from '../web/encoders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_gif_matte_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// a small GIF reader: the global palette, full frames, the transparent index -> [RGBA frames]
function readGif(b) {
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8), flags = b[10], gsize = flags & 0x80 ? 3 << ((flags & 7) + 1) : 0;
  const pal = b.subarray(13, 13 + gsize);
  let p = 13 + gsize, tIndex = -1;
  const frames = [];
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[p++];
      if (label === 0xf9) tIndex = b[p + 1] & 1 ? b[p + 4] : -1;
      while (b[p]) p += b[p] + 1;
      p++;
      continue;
    }
    if (t !== 0x2c) throw new Error('bad block');
    p += 9;
    const minCode = b[p++], data = [];
    while (b[p]) { data.push(...b.subarray(p + 1, p + 1 + b[p])); p += b[p] + 1; }
    p++;
    // LZW
    const clear = 1 << minCode, end = clear + 1, out = [];
    let size = minCode + 1, dict = [], prev = null, bit = 0;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[end] = []; size = minCode + 1; prev = null; };
    reset();
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) if (data[bit >> 3] & (1 << (bit & 7))) code |= 1 << i;
      if (bit > data.length * 8) break;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      const entry = code < dict.length ? dict[code] : [...prev, prev[0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
      prev = entry;
    }
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const k = out[i];
      if (k === tIndex) continue;
      rgba.set([pal[3 * k], pal[3 * k + 1], pal[3 * k + 2], 255], i * 4);
    }
    frames.push(rgba);
  }
  return { w, h, frames };
}

// the rule, on known pixels
{
  const f = [new Uint8Array([200, 0, 0, 255, 200, 0, 0, 128, 200, 0, 0, 64, 200, 0, 0, 63, 0, 0, 0, 0])];
  const m = matteFrames(f, [255, 255, 255])[0];
  check([...m].join() === '200,0,0,255,227,127,127,255,241,191,191,255,0,0,0,0,0,0,0,0', `the rule: opaque kept, half mixed with the page (${[...m.subarray(4, 8)]}), a quarter mixed, under a quarter transparent`);
  check(matteFrames(f, null) === f, 'no matte: the frames as they are');
}

const exe = findExporter();
if (!exe) { console.log('skip the rest: build/ugo_export not built'); process.exit(failures ? 1 : 0); }
const MODEL = path.join(ROOT, 'samples/basic/model.ug9'), size = '140x200';
const run = (args) => execFileSync(exe, [MODEL, '--anim', 'idle', '--frames', '2', '--fps', '2', '--size', size, '--no-dither', ...args], { stdio: 'ignore' });
run(['--format', 'raw', '--out', path.join(OUT, 'f.rgba')]);
const raw = fs.readFileSync(path.join(OUT, 'f.rgba')), W = 140, H = 200, n = W * H * 4;
const rawFrames = [raw.subarray(0, n), raw.subarray(n, 2 * n)];
let edges = 0;
for (const f of rawFrames) for (let p = 3; p < f.length; p += 4) if (f[p] > 0 && f[p] < 255) edges++;
const want = matteFrames(rawFrames, [0, 160, 255]);
// how a decoded GIF compares with the mixed frames: transparency exactly, colours within the palette's rounding
const compare = (g) => {
  let wrongAlpha = 0, worst = 0;
  g.frames.forEach((f, k) => { for (let i = 0; i < W * H; i++) { const a = f[i * 4 + 3], e = want[k][i * 4 + 3]; if (a !== e) wrongAlpha++; else if (a) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(f[i * 4 + c] - want[k][i * 4 + c])); } });
  return { wrongAlpha, worst };
};
run(['--matte', '#00a0ff', '--out', path.join(OUT, 'm.gif')]);
const cli = compare(readGif(fs.readFileSync(path.join(OUT, 'm.gif'))));
check(edges > 100 && cli.wrongAlpha === 0 && cli.worst <= 40, `ugo_export --matte #00a0ff: transparent exactly where the picture is under a quarter opaque, the ${edges} edge pixels mixed with the page (colours within ${cli.worst} of the mix, the palette's rounding)`);
const web = compare(readGif(new Uint8Array(await encodeGIF(rawFrames, W, H, 2, { dither: false, matte: [0, 160, 255] }).arrayBuffer())));
check(web.wrongAlpha === 0 && web.worst <= 40, `web/encoders.js encodeGIF { matte }: the same transparency, colours within ${web.worst}`);
// the plain GIF: edges at least half opaque keep their own colour (the rim the matte takes away)
run(['--out', path.join(OUT, 'plain.gif')]);
const plain = readGif(fs.readFileSync(path.join(OUT, 'plain.gif')));
let rim = 0;
plain.frames.forEach((f, k) => { for (let i = 0; i < W * H; i++) { const a = rawFrames[k][i * 4 + 3]; if (a >= 128 && a < 255 && f[i * 4 + 3]) rim++; } });
check(rim > 0, `without a matte: ${rim} half-transparent edge pixels are drawn opaque in their own colour (the rim)`);
// the preset's "matte": the same file as the flag; a bad colour refused
fs.writeFileSync(path.join(OUT, 'p.json'), JSON.stringify({ ugo9ExportPreset: 1, matte: '#00a0ff' }));
run(['--preset', path.join(OUT, 'p.json'), '--out', path.join(OUT, 'p.gif')]);
check(Buffer.compare(fs.readFileSync(path.join(OUT, 'p.gif')), fs.readFileSync(path.join(OUT, 'm.gif'))) === 0, 'the preset\'s "matte": the same GIF as --matte');
let code = 0;
try { run(['--matte', 'zz', '--out', path.join(OUT, 'bad.gif')]); } catch (e) { code = e.status; }
check(code === 2, `--matte zz: refused (exit ${code})`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall GIF matte checks passed');
process.exit(failures ? 1 : 0);
