// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The "open and it runs" pages for web engines (web/engines/three.html, pixi.html, phaser.html):
// the sample character shows, the animation list and a parameter slider change it, clicking the
// face names it, and nothing goes wrong. The engines come from the CDN in the pages; here they
// are served from node_modules instead (no network in tests).
//   npm install --no-save three@0.186.1 pixi.js@8.22.0 phaser@4.2.1   (once)
//   node tests/engine_pages_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8133;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// the CDN, from node_modules
const cdn = { 'pixi.js@8.22.0/': 'pixi.js/', 'phaser@4.2.1/': 'phaser/', 'three@0.186.1/': 'three/' };
async function routeCdn(page) {
  await page.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
    const url = new URL(route.request().url()).pathname.replace('/npm/', '');
    const key = Object.keys(cdn).find((k) => url.startsWith(k));
    const file = key && path.join(root, 'node_modules', cdn[key] + url.slice(key.length));
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not here' });
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
  });
}

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  for (const name of ['pixi', 'phaser', 'three']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await routeCdn(page);
    await page.goto(`http://localhost:${port}/web/engines/${name}.html`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    // the canvas shows the character: pixels that are neither the background nor the backdrop
    const drawn = () => page.evaluate(() => {
      const c = document.querySelector('#view canvas');
      const g = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }).getContext('2d');
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 16) {
        const bg = Math.abs(d[i] - 233) + Math.abs(d[i + 1] - 230) + Math.abs(d[i + 2] - 220) < 12;
        const back = Math.abs(d[i] - 216) + Math.abs(d[i + 1] - 210) + Math.abs(d[i + 2] - 192) < 12;
        if (!bg && !back) n++;
      }
      return n;
    });
    const n0 = await drawn();
    check(n0 > 2000, `${name}: the character shows (${n0} sampled pixels)`);
    // a slider: the head's turn (HeadTurnX, or AngleX in older samples) to its end, read back from the instance
    const turn = await page.evaluate(() => (document.querySelector('input[data-param="HeadTurnX"]') ? 'HeadTurnX' : 'AngleX'));
    await page.evaluate((n) => { const s = document.querySelector(`input[data-param="${n}"]`); s.value = s.max; s.dispatchEvent(new Event('input')); }, turn);
    await page.selectOption('#anim', 'talk');
    await page.waitForTimeout(300);
    const after = await page.evaluate((n) => {
      const h = window.ugoTest.hero;
      return { angle: h.instance.get(n), anim: document.querySelector('#anim').value };
    }, turn);
    check(Math.abs(after.angle - 30) < 1e-3 && after.anim === 'talk', `${name}: the slider sets ${turn} (${after.angle}) and the list picks an animation (${after.anim})`);
    await page.click('#resetParams');
    await page.selectOption('#anim', ''); // the rest pose for clicking
    await page.waitForTimeout(300);
    // click the face
    const at = await page.evaluate((engine) => {
      const t = window.ugoTest, c = document.querySelector('#view canvas'), r = c.getBoundingClientRect();
      if (engine === 'three') {
        const v = t.hero.localToWorld(new (t.hero.position.constructor)(0, 330 * 1.6 / t.model.canvas[1], 0)).project(t.camera);
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
      }
      const h = t.hero;
      return [r.left + h.x * r.width / c.width, r.top + (h.y - 330 * h.scaleY) * r.height / c.height];
    }, name);
    await page.mouse.click(at[0], at[1]);
    await page.waitForTimeout(100);
    const picked = await page.textContent('#picked');
    check(picked === 'face', `${name}: clicking the face names it (${picked})`);
    await page.mouse.click(5, 5);
    check((await page.textContent('#picked')) !== 'face', `${name}: clicking beside it names nothing`);
    // the microphone (Chromium's fake one beeps): the mouth opens through the gate
    // The fake microphone beeps only now and then, and the gate closes the mouth 0.12 s after a beep: polling every
    // 100 ms could miss every open moment. So the page keeps the largest opening it showed, every frame, for up to 4 s.
    await page.evaluate(() => {
      window.mouthMost = 0;
      const watch = () => { window.mouthMost = Math.max(window.mouthMost, window.ugoTest.hero.instance.get('MouthOpen')); if (window.mouthMost < 0.05) requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    });
    await page.click('#mic');
    let mouth = 0;
    for (let k = 0; k < 40 && mouth < 0.05; k++) {
      await page.waitForTimeout(100);
      mouth = await page.evaluate(() => window.mouthMost);
    }
    const status = await page.textContent('#micStatus');
    check(mouth > 0.05 || status !== '', `${name}: the microphone opens the mouth (MouthOpen ${mouth.toFixed(2)}${status ? `, ${status}` : ''})`);
    await page.click('#mic');
    check(errors.length === 0, `${name}: no errors ${errors.length ? JSON.stringify(errors) : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all engine page checks passed');
