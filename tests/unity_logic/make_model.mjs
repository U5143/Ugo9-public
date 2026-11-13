// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The small model tests/unity_logic uses for switching animations: "once" (A 0 -> 1 over 1 s,
// does not loop) and "loop" (A 1 -> 0 -> 1 over 2 s); for layers, "both" (A 0.8 and B 0.6, held) and
// "nudge" (A 0.25, held: added on top it raises A by 0.25).   node tests/unity_logic/make_model.mjs
import fs from 'node:fs';
import { compileUgo, FORMAT_VERSION } from '../../tools/compile.mjs';

const model = {
  format: 'ugo9', version: FORMAT_VERSION,
  canvas: { width: 100, height: 100, originX: 50, originY: 50 },
  parameters: [{ id: 'A', min: 0, default: 0, max: 1 }, { id: 'B', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }],
  parts: [{ id: 'p', vertices: [-10, -10, 10, -10, 10, 10, -10, 10], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  animations: [
    { id: 'once', duration: 1, loop: false, tracks: { A: [[0, 0], [1, 1]] } },
    { id: 'loop', duration: 2, tracks: { A: [[0, 1], [1, 0], [2, 1]] } },
    { id: 'both', duration: 1, tracks: { A: [[0, 0.8], [1, 0.8]], B: [[0, 0.6], [1, 0.6]] } },
    { id: 'nudge', duration: 1, loop: false, tracks: { A: [[0, 0.25], [1, 0.25]] } },
  ],
};
fs.writeFileSync(new URL('./model.ug9', import.meta.url), new Uint8Array(compileUgo(model)));

// std.ug9: the standard look names (HeadTurnX, PupilX, BodyTurnX) next to an older one (AngleX),
// for the helpers: they move the standard ones and leave AngleX alone.
const std = {
  ...model,
  parameters: [
    { id: 'HeadTurnX', min: -30, default: 0, max: 30 }, { id: 'PupilX', min: -1, default: 0, max: 1 },
    { id: 'BodyTurnX', min: -10, default: 0, max: 10 }, { id: 'AngleX', min: -30, default: 0, max: 30 },
  ],
  animations: [],
};
fs.writeFileSync(new URL('./std.ug9', import.meta.url), new Uint8Array(compileUgo(std)));

// rig.ug9: an arm of two bones (reaching), a swaying chain (wind), hit areas ("hit:head", "当たり：body")
const sq = (x0, y0, x1, y1) => ({ vertices: [x0, y0, x1, y0, x1, y1, x0, y1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] });
const rig = {
  format: 'ugo9', version: FORMAT_VERSION,
  canvas: { width: 200, height: 200, originX: 0, originY: 0 },
  bones: [
    { id: 'root' },
    { id: 'arm1', parent: 'root', x: 100, y: 100, length: 40 }, { id: 'arm2', parent: 'arm1', x: 40, length: 40 },
    { id: 'h1', parent: 'root', x: 20, y: 20, rotate: 90, length: 40 }, { id: 'h2', parent: 'h1', x: 40, length: 40 },
  ],
  parts: [
    { id: 'arm', bone: 'arm1', ...sq(100, 98, 180, 102) },
    { id: 'hair', bone: 'h1', vertices: [18, 20, 22, 20, 22, 100, 18, 100], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] },
    { id: '当たり：body', bone: 'root', maskOnly: true, ...sq(0, 0, 100, 100) },
    { id: 'hit:head', bone: 'root', maskOnly: true, ...sq(40, 40, 60, 60) },
  ],
  chains: [{ id: 'hair', bones: ['h1', 'h2'], stiffness: 5, damping: 3, gravity: [0, 300] }],
};
fs.writeFileSync(new URL('./rig.ug9', import.meta.url), new Uint8Array(compileUgo(rig)));
