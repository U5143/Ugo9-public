// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export's JPEG, crop, hold (on twos / threes) and each-animation options (docs/機能の比べ.md #92 #85,
// 利用者の声 #25 #24): a crop is that part of the whole picture (within one level); on twos each pose is shown on two
// frames; --each-anim gives what --anim NAME gives, one file each, named by {anim} (or _NAME); JPEG: one file
// for one frame, a folder for more, smaller at a lower quality; bad values refused. A preset's region (model pixels),
// jpegQuality, holdFrames and eachAnim give what the options give.
//   node tests/export_options_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExporter } from '../tools/compare_frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_options_test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = findExporter();
if (!exe) { console.log('skip: build/ugo_export not built'); process.exit(0); }
const MODEL = path.join(ROOT, 'samples/basic/model.ug9');
const run = (args) => execFileSync(exe, [MODEL, ...args], { stdio: 'ignore' });
const code = (args) => { try { run(args); return 0; } catch (e) { return e.status; } };
const raw = (args, name) => { const f = path.join(OUT, name); run([...args, '--format', 'raw', '--out', f]); return fs.readFileSync(f); };

// crop: that part of the whole picture
{
  const whole = raw(['--anim', 'idle', '--frames', '1', '--size', '210x300'], 'whole.rgba'), part = raw(['--anim', 'idle', '--frames', '1', '--size', '210x300', '--crop', '50,40,100,120'], 'part.rgba');
  let worst = part.length === 100 * 120 * 4 ? 0 : 255;
  for (let y = 0; y < 120 && worst < 255; y++) for (let x = 0; x < 400; x++) worst = Math.max(worst, Math.abs(part[y * 400 + x] - whole[((y + 40) * 210 + 50) * 4 + x]));
  check(worst <= 1, `--crop 50,40,100,120: a 100×120 picture, that part of the whole 210×300 one (within ${worst} level: the shifted origin's rounding)`);
  check(code(['--frames', '1', '--size', '210x300', '--crop', '200,0,20,20', '--format', 'raw', '--out', path.join(OUT, 'x.rgba')]) === 2, '--crop outside the picture: refused');
}
// on twos: each pose on two frames
{
  const n = 70 * 100 * 4, f = raw(['--anim', 'idle', '--frames', '6', '--fps', '12', '--size', '70x100', '--hold', '2'], 'h.rgba'), fr = (i) => f.subarray(i * n, (i + 1) * n);
  check(Buffer.compare(fr(0), fr(1)) === 0 && Buffer.compare(fr(2), fr(3)) === 0 && Buffer.compare(fr(4), fr(5)) === 0 && Buffer.compare(fr(1), fr(2)) !== 0 && f.length === 6 * n,
    '--hold 2: 6 frames at 12 fps, each pose shown twice (0=1, 2=3, 4=5), the poses moving on');
  check(code(['--frames', '1', '--hold', '0', '--format', 'raw', '--out', path.join(OUT, 'x.rgba')]) === 2, '--hold 0: refused');
}
// each animation: what --anim gives, one file each
{
  run(['--each-anim', '--frames', '2', '--size', '70x100', '--format', 'raw', '--out', path.join(OUT, 'each_{anim}.rgba'), '--format', 'raw', '--out', path.join(OUT, 'plain.rgba')]);
  const one = (a) => raw(['--anim', a, '--frames', '2', '--size', '70x100'], `one_${a}.rgba`);
  const ok = ['idle', 'talk'].every((a) => fs.existsSync(path.join(OUT, `each_${a}.rgba`)) && Buffer.compare(fs.readFileSync(path.join(OUT, `each_${a}.rgba`)), one(a)) === 0 && fs.existsSync(path.join(OUT, `plain_${a}.rgba`)));
  check(ok, '--each-anim: each_idle and each_talk ({anim}), plain_idle and plain_talk (_NAME), each the same bytes as --anim NAME');
}
// JPEG: one file for one frame, a folder for more; quality
{
  run(['--frames', '1', '--size', '210x300', '--quality', '95', '--out', path.join(OUT, 'hi.jpg')]);
  run(['--frames', '1', '--size', '210x300', '--quality', '30', '--out', path.join(OUT, 'lo.jpg')]);
  fs.mkdirSync(path.join(OUT, 'jpgs'));
  run(['--frames', '3', '--size', '70x100', '--format', 'jpeg', '--out', path.join(OUT, 'jpgs')]);
  run(['--frames', '2', '--size', '70x100', '--out', path.join(OUT, 'two.jpg')]);
  check(fs.existsSync(path.join(OUT, 'two_00000.jpg')) && fs.existsSync(path.join(OUT, 'two_00001.jpg')), 'two frames to two.jpg: two_00000.jpg and two_00001.jpg');
  const hi = fs.readFileSync(path.join(OUT, 'hi.jpg')), lo = fs.readFileSync(path.join(OUT, 'lo.jpg'));
  check(hi[0] === 0xff && hi[1] === 0xd8 && lo.length < hi.length && fs.readdirSync(path.join(OUT, 'jpgs')).join() === 'frame_00000.jpg,frame_00001.jpg,frame_00002.jpg',
    `JPEG: one frame to a .jpg (quality 95: ${hi.length} bytes, 30: ${lo.length}); three frames to frame_00000.jpg… in a folder`);
  check(code(['--frames', '1', '--quality', '0', '--out', path.join(OUT, 'q.jpg')]) === 2, '--quality 0: refused');
}

// the same from a preset (web/export_preset.js's names): region in model pixels, jpegQuality, holdFrames, eachAnim
{
  const preset = (o) => { const f = path.join(OUT, `p${Object.keys(o).join('')}.json`); fs.writeFileSync(f, JSON.stringify({ ugo9ExportPreset: 1, ...o })); return f; };
  const base = ['--anim', 'idle', '--frames', '1', '--size', '210x300'];
  // the sample's canvas is 420×600 with its origin at 210,590: at 210×300 a model pixel is half a picture pixel, so
  // x -110..90, y -510..-270 is the picture's 50..150, 40..160
  const reg = preset({ region: { x: -110, y: -510, width: 200, height: 240 } });
  const a = raw([...base, '--crop', '50,40,100,120'], 'c1.rgba'), b = raw([...base, '--preset', reg], 'c2.rgba');
  check(Buffer.compare(a, b) === 0, 'region (model pixels) in a preset: the same bytes as --crop with the picture\'s pixels it covers');
  const odd = raw([...base, '--preset', preset({ region: { x: -109.3, y: -509.9, width: 199, height: 239.5 } })], 'c3.rgba');
  check(odd.length === 100 * 120 * 4, 'a region that does not fall on whole pixels: the whole pixels that cover it (100×120)');
  const after = raw([...base, '--preset', reg, '--crop', '0,0,10,10'], 'c4.rgba');
  check(after.length === 10 * 10 * 4, '--crop after the preset wins over its region');
  check(code([...base, '--preset', preset({ region: { x: 300, y: 0, width: 50, height: 50 } }), '--format', 'raw', '--out', path.join(OUT, 'x.rgba')]) === 2, 'a region outside the picture: refused');
  const h1 = raw(['--anim', 'idle', '--frames', '6', '--fps', '12', '--size', '70x100', '--hold', '3'], 'h1.rgba'), h2 = raw(['--anim', 'idle', '--frames', '6', '--fps', '12', '--size', '70x100', '--preset', preset({ holdFrames: 3 })], 'h2.rgba');
  check(Buffer.compare(h1, h2) === 0, 'holdFrames 3: the same as --hold 3');
  run(['--frames', '1', '--size', '105x150', '--quality', '40', '--out', path.join(OUT, 'q1.jpg')]);
  run(['--frames', '1', '--size', '105x150', '--preset', preset({ jpegQuality: 40 }), '--out', path.join(OUT, 'q2.jpg')]);
  check(Buffer.compare(fs.readFileSync(path.join(OUT, 'q1.jpg')), fs.readFileSync(path.join(OUT, 'q2.jpg'))) === 0, 'jpegQuality 40: the same JPEG as --quality 40');
  run(['--frames', '2', '--size', '70x100', '--each-anim', '--format', 'raw', '--out', path.join(OUT, 'e1_{anim}.rgba')]);
  run(['--frames', '2', '--size', '70x100', '--preset', preset({ eachAnim: true }), '--format', 'raw', '--out', path.join(OUT, 'e2_{anim}.rgba')]);
  check(['idle', 'talk'].every((n) => fs.existsSync(path.join(OUT, `e2_${n}.rgba`)) && Buffer.compare(fs.readFileSync(path.join(OUT, `e1_${n}.rgba`)), fs.readFileSync(path.join(OUT, `e2_${n}.rgba`))) === 0),
    'eachAnim true: a file per animation, the same as --each-anim');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall export option checks passed');
process.exit(failures ? 1 : 0);
