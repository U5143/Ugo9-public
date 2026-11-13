// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A picture behind the model in an export (ugo_export --backdrop, 機能の比べ #89): by default it covers the canvas
// (its shape kept), so a picture shaped like the canvas fills it exactly, corner to corner; where the model is drawn
// the model is over it, unchanged; the frame is opaque where the picture is; placed at X,Y W×H (model px) it covers
// only there; it moves and zooms with the camera; the picture is the same for any number of threads; a wrong
// rectangle answers 2, a missing file 1.
//   node tests/export_backdrop_test.mjs   (needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (!exe) { console.log('skip: no build/ugo_export'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdrop-'));
const { width: CW, height: CH, originX: OX, originY: OY } = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8')).canvas;
const W = CW / 2, H = CH / 2; // the output: half the canvas

// a picture shaped like the canvas, four colours: top left red, top right green, bottom left blue, bottom right yellow
const QUAD = [[220, 30, 30], [30, 200, 60], [40, 60, 220], [240, 220, 40]];
const pw = 42, ph = 60, pic = new Uint8Array(pw * ph * 4);
for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) pic.set([...QUAD[(y < ph / 2 ? 0 : 2) + (x < pw / 2 ? 0 : 1)], 255], (y * pw + x) * 4);
const file = path.join(dir, '背景.png');
fs.writeFileSync(file, encodePng(pw, ph, pic));

const draw = (extra, name) => {
  const out = path.join(dir, name + '.rgba');
  const r = spawnSync(exe, ['samples/basic/model.ug9', '--anim', 'idle', '--frames', '1', '--size', `${W}x${H}`, '--ss', '1', ...extra, '--out', out], { encoding: 'utf8' });
  return { status: r.status, err: r.stderr, px: r.status === 0 ? fs.readFileSync(out) : null };
};
const at = (px, x, y) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const plain = draw([], 'plain'), back = draw(['--backdrop', file], 'back');
const corners = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]];
check(back.status === 0 && corners.every(([x, y], i) => at(plain.px, x, y)[3] === 0 && at(back.px, x, y).join() === [...QUAD[i], 255].join()),
  `covering the canvas: each corner is its colour of the picture (${corners.map(([x, y]) => at(back.px, x, y).slice(0, 3).join(',')).join(' / ')})`);
let over = 0, same = 0, opaque = true;
for (let i = 0; i < plain.px.length; i += 4) {
  if (back.px[i + 3] !== 255) opaque = false;
  if (plain.px[i + 3] === 255) { over++; if (plain.px[i] === back.px[i] && plain.px[i + 1] === back.px[i + 1] && plain.px[i + 2] === back.px[i + 2]) same++; }
}
check(over > 1000 && same >= over * 0.999 && opaque, `the model over it, unchanged where it is opaque (${same} of ${over} pixels; the few others are parts with multiply / screen, which mix with what is under them); the frame opaque everywhere`);

// placed at X,Y W×H: the top left quarter of the canvas only
const q = draw(['--backdrop', `${file}:${-OX},${-OY},${CW / 2},${CH / 2}`], 'quarter');
check(q.status === 0 && at(q.px, 2, 2).join() === [...QUAD[0], 255].join() && at(q.px, W / 2 - 3, 2).join() === [...QUAD[1], 255].join() && at(q.px, W - 3, H - 3)[3] === 0,
  'placed at the top left quarter (model px): the picture there, transparent elsewhere');

// with the camera: zoomed 2× on a point a quarter into the canvas (inside the picture's red quarter), all the frame
// shows red where the model is not drawn (the quarter's edges reach the frame's right and bottom edges; the last 8 px
// there blend into the next quarter: a picture pixel is 10 frame pixels at this zoom)
const look = `${-OX + CW / 4},${-OY + CH / 4}`;
const cam = draw(['--backdrop', file, '--camera', `0:2:${look}`], 'cam'), camPlain = draw(['--camera', `0:2:${look}`], 'camplain'), still = draw(['--backdrop', file, '--camera', '0:1'], 'still');
let bare = 0, red = 0;
for (let y = 0; y < H - 8; y++) for (let x = 0; x < W - 8; x++) if (at(camPlain.px, x, y)[3] === 0) { bare++; if (at(cam.px, x, y).join() === [...QUAD[0], 255].join()) red++; }
check(still.px.equals(back.px) && bare > 1000 && red === bare, `it moves with the camera: zoom 1 is the same bytes; zoom 2 into the red quarter shows red wherever the model is not (${red} of ${bare} pixels)`);

// threads: the same bytes
const t1 = draw(['--backdrop', file, '--threads', '1', '--frames', '4'], 't1'), t4 = draw(['--backdrop', file, '--threads', '4', '--frames', '4'], 't4');
check(t1.px.equals(t4.px), 'the same bytes with 1 and 4 threads');

// wrong
const zero = draw(['--backdrop', `${file}:0,0,0,10`], 'zero'), none = draw(['--backdrop', path.join(dir, 'none.png')], 'none');
check(zero.status === 2 && /above 0/.test(zero.err) && none.status === 1 && /cannot load/.test(none.err), '--backdrop with a width of 0: 2; a picture that is not there: 1');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall backdrop checks passed');
process.exit(failures ? 1 : 0);
