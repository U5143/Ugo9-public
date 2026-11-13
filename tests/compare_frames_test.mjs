// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Self-test of tools/compare_frames.mjs (the tool that compares Spine's own pictures with
// ours), using our own test rig: a "reference" is made from our own frames, cropped at an
// offset the tool does not know. The tool must find the offset and report no difference,
// and must report differences when the reference is from other times.
//   node tests/compare_frames_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, findExporter, listFrames } from '../tools/compare_frames.mjs';
import { decodePng, encodePng } from '../tools/png.mjs';
import { removeTree } from './lib/remove_tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'compare_test');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

removeTree(OUT);
fs.mkdirSync(OUT, { recursive: true });
execFileSync('node', [path.join(ROOT, 'tools/import_spine.mjs'), path.join(ROOT, 'tests/spine/rig.json'), path.join(ROOT, 'tests/spine/rig.atlas'), path.join(OUT, 'rig')], { stdio: 'ignore' });
const model = path.join(OUT, 'rig', 'model.ug9');
const exporter = findExporter();

// reference frames: our own drawing with 40 px around it, cropped (fixed or moving crop)
function makeRef(name, { start = 0, crop }) {
  const full = path.join(OUT, name + '_full'), dir = path.join(OUT, name);
  fs.mkdirSync(full, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  execFileSync(exporter, [model, '--anim', 'wave', '--fps', '10', '--frames', '12', '--start', String(start), '--warmup', '0', '--pad', '40', '--ss', '2', '--format', 'frames', '--out', full], { stdio: 'ignore' });
  listFrames(full).forEach((f, i) => {
    const img = decodePng(fs.readFileSync(f)), [x0, y0, w, h] = crop(i, img);
    const o = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) o.set(img.rgba.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4), y * w * 4);
    fs.writeFileSync(path.join(dir, `wave_${i}.png`), encodePng(w, h, o)); // unpadded numbers: sorted by value
  });
  return dir;
}
const quiet = () => {};

const same = makeRef('same', { crop: (i, img) => [13, 7, img.width - 30, img.height - 20] });
let s = await compare({ model, anim: 'wave', ref: same, fps: 10, out: path.join(OUT, 'r_same'), log: quiet });
check(s.tolerantMax === 0 && s.strictMean < 0.001, `same frames, fixed crop: differing ${(100 * s.tolerantMax).toFixed(3)}% (1 px tolerance), ${(100 * s.strictMean).toFixed(3)}% strict`);
// ref (x, y) = our padded frame (x + 13, y + 7); the tool adds its own margin to both
check(s.align[0] - s.align[1] === 13 - 7, `offset found (${s.align.join(', ')})`);

const moving = makeRef('moving', { crop: (i, img) => [5 + 3 * i, 30 - 2 * i, img.width - 60, img.height - 50] });
s = await compare({ model, anim: 'wave', ref: moving, fps: 10, alignMode: 'each', out: path.join(OUT, 'r_moving'), log: quiet });
check(s.tolerantMax === 0, `same frames, a different crop in each frame (--align each): differing ${(100 * s.tolerantMax).toFixed(3)}%`);

const late = makeRef('late', { start: 0.05, crop: (i, img) => [13, 7, img.width - 30, img.height - 20] });
s = await compare({ model, anim: 'wave', ref: late, fps: 10, out: path.join(OUT, 'r_late'), log: quiet });
check(s.tolerantMax > 0.01, `frames 0.05 s later are seen as different (max ${(100 * s.tolerantMax).toFixed(2)}% of pixels)`);
check(fs.existsSync(path.join(OUT, 'r_late', 'report.json')) && fs.readdirSync(path.join(OUT, 'r_late')).some((f) => f.startsWith('cmp_')), 'report and side-by-side pictures written');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
