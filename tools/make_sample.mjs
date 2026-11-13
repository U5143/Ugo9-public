// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Generates the sample character: <out>/atlas.png, <out>/model.json, <out>/model.ug9.
// The art is drawn from simple shapes (a placeholder until real art exists).
//
//   node tools/make_sample.mjs [outDir=samples/basic] [--density N]
//
// --density N subdivides every mesh N times more finely (same look, ~N^2
// vertices) and is used by the benchmarks.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { compileUgo } from './compile.mjs';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) || 'samples/basic';
const di = args.indexOf('--density');
const DENSITY = di >= 0 ? Math.max(1, Number(args[di + 1]) || 1) : 1;

// ---- shapes (signed distance in pixels, negative inside) -----------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ellipse = (cx, cy, rx, ry) => (x, y) => {
  const dx = (x - cx) / rx, dy = (y - cy) / ry, k = Math.hypot(dx, dy);
  if (k < 1e-6) return -Math.min(rx, ry);
  return (k - 1) / Math.hypot(dx / (rx * k), dy / (ry * k));
};
const rrect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const union = (...fs) => (x, y) => Math.min(...fs.map((f) => f(x, y)));
const inter = (...fs) => (x, y) => Math.max(...fs.map((f) => f(x, y)));
const ring = (f, t) => (x, y) => Math.abs(f(x, y)) - t;
const below = (yc) => (x, y) => yc - y; // keeps y > yc (y grows downwards)
const above = (yc) => (x, y) => y - yc;
const strand = (cx, top, bottom, w0, w1) => (x, y) => {
  const t = clamp((y - top) / (bottom - top), 0, 1);
  const hw = lerp(w0, w1, t) * (t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.15) ** 2)) : 1);
  return Math.max(Math.abs(x - cx - 6 * Math.sin(t * 3)) - hw, top - y, y - bottom);
};
const mirror = (f) => (x, y) => f(-x, y);

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
const vgrad = (y0, y1, c0, c1) => (x, y) => { const t = clamp((y - y0) / (y1 - y0), 0, 1); return c0.map((v, i) => lerp(v, c1[i], t)); };

const C = {
  skin: hex('#fde8da'), skinShade: hex('#f4cdb9'), skinLine: hex('#cf917c'),
  hair: hex('#6a4a8c'), hairDark: hex('#3f2b5c'), hairLight: hex('#9c7cc4'),
  white: hex('#ffffff'), lash: hex('#2b1f36'), iris0: hex('#22408f'), iris1: hex('#4f93e6'), pupil: hex('#141833'),
  mouth0: hex('#a8384a'), mouth1: hex('#e0707c'), blush: hex('#f59a9a', 0.45),
  shirt: hex('#f6f7fc'), shirtShade: hex('#dfe3f0'), collar: hex('#2c3a68'), ribbon: hex('#d8485a'),
};

// ---- parts -------------------------------------------------------------
// rect is in model space: [x0, y0, w, h] (origin at the bottom centre, y down).
const HEAD = { x: 0, y: -420 };
const parts = [];
const part = (id, rect, draw, opts = {}) => parts.push({ id, rect, draw, cell: 16, ...opts });

part('hairBack', [-160, -568, 320, 350], (L) => {
  L.fill(union(ellipse(0, -420, 150, 146), rrect(0, -330, 138, 108, 60)), vgrad(-560, -230, C.hair, C.hairDark));
}, { bone: 'hairBackB' });
part('body', [-166, -292, 332, 292], (L) => {
  const torso = rrect(0, -140, 152, 140, 44);
  L.fill(torso, vgrad(-270, 0, C.shirt, C.shirtShade));
  L.fill(inter(torso, union(ellipse(-58, -262, 74, 34), ellipse(58, -262, 74, 34))), C.collar);
  L.fill(union(ellipse(0, -234, 20, 13), ellipse(-14, -216, 9, 20), ellipse(14, -216, 9, 20)), C.ribbon);
}, { bone: 'body' });
part('neck', [-34, -324, 68, 92], (L) => {
  L.fill(rrect(0, -292, 24, 30, 10), vgrad(-320, -296, C.skinShade, C.skin));
}, { bone: 'neck', cell: 12 });
part('face', [-122, -552, 244, 264], (L) => {
  const f = ellipse(0, -420, 110, 121);
  L.fill(f, C.skin);
  L.fill(ellipse(-60, -370, 22, 10), C.blush);
  L.fill(ellipse(60, -370, 22, 10), C.blush);
  L.fill(ellipse(0, -384, 3, 2), C.skinLine);
  L.fill(ring(f, 0.9), C.skinLine);
}, { bone: 'head', color: 'skin' });
for (const side of ['L', 'R']) {
  const s = side === 'L' ? -1 : 1;
  const M = s < 0 ? (f) => f : mirror; // shapes are written for the left side
  part(`eyeWhite${side}`, s < 0 ? [-76, -438, 68, 80] : [8, -438, 68, 80], (L) => {
    const e = ellipse(-42, -398, 26, 30);
    L.fill(M(e), C.white);
    L.fill(M(inter(ring(e, 2.4), above(-392))), C.lash);
    L.fill(M(ring(e, 0.8)), C.skinLine);
  }, { bone: 'head', cell: 8 });
  part(`iris${side}`, s < 0 ? [-66, -418, 48, 52] : [18, -418, 48, 52], (L) => {
    L.fill(M(ellipse(-42, -393, 17, 20)), vgrad(-413, -373, C.iris0, C.iris1));
    L.fill(M(ellipse(-42, -391, 7, 9)), C.pupil);
    L.fill(ellipse(s < 0 ? -48 : 36, -401, 4.5, 5), C.white);
  }, { bone: 'head', cell: 8, mask: [`eyeWhite${side}`] }); // the iris never leaves the eye white
  part(`eyeClosed${side}`, s < 0 ? [-74, -402, 64, 32] : [10, -402, 64, 32], (L) => {
    L.fill(M(inter(ring(ellipse(-42, -398, 26, 20), 1.8), below(-392))), C.lash);
  }, { bone: 'head', cell: 8, opacity: 0 });
}
part('mouth', [-24, -358, 48, 30], (L) => {
  L.fill(ellipse(0, -345, 13, 5), vgrad(-350, -340, C.mouth0, C.mouth1));
}, { bone: 'head', cell: 6 });
for (const side of ['L', 'R']) {
  const s = side === 'L' ? -1 : 1;
  const f = strand(-122, -505, -226, 20, 12);
  part(`hairSide${side}`, s < 0 ? [-152, -510, 60, 290] : [92, -510, 60, 290], (L) => {
    L.fill(s < 0 ? f : mirror(f), vgrad(-470, -230, C.hair, C.hairDark));
  }, {
    cellW: 15, cellH: 10,
    weights: (x, y) => {
      const w2 = smooth(-390, -320, y);
      return [[`hair${side}1`, 1 - w2], [`hair${side}2`, w2]];
    },
  });
}
part('bangs', [-146, -562, 292, 162], (L) => {
  const shape = inter(union(
    ellipse(0, -500, 138, 62),
    ellipse(-96, -470, 30, 46), ellipse(-48, -462, 32, 46), ellipse(0, -468, 30, 42),
    ellipse(48, -462, 32, 46), ellipse(96, -470, 30, 46),
  ), above(-412));
  L.fill(shape, vgrad(-560, -410, C.hairLight, C.hair));
  L.fill(inter(shape, ring(ellipse(0, -505, 110, 40), 3), above(-515)), hex('#b89ad8', 0.7));
}, { bone: 'head' });
for (const side of ['L', 'R']) {
  const s = side === 'L' ? -1 : 1;
  const M = s < 0 ? (f) => f : mirror;
  part(`brow${side}`, s < 0 ? [-70, -452, 56, 26] : [14, -452, 56, 26], (L) => {
    L.fill(M(rrect(-42, -440, 22, 3.5, 3.5)), C.hairDark);
  }, { bone: 'head', cell: 7 });
}

// ---- rasterise parts into an atlas ----------------------------------------
class Layer {
  constructor(rect) {
    this.rect = rect;
    this.w = rect[2]; this.h = rect[3];
    this.px = new Float32Array(this.w * this.h * 4); // premultiplied
  }
  fill(sdf, color) {
    const [x0, y0] = this.rect;
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = x0 + i + 0.5, y = y0 + j + 0.5;
        const cov = clamp(0.5 - sdf(x, y), 0, 1);
        if (cov <= 0) continue;
        const c = typeof color === 'function' ? color(x, y) : color;
        const a = c[3] * cov, k = 4 * (j * this.w + i), p = this.px;
        p[k] = c[0] * a + p[k] * (1 - a);
        p[k + 1] = c[1] * a + p[k + 1] * (1 - a);
        p[k + 2] = c[2] * a + p[k + 2] * (1 - a);
        p[k + 3] = a + p[k + 3] * (1 - a);
      }
    }
  }
  alphaAt(i, j) { return i < 0 || j < 0 || i >= this.w || j >= this.h ? 0 : this.px[4 * (j * this.w + i) + 3]; }
}
for (const p of parts) { p.layer = new Layer(p.rect); p.draw(p.layer); }

const PAD = 2, ATLAS_W = 1024;
let cx = PAD, cy = PAD, rowH = 0;
for (const p of [...parts].sort((a, b) => b.rect[3] - a.rect[3])) {
  if (cx + p.rect[2] + PAD > ATLAS_W) { cx = PAD; cy += rowH + PAD; rowH = 0; }
  p.atlas = [cx, cy];
  cx += p.rect[2] + PAD;
  rowH = Math.max(rowH, p.rect[3]);
}
let ATLAS_H = 64;
while (ATLAS_H < cy + rowH + PAD) ATLAS_H *= 2;
const atlas = new Uint8Array(ATLAS_W * ATLAS_H * 4);
for (const p of parts) {
  const L = p.layer;
  for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
    const s = 4 * (j * L.w + i), d = 4 * ((p.atlas[1] + j) * ATLAS_W + p.atlas[0] + i);
    const a = L.px[s + 3];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) atlas[d + c] = Math.round(clamp(L.px[s + c] / a, 0, 1) * 255);
    atlas[d + 3] = Math.round(a * 255);
  }
}

// ---- meshes: a grid over each part, keeping only cells that hold pixels -----
for (const p of parts) {
  const [x0, y0, w, h] = p.rect;
  const cw = (p.cellW || p.cell) / DENSITY, ch = (p.cellH || p.cell) / DENSITY;
  const nx = Math.ceil(w / cw), ny = Math.ceil(h / ch);
  const L = p.layer;
  const used = new Map();
  const verts = [], uvs = [], tris = [];
  const vid = (i, j) => {
    const key = j * (nx + 1) + i;
    if (!used.has(key)) {
      const x = x0 + (w * i) / nx, y = y0 + (h * j) / ny;
      used.set(key, verts.length / 2);
      verts.push(+x.toFixed(3), +y.toFixed(3));
      uvs.push((p.atlas[0] + (x - x0)) / ATLAS_W, (p.atlas[1] + (y - y0)) / ATLAS_H);
    }
    return used.get(key);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const ia = Math.floor((w * i) / nx) - 1, ib = Math.ceil((w * (i + 1)) / nx) + 1;
    const ja = Math.floor((h * j) / ny) - 1, jb = Math.ceil((h * (j + 1)) / ny) + 1;
    let any = false;
    for (let jj = ja; jj < jb && !any; jj++) for (let ii = ia; ii < ib; ii++) if (L.alphaAt(ii, jj) > 0) { any = true; break; }
    if (!any) continue;
    const a = vid(i, j), b = vid(i + 1, j), c = vid(i, j + 1), d = vid(i + 1, j + 1);
    if ((i + j) % 2) tris.push(a, b, d, a, d, c); else tris.push(a, b, c, b, d, c);
  }
  p.mesh = { verts, uvs, tris };
}

// ---- deformations -----------------------------------------------------------
const DEGR = Math.PI / 180;
const FEATURES = ['eyeWhiteL', 'irisL', 'eyeClosedL', 'browL', 'eyeWhiteR', 'irisR', 'eyeClosedR', 'browR', 'mouth'];
// how far each head part sits in front of (+) or behind (-) the head's centre, in px
const DEPTH_X = { face: 30, bangs: 62, hairBack: -34, ...Object.fromEntries(FEATURES.map((f) => [f, 48])) };
const DEPTH_Y = { face: 18, bangs: 44, hairBack: -26, ...Object.fromEntries(FEATURES.map((f) => [f, 34])) };
const SIDE_SHIFT = { hairSideL: 1, hairSideR: 1 };

const morphFor = (ids, fn) => {
  const out = {};
  for (const id of ids) {
    const p = parts.find((q) => q.id === id);
    const dense = [];
    for (let i = 0; i < p.mesh.verts.length; i += 2) {
      const [dx, dy] = fn(p.mesh.verts[i], p.mesh.verts[i + 1], id);
      dense.push(+dx.toFixed(3), +dy.toFixed(3));
    }
    out[id] = { dense };
  }
  return out;
};
// head turn: points move by sin(angle) * depth * sqrt(1 - u^2) (an ellipsoid seen from the front)
const turnX = (deg) => (x, y, id) => {
  if (SIDE_SHIFT[id]) return [Math.sin(deg * DEGR) * 22, 0];
  const u = clamp((x - HEAD.x) / 125, -1, 1);
  return [Math.sin(deg * DEGR) * DEPTH_X[id] * Math.sqrt(1 - u * u), 0];
};
const turnY = (deg) => (x, y, id) => {
  if (SIDE_SHIFT[id]) return [0, -Math.sin(deg * DEGR) * 14];
  const v = clamp((y - HEAD.y) / 135, -1, 1);
  return [0, -Math.sin(deg * DEGR) * DEPTH_Y[id] * Math.sqrt(1 - v * v)];
};
const headParts = ['hairBack', 'face', ...FEATURES, 'hairSideL', 'hairSideR', 'bangs'];

const deformers = [
  { region: { HeadTurnX: [0, 30, 30] }, morphs: morphFor(headParts, turnX(30)) },
  { region: { HeadTurnX: [-30, -30, 0] }, morphs: morphFor(headParts, turnX(-30)) },
  { region: { HeadTurnY: [0, 30, 30] }, morphs: morphFor(headParts, turnY(30)) },
  { region: { HeadTurnY: [-30, -30, 0] }, morphs: morphFor(headParts, turnY(-30)) },
  { region: { HeadTilt: [0, 30, 30] }, bones: { head: { rotation: 10 } } },
  { region: { HeadTilt: [-30, -30, 0] }, bones: { head: { rotation: -10 } } },
  { region: { BodyTurnX: [0, 10, 10] }, bones: { body: { rotation: 5 }, neck: { rotation: -2 } } },
  { region: { BodyTurnX: [-10, -10, 0] }, bones: { body: { rotation: -5 }, neck: { rotation: 2 } } },
  { region: { Breath: [0, 1, 1] }, bones: { body: { scaleY: 0.012 }, neck: { y: -1.5 } } },
  { region: { BrowY: [0, 1, 1] }, morphs: morphFor(['browL', 'browR'], () => [0, -7]) },
  { region: { BrowY: [-1, -1, 0] }, morphs: morphFor(['browL', 'browR'], () => [0, 5]) },
  { region: { PupilX: [0, 1, 1] }, morphs: morphFor(['irisL', 'irisR'], () => [12, 0]) },
  { region: { PupilX: [-1, -1, 0] }, morphs: morphFor(['irisL', 'irisR'], () => [-12, 0]) },
  { region: { PupilY: [0, 1, 1] }, morphs: morphFor(['irisL', 'irisR'], () => [0, -8]) },
  { region: { PupilY: [-1, -1, 0] }, morphs: morphFor(['irisL', 'irisR'], () => [0, 7]) },
  { region: { MouthOpen: [0, 1, 1] }, morphs: morphFor(['mouth'], (x, y) => [-0.2 * x, 2.2 * (y + 350)]) },
  { region: { HairSideSway: [-1, -1, 0] }, bones: { hairL1: { rotation: 8 }, hairL2: { rotation: 12 }, hairR1: { rotation: 8 }, hairR2: { rotation: 12 } } },
  { region: { HairSideSway: [0, 1, 1] }, bones: { hairL1: { rotation: -8 }, hairL2: { rotation: -12 }, hairR1: { rotation: -8 }, hairR2: { rotation: -12 } } },
  { region: { HairBackSway: [-1, -1, 0] }, bones: { hairBackB: { rotation: 2.5 } } },
  { region: { HairBackSway: [0, 1, 1] }, bones: { hairBackB: { rotation: -2.5 } } },
  // face colour (multiply / screen colour on the skin): 1 flushes, -1 goes pale
  { region: { FaceColor: [0, 1, 1] }, colors: { skin: { multiply: [0, -0.12, -0.1], screen: [0.18, 0.02, 0.04] } } },
  { region: { FaceColor: [-1, -1, 0] }, colors: { skin: { multiply: [-0.12, -0.04, 0], screen: [0.05, 0.1, 0.16] } } },
];
for (const side of ['L', 'R']) {
  // closing: the eye flattens onto its lower lid; the open eye fades out at the very end
  deformers.push({
    region: { [`EyeOpen${side}`]: [0, 0, 1] },
    morphs: morphFor([`eyeWhite${side}`, `iris${side}`], (x, y) => [0, (-384 - y) * 0.95]),
  });
  deformers.push({
    region: { [`EyeOpen${side}`]: [0, 0, 0.35] },
    opacity: { [`eyeWhite${side}`]: -1, [`iris${side}`]: -1, [`eyeClosed${side}`]: 1 },
  });
}

// ---- model --------------------------------------------------------------------
const model = {
  format: 'ugo9',
  version: '0.1',
  canvas: { width: 420, height: 600, originX: 210, originY: 590 },
  textures: ['atlas.png'],
  parameters: [
    { id: 'HeadTurnX', min: -30, default: 0, max: 30 },
    { id: 'HeadTurnY', min: -30, default: 0, max: 30 },
    { id: 'HeadTilt', min: -30, default: 0, max: 30 },
    { id: 'EyeOpenL', min: 0, default: 1, max: 1 },
    { id: 'EyeOpenR', min: 0, default: 1, max: 1 },
    { id: 'PupilX', min: -1, default: 0, max: 1 },
    { id: 'PupilY', min: -1, default: 0, max: 1 },
    { id: 'BrowY', min: -1, default: 0, max: 1 },
    { id: 'MouthOpen', min: 0, default: 0, max: 1 },
    { id: 'BodyTurnX', min: -10, default: 0, max: 10 },
    { id: 'Breath', min: 0, default: 0, max: 1 },
    { id: 'HairSideSway', min: -1, default: 0, max: 1 },
    { id: 'HairBackSway', min: -1, default: 0, max: 1 },
    { id: 'FaceColor', min: -1, default: 0, max: 1 },
  ],
  colors: [{ id: 'skin', multiply: [1, 1, 1], screen: [0, 0, 0] }],
  bones: [
    { id: 'root' },
    { id: 'body', parent: 'root', y: -120 },
    { id: 'neck', parent: 'body', y: -150 },
    { id: 'head', parent: 'neck', y: -30 },
    { id: 'hairBackB', parent: 'head', y: -180 },
    { id: 'hairL1', parent: 'head', x: -122, y: -160 },
    { id: 'hairL2', parent: 'hairL1', y: 115 },
    { id: 'hairR1', parent: 'head', x: 122, y: -160 },
    { id: 'hairR2', parent: 'hairR1', y: 115 },
  ],
  parts: parts.map((p) => {
    const out = {
      id: p.id, texture: 0, opacity: p.opacity ?? 1,
      vertices: p.mesh.verts, uvs: p.mesh.uvs.map((v) => +v.toFixed(6)), triangles: p.mesh.tris,
    };
    if (p.mask) out.mask = p.mask;
    if (p.color) out.color = p.color;
    if (p.weights) {
      out.weights = [];
      for (let i = 0; i < p.mesh.verts.length; i += 2) out.weights.push(p.weights(p.mesh.verts[i], p.mesh.verts[i + 1]).map(([b, w]) => [b, +w.toFixed(4)]));
    } else out.bone = p.bone;
    return out;
  }),
  deformers,
  physics: [
    { output: 'HairSideSway', inputs: { HeadTurnX: 1, HeadTilt: 1, BodyTurnX: 2 }, stiffness: 30, damping: 5, gain: 0.12 },
    { output: 'HairBackSway', inputs: { HeadTurnX: 0.6, HeadTilt: 0.8, BodyTurnX: 2 }, stiffness: 18, damping: 4, gain: 0.1 },
  ],
  animations: [
    {
      id: 'idle', duration: 6, loop: true,
      tracks: {
        HeadTurnX: [[0, 0, 'smooth'], [1.5, 10, 'smooth'], [3, -6, 'smooth'], [4.5, 4, 'smooth'], [6, 0]],
        HeadTurnY: [[0, 0, 'smooth'], [2, -4, 'smooth'], [4, 3, 'smooth'], [6, 0]],
        HeadTilt: [[0, 0, 'smooth'], [3, 4, 'smooth'], [6, 0]],
        BodyTurnX: [[0, 0, 'smooth'], [3, 3, 'smooth'], [6, 0]],
        Breath: [[0, 0, 'smooth'], [1.5, 1, 'smooth'], [3, 0, 'smooth'], [4.5, 1, 'smooth'], [6, 0]],
        PupilX: [[0, 0, 'smooth'], [1.5, 0.4, 'smooth'], [3, -0.3, 'smooth'], [6, 0]],
        EyeOpenL: [[0, 1], [2.0, 1], [2.08, 0], [2.2, 1], [4.6, 1], [4.68, 0], [4.8, 1], [6, 1]],
        EyeOpenR: [[0, 1], [2.0, 1], [2.08, 0], [2.2, 1], [4.6, 1], [4.68, 0], [4.8, 1], [6, 1]],
      },
    },
    {
      id: 'talk', duration: 2, loop: true,
      tracks: {
        MouthOpen: [[0, 0, 'smooth'], [0.15, 0.8, 'smooth'], [0.3, 0.2, 'smooth'], [0.45, 1, 'smooth'], [0.65, 0.1, 'smooth'],
          [0.8, 0.7, 'smooth'], [1.0, 0, 'smooth'], [1.3, 0.9, 'smooth'], [1.5, 0.3, 'smooth'], [1.7, 0.6, 'smooth'], [2, 0]],
        HeadTurnY: [[0, 0, 'smooth'], [0.5, -3, 'smooth'], [1, 1, 'smooth'], [1.5, -2, 'smooth'], [2, 0]],
        BrowY: [[0, 0, 'smooth'], [0.5, 0.6, 'smooth'], [1.4, 0, 'smooth'], [2, 0]],
      },
    },
  ],
};

// ---- write --------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'atlas.png'), encodePNG(ATLAS_W, ATLAS_H, atlas));
fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
const bin = compileUgo(model);
fs.writeFileSync(path.join(outDir, 'model.ug9'), new Uint8Array(bin));
const nv = parts.reduce((s, p) => s + p.mesh.verts.length / 2, 0);
const nt = parts.reduce((s, p) => s + p.mesh.tris.length / 3, 0);
console.log(`${outDir}: ${parts.length} parts, ${nv} vertices, ${nt} triangles, atlas ${ATLAS_W}x${ATLAS_H}, model.ug9 ${bin.byteLength} bytes`);
