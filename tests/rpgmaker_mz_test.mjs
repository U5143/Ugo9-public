// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The RPG Maker MZ plugin (engines/rpgmaker_mz): built into one file, run in PixiJS 5 (MZ's version)
// with stand-ins for MZ's objects (tests/rpgmaker_mz/page.html): a character shows between the
// map and the windows, animations and expressions switch, the speaker talks during messages.
//   node tests/rpgmaker_mz_test.mjs   (installs pixi.js@5.3.12 into build/rpgmaker_mz/pixi5 once)
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pixi = path.join(root, 'build', 'rpgmaker_mz', 'pixi5');
if (!fs.existsSync(path.join(pixi, 'node_modules', 'pixi.js', 'dist', 'pixi.js'))) {
  fs.mkdirSync(pixi, { recursive: true });
  fs.writeFileSync(path.join(pixi, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'pixi.js@5.3.12'], { cwd: pixi, stdio: 'inherit' });
}
execFileSync(process.execPath, [path.join(root, 'engines', 'rpgmaker_mz', 'build.mjs')], { stdio: 'inherit' });

const port = 8133;
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
  await page.goto(`http://localhost:${port}/tests/rpgmaker_mz/page.html`);
  await page.waitForFunction(() => window.loaded === true && window.Ugo9 && window.Ugo9.rt, null, { timeout: 30000 });

  const simd = await page.evaluate(() => [window.Ugo9.rt.simd, typeof WebAssembly.validate === 'function']);
  check(simd[0] === true, `the plugin runs the core's SIMD build where the browser has WebAssembly SIMD (runtime.simd ${simd[0]})`);
  await page.evaluate(() => window.run('show', { id: 'hero', model: 'basic', x: '408', y: '600', scale: '0.6', animation: '' }));
  await page.waitForFunction(() => window.Ugo9.get('hero') !== null, null, { timeout: 30000 });
  const first = await page.evaluate(() => { window.step(10); return { drawn: window.drawn(), anim: window.Ugo9.get('hero').animation, win: window.pixel(408, 560) }; });
  check(first.drawn > 3000 && first.anim === 'idle', `a character shows (${first.drawn} pixels), playing its first animation (${first.anim})`);
  check(first.win[2] > 200 && first.win[0] < 40, `the windows stay above the character (window pixel ${first.win})`);
  const order = await page.evaluate(() => { const s = window.scene; return [s.children.indexOf(window.Ugo9.sprite), s.children.indexOf(s._windowLayer)]; });
  check(order[0] >= 0 && order[0] < order[1], `the character's sprite is put below the window layer (${order})`);

  const switched = await page.evaluate(() => {
    window.run('play', { id: 'hero', animation: 'talk', fade: '0.3' });
    window.step(5);
    const c = window.Ugo9.get('hero');
    return { anim: c.animation, from: c.from };
  });
  check(switched.anim === 'talk' && switched.from === 'idle', `play blends from idle to talk (${switched.from} -> ${switched.anim})`);

  const params = await page.evaluate(() => {
    const c = window.Ugo9.get('hero'), model = c.kind.model;
    const name = model.paramIndex.has('HeadTurnX') ? 'HeadTurnX' : 'AngleX';
    window.run('param', { id: 'hero', name, value: '20' });
    window.step(2);
    const set = c.instance.get(name);
    window.run('param', { id: 'hero', name, value: '' });
    window.run('play', { id: 'hero', animation: 'idle', fade: '0' });
    window.step(2);
    return { set, cleared: c.params.size };
  });
  check(Math.abs(params.set - 20) < 1e-3 && params.cleared === 0, `a parameter is kept over the animation, and given back (${params.set})`);

  const talk = await page.evaluate(() => {
    window.run('speaker', { id: 'hero' });
    const c = window.Ugo9.get('hero');
    const mouth = () => c.instance.get('MouthOpen');
    window.step(10);
    const quiet = mouth();
    window.$gameMessage.busy = true; window.scene._messageWindow._textState = { index: 0 };
    let most = 0;
    for (let i = 0; i < 30; i++) { window.step(1); most = Math.max(most, mouth()); }
    window.$gameMessage.busy = false; window.scene._messageWindow._textState = null;
    window.step(30);
    return { quiet, most, after: mouth() };
  });
  check(talk.quiet < 0.1 && talk.most > 0.5 && talk.after < 0.1, `the speaker talks while a message is written out (mouth ${talk.quiet.toFixed(2)} -> ${talk.most.toFixed(2)} -> ${talk.after.toFixed(2)})`);

  const gone = await page.evaluate(() => { window.run('hide', { id: 'hero' }); window.step(2); return { drawn: window.drawn(), has: window.Ugo9.get('hero') }; });
  check(gone.drawn < 50 && gone.has === null, `hide takes the character away (${gone.drawn} pixels left)`);
  check(errors.length === 0, `no errors on the page${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all RPG Maker MZ plugin checks passed');
