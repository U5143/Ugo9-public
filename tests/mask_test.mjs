// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Browser test for masks, blend modes and colours (format 0.4).
//
//   node tests/mask_test.mjs            (headless, SwiftShader: no dual-source blending, so masks + separate draws)
//   node tests/mask_test.mjs --headed   (a window on this machine's own GPU: the one-draw path with
//                                        WEBGL_blend_func_extended where the GPU has it; the PC check)
//
// The WebGL renderer (mask pass + one draw, with and without dual-source
// blending, and the strict per-character mode) must draw the same picture as
// the C software renderer for the sample (iris clipped by the eye white,
// multiply / screen face colour) and for tests/pose/rig.ug9 (Spine-style
// clipping polygon, inverted mask, add / multiply / screen, tint and dark colour).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8127;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

const headed = process.argv.includes('--headed');
const browser = await chromium.launch(headed ? { headless: false, args: ['--ignore-gpu-blocklist'] }
  : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/tests/mask/page.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 20000 });
  const r = await page.evaluate(() => window.run());
  const ru = r.reuse; delete r.reuse;
  check(ru.basicDiff === 0 && ru.rigDiff === 0 && ru.basicAgain === 0, `one renderer switched between models draws what fresh renderers draw (${ru.basicDiff}, ${ru.rigDiff}, ${ru.basicAgain} channels differ)`);
  check(ru.atlasKept && ru.atlasChanged, 'setModel keeps the atlas for the same images and remakes it for others');
  check(ru.disposed, 'dispose frees the renderer');
  check(r.maskEffect > 50, `the masks change the picture (${r.maskEffect} pixels where the iris leaves the eye white)`);
  delete r.maskEffect;
  for (const [name, v] of Object.entries(r)) {
    // edges are sampled differently (mipmaps, rasterisation rules): allow a thin seam
    check(v.painted > 1000 && v.over <= Math.max(60, v.painted * 0.01),
      `${name}: GPU matches the C renderer (max diff ${v.max}, ${v.over} channels > 24 of ${v.painted} painted pixels, ${v.draws} draws${v.dual ? ', dual-source' : ''})`);
  }
  check(r.basic.draws === 2, `masks + one draw (${r.basic.draws} draws)`);
  // which path ran: multiply and screen in the same draw (dual-source blending) or drawn apart
  console.log(`info dual-source blending (WEBGL_blend_func_extended): ${r.rig_t0.dual ? 'yes: multiply and screen in one draw' : 'no: drawn apart'} (rig: ${r.rig_t0.draws} draws, without it ${r.rig_nodual_t0.draws})`);
  if (headed && !r.rig_t0.dual) console.log('info this GPU has no WEBGL_blend_func_extended: record that, the one-draw path could not be checked here');
  check(errors.length === 0, `no errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all mask checks passed');
