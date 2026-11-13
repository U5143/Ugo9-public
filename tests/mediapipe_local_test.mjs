// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The VTuber page without the internet: tools/fetch_mediapipe.mjs keeps MediaPipe and the face model in
// web/vendor/mediapipe/ (checked against their SHA-256), and with every request to cdn.jsdelivr.net and Google's
// storage refused, the page still reads the face (a fake camera) and says it uses this PC's copy.
//   node tests/mediapipe_local_test.mjs        (downloads about 22 MB the first time)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMediapipe, FILES } from '../tools/fetch_mediapipe.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const got = await fetchMediapipe();
check(got.length === FILES.length && fs.existsSync(path.join(root, 'web', 'vendor', 'mediapipe', 'LICENSE-Apache-2.0.txt')),
  `MediaPipe kept on this PC, every file checked (${(got.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB) with its licence`);
check(execFileSync('git', ['check-ignore', 'web/vendor/mediapipe/vision_bundle.js'], { cwd: root, encoding: 'utf8' }).trim() !== '', 'and git ignores it (not committed)');

// the fake camera of tests/vtuber_test.mjs (made there)
const video = path.join(root, 'build', 'vtuber', 'face.y4m');
if (!fs.existsSync(video)) execFileSync(process.execPath, [path.join(root, 'tests', 'vtuber_test.mjs')], { stdio: 'ignore' });
const port = 8152;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, permissions: ['camera'] });
  const refused = [];
  // no internet: refuse what the page would load from outside (the worker's requests too)
  await ctx.route(/^https:\/\/(cdn\.jsdelivr\.net|storage\.googleapis\.com)\//, (r) => { refused.push(r.request().url()); return r.abort(); });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/vtuber.html`);
  await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  await page.click('#start');
  const tracked = await page.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 90000 }).then(() => true, () => false);
  check(tracked, 'with the internet refused, the face is read');
  check(await page.evaluate(() => window.ugoVtuber.localMediapipe && window.ugoVtuber.inWorker), 'from this PC\'s copy, on the worker thread');
  check(refused.length === 0, `nothing was even asked of the internet${refused.length ? ` (asked: ${refused.slice(0, 3).join(', ')})` : ''}`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all local MediaPipe checks passed');
