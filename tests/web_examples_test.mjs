// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Web examples (web/examples/): each page loads, draws the character with no errors, and the interactive
// ones answer (an expression button, the pointer for looking, a tap for hit testing, fixed frames in a shuffled
// order). And (利用者の声 #409) they work from a plain static server too (one that knows nothing of .wasm or
// .ug9), and opened straight from the disk (file:) they say what to do instead of staying blank.
//   node tests/web_examples_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8191;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  // pixels of the canvas that are not its white background (from a screenshot: WebGL's buffer is gone after the frame)
  const drawn = async (page) => {
    const png = (await page.locator('#c').screenshot()).toString('base64');
    return page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const x = new OffscreenCanvas(img.width, img.height), g = x.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++;
      return n;
    }, png);
  };
  // each page with WebGPU (where the browser has an adapter) and again forced to WebGL2
  // a plain static server for the repository: every file as it is, only .html / .js / .png named, the rest
  // application/octet-stream (as many simple servers do)
  const plain = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => plain.listen(8192, '127.0.0.1', r));
  const names = ['01_load', '02_expression', '03_look', '04_blink', '05_mouth', '06_hit', '07_frames'];
  const pages = [...names.flatMap((n) => [[n, ''], [n, '?webgl2']]), ...names.map((n) => [n, '', 8192])];
  for (const [base, query, onPort = port] of pages) {
    const name = base + query + (onPort !== port ? ' (a plain server)' : '');
    const page = await browser.newPage({ viewport: { width: 700, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://localhost:${onPort}/web/examples/${base}.html${query}`);
    await page.waitForTimeout(1200);
    const px = await drawn(page);
    const kind = await page.getAttribute('#c', 'data-renderer');
    const core = await page.getAttribute('#c', 'data-core');
    check((kind === 'webgpu' || kind === 'webgl2') && core === 'simd', `${name}: drawn with ${kind}, the core's SIMD build (${core})`); // WebGPU where the browser can present it
    if (query) check(kind === 'webgl2', `${name}: ?webgl2 forces WebGL2`);
    let extra = '';
    if (base === '02_expression') { await page.click('button:has-text("smile")'); await page.waitForTimeout(500); extra = ', smile pressed'; }
    if (base === '03_look') { const b = await page.locator('#c').boundingBox(); await page.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.1); await page.waitForTimeout(500); extra = ', pointer moved'; }
    if (base === '06_hit') {
      const b = await page.locator('#c').boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
      await page.waitForTimeout(200);
      extra = `, tap says "${await page.textContent('#out')}"`;
      check(/part: |area: /.test(await page.textContent('#out')), `${name}: a tap on the character names what is there`);
    }
    if (base === '07_frames') {
      await page.click('#shuffle');
      await page.waitForFunction(() => window.ugoFramesResult !== undefined, null, { timeout: 30000 });
      check(await page.evaluate(() => window.ugoFramesResult) === 0, `${name}: 300 frames in a shuffled order equal them in order ("${await page.textContent('#out')}")`);
      await page.fill('#n', '150'); await page.dispatchEvent('#n', 'input'); await page.waitForTimeout(200);
      extra = ', frame 150 shown';
    }
    check(px > 5000 && errors.length === 0, `${name}: draws the character (${px} pixels)${extra}, no errors${errors.length ? ` — ${errors.join(' | ')}` : ''}`);
    await page.close();
  }
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/web/examples/`);
  check((await page.locator('li a').count()) === names.length, `the list page links the ${names.length} examples`);
  // opened straight from the disk: no modules load, the page says what to do
  const file = await browser.newPage();
  await file.goto('file://' + path.join(root, 'web', 'examples', '01_load.html'));
  await file.waitForTimeout(500);
  check(/ファイルを直接開くと.*node tools\/serve\.mjs/.test(await file.textContent('main')), 'opened as a file, the page says to use a server (not left blank)');
  // a model that is not there: said on the page
  // (on the list page, which starts no character of its own: a page that does would write its own line into #out
  // at a moment of its own; then wait for the message itself, not a fixed time)
  const missing = await browser.newPage();
  await missing.goto(`http://localhost:${port}/web/examples/`);
  await missing.evaluate(async () => {
    const out = document.createElement('div'); out.id = 'out'; document.querySelector('main').append(out);
    const { start } = await import('./common.js');
    await start(document.createElement('canvas'), { model: '../../samples/nope.ug9' }).catch(() => {});
  });
  const said = await missing.waitForFunction(() => /モデル（.*nope\.ug9）を読めませんでした/.test(document.getElementById('out').textContent), null, { timeout: 15000 }).then(() => true, () => false);
  check(said, `a missing file is said on the page ("${(await missing.textContent('#out')).slice(0, 60)}…")`);
  plain.close();
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all web example checks passed');
