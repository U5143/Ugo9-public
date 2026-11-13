// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 -> VRM 1.0 (.vrm) for 3D VTuber apps (Warudo, VMagicMirror, ...).
//
//   node tools/export_vrm.mjs model.ug9 out.vrm [options]   (a .ugo, its name before, is read too)
//     --height 1.0        height of the model canvas in metres
//     --name "..."        model name (default: the file name)
//     --author "..."      author (default: "Unknown")
//     --expressions f.json  expression -> parameter values, e.g.
//                         {"blink": {"EyeOpenL": 0, "EyeOpenR": 0}, "aa": {"MouthOpen": 1}}
//     --spring a,b        bones that start a swaying chain (default: bones named like hair/ribbon/tail/skirt)
//
// The character stays a flat sheet facing +Z. VRM apps move it with humanoid
// bones (so turning the head turns the sheet) and with expressions. Each
// expression is baked by running the Ugo9 core with the parameter values
// above; parts that are hidden in that state are collapsed to a point, so
// switching parts (open eye / closed eye) works in every app.
// Arms and legs that a 2D bust-up model does not have are added as unused
// bones, because VRM requires them. Meta defaults are the most restrictive
// ones: set the licence terms you want before sharing the file.

import fs from 'node:fs';
import path from 'node:path';
import { UgoRuntime } from '../web/ugo.js';
import { exportVrm } from './vrm_export.mjs';
import { importUg9 } from './import_ug9.mjs';
import { checkExport } from './check_export.mjs';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--lit'].includes(args[i - 1])));
const [input, output = (files[0] || '').replace(/\.ug(o|9)$/i, '') + '.vrm'] = files;
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
if (!input) {
  console.error('usage: node tools/export_vrm.mjs model.ug9 out.vrm [--height 1.0] [--name n] [--author a] [--expressions f.json] [--spring b1,b2]');
  process.exit(2);
}

const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const ugo = fs.readFileSync(input);
const textures = rt.loadModel(ugo.buffer.slice(ugo.byteOffset, ugo.byteOffset + ugo.byteLength)).textures;
const png = (textures.length ? textures : ['atlas.png']).map((t) => fs.readFileSync(path.join(path.dirname(input), t))); // every atlas page
const expressions = opt('--expressions', null) ? JSON.parse(fs.readFileSync(opt('--expressions', null), 'utf8')) : undefined;
// before writing: what a VRM app does not move (the animations, parameters no expression uses, physics on parameters);
// the rest (masks, blend modes, ...) the exporter says as it writes
try {
  const { json: model } = importUg9(ugo);
  for (const n of checkExport(model, 'vrm', { expressions }).notes) if (['vrmAnimations', 'vrmParamsUnused', 'vrmPhysicsParams'].includes(n.code)) {
    const list = n.vars.names || n.vars.params || [];
    console.warn(`warning: ${n.text} (${list.join(', ')}${n.vars.count > list.length ? ', ...' : ''})`);
  }
} catch { /* a file the importer cannot read back: the exporter says what it can */ }
let out;
try {
  out = exportVrm(rt, ugo, png, { height: opt('--height', 1.0), name: opt('--name', path.basename(input).replace(/\.ug(o|9)$/i, '')), author: opt('--author', 'Unknown'),
    expressions, spring: opt('--spring', null) ?? undefined });
} catch (e) { if (e.code !== 'vrmNoHumanoid') throw e; console.error(e.message); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, out.vrm);
console.log(`${output}: ${out.summary}`);
