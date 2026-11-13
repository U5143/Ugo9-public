// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Browser test for the Web runtime (headless Chromium via Playwright).
//
//   node tests/web_test.mjs
//
// - the demo loads with no console errors
// - GPU deformation and CPU deformation draw the same picture
// - per-frame CPU cost with many characters, GPU vs CPU deformation
// - GIF and APNG export from the page produce valid files
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright'); // CommonJS lookup also honours NODE_PATH
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'web');
fs.mkdirSync(out, { recursive: true });
const port = 8123;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, acceptDownloads: true });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/`);
  await page.waitForFunction(() => window.ugoDemo?.model && window.ugoDemo.instances.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.locator('#view').screenshot({ path: path.join(out, 'demo.png') });
  check(errors.length === 0, `demo loads without errors ${errors.length ? JSON.stringify(errors) : ''}`);

  // same picture from both deformation paths (fixed pose, no animation)
  await page.evaluate(() => {
    const d = window.ugoDemo;
    d.state.anim = ''; d.state.follow = false;
    d.state.pinned.clear();
    [['AngleX', 22], ['AngleY', -12], ['EyeOpenL', 0.3], ['MouthOpen', 0.7], ['EyeBallX', -0.6], ['BodyAngleX', 4]]
      .forEach(([n, v]) => d.state.pinned.set(d.model.paramIndex.get(n), v));
  });
  await page.waitForTimeout(2500); // let the hair physics settle (on a slow machine it may still swing a little)
  // then hold that pose: both paths draw the same frame block, however slow the machine is
  await page.evaluate(() => new Promise((r) => { window.ugoDemo.state.frozen = true; requestAnimationFrame(() => requestAnimationFrame(r)); }));
  const shot = async (mode, file) => {
    await page.evaluate((m) => new Promise((r) => { window.ugoDemo.state.mode = m; requestAnimationFrame(() => requestAnimationFrame(r)); }), mode);
    return page.locator('#view').screenshot({ path: path.join(out, file) });
  };
  const a = await shot('gpu', 'pose_gpu.png');
  const b = await shot('cpu', 'pose_cpu.png');
  await page.evaluate(() => { window.ugoDemo.state.frozen = false; });
  const diff = await page.evaluate(async ([pa, pb]) => {
    const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const [ia, ib] = await Promise.all([load(pa), load(pb)]);
    const c = new OffscreenCanvas(ia.width, ia.height), x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, ia.width, ia.height).data;
    x.clearRect(0, 0, ia.width, ia.height); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, ia.width, ia.height).data;
    let max = 0, over = 0;
    for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d > max) max = d; if (d > 8) over++; }
    return { max, over, total: da.length };
  }, [a.toString('base64'), b.toString('base64')]);
  check(diff.over / diff.total < 0.0005, `GPU and CPU deformation match (max diff ${diff.max}, ${diff.over} channels differ by > 8)`);

  // many characters: CPU time per frame in each mode
  const bench = async (mode, count) => {
    await page.evaluate(([m, n]) => {
      const d = window.ugoDemo;
      d.state.mode = m; d.state.anim = 'idle'; d.state.pinned.clear();
      const slider = document.getElementById('count');
      slider.value = String((Math.log10(n) / Math.log10(2000)) * 100);
      slider.dispatchEvent(new Event('input'));
    }, [mode, count]);
    // slow software GPUs can take seconds per frame in CPU mode: wait until the stats show this mode
    await page.waitForFunction((m) => {
      // the sample has masks: one draw for the masks, one for the characters (per character in CPU mode)
      const want = m === 'gpu' ? 2 : 2 * window.ugoDemo.instances.length;
      return document.getElementById('sDraws').textContent === `${want} 回`;
    }, mode, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(2000);
    return page.evaluate(() => ({
      count: window.ugoDemo.instances.length,
      fps: document.getElementById('sFps').textContent,
      update: document.getElementById('sUpdate').textContent,
      deform: document.getElementById('sDeform').textContent,
      submit: document.getElementById('sSubmit').textContent,
      draws: document.getElementById('sDraws').textContent,
      upload: document.getElementById('sUpload').textContent,
    }));
  };
  const g = await bench('gpu', 200);
  // only kept as a CI artifact: a busy software GPU can take long to finish 200 characters,
  // so wait longer and don't fail the run over the picture
  await page.screenshot({ path: path.join(out, 'crowd.png'), timeout: 120000 })
    .catch((e) => console.log(`     (crowd.png not taken: ${String(e).split('\n')[0]})`));
  const c = await bench('cpu', 200);
  console.log('     GPU mode:', JSON.stringify(g));
  console.log('     CPU mode:', JSON.stringify(c));
  check(g.draws === '2 回', 'GPU mode draws every character in one call (plus one for the masks)');
  check(c.draws === `${2 * c.count} 回`, `CPU mode draws character by character (${c.draws})`);

  // export from the page
  await page.evaluate(() => {
    const d = window.ugoDemo;
    d.state.mode = 'gpu';
    const slider = document.getElementById('count'); slider.value = '0'; slider.dispatchEvent(new Event('input'));
  });
  for (const fmt of ['gif', 'apng']) {
    await page.selectOption('#exFormat', fmt);
    await page.selectOption('#exScale', '0.5');
    await page.fill('#exSeconds', '1');
    await page.fill('#exFps', '12');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#exGo')]);
    const file = path.join(out, `export.${fmt === 'gif' ? 'gif' : 'png'}`);
    await dl.saveAs(file);
    const head = fs.readFileSync(file).subarray(0, 8).toString('latin1');
    check(fmt === 'gif' ? head.startsWith('GIF89a') : head.startsWith('\x89PNG'), `export ${fmt}: ${fs.statSync(file).size} bytes`);
  }
  check(errors.length === 0, `no errors during the run ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all browser checks passed');
