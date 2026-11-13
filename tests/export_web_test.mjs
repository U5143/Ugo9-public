// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A character for a web page in one file (tools/export_web.mjs, 利用者の声 #29), in headless Chromium:
// the one-page form opens with nothing else fetched and no errors; the module form gives <ugo9-player>
// with one script tag; paused at the start it draws what ugo_export draws (within what GPU and CPU
// drawing differ by); mount() plays another animation and refuses one that is not there.
//   node tests/export_web_test.mjs        (needs Playwright's Chromium; the picture needs build/ugo_export)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webModule, webPage, viewerPage } from '../tools/export_web.mjs';
import { scaleModel } from '../tools/scale_model.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { decodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_web_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const model = path.join(ROOT, 'samples/basic/model.ug9');
fs.writeFileSync(path.join(OUT, 'basic.ugo9.js'), webModule(model));
fs.writeFileSync(path.join(OUT, 'page.html'), webPage(model, { anim: 'talk' }));
fs.writeFileSync(path.join(OUT, 'viewer.html'), viewerPage(model));
// several models in one file: the sample and the sample at half the size (its own model, the same picture)
fs.mkdirSync(path.join(OUT, 'half'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'samples/basic/atlas.png'), path.join(OUT, 'half', 'atlas.png'));
fs.writeFileSync(path.join(OUT, 'half', 'half.ug9'), new Uint8Array(compileUgo(scaleModel(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/basic/model.json'), 'utf8')), 0.5), { warnings: [] })));
const cast = [model, path.join(OUT, 'half', 'half.ug9')];
fs.writeFileSync(path.join(OUT, 'cast.html'), webPage(cast, { names: ['big', 'half'] }));
const castModule = webModule(cast), single = webModule(model);
fs.writeFileSync(path.join(OUT, 'module.html'), `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">
<script type="module" src="basic.ugo9.js"></script>
<ugo9-player id="p" anim="idle" paused style="width:210px;height:300px"></ugo9-player></body>`);
const port = 8131, server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const base = `http://localhost:${port}/build/export_web_test/`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  // the page: one file, nothing else fetched
  {
    const page = await browser.newPage({ viewport: { width: 420, height: 600 } }), errors = [], requests = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(base + 'page.html');
    await page.waitForFunction(() => document.querySelector('ugo9-player')?.player, null, { timeout: 20000 });
    await page.waitForTimeout(500);
    const shot = decodePng(await page.screenshot({ omitBackground: true }));
    let shown = 0; for (let i = 3; i < shot.rgba.length; i += 4) if (shot.rgba[i] > 128) shown++;
    const anim = await page.evaluate(() => document.querySelector('ugo9-player').player.animations.join());
    check(errors.length === 0 && requests.length === 1 && shown > 20000, `the page: opens with no errors, nothing fetched but itself (${requests.length} request), the character drawn (${shown} px), its animations ${anim}`);
    await page.close();
  }
  // the module: <ugo9-player> with one script tag; paused at the start: as ugo_export draws it
  {
    const page = await browser.newPage({ viewport: { width: 210, height: 300 } }), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + 'module.html');
    await page.waitForFunction(() => document.getElementById('p')?.player, null, { timeout: 20000 });
    await page.waitForTimeout(400);
    const shot = decodePng(await page.locator('#p').screenshot({ omitBackground: true }));
    check(errors.length === 0 && shot.width === 210 && shot.height === 300, `the module: <ugo9-player> from one script tag, no errors (${shot.width}×${shot.height})`);
    const exe = (() => { try { return findExporter(); } catch { return null; } })(); // (throws when not built: skipped below)
    if (exe) {
      execFileSync(exe, [model, '--anim', 'idle', '--frames', '1', '--warmup', '0', '--size', '210x300', '--format', 'raw', '--out', path.join(OUT, 'ref.rgba')], { stdio: 'ignore' });
      const ref = fs.readFileSync(path.join(OUT, 'ref.rgba'));
      let bad = 0, both = 0;
      for (let i = 0; i < 210 * 300; i++) {
        const a = shot.rgba.subarray(i * 4, i * 4 + 4), b = ref.subarray(i * 4, i * 4 + 4);
        if (a[3] > 128 || b[3] > 128) both++;
        if (Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[k] - b[k]))) > 48) bad++;
      }
      check(both > 10000 && bad <= both * 0.03, `paused at the start: the picture ugo_export draws (${bad} of ${both} px differ by more than 48: GPU and CPU edges)`);
    } else console.log('skip the picture: build/ugo_export not built');
    const r = await page.evaluate(async () => {
      const p = document.getElementById('p').player;
      p.play('talk');
      let refused = '';
      try { p.play('nope'); } catch (e) { refused = e.message; }
      return { refused, n: p.animations.length };
    });
    check(/no animation named nope/.test(r.refused) && r.n === 2, 'the player: plays another animation, refuses one that is not there');
    await page.close();
  }
  // both cores in the file (#469): the SIMD one where the browser has it, the same picture as the plain one
  // (window.UGO9_NO_SIMD keeps the plain one); --no-simd: only the plain core, a smaller file
  {
    const shot = async (noSimd) => {
      const page = await browser.newPage({ viewport: { width: 210, height: 300 } });
      if (noSimd) await page.addInitScript(() => { window.UGO9_NO_SIMD = true; });
      await page.goto(base + 'module.html');
      await page.waitForFunction(() => document.getElementById('p')?.player, null, { timeout: 20000 });
      await page.waitForTimeout(400);
      const simd = await page.evaluate(() => document.getElementById('p').player.model.rt.simd);
      const png = decodePng(await page.locator('#p').screenshot({ omitBackground: true }));
      await page.close();
      return { simd, png };
    };
    const a = await shot(false), b = await shot(true);
    const plainOnly = webModule(model, { simd: false }), both = fs.readFileSync(path.join(OUT, 'basic.ugo9.js'), 'utf8');
    check(a.simd === true && b.simd === false && Buffer.from(a.png.rgba).equals(Buffer.from(b.png.rgba)),
      `the SIMD core where the browser has it (${a.simd}), the plain one when kept (${b.simd}): the same picture, byte for byte`);
    check(/const UGO9_WASM_SIMD = "/.test(both) && /const UGO9_WASM_SIMD = null;/.test(plainOnly) && both.length - plainOnly.length > 50000,
      `--no-simd (opts.simd false): only the plain core, ${((both.length - plainOnly.length) / 1024).toFixed(0)} KB smaller`);
  }
  // the viewer: a panel with the animations, the speed, the zoom, the background and a slider per parameter
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } }), errors = [], requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(base + 'viewer.html');
    await page.waitForFunction(() => window.ugo9Viewer, null, { timeout: 20000 });
    const info = await page.evaluate(() => ({ anims: [...document.querySelectorAll('#anim option')].map((o) => o.value), sliders: document.querySelectorAll('#params input[type=range]').length, params: window.ugo9Viewer.model.params.length }));
    check(errors.length === 0 && requests.length === 1 && info.anims.join() === 'idle,talk' && info.sliders === info.params && info.params > 0,
      `the viewer: one file, no errors; the animations ${info.anims.join(', ')}; a slider for each of the ${info.params} parameters`);
    const shown = async () => { await page.waitForTimeout(300); const s = decodePng(await page.locator('#stage').screenshot({ omitBackground: true })); let n = 0; for (let i = 3; i < s.rgba.length; i += 4) if (s.rgba[i] > 128) n++; return n; };
    await page.evaluate(() => { document.getElementById('clear').click(); document.getElementById('pause').click(); document.documentElement.style.background = document.body.style.background = 'transparent'; });
    const before = await shown();
    await page.evaluate(() => { const z = document.getElementById('zoom'); z.value = 0.5; z.dispatchEvent(new Event('input')); });
    const smaller = await shown();
    const pinned = await page.evaluate(async () => { const r = document.querySelector('#params input[type=range]'), name = window.ugo9Viewer.model.params[0].name; r.value = r.max; r.dispatchEvent(new Event('input')); await new Promise((f) => setTimeout(f, 200)); return Math.abs(window.ugo9Viewer.instance.get(name) - +r.max) < 1e-3; });
    check(smaller < before * 0.4 && smaller > before * 0.15 && pinned, `zoom 0.5: the character drawn about a quarter the size (${before} → ${smaller} px); a slider holds its parameter at the value`);
    await page.close();
  }
  // several models: the core once, a player per model by name
  {
    const halfAlone = webModule(path.join(OUT, 'half', 'half.ug9'));
    check(castModule.length < single.length + halfAlone.length - 150000 && (castModule.match(/const UGO9_WASM = /g) || []).length === 1 && (castModule.match(/const UGO9_WASM_SIMD = /g) || []).length === 1,
      `two models in one module: the cores and the runtime once (${(castModule.length / 1024).toFixed(0)} KB, against ${((single.length + halfAlone.length) / 1024).toFixed(0)} KB as two files)`);
    const page = await browser.newPage({ viewport: { width: 840, height: 600 } }), errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + 'cast.html');
    await page.waitForFunction(() => [...document.querySelectorAll('ugo9-player')].every((p) => p.player), null, { timeout: 20000 });
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => [...document.querySelectorAll('ugo9-player')].map((p) => [p.getAttribute('model'), p.player.model.canvas[0]]));
    const shots = [];
    for (const el of await page.locator('ugo9-player').all()) { const im = decodePng(await el.screenshot({ omitBackground: true })); let n = 0; for (let i = 3; i < im.rgba.length; i += 4) if (im.rgba[i] > 128) n++; shots.push(n); }
    check(errors.length === 0 && info.map((x) => x[0]).join() === 'big,half' && info[0][1] === 2 * info[1][1] && shots.every((n) => n > 10000),
      `a page of two: each player its own model (canvases ${info.map((x) => x[1]).join(' and ')}), both drawn (${shots.join(', ')} px), no errors`);
    await page.close();
  }
  // mount() with a model name the file does not have: refused, naming the ones it has
  {
    fs.writeFileSync(path.join(OUT, 'cast.ugo9.js'), castModule);
    fs.writeFileSync(path.join(OUT, 'nomodel.html'), '<!doctype html><meta charset="utf-8"><canvas id="c"></canvas>');
    const page = await browser.newPage();
    await page.goto(base + 'nomodel.html');
    const msg = await page.evaluate(async () => { const m = await import('./cast.ugo9.js'); try { await m.mount('#c', { model: 'nope' }); return 'mounted'; } catch (e) { return e.message + ' | ' + m.models.join(); } });
    check(/no model named nope/.test(msg) && msg.endsWith('| model,half'), `an unknown model: refused, the file's models named (${msg})`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall web embed checks passed');
process.exit(failures ? 1 : 0);
