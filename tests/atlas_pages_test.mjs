// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Several atlas pages of different sizes (tests/atlas_pages/page.html): the WebGL2 renderer and the WebGPU one put
// every page in one texture array, smaller pages padded; each must draw what the C software renderer draws from the
// pages as they are: at 1:1, turned, smaller than the pages (mipmaps), and with nearest sampling, with the parts in
// a draw order that goes back and forth between the pages, and a part reading a smaller page up to its far corner.
// The same pages in another order must not pass (the check sees which page a part reads).
//   node tests/atlas_pages_test.mjs   (headless Chromium, SwiftShader; without a WebGPU adapter only WebGL2)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8153;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('GPU stall due to ReadPixels')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/tests/atlas_pages/page.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 20000 });
  const r = await page.evaluate(() => window.run());
  if (!r.webgpu) console.log('(no WebGPU adapter here: WebGL2 only)');
  const { shuffled, shuffledGpu, gpuErrors, farEdge } = r;
  delete r.webgpu; delete r.shuffled; delete r.shuffledGpu; delete r.gpuErrors; delete r.farEdge;
  for (const [name, v] of Object.entries(r)) {
    // inside the parts the same colours; on their edges (sampled differently: rasterisation rules, mipmaps) a thin seam
    check(v.painted > 20000 && v.inner > v.painted * 0.5 && v.innerMax <= 8 && v.over <= v.painted * 0.04 && v.draws === 1,
      `${name}: matches the C renderer (inside the parts max diff ${v.innerMax} over ${v.inner} pixels; edges: ${v.over} channels > 24 of ${v.painted} painted pixels; ${v.draws} draw)`);
  }
  check(farEdge.c === 255 && farEdge.webgl2 === 255 && (farEdge.webgpu ?? 255) === 255,
    `the smallest page drawn small: its far edges stay opaque, the padding beside it in the texture array not mixed in (alpha ${farEdge.webgl2} WebGL2, ${farEdge.webgpu ?? '-'} WebGPU, ${farEdge.c} C)`);
  check(shuffled.over > shuffled.painted * 0.5, `the pages in another order do not pass (WebGL2: ${shuffled.over} channels > 24)`);
  if (shuffledGpu) check(shuffledGpu.over > shuffledGpu.painted * 0.5, `the pages in another order do not pass (WebGPU: ${shuffledGpu.over} channels > 24)`);
  check(gpuErrors.length === 0 && errors.length === 0, `no errors ${[...gpuErrors, ...errors].length ? JSON.stringify([...gpuErrors, ...errors]) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all atlas page checks passed');
