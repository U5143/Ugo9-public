// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The NTSC frame rates written exactly (利用者の声 #12「フレームレートが食い違う」): --fps 29.97 was handed to ffmpeg
// as 2997/100, which editing software does not take as 29.97 (30000/1001) and drifts against; 23.976 and 59.94 the
// same. Now MP4, MOV and WebM carry 30000/1001 (24000/1001 ...), the APNG frame delay is 1001/30000 (it was 33/1000,
// 30.3 fps) from ugo_export and from web/encoders.js; whole rates and other ones (12.5) are as before.
//   node tests/export_ntsc_test.mjs   (needs build/ugo_export; the video checks need ffprobe)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findExporter } from '../tools/compare_frames.mjs';
import { encodeAPNG } from '../web/encoders.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
// the first frame's delay in an APNG (fcTL: delay_num, delay_den)
const delay = (buf) => { const i = Buffer.from(buf).indexOf('fcTL'); return [buf[i + 24] << 8 | buf[i + 25], buf[i + 26] << 8 | buf[i + 27]]; };

// web/encoders.js
const frames = [new Uint8Array(8 * 8 * 4).fill(200), new Uint8Array(8 * 8 * 4).fill(100)];
const web = async (fps) => delay(new Uint8Array(await (await encodeAPNG(frames, 8, 8, fps)).arrayBuffer()));
check((await web(29.97)).join() === '1001,30000' && (await web(59.94)).join() === '1001,60000' && (await web(23.976)).join() === '1001,24000',
  `encodeAPNG: 29.97 → ${(await web(29.97)).join('/')}, 59.94 and 23.976 the same way`);
check((await web(30)).join() === '1,30' && (await web(12.5)).join() === '80,1000', 'encodeAPNG: 30 → 1/30, 12.5 → 80/1000 as before');

const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (!exe) { console.log('skip ugo_export: no build/ugo_export'); process.exit(failures ? 1 : 0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntsc-'));
const out = (fps, ext) => { const f = path.join(dir, `${fps}.${ext}`); const r = spawnSync(exe, ['samples/basic/model.ug9', '--anim', 'idle', '--size', '64x64', '--ss', '1', '--fps', String(fps), '--frames', '12', '--out', f]); return r.status === 0 ? f : null; };
check(delay(fs.readFileSync(out(29.97, 'png'))).join() === '1001,30000' && delay(fs.readFileSync(out(30, 'png'))).join() === '1,30', 'ugo_export APNG: 29.97 → 1001/30000, 30 → 1/30');
let probe = true;
try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { probe = false; }
if (!probe) console.log('skip the video checks (no ffmpeg / ffprobe)');
else {
  const rate = (f) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', f]).toString().trim();
  const got = ['mp4', 'mov', 'webm'].map((e) => rate(out(29.97, e)));
  check(got.every((r) => r === '30000/1001'), `29.97 as MP4, MOV, WebM: ${got.join(', ')}`);
  check(rate(out(23.976, 'mp4')) === '24000/1001' && rate(out(59.94, 'mp4')) === '60000/1001', '23.976 → 24000/1001, 59.94 → 60000/1001');
  check(rate(out(30, 'mp4')) === '30/1' && rate(out(12.5, 'mp4')) === '25/2', 'whole and other rates as before (30/1, 25/2)');
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall NTSC rate checks passed');
process.exit(failures ? 1 : 0);
