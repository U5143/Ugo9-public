// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A transparent video for video editors (ugo_export .mov, 利用者の声 #12): ProRes 4444 with its transparency, written
// in the same run as the raw frames; read back by ffmpeg it has every frame, the transparency (transparent around
// the character, opaque inside, the half-transparent edges kept) and the colours close to the raw frames.
//   node tests/export_mov_test.mjs   (needs build/ugo_export and ffmpeg)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const has = (cmd) => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (!exe || !has('ffmpeg') || !has('ffprobe')) { console.log('skip: needs build/ugo_export, ffmpeg and ffprobe'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mov-')), W = 140, H = 200, N = 6;
execFileSync(exe, ['samples/basic/model.ug9', '--anim', 'idle', '--frames', String(N), '--size', `${W}x${H}`, '--out', path.join(dir, 'a.mov'), '--out', path.join(dir, 'a.rgba')], { stdio: 'ignore' });
const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', path.join(dir, 'a.mov')]).toString()).streams[0];
check(s.codec_name === 'prores' && /4444/.test(s.profile) && /yuva/.test(s.pix_fmt) && Number(s.nb_read_frames) === N && s.width === W && s.height === H,
  `ProRes 4444 with transparency (${s.codec_name}, ${s.profile}, ${s.pix_fmt}), ${s.nb_read_frames} frames, ${s.width}×${s.height}`);

const back = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'a.mov'), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']), raw = fs.readFileSync(path.join(dir, 'a.rgba'));
check(back.length === raw.length, `read back: the same size as the raw frames (${back.length} bytes)`);
let alphaMost = 0, colourSum = 0, colourN = 0, clear = 0, solid = 0, edge = 0, edgeKept = 0;
for (let i = 0; i < raw.length; i += 4) {
  const a = raw[i + 3];
  alphaMost = Math.max(alphaMost, Math.abs(a - back[i + 3]));
  if (a === 0) clear += back[i + 3] === 0; else if (a === 255) solid += back[i + 3] === 255;
  if (a > 1 && a < 254) { edge++; edgeKept += back[i + 3] > 0 && back[i + 3] < 255; }
  if (a > 128) for (let c = 0; c < 3; c++) { colourSum += Math.abs(raw[i + c] - back[i + c]); colourN++; }
}
const pixels = raw.length / 4, zeros = [...raw].filter((_, i) => i % 4 === 3 && raw[i] === 0).length, ones = [...raw].filter((_, i) => i % 4 === 3 && raw[i] === 255).length;
check(alphaMost <= 1 && clear === zeros && solid === ones, `the transparency as drawn (largest difference ${alphaMost}; ${zeros} clear and ${ones} opaque pixels of ${pixels} stay so)`);
check(edge > 0 && edgeKept === edge, `the half-transparent edges stay half-transparent (${edgeKept} of ${edge} with alpha 2..253)`);
const mean = colourSum / colourN;
check(mean < 2, `the colours close to the raw frames (mean difference ${mean.toFixed(2)} of 255, YUV 4:4:4)`);

// through the one command
const r = execFileSync(process.execPath, ['tools/ugo9.mjs', 'export', 'samples/basic/model.ug9', '--out', path.join(dir, 'b.mov'), '--', '--frames', '2', '--size', '70x100'], { encoding: 'utf8' });
check(fs.existsSync(path.join(dir, 'b.mov')) && fs.statSync(path.join(dir, 'b.mov')).size > 0, `tools/ugo9.mjs export … --out b.mov writes it (the kind from the ending) (${r.trim().split('\n').pop() || 'done'})`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall .mov checks passed');
process.exit(failures ? 1 : 0);
