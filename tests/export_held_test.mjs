// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// gif and sheet hold every frame until the end (ugo_export --max-held, 利用者の声 #390): past the limit it stops before
// drawing, with the size and what to use instead (answer 2, nothing written), instead of the system ending it part way.
// 70 s of 1080p as GIF (about 16 GB) is stopped by the default 4096 MB; a short GIF is written as before; a sheet
// counts twice (its laid-out copy); the formats written frame by frame are not counted; --max-held sets the limit,
// 0 none.
//   node tests/export_held_test.mjs   (needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (!exe) { console.log('skip: no build/ugo_export'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
const run = (...a) => spawnSync(exe, ['samples/basic/model.ug9', '--anim', 'idle', '--ss', '1', ...a], { encoding: 'utf8' });

const long = run('--size', '1920x1080', '--seconds', '70', '--out', path.join(dir, 'long.gif'));
check(long.status === 2 && /about 16611 MB, more than --max-held 4096 MB/.test(long.stderr) && /mp4, webm, mov, apng or frames/.test(long.stderr) && !fs.existsSync(path.join(dir, 'long.gif')),
  `70 s of 1080p as GIF: stopped before drawing (${long.stderr.split('\n')[0]})`);
const short = run('--size', '200x150', '--frames', '10', '--out', path.join(dir, 'short.gif'));
check(short.status === 0 && fs.statSync(path.join(dir, 'short.gif')).size > 0, 'a short GIF: written as before');
// 200×150×4 = 0.114 MB a frame: 10 frames 1.14 MB
const lim = (fmt, mb, ext = fmt) => run('--size', '200x150', '--frames', '10', '--max-held', String(mb), '--format', fmt, '--out', path.join(dir, `l${mb}.${ext}`)).status;
check(lim('gif', 1) === 2 && lim('gif', 1.2) === 0, '--max-held 1: stopped; 1.2: written (1.14 MB held)');
check(lim('sheet', 1.2, 'png') === 2 && lim('sheet', 2.4, 'png') === 0, 'a sheet counts twice (2.29 MB)');
check(lim('apng', 0.01, 'png') === 0 && lim('gif', 0) === 0, 'apng (frame by frame) is not counted; --max-held 0: no limit');
check(run('--max-held', '-1', '--out', path.join(dir, 'x.gif')).status === 2, '--max-held below 0: 2');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall held frame checks passed');
process.exit(failures ? 1 : 0);
