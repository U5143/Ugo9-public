// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A small model for checking warp grids (format 0.5) in other tools, e.g. the
// glTF / VRM exporters: a face grid on the head bone, an eye grid inside it,
// two-axis regions with a corner correction, a morph inside the nested grid,
// a rotating bone and a bone inside the face grid (a rotation deformer).
//   node tests/warp/make_model.mjs   (writes model.json, model.ug9, atlas.png here)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { compileUgo } from '../../tools/compile.mjs';

const dir = new URL('./', import.meta.url);

// 64 x 64 atlas: a checker in four colours, so bending shows
const S = 64, px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const q = (x < 32 ? 0 : 1) + (y < 32 ? 0 : 2), dark = ((x >> 3) + (y >> 3)) & 1;
  const c = [[230, 190, 160], [90, 120, 200], [250, 250, 250], [200, 80, 90]][q].map((v) => (dark ? v * 0.75 : v) | 0);
  px.set([...c, 255], 4 * (y * S + x));
}
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const td = Buffer.concat([Buffer.from(t), d]), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

// a subdivided rectangle over one quarter of the atlas
const sheet = (x, y, w, h, nx, ny, [u0, v0]) => {
  const vertices = [], uvs = [], triangles = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    vertices.push(+(x + w * i / nx).toFixed(3), +(y + h * j / ny).toFixed(3)); uvs.push(u0 + 0.5 * i / nx, v0 + 0.5 * j / ny);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; triangles.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
  return { vertices, uvs, triangles };
};
// face grid 3 x 3 over the head, eye grid 2 x 1 inside it
const face = { id: 'face', cols: 3, rows: 3, rect: [-60, -230, 120, 120], bone: 'head' };
const eye = { id: 'eye', cols: 2, rows: 1, rect: [-40, -190, 50, 24], parent: 'face' };
const facePoints = 16;
// head turn: inner columns slide toward the turn, the far side squashes
const turnX = (s) => Array.from({ length: facePoints }, (_, k) => { const i = k % 4, j = (k / 4) | 0; return [s * [4, 16, 16, 4][i] * (j === 0 || j === 3 ? 0.6 : 1), 0]; }).flat();
const turnY = (s) => Array.from({ length: facePoints }, (_, k) => { const i = k % 4, j = (k / 4) | 0; return [0, s * [3, 12, 12, 3][j] * (i === 0 || i === 3 ? 0.6 : 1)]; }).flat();
const model = {
  format: 'ugo9', version: '0.6',
  canvas: { width: 256, height: 280, originX: 128, originY: 270 },
  textures: ['atlas.png'],
  parameters: [
    { id: 'AngleX', min: -30, default: 0, max: 30 }, { id: 'AngleY', min: -30, default: 0, max: 30 },
    { id: 'AngleZ', min: -30, default: 0, max: 30 }, { id: 'EyeOpen', min: 0, default: 1, max: 1 },
    { id: 'BrowAngle', min: -1, default: 0, max: 1 },
  ],
  bones: [{ id: 'root' }, { id: 'body', parent: 'root', y: -100 }, { id: 'head', parent: 'body', y: -60 },
    { id: 'brow', warp: 'face', x: 10, y: -200 }], // rides on the face grid and turns with it
  warps: [face, eye],
  parts: [
    { id: 'body', texture: 0, bone: 'body', ...sheet(-40, -110, 80, 100, 2, 2, [0.5, 0.5]) },
    { id: 'face', texture: 0, warp: 'face', ...sheet(-55, -225, 110, 110, 8, 8, [0, 0]) },
    { id: 'eye', texture: 0, warp: 'eye', ...sheet(-36, -186, 42, 16, 6, 2, [0, 0.5]) },
    // sticks out of the face grid on the right: continues straight past the edge
    { id: 'fringe', texture: 0, warp: 'face', ...sheet(-50, -240, 125, 30, 10, 2, [0.5, 0]) },
    { id: 'brow', texture: 0, bone: 'brow', ...sheet(10, -204, 36, 8, 4, 1, [0.5, 0.5]) },
  ],
  deformers: [
    { region: { AngleX: [0, 30, 30] }, warps: { face: { dense: turnX(1) } } },
    { region: { AngleX: [-30, -30, 0] }, warps: { face: { dense: turnX(-1) } } },
    { region: { AngleY: [0, 30, 30] }, warps: { face: { dense: turnY(-1) } } },
    { region: { AngleY: [-30, -30, 0] }, warps: { face: { dense: turnY(1) } } },
    // two-axis corner: the upper outer point pulls in further when turning right and up
    { region: { AngleX: [0, 30, 30], AngleY: [0, 30, 30] }, warps: { face: { points: [3, 2], deltas: [-6, 4, -3, 2] } } },
    { region: { AngleZ: [0, 30, 30] }, bones: { head: { rotation: 12 } } },
    { region: { AngleZ: [-30, -30, 0] }, bones: { head: { rotation: -12 } } },
    { region: { BrowAngle: [0, 1, 1] }, bones: { brow: { rotation: 15 } } },
    { region: { BrowAngle: [-1, -1, 0] }, bones: { brow: { rotation: -15 } } },
    // the eye closes inside its own grid (and bends with the face)
    { region: { EyeOpen: [0, 0, 1] }, warps: { eye: { points: [0, 1, 2], deltas: [0, 10, 0, 12, 0, 10] } },
      morphs: { eye: { dense: Array.from({ length: 21 }, (_, k) => [0, (k / 7 | 0) === 0 ? 6 : 0]).flat() } } },
  ],
  animations: [{
    id: 'look', duration: 4, loop: true,
    tracks: {
      AngleX: [[0, 0, 'smooth'], [1, 30, 'smooth'], [2, 0, 'smooth'], [3, -30, 'smooth'], [4, 0]],
      AngleY: [[0, 0, 'smooth'], [0.5, 20, 'smooth'], [1.5, -20, 'smooth'], [2.5, 30, 'smooth'], [4, 0]],
      AngleZ: [[0, 0, 'smooth'], [2, 15, 'smooth'], [4, 0]],
      EyeOpen: [[0, 1], [1.8, 1], [1.9, 0], [2.0, 1], [4, 1]],
      BrowAngle: [[0, 0, 'smooth'], [1, 1, 'smooth'], [3, -1, 'smooth'], [4, 0]],
    },
  }],
};
fs.writeFileSync(new URL('model.json', dir), JSON.stringify(model, null, 1) + '\n');
fs.writeFileSync(new URL('model.ug9', dir), new Uint8Array(compileUgo(model)));
fs.writeFileSync(new URL('atlas.png', dir), png);
console.log('tests/warp: model.json, model.ug9, atlas.png');
