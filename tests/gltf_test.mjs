// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// glTF verification in a browser (three.js), see docs/検証_glTF.md.
//
//   npm install --no-save three@0.186.1   (once)
//   node tools/export_gltf.mjs samples/basic/model.ug9 build/gltf/basic.glb
//   node tests/gltf_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'gltf');
fs.mkdirSync(out, { recursive: true });
const port = 8124;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = {};
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/tests/gltf/compare.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  results.info = await page.evaluate(() => window.info);

  results.baked = {};
  for (const [anim, frame] of [['idle', 0], ['idle', 45], ['idle', 62], ['idle', 90], ['idle', 135], ['talk', 14]]) {
    results.baked[`${anim}@${frame}`] = await page.evaluate(([a, f]) => window.compareBaked(a, f), [anim, frame]);
    if (anim === 'idle' && frame === 62) await page.screenshot({ path: path.join(out, 'baked_idle62.png') });
  }
  results.driven = {};
  const poses = {
    rest: {},
    turnRightBlink: { AngleX: 22, AngleY: -12, EyeOpenL: 0.2, MouthOpen: 0.7, EyeBallX: -0.6, BodyAngleX: 4 },
    tiltLeft: { AngleX: -30, AngleZ: -25, BrowY: 1, MouthOpen: 1 },
  };
  for (const [name, p] of Object.entries(poses)) {
    results.driven[name] = await page.evaluate((params) => window.compareDriven(params), p);
    if (name === 'turnRightBlink') await page.screenshot({ path: path.join(out, 'driven_turn.png') });
  }
  results.bench = {};
  for (const n of [1, 50, 200]) {
    results.bench[`three_${n}`] = await page.evaluate((k) => window.benchThree(k), n);
    results.bench[`three_${n}_singlepass`] = await page.evaluate((k) => window.benchThree(k, 60, true), n);
    results.bench[`ugo_${n}`] = await page.evaluate((k) => window.benchUgo(k), n);
  }
  results.errors = errors;
} finally {
  await browser.close();
  server.kill();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
