// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/make_vtuber_artifact.mjs: the VTuber page as one folder on its own (for an https page such as a claude.ai
// Artifact, to try it on a phone). The folder is served by a plain file server of its own here, not by
// tools/serve.mjs, and every request is watched:
// - only the folder's own files and MediaPipe from cdn.jsdelivr.net at its fixed version; no /relay, no
//   /vtuber/model, the face model from the folder (not Google's storage)
// - the sample character is drawn; with the camera refused the page says why and turns the face with the
//   finger or the mouse; with a (fake) camera the face is tracked
//   node tests/vtuber_artifact_test.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVtuberArtifact } from '../tools/make_vtuber_artifact.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const out = path.join(root, 'build', 'vtuber_artifact_test');
const made = await makeVtuberArtifact({ out });
const names = made.files.map((f) => f.name);
check(['index.html', 'ugo.js', 'ugo.wasm', 'ugo_simd.wasm', 'tracking.js', 'tracking_worker.js', 'sample_model.ug9.wasm', 'sample_atlas.png', 'face_landmarker.task.wasm', 'THIRD_PARTY.txt', 'LICENSE-Apache-2.0.txt'].every((n) => names.includes(n)),
  `the folder has the page, the runtime, the sample, the face model and its license (${made.files.length} files, ${(made.files.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB)`);
// a claude.ai Artifact takes only some types: every file's name ends in one of them
const odd = names.filter((n) => !/\.(html|js|wasm|png|json|txt|css)$/.test(n));
check(odd.length === 0, `every file has a type an Artifact takes (.html .js .wasm .png .txt${odd.length ? `; not: ${odd}` : ''})`);
check(made.hosts.length === 1 && made.hosts[0] === 'cdn.jsdelivr.net', `outside loads: only cdn.jsdelivr.net (${made.hosts})`);
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
check(/MP_VERSION = '\d+\.\d+\.\d+'/.test(fs.readFileSync(path.join(out, 'tracking.js'), 'utf8')) && /data-standalone/.test(html), 'MediaPipe at a fixed version; the page in standalone mode');

// the fake camera of tests/vtuber_test.mjs (MediaPipe's sample portrait turning; made there, or here the same way)
const vdir = path.join(root, 'build', 'vtuber'), video = path.join(vdir, 'face.y4m');
if (!fs.existsSync(video)) {
  fs.mkdirSync(vdir, { recursive: true });
  const photo = path.join(vdir, 'portrait.jpg');
  if (!fs.existsSync(photo)) fs.writeFileSync(photo, Buffer.from(await (await fetch('https://storage.googleapis.com/mediapipe-assets/portrait.jpg')).arrayBuffer()));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', photo, '-t', '8', '-r', '30', '-vf',
    "crop=820:615:0:0,scale=640:480,rotate='0.25*sin(2*PI*t/4)':fillcolor=gray,format=yuv420p", video]);
}

// a plain file server for the folder only
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const asked = [];
let served = out; // the folder being served (the --offline one in the last part)
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  asked.push(p);
  const file = path.join(served, p === '/' ? 'index.html' : p);
  if (!file.startsWith(served) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(8149, '127.0.0.1', r));
const url = 'http://localhost:8149/';

const outside = [];
const watch = (ctx) => ctx.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== 'localhost') outside.push(u.hostname + u.pathname); });
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
try {
  // 1. the camera refused (no permission given): the page says so and follows the finger / mouse
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    watch(ctx);
    await ctx.route('**/*', (r) => r.continue());
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.dismiss());
    await ctx.grantPermissions([]);
    await page.goto(url);
    await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
    check(await page.evaluate(() => window.ugoVtuber.standalone && window.ugoVtuber.modelName === '見本'), 'the sample opens from the folder');
    check(!(await page.isVisible('#relayStatus')), 'no OBS section (there is no relay here)');
    check(asked.includes('/ugo_simd.wasm') && !asked.includes('/ugo.wasm'), 'the core\'s SIMD build from the folder (this browser has SIMD)');
    // a denied camera: deny the permission prompt
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); });
    await page.click('#start');
    await page.waitForFunction(() => window.ugoVtuber.message.length > 0, null, { timeout: 10000 });
    const msg = await page.evaluate(() => window.ugoVtuber.message);
    check(/カメラの使用が許可されていません/.test(msg) && /指でなぞる/.test(msg) && await page.evaluate(() => window.ugoVtuber.pointer), `camera refused: said, and the face follows the finger or mouse ("${msg}")`);
    const box = await page.locator('#view').boundingBox();
    await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.3);
    await page.waitForTimeout(800);
    const right = await page.evaluate(() => window.ugoVtuber.params.HeadTurnX);
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.3);
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => window.ugoVtuber.params.HeadTurnX);
    check(right > 10 && left < -10, `pointing right / left turns the face (HeadTurnX ${right.toFixed(1)} / ${left.toFixed(1)})`);
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); });
    await page.click('#micStart');
    await page.waitForTimeout(300);
    check(/マイクの使用が許可されていません/.test(await page.textContent('#micStatus')), `microphone refused: said (${await page.textContent('#micStatus')})`);
    check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
    await ctx.close();
  }
  // 2. a camera: tracked with the face model from the folder
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['camera'] });
    watch(ctx);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
    await page.click('#start');
    const tracked = await page.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 60000 }).then(() => true, () => false);
    check(tracked, `with a camera the face is tracked (${await page.textContent('#camStatus')})`);
    check(asked.includes('/face_landmarker.task.wasm'), 'the face model comes from the folder');
    check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
    await ctx.close();
  }
  const bad = outside.filter((u) => !/^cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\//.test(u));
  check(bad.length === 0 && outside.length > 0, `outside the folder only MediaPipe from cdn.jsdelivr.net at its version (${outside.length} requests${bad.length ? `; others: ${bad.join(', ')}` : ''})`);
  const local = [...new Set(asked)];
  // (vendor/mediapipe/vision_bundle.js: tracking.js asks once whether a local MediaPipe is there; here it is not)
  check(local.every((p) => p === '/' || names.includes(p.slice(1)) || p === '/vendor/mediapipe/vision_bundle.js') && !local.some((p) => /relay|vtuber\/model/.test(p)),
    `from the folder only its own files, no relay or shared model (${local.join(' ')})`);

  // 3. --offline: MediaPipe in the folder too; with every request to the internet refused, the face is still read
  {
    const off = path.join(root, 'build', 'vtuber_artifact_offline_test');
    const madeOff = await makeVtuberArtifact({ out: off, offline: true });
    check(madeOff.hosts.length === 0 && madeOff.files.some((f) => f.name === 'vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
      `--offline: MediaPipe in the folder, nothing to load from outside (${madeOff.files.length} files, ${(madeOff.files.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB)`);
    const odd = madeOff.files.map((f) => f.name).filter((n) => !/\.(html|js|wasm|png|json|txt|css)$/.test(n));
    check(odd.length === 0, `--offline: every file a type an Artifact takes${odd.length ? ` (not: ${odd})` : ''}`);
    served = off;
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['camera'] });
    const refused = [];
    await ctx.route((u) => new URL(u).hostname !== 'localhost', (r) => { refused.push(r.request().url()); return r.abort(); });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
    await page.click('#start');
    const tracked = await page.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 90000 }).then(() => true, () => false);
    check(tracked && await page.evaluate(() => window.ugoVtuber.localMediapipe), '--offline, the internet refused: the face is read with the folder\'s MediaPipe');
    check(refused.length === 0, `--offline: nothing asked of the internet${refused.length ? ` (asked: ${refused.slice(0, 3).join(', ')})` : ''}`);
    check(errors.length === 0, `--offline: no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all VTuber artifact checks passed');
