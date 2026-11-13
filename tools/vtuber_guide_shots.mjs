// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The pictures of docs/VTuber.md's "はじめて使う" (first time): the VTuber page at each step, the control in
// question outlined. Made again after the page changes:
//   node tools/vtuber_guide_shots.mjs          (writes docs/VTuber/01_open.png .. 05_obs.png)
// Uses headless Chromium with its fake camera (the moving test video of tests/vtuber_test.mjs, built there);
// the camera picture itself is never shown in the pictures (it is a third-party photo), only the character
// (the CC0 sample) and the page. OBS cannot run here: the last picture is the display page (#view) over a
// stand-in game screen, as OBS lays it.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'VTuber');
fs.mkdirSync(out, { recursive: true });
const video = path.join(root, 'build', 'vtuber', 'face.y4m');
if (!fs.existsSync(video)) execFileSync(process.execPath, [path.join(root, 'tests', 'vtuber_test.mjs')], { stdio: 'ignore' });
const port = 8151;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
const written = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/web/vtuber.html`);
  await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  // outline one control (and scroll the panel to it)
  const mark = (sel) => page.evaluate((s) => {
    document.querySelectorAll('[data-shot]').forEach((e) => { e.style.outline = ''; delete e.dataset.shot; });
    const e = s && document.querySelector(s);
    if (e) { e.dataset.shot = '1'; e.style.outline = '3px solid #e0457b'; e.style.outlineOffset = '2px'; e.scrollIntoView({ block: 'center' }); }
  }, sel);
  const shot = async (name) => { const f = path.join(out, name); await page.screenshot({ path: f }); written.push(f); };

  await mark('#guide summary');
  await shot('01_open.png');
  await mark('#start');
  await shot('02_camera_before.png');
  await page.click('#start');
  await page.waitForFunction(() => window.ugoVtuber.faceWeight > 0.9, null, { timeout: 60000 });
  await page.evaluate(() => { document.getElementById('cam').hidden = true; }); // never the camera picture
  await page.waitForTimeout(600);
  await mark('#camStatus');
  await shot('02_camera_after.png');
  await mark('#calib');
  await shot('03_front.png');
  await mark('#copyUrl');
  await shot('04_obs_url.png');

  // the display page as OBS lays it over a game: the page is transparent, so a stand-in screen shows through
  const view = await ctx.newPage();
  await view.setViewportSize({ width: 800, height: 500 });
  await view.setContent(`<body style="margin:0;background:linear-gradient(160deg,#2d3b6a,#6a4c8c 55%,#d98a6a);font:20px system-ui;color:#fff">
    <div style="position:absolute;left:24px;top:20px;opacity:.85">（ゲームや配信の画面）</div>
    <iframe src="http://localhost:${port}/web/vtuber.html#view" style="position:absolute;right:30px;bottom:0;width:320px;height:440px;border:0;background:transparent" allowtransparency="true"></iframe></body>`);
  await view.waitForTimeout(3000);
  const f = path.join(out, '05_obs.png');
  await view.screenshot({ path: f });
  written.push(f);
} finally {
  await browser.close();
  server.kill();
}
for (const f of written) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
