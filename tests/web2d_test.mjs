// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 characters in PixiJS and Phaser (web/ugo_layer.js, web/ugo_pixi.js, web/ugo_phaser.js):
// the same picture as the plain 2D renderer, between the engine's own sprites, and picking.
//   npm install --no-save three@0.186.1 pixi.js@8.22.0 phaser@4.2.1   (once)
//   node tests/web2d_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8131;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/tests/web2d/page.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const px = await page.evaluate(() => window.pixi());
  check(px.same.drawn > 2000 && px.same.over <= Math.max(60, 0.01 * px.same.drawn),
    `PixiJS: the layer's sprite shows the same picture as the 2D renderer (max diff ${px.same.max}, ${px.same.over} of ${px.same.drawn} drawn pixels differ by > 24)`);
  check(px.covered[2] > 150 && px.covered[0] < 80, `PixiJS: a sprite above the layer hides the character (pixel ${px.covered})`);
  check(px.picked === 'face' && px.drawCalls >= 1, `PixiJS: pick names the part under a point (${px.picked}), ${px.drawCalls} draw call(s)`);
  const sh = await page.evaluate(() => window.pixiSheet());
  check(sh.same.drawn > 2000 && sh.same.over <= Math.max(60, 0.01 * sh.same.drawn),
    `PixiJS sprite per character: the same picture as the 2D renderer (max diff ${sh.same.max}, ${sh.same.over} of ${sh.same.drawn} differ by > 24)`);
  check(sh.aFace[2] > 150 && sh.aFace[0] < 80 && !(sh.bFace[2] > 150 && sh.bFace[0] < 80),
    `PixiJS sprite per character: a Pixi object goes between two characters (a's face ${sh.aFace}, b's face ${sh.bFace})`);
  check(sh.picked === 'face' && sh.drawCalls >= 1, `PixiJS sprite per character: pickIn names the face (${sh.picked}), ${sh.drawCalls} draw call(s) for both`);
  const ph = await page.evaluate(() => window.phaser());
  check(ph.same.drawn > 2000 && ph.same.over <= Math.max(60, 0.01 * ph.same.drawn),
    `Phaser: the layer's image shows the same picture as the 2D renderer (max diff ${ph.same.max}, ${ph.same.over} of ${ph.same.drawn} drawn pixels differ by > 24)`);
  check(ph.picked === 'face', `Phaser: pick names the part under a point (${ph.picked})`);
  const phs = await page.evaluate(() => window.phaserSheet());
  check(phs.same.drawn > 2000 && phs.same.over <= Math.max(60, 0.01 * phs.same.drawn),
    `Phaser image per character: the same picture as the 2D renderer (max diff ${phs.same.max}, ${phs.same.over} of ${phs.same.drawn} differ by > 24)`);
  check(errors.length === 0, `no errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all PixiJS and Phaser checks passed');
