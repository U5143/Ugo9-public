// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A very big PSD in the browser: 7500 x 7300 px, 300 layers (about 110 MB, made by
// tests/psd/make_big.mjs into build/psd_big/ the first time), read in Chromium the way the
// editor opens a PSD. Checks the page does not crash and the result is
// whole; prints the time and (on Linux) the page process's peak memory.
// With --workers=n (default 3) the layers are read in n Workers (importPsdParallel); --workers=0
// reads them on the page (importPsdAsync).
// Slow (about half a minute and more), so not in CI:   node tests/psd_big_browser_test.mjs [width height layers] [--workers=n]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePsd, bigLayers } from './psd/make_big.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [W, H, N] = args.length >= 3 ? args.slice(0, 3).map(Number) : [7500, 7300, 300];
// --workers=n: read the layers in n Workers (importPsdParallel); 0: importPsdAsync on the page
const WORKERS = +(process.argv.find((a) => a.startsWith('--workers='))?.slice(10) ?? 3);
const rel = `build/psd_big/${W}x${H}_${N}.psd`, file = path.join(root, rel);
if (!fs.existsSync(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = performance.now();
  fs.writeFileSync(file, writePsd(W, H, bigLayers(W, H, N)));
  console.log(`made ${rel}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}

// peak memory of Chromium's page processes (Linux /proc; elsewhere nothing)
const rendererPeakMB = () => {
  let peak = 0;
  try {
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
        const m = /VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
        if (m) peak = Math.max(peak, +m[1] / 1024);
      } catch { /* the process ended */ }
    }
  } catch { /* no /proc */ }
  return Math.round(peak);
};

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 8600 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [path.join(root, 'tools/serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  let crashed = false, peak = 0;
  page.on('crash', () => { crashed = true; });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(`http://localhost:${port}/blank`).catch(() => {}); // any page of the server (a 404 is fine): the importer is loaded from it
  const watch = setInterval(() => { peak = Math.max(peak, rendererPeakMB()); }, 1000);
  const r = await page.evaluate(async ({ url, workers }) => {
    const { importPsdAsync, importPsdParallel } = await import('/tools/import_psd.mjs');
    let bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    // a pool of module Workers, as the editor makes: run(job) -> Promise of the layer's pixels
    const ws = Array.from({ length: workers }, () => new Worker('/tests/psd/layer_worker_web.mjs', { type: 'module' }));
    const idle = [...ws], queue = [], waiting = new Map();
    let id = 0;
    const send = () => { while (idle.length && queue.length) { const w = idle.pop(), { job, k } = queue.shift(); w.postMessage({ id: k, job }, [job.bytes]); } };
    for (const w of ws) w.onmessage = ({ data: { id: k, px, error } }) => {
      const { resolve, reject } = waiting.get(k); waiting.delete(k); idle.push(w); send();
      if (error) reject(Object.assign(new Error(error.message), error)); else resolve(px);
    };
    const run = (job) => new Promise((resolve, reject) => { const k = id++; waiting.set(k, { resolve, reject }); queue.push({ job, k }); send(); });
    const t = performance.now();
    const res = workers ? await importPsdParallel(bytes, {}, run) : await importPsdAsync(bytes);
    ws.forEach((w) => w.terminate());
    bytes = null;
    return { ms: Math.round(performance.now() - t), parts: res.model.parts.length, scale: res.scale,
      pages: res.atlases.map((a) => `${a.width}x${a.height}`), full: res.atlases.every((a) => a.rgba?.length === a.width * a.height * 4),
      codes: [...new Set(res.notes.map((n) => n.code))] };
  }, { url: `/${rel}`, workers: WORKERS }).catch((e) => ({ error: e.message }));
  clearInterval(watch);
  peak = Math.max(peak, rendererPeakMB());
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
  check(!crashed && !r.error, `the page did not crash${r.error ? ` (${r.error})` : ''}`);
  if (!r.error) {
    check(r.parts === N + 2, `${r.parts} parts (background, ${N} blobs, the hidden one)`);
    check(r.scale < 1 && r.full && r.pages.length > 1, `scaled to ${r.scale.toFixed(3)}, ${r.pages.length} atlas pages, all filled`);
    check(r.codes.includes('psdScaledDown'), 'the scaling is noted');
    console.log(`${WORKERS ? `importPsdParallel, ${WORKERS} Workers` : 'importPsdAsync'}: ${(r.ms / 1000).toFixed(1)} s; page process peak ${peak ? `${peak} MB` : 'not measured'}`);
  }
} finally { await browser.close(); server.kill(); }
if (failed) process.exit(1);
console.log('psd big browser: ok');
