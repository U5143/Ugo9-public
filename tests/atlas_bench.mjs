// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// How long putting the atlas on the GPU takes (UgoRenderer.setImages), part by part:
// decoding the PNGs, the texture's storage, each page, the mipmaps. Big atlases
// (4096 px, several pages, one smaller page). The parts are timed with the zero
// padding setImages used to upload, for comparison. Not a pass/fail test.
//   node tests/atlas_bench.mjs [pages=4] [size=4096]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const PAGES = +(process.argv[2] || 4), SIZE = +(process.argv[3] || 4096);
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 8145;
const server = spawn(process.execPath, [new URL('../tools/serve.mjs', import.meta.url).pathname, String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('err', String(e)));
  page.on('console', (m) => console.log(m.text()));
  await page.goto(`http://localhost:${port}/web/index.html`).catch(() => {});
  const r = await page.evaluate(async ({ PAGES, SIZE, OLD_PADDING }) => {
    const { UgoRenderer, loadImage } = await import('/web/ugo.js');
    // pages like a PSD atlas: shapes with soft edges on transparency; the last page smaller
    const blobs = [];
    for (let p = 0; p < PAGES; p++) {
      const s = p === PAGES - 1 && PAGES > 1 ? SIZE / 2 : SIZE;
      const c = new OffscreenCanvas(s, s), x = c.getContext('2d');
      for (let k = 0; k < 400; k++) {
        x.fillStyle = `hsla(${(k * 37) % 360}, 60%, 60%, ${0.5 + (k % 5) / 10})`;
        x.beginPath(); x.ellipse((k * 997) % s, (k * 613) % s, 20 + (k % 90), 15 + (k % 70), k, 0, 7); x.fill();
      }
      blobs.push(await c.convertToBlob({ type: 'image/png' }));
    }
    const t0 = performance.now();
    const images = await Promise.all(blobs.map((b) => loadImage(b)));
    const decode = performance.now() - t0;
    const gl = document.createElement('canvas').getContext('webgl2');
    const T = gl.TEXTURE_2D_ARRAY;
    const rows = [];
    for (let rep = 0; rep < 3; rep++) {
      const t = {};
      let t1 = performance.now();
      const lap = (k) => { gl.finish(); const n = performance.now(); t[k] = (t[k] || 0) + n - t1; t1 = n; };
      const tex = gl.createTexture();
      gl.bindTexture(T, tex);
      const aw = Math.max(...images.map((i) => i.width)), ah = Math.max(...images.map((i) => i.height));
      gl.texStorage3D(T, 1 + Math.floor(Math.log2(Math.max(aw, ah))), gl.RGBA8, aw, ah, images.length);
      lap('storage');
      if (OLD_PADDING && images.some((im) => im.width !== aw || im.height !== ah)) { // what setImages did before
        gl.texSubImage3D(T, 0, 0, 0, 0, aw, ah, images.length, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(aw * ah * 4 * images.length));
        lap('padding');
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      images.forEach((im, i) => gl.texSubImage3D(T, 0, 0, 0, i, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      lap('pages');
      gl.generateMipmap(T);
      lap('mipmaps');
      gl.deleteTexture(tex);
      // the renderer's own setImages, end to end
      const r = { gl, sampling: 'linear', applySampling: UgoRenderer.prototype.applySampling };
      const s0 = performance.now();
      UgoRenderer.prototype.setImages.call(r, images); gl.finish();
      t.setImages = performance.now() - s0;
      gl.deleteTexture(r.atlas);
      rows.push(t);
    }
    return { decode, rows };
  }, { PAGES, SIZE, OLD_PADDING: true });
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const out = {};
  for (const k of Object.keys(r.rows[0])) out[k] = +med(r.rows.map((x) => x[k])).toFixed(1);
  console.log(`${PAGES} pages of ${SIZE} px (the last half size): decode ${r.decode.toFixed(0)} ms, upload ms`, JSON.stringify(out));
} finally { await browser.close(); server.kill(); }
