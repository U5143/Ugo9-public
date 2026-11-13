// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// What every example shares: load the core and a model, place one character in the canvas, run a frame loop,
// and turn a pointer position into model space. Each example then adds one thing (see docs/芯のAPI.md).
// Drawn with WebGPU where the browser has it, else WebGL2 (add ?webgl2 to the page's address to force WebGL2).
import { UgoRuntime, loadImage } from '../ugo.js';
import { createRenderer } from '../ugo_webgpu.js';

// what went wrong, said on the page (the #out line) as well as in the console
function say(text) { const out = document.getElementById('out'); if (out) { out.textContent = text; out.style.color = '#b4502a'; } }
async function fetchOk(url, what) {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) throw new Error(`${what}（${url}）を読めませんでした。リポジトリのフォルダごと置いて、そこで node tools/serve.mjs（か npx serve など、どの静的なサーバーでも）を動かし、http://localhost:…/web/examples/ を開いてください`);
  return r;
}

export async function start(canvas, opts = {}) {
  try { return await startUp(canvas, opts); } catch (e) { say(e.message || String(e)); throw e; }
}
async function startUp(canvas, { model: modelUrl = '../../samples/basic/model.ug9', atlas = '../../samples/basic/atlas.png' } = {}) {
  // the SIMD build where the browser has SIMD (UgoRuntime.load does the same for a URL); else, or if it is not there, ugo.wasm
  const simd = UgoRuntime.simdSupported() ? await fetch(new URL('../ugo_simd.wasm', import.meta.url)).catch(() => null) : null;
  const rt = await UgoRuntime.load(await (simd && simd.ok ? simd : await fetchOk(new URL('../ugo.wasm', import.meta.url), '芯（ugo.wasm）')).arrayBuffer());
  canvas.dataset.core = rt.simd ? 'simd' : 'plain';
  const model = rt.loadModel(await (await fetchOk(new URL(modelUrl, import.meta.url), 'モデル')).arrayBuffer());
  const webgpu = !new URLSearchParams(location.search).has('webgl2');
  await fetchOk(new URL(atlas, import.meta.url), 'テクスチャ');
  const renderer = await createRenderer(canvas, model, [await loadImage(new URL(atlas, import.meta.url))], { webgpu });
  const gl = renderer.kind === 'webgl2' ? renderer.gl : null;
  canvas.dataset.renderer = renderer.kind; // 'webgpu' or 'webgl2'
  const inst = model.createInstance();
  // place it: the model's canvas fitted into ours (screen pixels, y down)
  const [cw, ch, ox, oy] = model.canvas, s = Math.min(canvas.width / cw, canvas.height / ch);
  const tx = (canvas.width - cw * s) / 2 + ox * s, ty = (canvas.height - ch * s) / 2 + oy * s;
  inst.setTransform(s, 0, 0, s, tx, ty);
  // a pointer event -> model space (what pickPart, hitTest and UgoLook take)
  const toModel = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * canvas.width / r.width, y = (e.clientY - r.top) * canvas.height / r.height;
    return [(x - tx) / s, (y - ty) / s];
  };
  // draws one updated instance (or several) into the canvas
  const draw = (insts = [inst]) => {
    if (gl) { gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    renderer.draw(insts, canvas.width, canvas.height); // (WebGPU clears first by itself)
  };
  // the frame loop: each(dt, seconds) sets the character up after reset(), then it is updated and drawn
  const loop = (each) => {
    let last = performance.now(), clock = 0;
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now; clock += dt;
      inst.reset();
      each(dt, clock);
      inst.update(dt);
      draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  return { rt, model, inst, renderer, gl, loop, draw, toModel, place: [s, tx, ty] };
}
