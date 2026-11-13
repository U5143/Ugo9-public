// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Opening a model in the VTuber page (利用者の声 #396: VTube Studio users could not open models with Japanese
// path names): a model and texture with Japanese names, picked and dropped; a texture name in macOS's
// decomposed form (NFD) and in other case; a broken file and a missing texture are said clearly; the
// display page (OBS) shows the opened model too, and the sample again after "見本に戻す".
//   node tests/vtuber_open_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { compileUgo } from '../tools/compile.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8147;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// a plain red PNG (8 x 8)
function png(r, g, b) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [r, g, b, 255]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const TEX = 'ガイド顔.png'; // "ガ" and "ド" come apart in NFD
const quad = (x, y, w, h) => ({ vertices: [x, y, x + w, y, x + w, y + h, x, y + h], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] });
const model = Buffer.from(compileUgo({
  format: 'ugo9', canvas: { width: 400, height: 400, originX: 200, originY: 200 }, textures: [`テクスチャ/${TEX}`],
  parameters: [{ id: 'AngleX', min: -30, default: 0, max: 30 }], bones: [{ id: 'root' }],
  parts: [{ id: '顔', texture: 0, bone: 'root', ...quad(-150, -150, 300, 300) }],
}));
const MODEL = 'ぼくのキャラ（試し）.ug9';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage(), view = await ctx.newPage(), errors = [];
  for (const [p, n] of [[page, ''], [view, 'view: ']]) p.on('pageerror', (e) => errors.push(n + String(e)));
  await page.goto(`http://localhost:${port}/web/vtuber.html`);
  await view.goto(`http://localhost:${port}/web/vtuber.html#view`);
  await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  await view.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  const status = () => page.textContent('#modelStatus');
  // the colour in the middle of the character (a screenshot: the WebGL picture is gone after it is shown)
  const middle = async (p) => {
    const shot = await p.locator('#view').screenshot();
    return p.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height).getContext('2d'); c.drawImage(img, 0, 0);
      return [...c.getImageData(img.width >> 1, img.height >> 1, 1, 1).data];
    }, shot.toString('base64'));
  };
  const red = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;

  // 1. picked: Japanese names as they are
  await page.setInputFiles('#open', [{ name: MODEL, mimeType: 'application/octet-stream', buffer: model }, { name: TEX, mimeType: 'image/png', buffer: png(230, 20, 20) }]);
  await page.waitForFunction((n) => window.ugoVtuber.modelName === n, MODEL.normalize('NFC'), { timeout: 10000 });
  check(/ぼくのキャラ（試し）\.ug9 を開きました/.test(await status()) && !/違う/.test(await status()), `picked with Japanese names: opened, texture found by name ("${await status()}")`);
  await page.waitForTimeout(300);
  check(red(await middle(page)), 'and drawn with its texture');
  await view.waitForFunction((n) => window.ugoVtuber.modelName === n, MODEL.normalize('NFC'), { timeout: 10000 }).catch(() => {});
  await view.waitForTimeout(300);
  check(await view.evaluate(() => window.ugoVtuber.modelName) === MODEL && red(await middle(view)), 'the display page (OBS) shows the opened model too');

  // 2. dropped: the texture's name decomposed (macOS) and in capitals
  await page.click('#sample');
  await page.waitForFunction(() => window.ugoVtuber.modelName === '見本');
  await view.waitForFunction(() => window.ugoVtuber.modelName === '見本', null, { timeout: 10000 }).catch(() => {});
  check(await view.evaluate(() => window.ugoVtuber.modelName) === '見本', '"見本に戻す" puts the sample back on both pages');
  const nfd = TEX.normalize('NFD').replace('.png', '.PNG');
  check(nfd !== TEX && nfd.normalize('NFC').toLowerCase() === TEX, `(the decomposed name differs from the model's: ${nfd.length} vs ${TEX.length} characters)`);
  await page.evaluate(async ([m, t, mn, tn]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(m)], mn.normalize('NFD')));
    dt.items.add(new File([new Uint8Array(t)], tn, { type: 'image/png' }));
    for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [[...model], [...png(20, 20, 230)], MODEL, nfd]);
  await page.waitForFunction((n) => window.ugoVtuber.modelName === n, MODEL.normalize('NFC'), { timeout: 10000 });
  await page.waitForTimeout(300);
  const blue = await middle(page);
  check(!/違う/.test(await status()) && blue[2] > 200 && blue[0] < 60, `dropped, the PNG's name decomposed and in capitals: found by name, drawn blue (${blue.slice(0, 3)})`);
  check(!(await page.evaluate(() => document.documentElement.classList.contains('dragging'))), 'the drop hint goes away after the drop');

  // 3. what cannot be opened is said
  await page.setInputFiles('#open', [{ name: 'メモ.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await page.waitForTimeout(300);
  check(/\.ug9 のファイルがありません/.test(await status()), `no model among the files: said (${await status()})`);
  await page.setInputFiles('#open', [{ name: '壊れた.ug9', mimeType: 'application/octet-stream', buffer: Buffer.from('not a model at all') }]);
  await page.waitForTimeout(300);
  check(/壊れた\.ug9 は Ugo9 のモデルとして読めませんでした/.test(await status()), 'a broken file: said, and the shown model is kept');
  check(await page.evaluate(() => window.ugoVtuber.modelName) === MODEL, '(still the last one)');
  await page.setInputFiles('#open', [{ name: MODEL, mimeType: 'application/octet-stream', buffer: model }]);
  await page.waitForTimeout(300);
  check(/テクスチャの PNG が足りません：テクスチャ\/ガイド顔\.png/.test(await status()), `the model without its PNG: the missing texture is named (${await status()})`);
  await page.setInputFiles('#open', [{ name: MODEL, mimeType: 'application/octet-stream', buffer: model }, { name: '別の名前.png', mimeType: 'image/png', buffer: png(20, 200, 20) }]);
  await page.waitForTimeout(300);
  check(/名前の違う PNG を順に使いました/.test(await status()), 'one PNG with another name: used, and said');
  // the mapping: a model whose parameters have names of its own moves nothing until they are chosen on the page
  {
    const own = Buffer.from(compileUgo({
      format: 'ugo9', canvas: { width: 400, height: 400, originX: 200, originY: 200 }, textures: ['own.png'],
      parameters: [{ id: 'KaoYoko', min: -30, default: 0, max: 30 }, { id: 'Kuchi', min: 0, default: 0, max: 1 }], bones: [{ id: 'root' }],
      parts: [{ id: 'face', texture: 0, bone: 'root', ...quad(-100, -100, 200, 200) }],
    }));
    await page.setInputFiles('#open', [{ name: 'own.ug9', mimeType: 'application/octet-stream', buffer: own }, { name: 'own.png', mimeType: 'image/png', buffer: png(200, 200, 200) }]);
    await page.waitForFunction(() => window.ugoVtuber.modelName === 'own.ug9', null, { timeout: 10000 });
    const st = await page.textContent('#mapStatus');
    check(/動かない物：顔の左右.*口の開き/.test(st) && await page.evaluate(() => document.getElementById('mapBox').open), `names of its own: the page says what will not move and opens the table ("${st.slice(0, 50)}…")`);
    check((await page.evaluate(() => window.ugoVtuber.tracked({ HeadTurnX: 10 }))).KaoYoko === 0, 'before choosing, the face does not move it');
    const row = (from) => `#mapTable tr[data-from="${from}"]`;
    await page.selectOption(`${row('HeadTurnX')} select`, 'KaoYoko');
    await page.fill(`${row('HeadTurnX')} input[type=number]`, '2'); await page.dispatchEvent(`${row('HeadTurnX')} input[type=number]`, 'change');
    await page.check(`${row('HeadTurnX')} input[type=checkbox]`);
    await page.selectOption(`${row('MouthOpen')} select`, 'Kuchi');
    const moved = await page.evaluate(() => window.ugoVtuber.tracked({ HeadTurnX: 10 }));
    check(moved.KaoYoko === -20, `chosen on the page with scale 2 and invert: HeadTurnX 10 moves KaoYoko to ${moved.KaoYoko}`);
    await page.reload();
    await page.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
    await page.setInputFiles('#open', [{ name: 'own.ug9', mimeType: 'application/octet-stream', buffer: own }, { name: 'own.png', mimeType: 'image/png', buffer: png(200, 200, 200) }]);
    await page.waitForFunction(() => window.ugoVtuber.modelName === 'own.ug9', null, { timeout: 10000 });
    const kept = await page.evaluate(() => window.ugoVtuber.mapping.filter((m) => m.to).map((m) => `${m.from}->${m.to}${m.invert ? '-' : ''}x${m.scale}`).join(' '));
    check(kept === 'HeadTurnX->KaoYoko-x2 MouthOpen->Kuchix1', `the model's mapping is kept for next time (${kept})`);
    await page.click('#sample');
    await page.waitForFunction(() => window.ugoVtuber.modelName === '見本');
    check(await page.evaluate(() => window.ugoVtuber.mapping.every((m) => m.to)), 'the sample: every tracked value found its parameter by name');
  }
  // (利用者の声 #415) the first-time guide and what moves: open on a first visit, closed once settings are kept
  const guideOpen = (p) => p.evaluate(() => document.getElementById('guide').open);
  const fresh = await browser.newContext({ viewport: { width: 1000, height: 700 } }), first = await fresh.newPage();
  await first.goto(`http://localhost:${port}/web/vtuber.html`);
  await first.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  check(await guideOpen(first) && /開く.*カメラを許す.*正面を合わせる.*OBS に重ねる/s.test(await first.textContent('#guide')), 'a first visit opens the four-step guide (open, allow the camera, face front, lay it in OBS)');
  check(/腕・手・指・足・全身は動きません/.test(await first.textContent('#moves')), 'the page says plainly what does not move (arms, hands, the whole body)');
  await first.check('#flipX'); // any setting kept
  await first.reload();
  await first.waitForFunction(() => window.ugoVtuber?.params, null, { timeout: 30000 });
  check(!(await guideOpen(first)), 'later visits keep the guide closed');
  await fresh.close();
  // the pictures docs/VTuber.md shows are there
  const guide = fs.readFileSync(path.join(root, 'docs', 'VTuber.md'), 'utf8');
  const pics = [...guide.matchAll(/\]\((VTuber\/[^)]+\.png)\)/g)].map((m) => m[1]);
  check(pics.length >= 5 && pics.every((f) => fs.existsSync(path.join(root, 'docs', f))), `the guide's ${pics.length} pictures exist (tools/vtuber_guide_shots.mjs makes them)`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all VTuber open checks passed');
