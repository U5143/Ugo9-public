// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for GDevelop (engines/gdevelop): built into one file, run in PixiJS 7 with stand-ins for gdjs and the scene
// (tests/gdevelop/page.html): a character shows on the layer and stays at its scene point when the camera moves,
// animations switch, parameters, picking, the mouth, hiding.
//   node tests/gdevelop_test.mjs   (installs pixi.js@7.4.2 into build/gdevelop/pixi7 once)
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pixi = path.join(root, 'build', 'gdevelop', 'pixi7');
if (!fs.existsSync(path.join(pixi, 'node_modules', 'pixi.js', 'dist', 'pixi.js'))) {
  fs.mkdirSync(pixi, { recursive: true });
  fs.writeFileSync(path.join(pixi, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'pixi.js@7.4.2'], { cwd: pixi, stdio: 'inherit' });
}
execFileSync(process.execPath, [path.join(root, 'engines', 'gdevelop', 'build.mjs')], { stdio: 'inherit' });

const port = 8134;
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
  await page.goto(`http://localhost:${port}/tests/gdevelop/page.html`);
  await page.waitForFunction(() => window.loaded === true && window.gdjs.ugo9, null, { timeout: 30000 });
  check(await page.evaluate(() => window.callbacks.length === 1), 'it updates after the events (registerRuntimeScenePostEventsCallback)');

  await page.evaluate(() => window.gdjs.ugo9.show(window.runtimeScene, 'hero', '/samples/basic/model.ug9', 400, 560, { scale: 0.6 }));
  await page.waitForFunction(() => window.gdjs.ugo9.isShown(window.runtimeScene, 'hero'), null, { timeout: 30000 });
  const first = await page.evaluate(() => { window.step(10); return window.drawn(); });
  check(first.n > 3000 && Math.abs(first.cx - 400) < 40, `a character shows at its scene point (${first.n} pixels, middle x ${first.cx.toFixed(0)})`);
  const moved = await page.evaluate(() => { window.camera.x = 500; window.step(3); const d = window.drawn(); window.camera.x = 400; window.step(2); return d; });
  check(moved.n > 3000 && Math.abs(moved.cx - 300) < 40, `the camera moves right, the character stays at its scene point (middle x ${moved.cx.toFixed(0)}, was ${first.cx.toFixed(0)})`);

  const r = await page.evaluate(() => {
    const u = window.gdjs.ugo9, s = window.runtimeScene;
    u.play(s, 'hero', 'talk', 0, 0.3);
    window.step(3);
    u.play(s, 'hero', 'idle');
    u.setParam(s, 'hero', 'MouthOpen', 1);
    window.step(2);
    const mouthSet = u.getParam(s, 'hero', 'MouthOpen');
    u.clearParam(s, 'hero', 'MouthOpen');
    u.setMouthLevel(s, 'hero', 1);
    window.step(30);
    const mouthLevel = u.getParam(s, 'hero', 'MouthOpen');
    u.setMouthLevel(s, 'hero', -1);
    window.step(2);
    const exprs = window.gdjs.ugo9.isShown(s, 'hero') ? (u.showExpression(s, 'hero', 'nothing'), u.onlyExpressions(s, 'hero'), 'ok') : '';
    const face = u.partAt(s, 'hero', 400, 560 - 330 * 0.6), none = u.partAt(s, 'hero', 5, 5);
    return { mouthSet, mouthLevel, face, none, exprs };
  });
  check(Math.abs(r.mouthSet - 1) < 1e-4, `a parameter is kept over the animation (${r.mouthSet})`);
  check(r.mouthLevel > 0.8, `the mouth follows a level (${r.mouthLevel.toFixed(2)})`);
  check(r.exprs === 'ok', 'expressions: show and only (no errors for a name the model lacks)');
  check(r.face === 'face' && r.none === '', `partAt names the face at a scene point (${r.face}), nothing in a corner`);

  const gone = await page.evaluate(() => { window.gdjs.ugo9.hide(window.runtimeScene, 'hero'); window.step(2); return window.drawn().n; });
  check(gone < 50, `hide takes it away (${gone} pixels)`);
  check(errors.length === 0, `no errors on the page${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all GDevelop checks passed');
