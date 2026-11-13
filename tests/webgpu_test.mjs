// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web/ugo_webgpu.js draws what UgoRenderer (WebGL2) draws: masks (strict too), warp grids, changing draw orders,
// every blend, colour slots, nearest sampling, several characters, and the CPU path. Headless Chromium with
// WebGPU on SwiftShader.
//   node tests/webgpu_test.mjs            (headless, SwiftShader)
//   node tests/webgpu_test.mjs --headed   (a window on this machine's own GPU: the PC check)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8133;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

const headed = process.argv.includes('--headed');
const browser = await chromium.launch(headed
  ? { headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] }
  : { args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('GPU stall due to ReadPixels')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/tests/webgpu/page.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 20000 });
  const r = await page.evaluate(() => window.run());
  if (r.noWebGPU) {
    console.log('skip: this browser has no WebGPU adapter');
  } else {
    const { create, errors: gpuErrors, adapter } = r;
    delete r.create; delete r.errors; delete r.adapter;
    console.log(`adapter: ${adapter}`);
    for (const [name, v] of Object.entries(r)) {
      // the same triangles and texels: only rounding and the mipmaps' filtering may differ
      check(v.painted > 2000 && v.over <= Math.max(40, v.painted * 0.004),
        `${name}: WebGPU draws what WebGL2 draws (max diff ${v.max}, ${v.over} channels > 24 of ${v.painted} painted pixels; draws ${v.drawsGL} / ${v.drawsGPU})`);
    }
    // a headless browser on SwiftShader renders with WebGPU but cannot present it on a canvas: then createRenderer
    // must notice and use WebGL2; where it can present (a PC's GPU), it must use WebGPU and the canvas shows the frame
    check(create[1] === 'webgl2' && (create[0] === 'webgl2' || create[2] > 1000),
      `createRenderer: ${create[0]}${create[0] === 'webgpu' ? ` (${create[2]} pixels on the canvas)` : ' (this browser cannot present WebGPU on a canvas)'}, WebGL2 when asked`);
    check(gpuErrors.length === 0, `no WebGPU validation errors ${gpuErrors.length ? JSON.stringify(gpuErrors) : ''}`);
  }
  check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all webgpu checks passed');
