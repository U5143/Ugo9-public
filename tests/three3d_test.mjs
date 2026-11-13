// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 characters in a three.js 3D scene (web/ugo_three.js).
//   npm install --no-save three@0.186.1   (once)
//   node tests/three3d_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { putModels } from './engine_scenes.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'three3d');
fs.mkdirSync(out, { recursive: true });
putModels(path.join(out, 'models')); // the draw order model (tests/engine_scenes.mjs)
const port = 8128;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // the software GPU reports stalls from readPixels; those are expected here
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('GL Driver Message')) errors.push(m.text());
  });
  await page.goto(`http://localhost:${port}/tests/three3d/page.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });

  // EyeBallX moves the irises against their eye-white masks (format 0.4)
  const posed = { AngleX: 22, AngleY: -12, EyeOpenL: 0.2, MouthOpen: 0.7, BodyAngleX: 4, EyeBallX: -1, EyeBallY: 0.6 };
  for (const [name, p, flip] of [['rest', {}, false], ['pose', posed, false], ['flipped', posed, true]]) {
    const r = await page.evaluate(([params, f]) => window.compareFront(params, f), [p, flip]);
    check(r.over16 <= 20, `${name}: three.js scene matches the 2D renderer (max diff ${r.max}, ${r.over16} pixels differ by > 16)`);
    if (name === 'pose') await page.screenshot({ path: path.join(out, 'front_compare.png') });
  }
  // masks, blend modes, colours, six bone weights (rig); warp grids (warp): tests/mask_test.mjs's rule
  for (const [name, url, params, anim, time, textures, sampling = 'linear', scale = 1] of [ // the rig has no texture files
    ['rig', '/tests/pose/rig.ug9', {}, '', 0, false], ['rig, animated', '/tests/pose/rig.ug9', { Bend: 0.7 }, 'idle', 0.6, false],
    ['warp', '/tests/warp/model.ug9', {}, '', 0, true], ['warp, animated', '/tests/warp/model.ug9', {}, 'idle', 0.5, true],
    // draw order keys (format 0.8): a parameter and an animation reorder coloured squares
    ...[['', {}], ['Swap 1', { Swap: 1 }], ['Swap 0.45', { Swap: 0.45 }], ['flip', {}, 'flip', 1.2]].map(([n, p, a = '', t = 0]) =>
      [`order ${n}`.trim(), '/build/three3d/models/order/model.ug9', p, a, t, true]),
    // pixel art (nearest sampling, enlarged so texels show as blocks): factory { sampling: 'nearest' } vs UgoRenderer { sampling: 'nearest' }
    ['warp, nearest x3', '/tests/warp/model.ug9', {}, 'idle', 0.5, true, 'nearest', 3],
    ['order, nearest x2', '/build/three3d/models/order/model.ug9', { Swap: 1 }, '', 0, true, 'nearest', 2],
  ]) {
    const r = await page.evaluate((a) => window.compareModel(...a), [url, params, anim, time, textures, sampling, scale]);
    check(r.drawn > 0 && r.over24 <= Math.max(60, 0.01 * r.drawn),
      `${name}: three.js scene matches the 2D renderer (max diff ${r.max}, ${r.over24} of ${r.drawn} drawn pixels differ by > 24)`);
  }
  const w0 = await page.evaluate(() => window.sideView(false, 0));
  const w60 = await page.evaluate(() => window.sideView(false, 60));
  const b60 = await page.evaluate(() => window.sideView(true, 60));
  await page.screenshot({ path: path.join(out, 'billboard_60deg.png') });
  console.log(`     drawn width: front ${w0}px, 60 degrees ${w60}px, 60 degrees billboard ${b60}px`);
  check(w60 < w0 * 0.65, 'without billboard the sheet narrows when seen from the side');
  check(b60 > w0 * 0.9, 'with billboard the character keeps facing the camera');
  const px = await page.evaluate(() => window.occlusion());
  check(px[2] > 150 && px[0] < 80, `a box in front hides the character (pixel ${px.slice(0, 3).join(',')})`);
  const red = await page.evaluate(() => window.tint(1, 0, 0, 1));
  const clear = await page.evaluate(() => window.tint(1, 1, 1, 0));
  check(red[0] > 1000 && red[1] === 0, `color tints the whole character (red: ${red})`);
  check(clear[0] === 0, `opacity 0 hides it (${clear})`);
  const pk = await page.evaluate(() => window.pick());
  check(pk[0][0] === 'face' && pk[0][1] === null, `partAt: a ray through the face names it, one past the character none (${JSON.stringify(pk[0])})`);
  check(pk[1][0] === 'face' && pk[1][1] === null, `partAt on a billboarded character seen from the side (${JSON.stringify(pk[1])})`);
  check(pk[2] === true, 'partBounds boxes the face around its middle');
  check(errors.length === 0, `no errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all three.js 3D checks passed');
