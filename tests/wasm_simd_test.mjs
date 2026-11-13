// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Two builds of the core for the web (tools/build_wasm.sh): web/ugo.wasm, and web/ugo_simd.wasm with WebAssembly
// SIMD. UgoRuntime.load picks ugo_simd.wasm where the browser has SIMD (and only fetches that one), ugo.wasm with
// { simd: false }, when ugo_simd.wasm is missing, or in a browser without SIMD; both play the sample the same, bit
// for bit (every build against native C: tests/determinism_test.mjs).
//   node tests/wasm_simd_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UgoRuntime } from '../web/ugo.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// Node: the bytes as given; each build says which it is
{
  const plain = await UgoRuntime.load(fs.readFileSync(path.join(root, 'web/ugo.wasm')));
  const simd = await UgoRuntime.load(fs.readFileSync(path.join(root, 'web/ugo_simd.wasm')));
  check(!plain.simd && simd.simd && UgoRuntime.simdSupported(), `from bytes: ugo.wasm runs as plain, ugo_simd.wasm as SIMD (Node has SIMD: ${UgoRuntime.simdSupported()})`);
  const size = (f) => fs.statSync(path.join(root, f)).size;
  check(size('web/ugo_simd.wasm') < size('web/ugo.wasm') * 1.25, `the SIMD build is about as large (${size('web/ugo.wasm')} / ${size('web/ugo_simd.wasm')} bytes)`);
}

const port = 8155;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
try {
  const run = async (name, setup, script) => {
    const page = await browser.newPage(), asked = [], errors = [];
    page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.endsWith('.wasm')) asked.push(p); });
    page.on('pageerror', (e) => errors.push(String(e)));
    if (setup) await setup(page);
    await page.route('**/blank.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
    await page.goto(`http://localhost:${port}/blank.html`); // a page of this server that loads nothing itself
    const r = await page.evaluate(script);
    await page.close();
    return { ...r, asked, errors };
  };
  // plays the sample (every animation, a second one mixed in) and returns the frame blocks' bytes as one hash
  const play = `
    const m = rt.loadModel(await (await fetch('/samples/basic/model.ug9')).arrayBuffer()), inst = m.createInstance();
    let h = 2166136261 >>> 0, n = 0;
    for (let a = 0; a < m.animations.length; a++) for (let i = 0; i < 50; i++) {
      inst.reset(); inst.play(a, i / 25, 1); inst.play((a + 1) % m.animations.length, i / 17, 0.4); inst.set(0, (i % 9) / 4 - 1); inst.update(1 / 30);
      const b = new Uint8Array(inst.frame().slice().buffer);
      for (const x of b) { h = Math.imul(h ^ x, 16777619) >>> 0; n++; }
    }
    return { simd: rt.simd, hash: h, bytes: n };`;
  const load = (args) => new Function(`return (async () => { const { UgoRuntime } = await import('/web/ugo.js'); const rt = await UgoRuntime.load(${args}); ${play} })();`);
  const auto = await run('auto', null, load("'/web/ugo.wasm'"));
  check(auto.simd && auto.asked.length === 1 && auto.asked[0] === '/web/ugo_simd.wasm', `a browser with SIMD loads ugo_simd.wasm only (${auto.asked.join(' ')})`);
  const def = await run('default', null, load(''));
  check(def.simd && def.asked.join() === '/web/ugo_simd.wasm', `with no URL too: ugo_simd.wasm next to ugo.js (${def.asked.join(' ')})`);
  const off = await run('off', null, load("'/web/ugo.wasm', { simd: false }"));
  check(!off.simd && off.asked.join() === '/web/ugo.wasm', `{ simd: false } loads ugo.wasm (${off.asked.join(' ')})`);
  const missing = await run('missing', (p) => p.route('**/ugo_simd.wasm', (r) => r.fulfill({ status: 404, body: '' })), load("'/web/ugo.wasm'"));
  check(!missing.simd && missing.asked.join() === '/web/ugo_simd.wasm,/web/ugo.wasm', `ugo_simd.wasm missing (a host that copied only ugo.wasm): ugo.wasm (${missing.asked.join(' ')})`);
  const old = await run('old', (p) => p.addInitScript(() => { const v = WebAssembly.validate; WebAssembly.validate = (b) => (b.length < 40 ? false : v(b)); }), load("'/web/ugo.wasm'"));
  check(!old.simd && old.asked.join() === '/web/ugo.wasm', `a browser without SIMD (WebAssembly.validate says no): ugo.wasm only (${old.asked.join(' ')})`);
  check(auto.hash === off.hash && auto.bytes === off.bytes && auto.bytes > 10000, `both builds play the sample the same (${auto.bytes} bytes of frame blocks, hash ${auto.hash.toString(16)})`);
  const errors = [auto, def, off, missing, old].flatMap((r) => r.errors);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all wasm SIMD checks passed');
