// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export draws masks (format 0.4): the sample's irises are clipped by the eye whites.
// With the eyes turned far to the side, the picture must differ from the same model with
// its masks taken out, and only around the eyes.
//   node tests/export_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileUgo } from '../tools/compile.mjs';
import { findExporter } from '../tools/compare_frames.mjs';
import { decodePng } from '../tools/png.mjs';
import { removeTree } from './lib/remove_tree.mjs';
import { sp } from './sample_names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/basic/model.json'), 'utf8'));
const masked = json.parts.filter((p) => p.mask).map((p) => p.id);
check(masked.length > 0, `the sample has masked parts (${masked.join(', ')})`);
const unmasked = structuredClone(json);
for (const p of unmasked.parts) { delete p.mask; delete p.maskInvert; }
for (const t of json.textures) fs.copyFileSync(path.join(ROOT, 'samples/basic', t), path.join(OUT, t));
fs.writeFileSync(path.join(OUT, 'masked.ugo'), new Uint8Array(compileUgo(json)));
fs.writeFileSync(path.join(OUT, 'unmasked.ugo'), new Uint8Array(compileUgo(unmasked)));

const draw = (name) => {
  const out = path.join(OUT, `${name}.rgba`);
  execFileSync(findExporter(), [path.join(OUT, `${name}.ugo`), '--frames', '1', '--param', `${sp('EyeBallX')}=1`, '--param', `${sp('EyeBallY')}=1`, '--format', 'raw', '--out', out], { stdio: 'ignore' });
  return fs.readFileSync(out);
};
const a = draw('masked'), b = draw('unmasked'), [W] = json.canvas ? [json.canvas.width] : [0];
let differ = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
for (let i = 0; i < a.length; i += 4) {
  if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) <= 8) continue;
  differ++;
  const x = (i / 4) % W, y = Math.floor(i / 4 / W);
  x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
}
check(differ > 20, `masks change the picture: ${differ} pixels differ from the model without masks`);
// the eye parts' area at rest (model space -> canvas)
const eyes = json.parts.filter((p) => /eye|iris/i.test(p.id)).flatMap((p) => p.vertices);
const ex = eyes.filter((_, i) => i % 2 === 0).map((x) => x + json.canvas.originX), ey = eyes.filter((_, i) => i % 2 === 1).map((y) => y + json.canvas.originY);
const near = x0 >= Math.min(...ex) - 20 && x1 <= Math.max(...ex) + 20 && y0 >= Math.min(...ey) - 20 && y1 <= Math.max(...ey) + 20;
check(differ === 0 || near, `the differences are around the eyes (x ${x0}..${x1}, y ${y0}..${y1})`);

// one drawing, several formats (--out repeated)
{
  const dir = path.join(OUT, 'multi'), frames = path.join(dir, 'frames');
  removeTree(dir); fs.mkdirSync(frames, { recursive: true });
  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const outs = ['a.gif', 'a.png', 'a.rgba', 'frames', ...(hasFfmpeg ? ['a.webm', 'a.mp4'] : [])];
  const args = [path.join(ROOT, 'samples/basic/model.ug9'), '--anim', 'idle', '--frames', '6', '--size', '140x200'];
  for (const o of outs) args.push('--out', path.join(dir, o));
  args.splice(args.indexOf(path.join(dir, 'frames')) + 1, 0, '--format', 'frames');
  execFileSync(findExporter(), args, { stdio: 'ignore' });
  execFileSync(findExporter(), [...args.slice(0, 7), '--out', path.join(dir, 'alone.rgba')], { stdio: 'ignore' });
  const together = fs.readFileSync(path.join(dir, 'a.rgba')), alone = fs.readFileSync(path.join(dir, 'alone.rgba'));
  check(outs.every((o) => fs.existsSync(path.join(dir, o))) && fs.readdirSync(frames).length === 6, `one run writes ${outs.join(', ')}`);
  check(together.equals(alone) && together.length === 6 * 140 * 200 * 4, 'the frames are the same as when written alone');
  const first = decodePng(fs.readFileSync(path.join(frames, 'frame_00000.png')));
  check(Buffer.from(first.rgba).equals(together.subarray(0, 140 * 200 * 4)), 'the PNG frames hold the same pixels');
  if (hasFfmpeg) {
    const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', path.join(dir, f)]).toString()).streams[0];
    const m = probe('a.mp4'), w = probe('a.webm');
    check(Number(m.nb_read_frames) === 6 && Number(w.nb_read_frames) === 6 && m.codec_name === 'h264' && w.codec_name === 'vp9', `MP4 (${m.codec_name}) and WebM (${w.codec_name}) from the same run, 6 frames each`);
  } else console.log('skip MP4 / WebM: ffmpeg not installed');
}

// sprite sheet: the JSON in the TexturePacker / Aseprite "JSON (Hash)" layout points at each frame
{
  const dir = path.join(OUT, 'sheet');
  fs.mkdirSync(dir, { recursive: true });
  const base = [path.join(ROOT, 'samples/basic/model.ug9'), '--anim', 'idle', '--frames', '5', '--size', '70x100'];
  execFileSync(findExporter(), [...base, '--format', 'sheet', '--out', path.join(dir, 'idle.png'), '--out', path.join(dir, 'idle.rgba')], { stdio: 'ignore' });
  const sheet = decodePng(fs.readFileSync(path.join(dir, 'idle.png'))), raw = fs.readFileSync(path.join(dir, 'idle.rgba'));
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'idle.png.json'), 'utf8'));
  const names = Object.keys(j.frames);
  check(names.length === 5 && names[0] === 'idle_0000' && j.meta.image === 'idle.png' && j.meta.size.w === sheet.width && j.meta.size.h === sheet.height
    && j.meta.frameTags[0].name === 'idle' && j.meta.frameTags[0].to === 4, `sheet JSON: ${names.length} frames, image ${j.meta.image} ${j.meta.size.w}x${j.meta.size.h}, tag ${j.meta.frameTags[0].name}`);
  let same = true;
  names.forEach((n, i) => {
    const { x, y, w, h } = j.frames[n].frame;
    for (let r = 0; r < h && same; r++) {
      const a = Buffer.from(sheet.rgba.buffer, sheet.rgba.byteOffset + ((y + r) * sheet.width + x) * 4, w * 4), b = raw.subarray((i * w * h + r * w) * 4, (i * w * h + r * w + w) * 4);
      if (!a.equals(b)) same = false;
    }
  });
  check(same, 'each frame rectangle in the sheet holds that frame');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall export checks passed');
process.exit(failures ? 1 : 0);
