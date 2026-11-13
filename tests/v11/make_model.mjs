// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A small .ug9 of format 1.1: its tracks and keys in tables 41-43, with curve keys (Bezier segments) on a
// parameter, a bone and a colour-less part's opacity, a track without keys, a smooth track and a step.
// Made by compiling the model as 1.0 (compileUgo's curveKeys: false) and rewriting its tracks with the
// curves below (tools/curve_keys.mjs toCurveFile): the curves are given in key units, as the core reads them. For the engines' tests, tests/curve_keys_test.mjs, and the core's
// corrupted-file runs (CMakeLists.txt).
//   node tests/v11/make_model.mjs   -> tests/v11/model.ug9
import fs from 'node:fs';
import { compileUgo } from '../../tools/compile.mjs';
import { toCurveFile } from '../../tools/curve_keys.mjs';

const quad = [-10, -10, 10, -10, 10, 10, -10, 10];
export const SOURCE = {
  format: 'ugo9', canvas: { width: 100, height: 100, originX: 50, originY: 50 }, textures: ['t.png'],
  parameters: [{ id: 'A', min: 0, default: 0, max: 1 }, { id: 'B', min: -10, default: 0, max: 10 }, { id: 'C', min: 0, default: 0, max: 1 },
    { id: 'D', min: 0, default: 0, max: 1 }, { id: 'E', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 10 }],
  parts: [{ id: 'p', bone: 'arm', vertices: quad, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  animations: [
    { id: 'wave', duration: 2, loop: true,
      tracks: { A: [[0, 0], [1, 1], [2, 0]], B: [[0, -10], [0.5, 10], [2, -10]], C: [[0, 0.5], [2, 0.5]],
        D: [[0, 0, 'smooth'], [2, 1]], E: [[0, 0, 'step'], [1, 1], [2, 0]] },
      bones: { arm: { rotate: [[0, 0], [1, 90], [2, 0]] } },
      opacity: { p: [[0, 1], [2, 0]] } },
    { id: 'plain', duration: 1, tracks: { A: [[0, 1], [1, 0]] } },
  ],
};

// curves by target: [kind, index, key within the track, n, cx1, cy1, cx2, cy2] (cx 0..65535 of the segment's time, cy in key units)
export const CURVES = [
  ['param', 0, 0, 16, 27525, 0, 38010, 65535],        // A 0 -> 1: ease in and out
  ['param', 0, 1, 8, 0, 65535, 65535, 0],              // A 1 -> 0: holds, then drops late
  ['param', 1, 0, 24, 65535, 0, 0, 65535],             // B: fast at both ends
  ['rotate', 1, 1, 256, 10000, 65535, 20000, 0],       // the arm: many pieces
  ['opacity', 0, 0, 2, 21845, 65535, 43690, 65535],    // opacity: two pieces
];
const KIND = { param: 0, rotate: 1, opacity: 6 };

export function build() {
  const v10 = compileUgo(SOURCE, { curveKeys: false });
  const dv = new DataView(v10), hs = dv.getUint32(12, true), n = dv.getUint32(32, true);
  let tracks = null;
  for (let i = 0; i < n; i++) if (dv.getUint32(hs + 16 * i, true) === 21) tracks = [dv.getUint32(hs + 16 * i + 4, true), dv.getUint32(hs + 16 * i + 8, true)];
  const targets = Array.from({ length: tracks[1] }, (_, i) => dv.getUint32(tracks[0] + 20 * i, true));
  const curves = CURVES.map(([kind, index, key, pieces, cx1, cy1, cx2, cy2]) => {
    const track = targets.indexOf((KIND[kind] * 0x1000000 + index) >>> 0);
    if (track < 0) throw new Error(`no ${kind} track ${index}`);
    return { track, key, n: pieces, cx1, cy1, cx2, cy2 };
  });
  return { v10, v11: toCurveFile(v10, curves) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('./model.ug9', import.meta.url);
  fs.writeFileSync(out, build().v11);
  console.log(`${out.pathname}: ${fs.statSync(out).size} bytes`);
}
