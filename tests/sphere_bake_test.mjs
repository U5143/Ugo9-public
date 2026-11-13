// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/sphere_bake.mjs: the sphere / cylinder deformer baked into warp keyforms and morphs
// (docs/球体デフォーマ.md, 確かめ方). The motions are written as regions between neighbour keys
// (as the editor writes keys), compiled and moved in the core, and the vertices are compared with
// the exact turned shape: within 1 % of the radius on its exact part, still past the falloff,
// no grid cell folds or grows past 0.5x / 2x, and the data stays small.
//   node tests/sphere_bake_test.mjs [cells]
import fs from 'node:fs';
import { makeSphereBake, shapeTurn } from '../tools/sphere_bake.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const D = Math.PI / 180;

// a disc (the face, 100 x 120) meshed every 8 px, out to 1.7 radii; a small "eye" part on it with a depth
const disc = (rx, ry, out, step, cy) => {
  const v = [], idx = new Map(), R = Math.ceil((Math.max(rx, ry) * out) / step) * step;
  for (let y = -R; y <= R; y += step) for (let x = -R; x <= R; x += step) if ((x / (rx * out)) ** 2 + (y / (ry * out)) ** 2 <= 1) { idx.set(`${x},${y}`, v.length / 2); v.push(x, y + cy); }
  const t = [];
  for (let y = -R; y < R; y += step) for (let x = -R; x < R; x += step) {
    const a = idx.get(`${x},${y}`), b = idx.get(`${x + step},${y}`), c = idx.get(`${x},${y + step}`), d = idx.get(`${x + step},${y + step}`);
    if (a !== undefined && b !== undefined && d !== undefined) t.push(a, b, d);
    if (a !== undefined && d !== undefined && c !== undefined) t.push(a, d, c);
  }
  return { vertices: v, triangles: t, uvs: new Array(v.length).fill(0.5) };
};
const cells = Number(process.argv[2] || 14);
const face = disc(100, 120, 1.7, 8, -300), eye = disc(16, 10, 1, 4, -300);
eye.vertices = eye.vertices.map((v, i) => (i % 2 ? v - 10 : v + 35)); // right of the middle, a little up
const model = {
  format: 'ugo9', version: '0.6', canvas: { width: 600, height: 700, originX: 300, originY: 650 },
  parameters: [{ id: 'AngleX', min: -30, default: 0, max: 30 }, { id: 'AngleY', min: -30, default: 0, max: 30 }, { id: 'BodyAngleX', min: -10, default: 0, max: 10 }, { id: 'FaceStretch', min: -1, default: 0, max: 1 }],
  bones: [{ id: 'root' }],
  warps: [{ id: 'face', cols: cells, rows: cells, rect: [-176, -512, 352, 424] }],
  parts: [{ id: 'face', texture: 0, warp: 'face', ...face }, { id: 'eye', texture: 0, warp: 'face', ...eye }],
  textures: ['none.png'], deformers: [], animations: [],
  editor: { depth: { eye: 0.15 } },
};
const shape = { id: 'head', type: 'sphere', center: [0, -300], radius: [100, 120], depth: 0.6, exact: 0.9, falloff: 1.6, params: { x: 'AngleX', y: 'AngleY' }, turn: { x: 30, y: 30 }, step: 10, target: { warp: 'face' } };

// as the editor writes them: the grid motions and the morph-only motions each on their own keys
// (the values in their `at`, and the default), a region rising from the key before and falling to the next
const write = (m, r) => {
  const out = structuredClone(m), def = (id) => out.parameters.find((p) => p.id === id).default;
  const keysOf = (list) => {
    const k = {};
    for (const mo of list) for (const [id, v] of Object.entries(mo.at)) (k[id] ||= new Set([def(id)])).add(v);
    return Object.fromEntries(Object.entries(k).map(([id, set]) => [id, [...set].sort((x, y) => x - y)]));
  };
  const groups = [r.motions.filter((mo) => mo.warps), r.motions.filter((mo) => !mo.warps)];
  out.deformers = groups.flatMap((list) => {
    const keys = keysOf(list);
    return list.map((mo) => ({
      region: Object.fromEntries(Object.entries(mo.at).map(([id, v]) => { const ks = keys[id], i = ks.indexOf(v); return [id, [ks[Math.max(0, i - 1)], v, ks[Math.min(ks.length - 1, i + 1)]]]; })),
      ...(mo.warps ? { warps: mo.warps } : {}), ...(mo.morphs ? { morphs: mo.morphs } : {}),
    }));
  });
  return out;
};
const r = makeSphereBake(model, shape);
const baked = write(model, r), bytes = compileUgo(baked).byteLength - compileUgo(model).byteLength;
const gridMotions = r.motions.filter((m) => m.warps).length, morphMotions = r.motions.filter((m) => m.morphs).length;
check(gridMotions === 48 && morphMotions === 24 && !r.notes.some((n) => n.code === 'sphereGridCoarse'), `grid keys every 10°: ${gridMotions} motions (6 + 6 along the axes, 36 crossings); the eye's depth as ${morphMotions} morph-only motions on keys every 15° (24 morphs a vertex)`);
check(bytes < 120 * 1024, `data: the .ugo grows by ${(bytes / 1024).toFixed(1)} KB (grid ${cells} x ${cells}, ${gridMotions} grid motions, eye ${eye.vertices.length / 2} vertices x ${morphMotions} morphs)`);

const m = rt.loadModel(compileUgo(baked)), inst = m.createInstance(), buf = rt.alloc(8 * m.vertexCount);
const pose = (ax, ay) => { inst.reset(); inst.set('AngleX', ax); inst.set('AngleY', ay); inst.update(0); rt.ex.ugo_deform_cpu(inst.ptr, buf); return rt.f32(buf, 2 * m.vertexCount).slice(); };
const exactPlain = { ...shape, exact: 1, falloff: 1 }; // the plain ellipsoid, for the reference
const angles = [[5, 0], [15, 0], [25, 0], [30, 0], [0, 15], [5, 5], [15, 10], [25, 15], [-12, 27], [30, 30], [-30, -25], [7, -18]];
let inside = 0, outside = 0, eyeErr = 0, worstAt = null;
const nFace = face.vertices.length / 2;
for (const [ax, ay] of angles) {
  const pos = pose(ax, ay);
  for (let i = 0; i < nFace; i++) {
    const p = [face.vertices[2 * i], face.vertices[2 * i + 1]], r2 = Math.hypot(p[0] / 100, (p[1] + 300) / 120), got = [pos[2 * i], pos[2 * i + 1]];
    if (r2 <= 0.9) { const e = shapeTurn(p, ax * D, ay * D, exactPlain), d = Math.hypot(got[0] - e[0], got[1] - e[1]) / 100; if (d > inside) { inside = d; worstAt = [ax, ay]; } }
    else if (r2 >= 1.6) outside = Math.max(outside, Math.hypot(got[0] - p[0], got[1] - p[1]));
  }
  for (let i = 0; i < eye.vertices.length / 2; i++) {
    const p = [eye.vertices[2 * i], eye.vertices[2 * i + 1]], e = shapeTurn(p, ax * D, ay * D, exactPlain, 0.15 * 100), k = nFace + i;
    eyeErr = Math.max(eyeErr, Math.hypot(pos[2 * k] - e[0], pos[2 * k + 1] - e[1]) / 100);
  }
}
check(inside < 0.01, `in-between angles: on the exact part (r <= 0.9) the vertices are within ${(inside * 100).toFixed(2)}% of the radius of the exact ellipsoid (worst at ${worstAt})`);
check(outside < 0.5, `past the falloff (r >= 1.6) nothing moves: up to ${outside.toFixed(2)} px`);
check(eyeErr < 0.01, `the eye with depth 0.15 (parallax, morphs): within ${(eyeErr * 100).toFixed(2)}% of the radius of the raised ellipsoid`);

// grid cells: none folds; past the falloff they keep their size. (Cells over the shape's far side
// shrink as a real sphere's do: at 30° / 30° the exact shape itself takes some down to 0.3x.)
const area = (P, i, j, C) => { const a = P[j * (C + 1) + i], b = P[j * (C + 1) + i + 1], c = P[(j + 1) * (C + 1) + i + 1], d = P[(j + 1) * (C + 1) + i]; return ((c[0] - a[0]) * (d[1] - b[1]) - (d[0] - b[0]) * (c[1] - a[1])) / 2; };
const pts = () => { const f = inst.warpPoints(0), o = []; for (let k = 0; k < f.length; k += 2) o.push([f[k], f[k + 1]]); return o; };
inst.reset(); inst.update(0);
const R0 = pts();
let lo = Infinity, hi = 0, outLo = Infinity, outHi = 0;
for (const [a, b] of [[30, 0], [0, 30], [30, 30], [-30, 30], [15, -20]]) {
  inst.reset(); inst.set('AngleX', a); inst.set('AngleY', b); inst.update(0);
  const P = pts();
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const q = area(P, i, j, cells) / area(R0, i, j, cells), c = [(R0[j * (cells + 1) + i][0] + R0[(j + 1) * (cells + 1) + i + 1][0]) / 2, (R0[j * (cells + 1) + i][1] + R0[(j + 1) * (cells + 1) + i + 1][1]) / 2];
    lo = Math.min(lo, q); hi = Math.max(hi, q);
    if (Math.hypot(c[0] / 100, (c[1] + 300) / 120) >= 1.8) { outLo = Math.min(outLo, q); outHi = Math.max(outHi, q); }
  }
}
check(lo > 0 && outLo > 0.9 && outHi < 1.1, `grid cells at the ends and corners: no fold (${lo.toFixed(2)}x..${hi.toFixed(2)}x); past the falloff ${outLo.toFixed(2)}x..${outHi.toFixed(2)}x`);

// a cylinder (a body's twist): one parameter, keys every 10°
{
  const cylShape = { id: 'body', type: 'cylinder', center: [0, -300], radius: [100, 120], depth: 0.6, exact: 0.9, falloff: 1.6, params: { x: 'BodyAngleX' }, turn: { x: 30 }, step: 10, target: { warp: 'face' } };
  const c = makeSphereBake({ ...model, editor: {} }, cylShape), cm = write(model, c), ci = rt.loadModel(compileUgo(cm)).createInstance(), cb = rt.alloc(8 * m.vertexCount);
  let worst = 0, still = 0;
  for (const v of [-7.5, -2.5, 2.5, 5, 8.3]) {
    ci.reset(); ci.set('BodyAngleX', v); ci.update(0); rt.ex.ugo_deform_cpu(ci.ptr, cb);
    const pos = rt.f32(cb, 2 * m.vertexCount);
    for (let i = 0; i < nFace; i++) {
      const p = [face.vertices[2 * i], face.vertices[2 * i + 1]], u = Math.abs(p[0] / 100), got = [pos[2 * i], pos[2 * i + 1]];
      if (u <= 0.9 && Math.abs(p[1] + 300) < 150) { const e = shapeTurn(p, (v / 10) * 30 * D, 0, { ...cylShape, exact: 1, falloff: 1 }); worst = Math.max(worst, Math.hypot(got[0] - e[0], got[1] - e[1]) / 100); }
      else if (u >= 1.6) still = Math.max(still, Math.hypot(got[0] - p[0], got[1] - p[1]));
    }
  }
  check(c.motions.filter((m) => m.warps).length === 6 && worst < 0.01 && still < 0.5, `cylinder: ${c.motions.length} keys; within ${(worst * 100).toFixed(2)}% of the radius, ${still.toFixed(2)} px past the falloff`);
}

// the stretch (radii x scale on FaceStretch): small ones as keys of their own added to the turn's,
// bigger ones baked with the turn on one key grid (angles every 15°)
for (const [scale, want] of [[[1.04, 0.96], 'sphereStretchAdd'], [[1.1, 0.9], 'sphereStretchFull']]) {
  const sh = { ...shape, stretch: { param: 'FaceStretch', scale } };
  const b = makeSphereBake({ ...model, editor: {} }, sh), bm = write(model, b), bi = rt.loadModel(compileUgo(bm)).createInstance(), bb = rt.alloc(8 * m.vertexCount);
  const size = compileUgo(bm).byteLength - compileUgo(model).byteLength;
  let worst = 0;
  for (const [ax, ay, fs] of [[0, 0, 1], [15, 10, 1], [30, 30, 1], [-25, 15, -1], [10, -5, 0.5]]) {
    bi.reset(); bi.set('AngleX', ax); bi.set('AngleY', ay); bi.set('FaceStretch', fs); bi.update(0); rt.ex.ugo_deform_cpu(bi.ptr, bb);
    const pos = rt.f32(bb, 2 * m.vertexCount), S = scale.map((v) => 1 + (v - 1) * fs);
    for (let i = 0; i < nFace; i++) {
      const p = [face.vertices[2 * i], face.vertices[2 * i + 1]];
      if (Math.hypot(p[0] / 100, (p[1] + 300) / 120) > 0.9) continue;
      const q = [p[0] * S[0], -300 + (p[1] + 300) * S[1]], e = shapeTurn(q, ax * D, ay * D, { ...exactPlain, radius: [100 * S[0], 120 * S[1]] });
      worst = Math.max(worst, Math.hypot(pos[2 * i] - e[0], pos[2 * i + 1] - e[1]) / 100);
    }
  }
  const mode = b.notes.find((n) => n.code.startsWith('sphereStretch'))?.code;
  check(mode === want && worst < (want === 'sphereStretchAdd' ? 0.03 : 0.012), `stretch ${scale.join(' x ')}: ${mode === 'sphereStretchAdd' ? 'added to the turn' : 'baked with the turn'}, within ${(worst * 100).toFixed(2)}% of the radius (${b.motions.length} motions, +${(size / 1024).toFixed(0)} KB)`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall sphere bake checks passed');
process.exit(failures ? 1 : 0);
