// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// How heavy one editor rebuild is for a big character (synthetic, about the size
// of a full PSD-based model): compile time per section in Node, then in Chromium
// compile + loadModel + setModel + instance + first frame, as editor/live.js does.
// Not a pass/fail test.   node tests/big_bench.mjs [parts=160] [atlas=4096]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { compileUgo } from '../tools/compile.mjs';

const PARTS = +(process.argv[2] || 160), ATLAS = +(process.argv[3] || 4096);

// a deterministic pseudo-random sequence (the same model every run, and every call: bigModel starts it again)
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

export function bigModel(nParts = PARTS) {
  seed = 1; // (a second call in the same process used to carry on the sequence: another model)
  const parameters = [];
  const axes = ['AngleX', 'AngleY', 'AngleZ', 'BodyX', 'BodyY', 'BodyZ', 'EyeLOpen', 'EyeROpen', 'EyeBallX', 'EyeBallY',
    'BrowLY', 'BrowRY', 'BrowLAngle', 'BrowRAngle', 'MouthOpen', 'MouthForm', 'Cheek', 'Breath', 'HairFront', 'HairSide',
    'HairBack', 'ArmLA', 'ArmRA', 'HandL', 'HandR', 'Skirt', 'Ribbon', 'Shoulder', 'Lean', 'Smile'];
  for (const id of axes) parameters.push({ id, min: -30, default: 0, max: 30 });
  // bones: a spine, a head, arms and hair strands
  const bones = [{ id: 'root' }, { id: 'hip', parent: 'root', y: -300 }, { id: 'chest', parent: 'hip', y: -150 },
    { id: 'neck', parent: 'chest', y: -120 }, { id: 'head', parent: 'neck', y: -60 }];
  for (const s of ['L', 'R']) {
    const x = s === 'L' ? -90 : 90;
    bones.push({ id: `arm${s}1`, parent: 'chest', x, y: -100, length: 120 }, { id: `arm${s}2`, parent: `arm${s}1`, x: 0, y: 120, length: 110 },
      { id: `hand${s}`, parent: `arm${s}2`, y: 110, length: 40 });
  }
  for (let h = 0; h < 8; h++) for (let k = 0; k < 4; k++)
    bones.push({ id: `hair${h}_${k}`, parent: k ? `hair${h}_${k - 1}` : 'head', x: k ? 0 : -80 + 23 * h, y: k ? 40 : -40, length: 40 });
  // warp grids: face, and parts of the face inside it, like a Live2D model
  const warps = [{ id: 'face', cols: 5, rows: 5, rect: [-150, -800, 300, 300], bone: 'head' }];
  for (const [id, r] of [['eyeL', [-110, -700, 90, 60]], ['eyeR', [20, -700, 90, 60]], ['browL', [-110, -740, 90, 30]],
    ['browR', [20, -740, 90, 30]], ['mouth', [-50, -580, 100, 50]], ['nose', [-20, -640, 40, 40]], ['cheekL', [-130, -620, 60, 40]],
    ['cheekR', [70, -620, 60, 40]], ['fringe', [-150, -820, 300, 120]]])
    warps.push({ id, cols: 3, rows: 3, rect: r, parent: 'face' });
  warps.push({ id: 'body', cols: 4, rows: 4, rect: [-200, -480, 400, 480], bone: 'chest' });

  // parts: grid meshes of 8x8 .. 16x16 quads (about 25k vertices for 160 parts)
  const parts = [], partVerts = [];
  const grid = (x, y, w, h, nx, ny, u0, v0, us, vs) => {
    const vertices = [], uvs = [], triangles = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      vertices.push(+(x + w * i / nx).toFixed(2), +(y + h * j / ny).toFixed(2));
      uvs.push(+(u0 + us * i / nx).toFixed(5), +(v0 + vs * j / ny).toFixed(5));
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; triangles.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
    return { vertices, uvs, triangles };
  };
  const cellsPerRow = Math.ceil(Math.sqrt(nParts)), cell = 1 / cellsPerRow;
  for (let i = 0; i < nParts; i++) {
    const n = 8 + Math.floor(rnd() * 9), m = 8 + Math.floor(rnd() * 9);
    const u0 = (i % cellsPerRow) * cell, v0 = Math.floor(i / cellsPerRow) * cell;
    const kind = i % 4; // 0: in a face warp, 1: in the body warp, 2: on a bone, 3: weighted to a hair chain
    let p;
    if (kind === 0) {
      const w = warps[i % 10], [x, y, ww, hh] = w.rect;
      p = { warp: w.id, ...grid(x + 4, y + 4, ww - 8, hh - 8, n, m, u0, v0, cell * 0.95, cell * 0.95) };
    } else if (kind === 1) {
      p = { warp: 'body', ...grid(-180 + rnd() * 200, -460 + rnd() * 200, 160, 220, n, m, u0, v0, cell * 0.95, cell * 0.95) };
    } else if (kind === 2) {
      const b = bones[1 + Math.floor(rnd() * 10)];
      p = { bone: b.id, ...grid(-100 + rnd() * 200, -700 + rnd() * 500, 120, 160, n, m, u0, v0, cell * 0.95, cell * 0.95) };
    } else {
      const h = i % 8, x0 = -80 + 23 * h;
      const g = grid(x0 - 15, -840, 30, 160, n, m, u0, v0, cell * 0.95, cell * 0.95);
      const weights = [];
      for (let k = 0; k < g.vertices.length; k += 2) {
        const t = Math.min(3, Math.max(0, (g.vertices[k + 1] + 840) / 40)), a = Math.floor(Math.min(t, 2.999)), f = t - a;
        weights.push([[`hair${h}_${a}`, 1 - f], [`hair${h}_${a + 1}`, f]]);
      }
      p = { weights, ...g };
    }
    parts.push({ id: `part${i}`, texture: 0, ...p });
    partVerts.push(p.vertices.length / 2);
  }
  // deformers: each parameter has two keys (min, max); each key moves some of the
  // parts with dense morphs, some grids and some bones
  const deformers = [];
  axes.forEach((id, a) => {
    for (const side of [-1, 1]) {
      const region = { [id]: side < 0 ? [-30, -30, 0] : [0, 30, 30] };
      const morphs = {}, warpsD = {}, bonesD = {};
      for (let k = 0; k < 6; k++) {
        const pi = (a * 7 + k * 13 + (side > 0 ? 3 : 0)) % nParts;
        morphs[`part${pi}`] = { dense: Array.from({ length: partVerts[pi] * 2 }, () => +(side * rnd() * 6).toFixed(2)) };
      }
      if (a < 10) for (const w of warps.slice(0, 3)) warpsD[w.id] = { dense: Array.from({ length: (w.cols + 1) * (w.rows + 1) * 2 }, () => +(side * rnd() * 8).toFixed(2)) };
      if (a % 3 === 0) bonesD[bones[2 + (a % 12)].id] = { rotation: side * 10 };
      deformers.push({ region, morphs, ...(Object.keys(warpsD).length ? { warps: warpsD } : {}), ...(Object.keys(bonesD).length ? { bones: bonesD } : {}) });
    }
  });
  // corner corrections on the head turn (two axes)
  for (const sx of [-1, 1]) for (const sy of [-1, 1])
    deformers.push({ region: { AngleX: sx < 0 ? [-30, -30, 0] : [0, 30, 30], AngleY: sy < 0 ? [-30, -30, 0] : [0, 30, 30] },
      warps: { face: { dense: Array.from({ length: 72 }, () => +(rnd() * 3).toFixed(2)) } } });
  const tracks = {};
  for (const id of axes.slice(0, 12)) tracks[id] = [[0, 0, 'smooth'], [1, 20, 'smooth'], [2, -20, 'smooth'], [3, 0]];
  return {
    format: 'ugo9', version: '0.6',
    canvas: { width: 600, height: 1000, originX: 300, originY: 980 },
    textures: ['atlas.png'],
    parameters, bones, warps, parts, deformers,
    animations: [{ id: 'idle', duration: 3, loop: true, tracks }],
  };
}

const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];

if (import.meta.url === `file://${process.argv[1]}`) {
  const model = bigModel();
  const json = JSON.stringify(model);
  let bytes, nv = 0;
  for (const p of model.parts) nv += p.vertices.length / 2;
  const totals = [], sections = [];
  for (let i = 0; i < 12; i++) { // the same object each time, as the editor compiles its document
    const t = {}, t0 = performance.now();
    bytes = compileUgo(model, { timings: t });
    totals.push(performance.now() - t0); sections.push(t);
  }
  totals.splice(0, 4); sections.splice(0, 4); // warm up
  const per = {};
  for (const k of Object.keys(sections[0])) per[k] = +med(sections.map((s) => s[k])).toFixed(2);
  console.log(JSON.stringify({ parts: model.parts.length, vertices: nv, params: model.parameters.length, warps: model.warps.length,
    deformers: model.deformers.length, jsonKB: Math.round(json.length / 1024), ugoKB: Math.round(bytes.byteLength / 1024) }));
  console.log('node compile ms', +med(totals).toFixed(1), JSON.stringify(per));

  // in the browser: the editor's path (editor/live.js build), the atlas kept as an ImageBitmap
  const { chromium } = createRequire(import.meta.url)('playwright');
  const port = 8143;
  const server = spawn(process.execPath, [new URL('../tools/serve.mjs', import.meta.url).pathname, String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('err', String(e)));
    await page.goto(`http://localhost:${port}/web/index.html`).catch(() => {});
    const r = await page.evaluate(async ({ json, atlas }) => {
      const { compileUgo } = await import('/tools/compile.mjs');
      const { UgoRuntime, UgoRenderer } = await import('/web/ugo.js');
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600; document.body.append(canvas);
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true });
      const c = new OffscreenCanvas(atlas, atlas), x = c.getContext('2d'); x.fillStyle = '#c96'; x.fillRect(0, 0, atlas, atlas);
      const image = await createImageBitmap(c);
      const rt = await UgoRuntime.load('/web/ugo.wasm');
      const mark = rt.ex.ugo_wasm_mark();
      let renderer = null;
      const rows = [], secs = [];
      const src = JSON.parse(json); // the editor compiles its live object; parse is not part of a rebuild
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now(), timings = {};
        const bytes = compileUgo(src, { warnings: [], timings });
        secs.push(timings);
        const t1 = performance.now();
        rt.ex.ugo_wasm_release(mark);
        const model = rt.loadModel(bytes);
        const t2 = performance.now();
        if (renderer) renderer.setModel(model, [image]); else renderer = new UgoRenderer(gl, model, [image]);
        const t3 = performance.now();
        const inst = model.createInstance();
        inst.update(0);
        const t4 = performance.now();
        renderer.draw([inst], 800, 600);
        gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        const t5 = performance.now();
        rows.push({ compile: t1 - t0, load: t2 - t1, setModel: t3 - t2, instance: t4 - t3, draw: t5 - t4, total: t5 - t0 });
      }
      return { rows: rows.slice(2), secs: secs.slice(2) };
    }, { json, atlas: ATLAS });
    const out = {}, sec = {};
    for (const k of Object.keys(r.rows[0])) out[k] = +med(r.rows.map((x) => x[k])).toFixed(1);
    for (const k of Object.keys(r.secs[0])) sec[k] = +med(r.secs.map((x) => x[k])).toFixed(2);
    console.log(`browser ms (atlas ${ATLAS}, setModel keeps it)`, JSON.stringify(out));
    console.log('browser compile sections ms', JSON.stringify(sec));
  } finally { await browser.close(); server.kill(); }
}
