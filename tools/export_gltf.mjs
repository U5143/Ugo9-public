// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Converts a .ug9 model (or a .ugo, its name before) into glTF 2.0 binary (.glb), to test how far a
// standard 3D format can carry an Ugo9 character (see docs/検証_glTF.md).
//
//   node tools/export_gltf.mjs model.ug9 [out.glb] [options]
//     --fps 30          animation sampling rate
//     --height 1.6      character height in metres (the model canvas's height);
//                       default 1 px = 1 cm
//     --lit             let scene lights shade it (default: unlit, like 2D art)
//     --depth 0.002     spread parts towards the camera by this many metres per
//                       part, for a little parallax when the camera moves
//     --billboard       mark the character to turn to face the camera (glTF has
//                       no billboard; engines read extras.ugo9.billboard)
//     --flat            bake every bone's world matrix (automatic when the skeleton uses
//                       IK / transform constraints, shear or non-normal inheritance)
//
// What it writes:
// - one skinned mesh (parts in draw order, one material, unlit, alpha blend)
// - bones as nodes (2D, y flipped to glTF's y-up, 1 px = 1 cm). A skeleton that plain
//   parent-child nodes cannot carry (constraints, shear, inheritance modes) is written
//   "flat": every bone is two nodes under one root, "bone:basis" (translation,
//   rotation, scale) and "bone" (rotation, scale ±1), so the pair can hold any 2D affine
//   world matrix (polar + eigen decomposition), and each frame's world matrix is baked
// - every Ugo9 morph as a sparse morph target (blend shape)
// - parts whose opacity changes get their own "visibility" bone that is
//   scaled to (almost) zero to hide them: glTF has no portable opacity
//   animation, and bone scale works in every engine. (Collapsing parts with
//   a morph target leaves slivers once other morphs add their deltas.)
// - each Ugo9 animation baked at --fps: bone TRS + all morph weights
// What it cannot write: the parameter logic (regions, physics) itself.

import fs from 'node:fs';
import path from 'node:path';
import { UgoRuntime } from '../web/ugo.js';
import { exportGlb } from './gltf_export.mjs';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const output = args.filter((a) => !a.startsWith('--'))[1] || (input || '').replace(/\.ug(o|9)$/i, '') + '.glb';
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
if (!input) {
  console.error('usage: node tools/export_gltf.mjs model.ug9 [out.glb] [--fps 30] [--height m] [--lit] [--depth m] [--billboard]');
  process.exit(2);
}

const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const ugo = fs.readFileSync(input);
const textures = rt.loadModel(ugo.buffer.slice(ugo.byteOffset, ugo.byteOffset + ugo.byteLength)).textures;
const png = (textures.length ? textures : ['atlas.png']).map((t) => fs.readFileSync(path.join(path.dirname(input), t))); // every atlas page
const { glb, summary } = exportGlb(rt, ugo, png, { fps: opt('--fps', 30), height: opt('--height', 0), depth: opt('--depth', 0), lit: args.includes('--lit'), billboard: args.includes('--billboard'), flat: args.includes('--flat') });
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, glb);
console.log(`${output}: ${summary}`);
