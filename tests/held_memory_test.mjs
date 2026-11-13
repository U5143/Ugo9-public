// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// GIF and APNG hold every frame before they are written (利用者の声 #390, 進行のバックログ 1): heldMemory says how much
// before anything is drawn, and stops it above 1.5 GB. 70 s of 1080p at 30 fps (the case that killed the tab) is too
// big, a 3 s 720p GIF is not; the formats written frame by frame count nothing; a GIF with a matte holds twice; what to
// use instead is offered; the limit can be set.
//   node tests/held_memory_test.mjs
import { heldMemory, HELD_LIMIT, STREAMED_FORMATS } from '../web/encoders.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const GB = (b) => (b / 2 ** 30).toFixed(1);

const long = heldMemory(['gif', 'mp4'], 1920, 1080, 70 * 30);
check(long.tooBig && Math.abs(long.bytes - 1920 * 1080 * 4 * 2100) < 1 && long.held.join() === 'gif', `70 s of 1080p as GIF: ${GB(long.bytes)} GB, stopped (limit ${GB(HELD_LIMIT)} GB)`);
const short = heldMemory(['gif', 'apng'], 1280, 720, 90);
check(!short.tooBig && short.held.join() === 'gif,apng', `3 s of 720p as GIF and APNG: ${GB(short.bytes)} GB, fine`);
const video = heldMemory(['mp4', 'webm-alpha', 'png-zip', 'mov-png'], 3840, 2160, 30 * 600);
check(video.bytes === 0 && !video.tooBig && video.held.length === 0, '10 min of 4K written frame by frame: nothing held');
const matte = heldMemory(['gif'], 1000, 1000, 100, { matte: [255, 255, 255] });
check(matte.bytes === 1000 * 1000 * 4 * 100 * 2, 'a GIF with a matte: twice (the matted copy)');
check(long.instead[0] === 'webm-alpha' && long.instead.every((f) => STREAMED_FORMATS.includes(f)), `instead: ${long.instead.join(', ')} (written frame by frame, transparent first)`);
check(heldMemory(['apng'], 100, 100, 100, { limit: 1e6 }).tooBig && !heldMemory(['apng'], 100, 100, 10, { limit: 1e6 }).tooBig, 'the limit can be set');

console.log(failures ? `\n${failures} check(s) failed` : '\nall held memory checks passed');
process.exit(failures ? 1 : 0);
