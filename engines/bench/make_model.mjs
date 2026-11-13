// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Makes a synthetic Ugo9 character with given counts, to compare runtimes with
// a model of the same size (docs/比較_Live2D.md). Only numbers are taken from the
// other model: no picture or data of it is used.
//
//   node engines/bench/make_model.mjs --out <dir> [--parts 80] [--vertices 4000]
//        [--params 30] [--warps 12] [--texture 2048] [--textures 1]
//
// Writes <dir>/model.ug9, <dir>/model.json (the authoring JSON) and the atlas PNG(s),
// and prints the counts of what it made. The character is 600 x 1000 px with its
// feet at the origin. Its "idle" animation (6 s, looping) turns the head (AngleX,
// AngleY, AngleZ), blinks (EyeOpenL/R), breathes (Breath) and sways the body
// (BodyAngleX); two pendulums (physics) swing the hair from the head and body motion.
import fs from 'node:fs';
import path from 'node:path';
import { compileUgo } from '../../tools/compile.mjs';
import { encodePng } from '../../tools/png.mjs';

export function benchModel({ parts: nParts = 80, vertices: nVerts = 4000, params: nParams = 30, warps: nWarps = 12, texture = 2048, textures = 1 } = {}) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

  // parameters: the usual ones first (the idle animation and physics use them), then extra ones
  const named = [['AngleX', -30, 30], ['AngleY', -30, 30], ['AngleZ', -30, 30], ['BodyAngleX', -10, 10], ['Breath', 0, 1],
    ['EyeOpenL', 0, 1, 1], ['EyeOpenR', 0, 1, 1], ['EyeBallX', -1, 1], ['EyeBallY', -1, 1], ['MouthOpen', 0, 1],
    ['BrowY', -1, 1], ['HairSway', -1, 1], ['HairBackSway', -1, 1]];
  const parameters = named.slice(0, Math.min(nParams, named.length)).map(([id, min, max, def = 0]) => ({ id, min, default: def, max }));
  for (let i = parameters.length; i < nParams; i++) parameters.push({ id: `Param${i}`, min: -1, default: 0, max: 1 });
  const ids = parameters.map((p) => p.id);

  // bones: a body, a neck and a head
  const bones = [{ id: 'root' }, { id: 'body', parent: 'root', y: -400 }, { id: 'neck', parent: 'body', y: -200 }, { id: 'head', parent: 'neck', y: -80 }];

  // warp grids: a face grid with smaller grids inside (eyes, mouth, ...), and body grids
  const warps = [];
  const faceRect = [-160, -900, 320, 340];
  if (nWarps > 0) warps.push({ id: 'face', cols: 5, rows: 5, rect: faceRect, bone: 'head' });
  for (let i = 1; i < nWarps; i++) {
    if (i % 3 === 0) warps.push({ id: `body${i}`, cols: 4, rows: 4, rect: [-220 + 40 * (i % 4), -560 + 30 * (i % 5), 280, 360], bone: 'body' });
    else {
      const w = 60 + 40 * rnd(), h = 40 + 30 * rnd();
      warps.push({ id: `w${i}`, cols: 3, rows: 3, rect: [faceRect[0] + rnd() * (faceRect[2] - w), faceRect[1] + rnd() * (faceRect[3] - h), +w.toFixed(1), +h.toFixed(1)], parent: 'face' });
    }
  }

  // parts: grid meshes, about nVerts vertices in all
  const perPart = Math.max(4, nVerts / nParts);
  const parts = [], partVerts = [];
  const pagesPerRow = Math.ceil(Math.sqrt(Math.ceil(nParts / textures))), cell = 1 / pagesPerRow;
  for (let i = 0; i < nParts; i++) {
    const side = Math.max(1, Math.round(Math.sqrt(perPart) - 1)); // (side+1)^2 vertices
    const nx = side, ny = Math.max(1, Math.round(perPart / (side + 1)) - 1);
    const tex = i % textures, k = Math.floor(i / textures);
    const u0 = (k % pagesPerRow) * cell, v0 = Math.floor(k / pagesPerRow) * cell;
    const kind = warps.length ? i % 3 : 2; // 0: in a face grid, 1: in a body grid, 2: on a bone
    let rect, owner;
    if (kind === 0) { const w = warps.filter((x) => x.id === 'face' || x.parent === 'face')[i % Math.max(1, Math.ceil(nWarps * 2 / 3))] ?? warps[0]; rect = w.rect; owner = { warp: w.id }; }
    else if (kind === 1 && warps.some((x) => x.bone === 'body')) { const b = warps.filter((x) => x.bone === 'body'); const w = b[i % b.length]; rect = w.rect; owner = { warp: w.id }; }
    else { rect = [-200 + rnd() * 250, -950 + rnd() * 800, 150, 200]; owner = { bone: i % 2 ? 'head' : 'body' }; }
    const [x, y, w, h] = rect;
    const vertices = [], uvs = [], triangles = [];
    for (let j = 0; j <= ny; j++) for (let q = 0; q <= nx; q++) {
      vertices.push(+(x + 2 + (w - 4) * q / nx).toFixed(2), +(y + 2 + (h - 4) * j / ny).toFixed(2));
      uvs.push(+(u0 + cell * 0.95 * q / nx).toFixed(5), +(v0 + cell * 0.95 * j / ny).toFixed(5));
    }
    for (let j = 0; j < ny; j++) for (let q = 0; q < nx; q++) { const a = j * (nx + 1) + q; triangles.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
    parts.push({ id: `part${i}`, texture: tex, ...owner, vertices, uvs, triangles });
    partVerts.push(vertices.length / 2);
  }

  // deformers: two keys per parameter, each moving a few parts, grids and the head
  const deformers = [];
  ids.forEach((id, a) => {
    const p = parameters[a];
    for (const end of [p.min, p.max]) {
      if (end === p.default) continue;
      const region = { [id]: end < p.default ? [end, end, p.default] : [p.default, end, end] };
      const s = end < p.default ? -1 : 1, morphs = {}, warpsD = {}, bonesD = {};
      for (let k = 0; k < 3; k++) {
        const pi = (a * 7 + k * 13 + (s > 0 ? 3 : 0)) % nParts;
        morphs[`part${pi}`] = { dense: Array.from({ length: partVerts[pi] * 2 }, () => +(s * rnd() * 6).toFixed(2)) };
      }
      for (const w of warps.slice(a % Math.max(1, warps.length), a % Math.max(1, warps.length) + 2)) {
        warpsD[w.id] = { dense: Array.from({ length: (w.cols + 1) * (w.rows + 1) * 2 }, () => +(s * rnd() * 8).toFixed(2)) };
      }
      if (id === 'AngleZ') bonesD.head = { rotation: s * 12 };
      if (id === 'BodyAngleX') bonesD.body = { rotation: s * 4 };
      deformers.push({ region, morphs, ...(Object.keys(warpsD).length ? { warps: warpsD } : {}), ...(Object.keys(bonesD).length ? { bones: bonesD } : {}) });
    }
  });

  const has = (id) => ids.includes(id);
  const physics = [];
  if (has('HairSway')) physics.push({ output: 'HairSway', inputs: { AngleX: 1, AngleZ: 1, BodyAngleX: 2 }, stiffness: 30, damping: 5, gain: 0.12 });
  if (has('HairBackSway')) physics.push({ output: 'HairBackSway', inputs: { AngleX: 0.6, AngleZ: 0.8, BodyAngleX: 2 }, stiffness: 18, damping: 4, gain: 0.1 });
  for (const ph of physics) for (const k of Object.keys(ph.inputs)) if (!has(k)) delete ph.inputs[k];

  const blink = [[0, 1], [2, 1], [2.08, 0], [2.2, 1], [4.6, 1], [4.68, 0], [4.8, 1], [6, 1]];
  const all = {
    AngleX: [[0, 0, 'smooth'], [1.5, 10, 'smooth'], [3, -6, 'smooth'], [4.5, 4, 'smooth'], [6, 0]],
    AngleY: [[0, 0, 'smooth'], [2, -4, 'smooth'], [4, 3, 'smooth'], [6, 0]],
    AngleZ: [[0, 0, 'smooth'], [3, 4, 'smooth'], [6, 0]],
    BodyAngleX: [[0, 0, 'smooth'], [3, 3, 'smooth'], [6, 0]],
    Breath: [[0, 0, 'smooth'], [1.5, 1, 'smooth'], [3, 0, 'smooth'], [4.5, 1, 'smooth'], [6, 0]],
    EyeOpenL: blink, EyeOpenR: blink,
  };
  const tracks = Object.fromEntries(Object.entries(all).filter(([k]) => has(k)));
  return {
    format: 'ugo9', version: '1.0',
    canvas: { width: 600, height: 1000, originX: 300, originY: 980 },
    textures: Array.from({ length: textures }, (_, i) => (textures > 1 ? `atlas${i}.png` : 'atlas.png')),
    parameters, bones, warps, parts, deformers, physics,
    animations: [{ id: 'idle', duration: 6, loop: true, tracks }],
  };
}

// a light texture with soft edges per part cell, so blending and filtering cost what a drawn one would
function atlasPng(size, cells, hue) {
  const px = new Uint8Array(size * size * 4), c = size / cells;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x % c) / c, fy = (y % c) / c, edge = Math.min(fx, fy, 1 - fx, 1 - fy);
    const a = Math.min(1, edge * 12), o = 4 * (y * size + x);
    px[o] = 200 + (hue * 37) % 55; px[o + 1] = 150 + ((x >> 4) & 31); px[o + 2] = 170 + ((y >> 4) & 31); px[o + 3] = Math.round(a * 255);
  }
  return encodePng(size, size, px);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make_model.mjs')) {
  const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => s.trim().split(/\s+/)));
  if (!args.out) { console.error('usage: node engines/bench/make_model.mjs --out <dir> [--parts 80] [--vertices 4000] [--params 30] [--warps 12] [--texture 2048] [--textures 1]'); process.exit(2); }
  const opt = {};
  for (const k of ['parts', 'vertices', 'params', 'warps', 'texture', 'textures']) if (args[k]) opt[k] = +args[k];
  const model = benchModel(opt);
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const bytes = compileUgo(model);
  fs.writeFileSync(path.join(out, 'model.ug9'), new Uint8Array(bytes));
  fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify(model));
  const cells = Math.ceil(Math.sqrt(Math.ceil(model.parts.length / model.textures.length)));
  model.textures.forEach((name, i) => fs.writeFileSync(path.join(out, name), atlasPng(opt.texture ?? 2048, cells, i)));
  let nv = 0, nt = 0;
  for (const p of model.parts) { nv += p.vertices.length / 2; nt += p.triangles.length / 3; }
  console.log(JSON.stringify({ parts: model.parts.length, vertices: nv, triangles: nt, params: model.parameters.length, warps: model.warps.length,
    textures: model.textures.length, textureSize: opt.texture ?? 2048, physics: model.physics.length, ugoBytes: bytes.byteLength, out }));
}
