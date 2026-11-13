// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Browser test for the VTuber page (headless Chromium with a fake camera).
//
//   node tests/vtuber_test.mjs
//
// Needs network access the first time (MediaPipe from its CDN, a test photo
// from MediaPipe's public test assets). Checks:
// - head angles from MediaPipe: a mirrored photo flips yaw, rotating the photo
//   changes roll in the expected direction
// - with a fake camera, tracking drives the character's parameters
// - the display page (#view) receives the pose over the relay and draws on a
//   transparent background
// - (利用者の声 #47) blinking on its own without the camera, the camera list, flipping the camera image
//   left-right turns the tracked face the other way, the microphone's gate opens the mouth (or not), and
//   the display page gets the mouth. The logic itself: tests/tracking_test.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'build', 'vtuber');
fs.mkdirSync(dir, { recursive: true });

// test images: MediaPipe's own sample portrait (downloaded, never committed)
const photo = path.join(dir, 'portrait.jpg');
if (!fs.existsSync(photo)) {
  const r = await fetch('https://storage.googleapis.com/mediapipe-assets/portrait.jpg');
  fs.writeFileSync(photo, Buffer.from(await r.arrayBuffer()));
}
const variants = { 'portrait_mirror.jpg': 'hflip', 'portrait_rot+15.jpg': 'rotate=15*PI/180:fillcolor=gray', 'portrait_rot-15.jpg': 'rotate=-15*PI/180:fillcolor=gray' };
for (const [name, vf] of Object.entries(variants)) {
  const out = path.join(dir, name);
  if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', photo, '-vf', vf, out]);
}
const video = path.join(dir, 'face.y4m');
if (!fs.existsSync(video)) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', photo, '-t', '8', '-r', '30', '-vf',
    "crop=820:615:0:0,scale=640:480,rotate='0.25*sin(2*PI*t/4)':fillcolor=gray,format=yuv420p", video]);
}

const port = 8126;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/vtuber.html`);
  await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });

  // head angles from still photos
  const a = {};
  for (const name of ['portrait.jpg', 'portrait_mirror.jpg', 'portrait_rot+15.jpg', 'portrait_rot-15.jpg']) {
    a[name] = await page.evaluate((u) => window.ugoVtuber.analyze(u), `/build/vtuber/${name}`);
    const r = a[name];
    console.log(`     ${name}: ${r ? `yaw ${r.angles.yaw.toFixed(1)} pitch ${r.angles.pitch.toFixed(1)} roll ${r.angles.roll.toFixed(1)}  -> HeadTurnX ${r.mapped.HeadTurnX.toFixed(1)} HeadTilt ${r.mapped.HeadTilt.toFixed(1)} MouthOpen ${r.mapped.MouthOpen.toFixed(2)}` : 'no face'}`);
  }
  const o = a['portrait.jpg'], m = a['portrait_mirror.jpg'], p = a['portrait_rot+15.jpg'], n = a['portrait_rot-15.jpg'];
  check(o && m && p && n, 'a face is found in every test photo');
  if (o && m) check(Math.sign(o.angles.yaw) === -Math.sign(m.angles.yaw) && Math.abs(o.angles.yaw + m.angles.yaw) < 4, 'mirroring the photo flips the yaw');
  if (o && m) {
    // where the nose sits between the cheeks tells which way the face points in the image
    const noseSide = (r) => (r.nose.x - (r.left.x + r.right.x) / 2) / Math.abs(r.right.x - r.left.x);
    check(Math.sign(noseSide(o)) === Math.sign(o.angles.yaw), `yaw > 0 means the face points to the image's right (nose offset ${noseSide(o).toFixed(3)}, yaw ${o.angles.yaw.toFixed(1)})`);
  }
  if (p && n) check(p.angles.roll < -8 && n.angles.roll > 8, `turning the photo clockwise gives roll < 0 (${p.angles.roll.toFixed(1)} / ${n.angles.roll.toFixed(1)})`);
  // mirror mode: a head leaning clockwise in the camera image leans counter-clockwise on screen
  if (p) check(p.mapped.HeadTilt < -8, `mirror mode: clockwise in the camera -> HeadTilt < 0 (counter-clockwise on screen) (${p.mapped.HeadTilt.toFixed(1)})`);
  if (o) check(Math.sign(o.mapped.HeadTurnX) === -Math.sign(o.angles.yaw), 'mirror mode: a face pointing to the image right turns to the screen left');

  // without the camera the eyes blink on their own (every 2 to 6 s)
  const shut = await page.evaluate(() => new Promise((done) => {
    let least = 1; const t0 = performance.now();
    const look = () => { least = Math.min(least, window.ugoVtuber.blinkOpenness); if (least < 0.5 || performance.now() - t0 > 7000) done(least); else requestAnimationFrame(look); };
    look();
  }));
  check(shut < 0.5, `without the camera the eyes blink on their own (openness down to ${shut.toFixed(2)})`);

  // live tracking with the fake camera, and the display page over the relay
  const view = await ctx.newPage();
  view.on('pageerror', (e) => errors.push('view: ' + String(e)));
  await view.goto(`http://localhost:${port}/web/vtuber.html#view`);
  await page.click('#start');
  await page.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 60000 });
  const cams = await page.evaluate(() => [...document.getElementById('camera').options].slice(1).map((o) => o.textContent));
  check(cams.length >= 1, `the cameras are listed to choose from (${cams.join(', ')})`);
  // flipping the camera image left-right turns the tracked face the other way: the fake video turns the photo
  // by 0.25 sin(2 pi t / 4) rad, so the tracked roll follows that wave, the other way round when flipped
  const follows = () => page.evaluate(() => new Promise((done) => {
    // over one whole turn (4 s) of the video, the covariance of the roll with the turn (means taken out, so the
    // face's own slight tilt does not count)
    const r = [], w = []; const t0 = performance.now(), cam = document.getElementById('cam');
    const look = () => {
      const f = window.ugoVtuber.face;
      if (f) { r.push(f.angles.roll); w.push(Math.sin(2 * Math.PI * cam.currentTime / 4)); }
      if (performance.now() - t0 < 4200) return requestAnimationFrame(look);
      const mr = r.reduce((a, b) => a + b, 0) / r.length, mw = w.reduce((a, b) => a + b, 0) / w.length;
      done(r.reduce((a, x, i) => a + (x - mr) * (w[i] - mw), 0) / r.length);
    };
    look();
  }));
  const yaw0 = await follows();
  await page.check('#flipX'); await page.waitForTimeout(400);
  const yaw1 = await follows();
  await page.uncheck('#flipX'); await page.waitForTimeout(400);
  check(Math.sign(yaw0) === -Math.sign(yaw1) && Math.abs(yaw0 - yaw1) > 3, `flipping the camera image turns the tracked tilt the other way (roll along the video's turn ${yaw0.toFixed(1)} -> ${yaw1.toFixed(1)})`);
  const samples = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await page.evaluate(() => window.ugoVtuber.params.HeadTilt));
    await page.waitForTimeout(500);
  }
  const spread = Math.max(...samples) - Math.min(...samples);
  check(spread > 5, `tracking moves the character: HeadTilt follows the rotating video (range ${spread.toFixed(1)})`);
  // the microphone (Chromium's fake one beeps): a low gate lets the beeps open the mouth, a high one does not
  await page.selectOption('#mouthSource', 'mic');
  await page.click('#micStart');
  await page.waitForFunction(() => window.ugoVtuber.mic, null, { timeout: 10000 });
  // set the gate, let the mouth settle (it closes from what the camera had it at), then watch it for 2.5 s
  const mouthOver = (gate) => page.evaluate((g) => new Promise((done) => {
    window.ugoVtuber.voice.gateDb = g;
    let most = 0, loud = -100; const t0 = performance.now();
    const look = () => {
      const t = performance.now() - t0;
      if (t > 600) { most = Math.max(most, window.ugoVtuber.mouthValue); loud = Math.max(loud, window.ugoVtuber.voice.db); }
      if (t > 3100) done([most, loud]); else requestAnimationFrame(look);
    };
    look();
  }), gate);
  const [quietMouth, loudest] = await mouthOver(10); // over anything a microphone's RMS can reach (0 dB)
  const [openMouth] = await mouthOver(-90);
  check(quietMouth < 0.02 && openMouth > 0.2, `microphone: sound under the gate leaves the mouth shut (${quietMouth.toFixed(2)}), over it opens it (${openMouth.toFixed(2)}; loudest ${loudest.toFixed(0)} dB)`);
  const viewMouth = await view.evaluate(() => new Promise((done) => {
    let most = 0; const t0 = performance.now();
    const look = () => { most = Math.max(most, window.ugoVtuber.params.MouthOpen); if (performance.now() - t0 > 2500) done(most); else requestAnimationFrame(look); };
    look();
  }));
  check(viewMouth > 0.1, `the display page moves the mouth too (up to ${viewMouth.toFixed(2)})`);
  await page.selectOption('#mouthSource', 'max');
  await page.screenshot({ path: path.join(dir, 'vtuber_control.png') });
  const viewWeight = await view.evaluate(() => window.ugoVtuber.faceWeight);
  check(viewWeight > 0.5, `the display page receives the pose over the relay (weight ${viewWeight.toFixed(2)})`);
  // a WebGL canvas cannot be read back after it is shown, so read a screenshot instead
  const shot = await view.screenshot({ path: path.join(dir, 'vtuber_view.png'), omitBackground: true });
  const corner = await view.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return [...x.getImageData(2, 2, 1, 1).data, ...x.getImageData(Math.floor(img.width / 2), Math.floor(img.height * 0.45), 1, 1).data];
  }, shot.toString('base64'));
  check(corner[3] === 0 && corner[7] > 200, `display page: transparent background (corner alpha ${corner[3]}), character drawn (centre alpha ${corner[7]})`);
  // the tracking runs on a thread of its own: the page keeps drawing while a frame is read. Frames drawn in 3 s
  // while tracking, with the worker and with the tracking on the page itself (?worker=0)
  await page.waitForTimeout(700); // the status line is written every 0.5 s
  check(await page.evaluate(() => window.ugoVtuber.inWorker) && /別のスレッド/.test(await page.textContent('#camStatus')),
    'the face is read on a thread of its own (a worker)');
  const fps = async (p) => p.evaluate(() => new Promise((done) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else done(n / 3); };
    requestAnimationFrame(tick);
  }));
  const onThread = await fps(page);
  const same = await ctx.newPage();
  same.on('pageerror', (e) => errors.push('worker=0: ' + String(e)));
  await same.goto(`http://localhost:${port}/web/vtuber.html?worker=0`);
  await same.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  await same.click('#start');
  await same.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 60000 });
  const onPage = await fps(same);
  check(!(await same.evaluate(() => window.ugoVtuber.inWorker)) && onThread > onPage * 1.5,
    `drawing while tracking: ${onThread.toFixed(0)} frames/s with the worker, ${onPage.toFixed(0)} with the tracking on the page (?worker=0)`);
  await same.close();
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all VTuber checks passed');
