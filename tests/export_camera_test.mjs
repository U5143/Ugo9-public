// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export --camera: zoom in and move over time at export (PV・MV, 利用者の声 #24).
// Zoom 2 is the middle of the picture drawn twice as big; a key's X,Y comes to the middle;
// between keys it eases and the zoom goes on a log scale (1 -> 4 passes 2 halfway); before the
// first key and after the last it holds; without --camera nothing changes.
//   node tests/export_camera_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExporter } from '../tools/compare_frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_camera_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const exe = findExporter();
if (!exe) { console.log('skip: build/ugo_export not built'); process.exit(0); }
const MODEL = path.join(ROOT, 'samples/basic/model.ug9');
const { canvas } = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/basic/model.json'), 'utf8'));
const W = canvas.width, H = canvas.height; // 420×600, the model point in the middle is (0, -290)
const mid = [W / 2 - canvas.originX, H / 2 - canvas.originY];

let n = 0;
const draw = (args, size = `${W}x${H}`) => { // -> frames of RGBA
  const out = path.join(OUT, `f${n++}.rgba`);
  execFileSync(exe, [MODEL, '--anim', 'idle', '--fps', '1', '--frames', '3', '--size', size, ...args, '--format', 'raw', '--out', out], { stdio: 'ignore' });
  const b = fs.readFileSync(out), [w, h] = size.split('x').map(Number), len = w * h * 4;
  return [0, 1, 2].map((i) => b.subarray(i * len, (i + 1) * len));
};
// largest difference and how many pixels differ by more than 8: a w×h box of frame a (aw wide, from
// ax,ay) against frame b (bw wide) from dx,dy
function diff(a, b, w, h, bw, dx = 0, dy = 0, aw = w, ax = 0, ay = 0) {
  let worst = 0, bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y + ay) * aw + x + ax) * 4, j = ((y + dy) * bw + x + dx) * 4;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k] - b[j + k]));
    worst = Math.max(worst, d); if (d > 8) bad++;
  }
  return { worst, bad };
}

const plain = draw([]);
const still = draw(['--camera', '0:1']);
check(plain.every((f, i) => Buffer.compare(f, still[i]) === 0), 'zoom 1 at the canvas\'s middle: the same bytes as without --camera');

const zoom2 = draw(['--camera', '0:2']);
const big = draw([], `${W * 2}x${H * 2}`);
const z = diff(zoom2[0], big[0], W, H, W * 2, W / 2, H / 2);
check(z.bad <= W * H * 0.002, `zoom 2: the middle of the picture drawn at twice the size (${z.bad} px differ by more than 8, largest ${z.worst})`);

const pan = draw(['--camera', `0:1:${mid[0] + 40},${mid[1] - 30}`]);
// looking 40 px right and 30 px up: the picture moves 40 px left and 30 px down
const p = diff(pan[0], plain[0], W, H, W);
const p2 = diff(pan[0], plain[0], W - 40, H - 30, W, 40, 0, W, 0, 30);
check(p.bad > 0 && p2.worst <= 1, `X,Y comes to the middle: looking 40 px right and 30 px up moves the picture 40 px left and 30 px down (largest ${p2.worst}; unmoved it would differ in ${p.bad} px)`);

const move = draw(['--camera', '2:4', '--camera', '0:1']); // keys out of order: sorted
const at2 = draw(['--camera', '0:2']), at4 = draw(['--camera', '0:4']);
const m0 = diff(move[0], plain[0], W, H, W), m1 = diff(move[1], at2[1], W, H, W), m2 = diff(move[2], at4[2], W, H, W);
check(m0.worst === 0 && m1.worst <= 1 && m2.worst === 0, `1 -> 4 over 2 s: zoom 1 at 0 s, 2 at 1 s (log scale, eased), 4 at 2 s (largest ${m0.worst} / ${m1.worst} / ${m2.worst})`);

const hold = draw(['--camera', '1:2']);
check(diff(hold[0], at2[0], W, H, W).worst === 0 && diff(hold[2], at2[2], W, H, W).worst === 0, 'one key at 1 s: held before it and after it');

// a cut: held at the key before until the cut's time, then the cut key at once (no easing)
const cut = draw(['--camera', '0:1', '--camera', '1:4:cut']); // frames at 0, 1, 2 s (fps 1)
const cutXY = draw(['--camera', '0:1', '--camera', `1:2:${mid[0] + 40},${mid[1] - 30}:cut`]);
const two = draw(['--camera', `0:2:${mid[0] + 40},${mid[1] - 30}`]);
check(diff(cut[0], plain[0], W, H, W).worst === 0 && diff(cut[1], at4[1], W, H, W).worst === 0 && diff(cut[2], at4[2], W, H, W).worst === 0,
  'a cut (1:4:cut): zoom 1 up to 1 s, then 4 at once at 1 s (no easing in between)');
check(diff(cutXY[1], two[1], W, H, W).worst === 0, 'a cut with a point (T:ZOOM:X,Y:cut)');
const half = draw(['--camera', '0:1', '--camera', '2:4:cut', '--fps', '2']);
const plain2 = draw(['--fps', '2']);
check(diff(half[1], plain2[1], W, H, W).worst === 0, 'halfway to a cut the camera has not moved (0.5 s of 0 → 2 s)');

for (const bad of ['1', '1:0', '-1:2', '0:2:5', 'a:b', '1:2:xcut', '1:2:0,0:cutx', '1:2:0,0x']) {
  let code = 0;
  try { execFileSync(exe, [MODEL, '--frames', '1', '--camera', bad, '--format', 'raw', '--out', path.join(OUT, 'bad.rgba')], { stdio: 'ignore' }); } catch (e) { code = e.status; }
  check(code === 2, `--camera ${bad}: refused (exit ${code})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall camera checks passed');
process.exit(failures ? 1 : 0);
