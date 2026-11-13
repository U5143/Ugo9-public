// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Browser test for the draw order (format 0.8) in the WebGL renderer: parts drawn
// by each character's own order, characters next to each other with the same
// order drawn together, more orders in use than the renderer keeps (it writes
// them again), and the same picture in GPU, strict-mask and CPU modes.
//
//   node tests/draw_order_test.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8146;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/web/index.html`).catch(() => {});
  const r = await page.evaluate(async () => {
    const { UgoRuntime, UgoRenderer, loadImage } = await import('/web/ugo.js');
    const { compileUgo } = await import('/tools/compile.mjs');
    const rt = await UgoRuntime.load('/web/ugo.wasm');
    // four parts on top of each other, each a solid colour of the atlas; Sw sends d to the back, Tw also brings a to the front
    const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    const atlas = new OffscreenCanvas(64, 16), x = atlas.getContext('2d');
    COLORS.forEach(([cr, cg, cb], i) => { x.fillStyle = `rgb(${cr},${cg},${cb})`; x.fillRect(16 * i, 0, 16, 16); });
    const image = await loadImage(await atlas.convertToBlob({ type: 'image/png' }));
    const quad = [-8, -8, 8, -8, 8, 8, -8, 8];
    const src = {
      format: 'ugo9', canvas: { width: 20, height: 20, originX: 10, originY: 10 }, textures: ['atlas.png'],
      parameters: [{ id: 'Sw', min: 0, default: 0, max: 1 }, { id: 'Tw', min: 0, default: 0, max: 1 }],
      bones: [{ id: 'root' }],
      parts: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, bone: 'root', vertices: quad, triangles: [0, 1, 2, 0, 2, 3],
        uvs: [(16 * i + 4) / 64, 0.25, (16 * i + 12) / 64, 0.25, (16 * i + 12) / 64, 0.75, (16 * i + 4) / 64, 0.75] })),
      deformers: [{ region: { Sw: [0, 1, 1] }, order: { d: 0 } }, { region: { Tw: [0, 1, 1] }, order: { d: 100, a: 900 } }],
    };
    const model = rt.loadModel(compileUgo(src));
    const W = 200, H = 20;
    const canvas = new OffscreenCanvas(W, H), gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
    const top = (sw, tw) => (tw ? 'a' : sw ? 'c' : 'd'); // the part drawn last
    const make = (list) => list.map(([sw, tw], i) => {
      const inst = model.createInstance();
      inst.reset(); inst.set('Sw', sw); inst.set('Tw', tw); inst.setTransform(1, 0, 0, 1, 10 + 20 * i, 10); inst.update(0);
      return inst;
    });
    const pixels = (renderer, insts, mode) => {
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const stats = renderer.draw(insts, W, H, mode);
      const px = new Uint8Array(4 * W * H);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // the colour at each character's centre (rows are bottom-up)
      const at = insts.map((_, i) => { const k = 4 * ((H - 1 - 10) * W + 10 + 20 * i); return Array.from(px.subarray(k, k + 3)); });
      return { at, draws: stats.drawCalls };
    };
    const name = (c) => ['a', 'b', 'c', 'd'][COLORS.findIndex((q) => q.every((v, k) => Math.abs(v - c[k]) < 8))] ?? `?${c}`;
    const states = [[0, 0], [0, 0], [1, 0], [1, 0], [0, 1], [0, 0], [1, 1]];
    const insts = make(states);
    const renderer = new UgoRenderer(gl, model, [image]);
    const gpu = pixels(renderer, insts, 'gpu'), cpu = pixels(renderer, insts, 'cpu');
    const strict = new UgoRenderer(gl, model, [image], { strictMasks: true });
    const st = pixels(strict, insts, 'gpu');
    // more orders than the renderer keeps: every permutation the runs can give, twice round
    const fake = (perm) => ({ drawOrderKey: () => 1 + perm.reduce((h, p) => h * 5 + p, 0), drawOrder: () => Uint32Array.from(perm) });
    const perms = [];
    const permute = (rest, done) => { if (!rest.length) perms.push(done); rest.forEach((p, i) => permute(rest.filter((_, j) => j !== i), [...done, p])); };
    permute([0, 1, 2, 3], []);
    let runsOk = true;
    for (const perm of [...perms, ...perms.slice(0, 5)]) {
      const runs = renderer.runsFor(fake(perm));
      if (runs.length !== 1 || runs[0].count !== 24) runsOk = false; // (one blend class: one run of 4 parts)
      if (renderer.orders.size > 8) runsOk = false;
    }
    const again = pixels(renderer, insts, 'gpu'); // the real orders written again after the slots were taken
    return { expected: states.map(([s, t]) => top(s, t)), gpu: gpu.at.map(name), cpu: cpu.at.map(name), strict: st.at.map(name), again: again.at.map(name),
      draws: gpu.draws, runsOk, kept: renderer.orders.size, hasOrder: model.hasDrawOrder };
  });
  check(r.hasOrder, 'the model has a draw order');
  check(r.gpu.join('') === r.expected.join(''), `GPU: each character's top part follows its own draw order (${r.gpu.join('')}, expected ${r.expected.join('')})`);
  check(r.cpu.join('') === r.expected.join('') && r.strict.join('') === r.expected.join(''), `CPU and strict modes draw the same (${r.cpu.join('')}, ${r.strict.join('')})`);
  check(r.draws === 5, `characters next to each other with the same order are drawn together (${r.draws} calls for 5 runs of 7 characters)`);
  check(r.runsOk && r.kept <= 8, `more orders than the renderer keeps (24 + 5) are written again as needed (${r.kept} kept)`);
  check(r.again.join('') === r.expected.join(''), `after that the characters still draw right (${r.again.join('')})`);
  // nearest sampling (pixel art): a 2 x 2 checker drawn 4x shows only its own four colours
  const px = await page.evaluate(async () => {
    const { UgoRuntime, UgoRenderer } = await import('/web/ugo.js');
    const { compileUgo } = await import('/tools/compile.mjs');
    const rt = await UgoRuntime.load('/web/ugo.wasm');
    const model = rt.loadModel(compileUgo({ format: 'ugo9', canvas: { width: 8, height: 8 }, textures: ['t.png'], bones: [{ id: 'root' }],
      parts: [{ id: 'p', bone: 'root', vertices: [0, 0, 8, 0, 8, 8, 0, 8], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }] }));
    const c = new OffscreenCanvas(2, 2), x = c.getContext('2d'), id = x.createImageData(2, 2);
    id.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    x.putImageData(id, 0, 0);
    const image = await createImageBitmap(c, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(8, 8), gl = canvas.getContext('webgl2', { antialias: false });
    const inst = model.createInstance(); inst.update(0);
    const colours = (ren) => {
      gl.viewport(0, 0, 8, 8); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      ren.draw([inst], 8, 8, 'gpu');
      const out = new Uint8Array(4 * 64), set = new Set();
      gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, out);
      for (let i = 0; i < 64; i++) set.add(out.slice(4 * i, 4 * i + 4).join(','));
      return [...set];
    };
    const ren = new UgoRenderer(gl, model, [image], { sampling: 'nearest' });
    const near = colours(ren);
    ren.setSampling('linear');
    const smooth = colours(ren);
    return { near, smooth: smooth.length };
  });
  const want = new Set(['255,0,0,255', '0,255,0,255', '0,0,255,255', '255,255,255,255']);
  check(px.near.length === 4 && px.near.every((c) => want.has(c)), `sampling 'nearest' draws only the texture's own colours (${px.near.join(' | ')})`);
  check(px.smooth > 4, `setSampling('linear') blends them again (${px.smooth} colours)`);
  check(errors.length === 0, `no errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all draw order checks passed');
