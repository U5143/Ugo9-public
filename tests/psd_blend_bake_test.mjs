// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Clipped layers in blend modes Ugo9 does not draw are painted into their base at import
// (tools/import_psd.mjs, tools/blend_modes.mjs). Where Python's psd-tools is installed, its own
// drawing of the base and those clipped layers (Photoshop's way) is the reference: the baked base
// must match it. Clipped layers in the runtime's own modes above the last baked one stay parts; a
// base with only those is left as it is.
//   node tests/psd_blend_bake_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importPsd } from '../tools/import_psd.mjs';
import { writePsd } from './psd/make_big.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'psd_blend_bake');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const psdTools = (() => { try { execFileSync('python3', ['-c', 'import psd_tools'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const W = 96, H = 80;
const layer = (name, left, top, w, h, f, more = {}) => ({ name, left, top, width: w, height: h, pixel: f, ...more });
// the base: a soft-edged disc in a colour gradient; clipped: stripes and gradients in many modes
const base = layer('skin', 8, 6, 70, 64, (x, y) => { const d = Math.hypot(x - 35, y - 32); return [200 + (x % 40), 150 + (y % 50), 120 + ((x + y) % 60), d < 26 ? 255 : d < 30 ? Math.round((30 - d) * 60) : 0]; });
const clip = (name, key, f, more = {}) => layer(name, 0, 0, W, H, f, { clipping: true, blend: key, ...more });
const MODES = [
  ['shade', 'mul ', (x, y) => [120, 90, 160, x > 40 ? 255 : 0]],
  ['light', 'over', (x, y) => [255, 230, 150, (x + y) % 20 < 10 ? 255 : 90], { opacity: 200 }],
  ['soft', 'sLit', (x, y) => [x * 2, 128, 255 - y * 2, 255], { opacity: 180 }],
  ['glow', 'div ', (x, y) => [180, 120, 60, y < 30 ? 255 : 0]],
  ['tint', 'hue ', (x, y) => [40, 160, 220, x < 50 ? 255 : 0], { opacity: 150 }],
  ['diff', 'diff', (x, y) => [60, 60, 200, y > 50 ? 255 : 0]],
  ['rim', 'scrn', (x, y) => [80, 80, 120, x > 60 ? 255 : 0]], // the runtime's own mode, above the last baked one: stays a part
];
const layers = [base, ...MODES.map(([n, k, f, m]) => clip(n, k, f, m)),
  layer('cloth', 30, 50, 40, 25, () => [60, 90, 200, 255]), clip('cloth shade', 'mul ', (x, y) => [100, 100, 100, x > 50 ? 255 : 0])];
const bytes = writePsd(W, H, layers, { composite: () => [255, 255, 255] });
const file = path.join(OUT, 'clips.psd');
fs.writeFileSync(file, bytes);

const res = importPsd(bytes, { inflate, keepPixels: true }), names = res.layers.map((l) => l.name);
const notes = res.notes.filter((n) => n.code === 'layerBlendBaked');
check(names.join() === 'skin,rim,cloth,cloth shade' && notes.map((n) => n.vars.layer).join() === 'shade,light,soft,glow,tint,diff' && notes.every((n) => n.level === 'info' && n.vars.base === 'skin'),
  `the six clipped layers up to the last one in a mode Ugo9 lacks are painted into skin (layerBlendBaked: ${notes.map((n) => `${n.vars.layer} ${n.vars.blend}`).join(', ')}); rim (screen, above them) and cloth's multiply stay parts`);
check(!res.notes.some((n) => n.code === 'layerBlend'), 'no layerBlend warnings left (nothing drawn as normal by mistake)');
const part = (id) => res.model.parts.find((p) => p.id === id);
check(part('rim').mask?.[0] === 'skin' && part('rim').blend === 'screen' && part('cloth shade').mask?.[0] === 'cloth', 'rim is still clipped to skin in screen; cloth shade to cloth');
const off = importPsd(bytes, { inflate, bakeBlends: false });
check(off.layers.length === 10 && off.notes.filter((n) => n.code === 'layerBlend').length === 5, `bakeBlends: false: as before (10 parts, ${off.notes.filter((n) => n.code === 'layerBlend').length} drawn as normal with a warning)`);

if (psdTools) {
  // psd-tools' drawing of skin and the six clipped layers only
  const py = `
import sys, json
import numpy as np
from psd_tools import PSDImage
p = PSDImage.open(sys.argv[1])
keep = set(sys.argv[2].split(','))
im = p.composite(force=True, layer_filter=lambda l: l.name in keep)
print(json.dumps(np.asarray(im.convert('RGBA')).astype(int).ravel().tolist()))`;
  const ref = JSON.parse(execFileSync('python3', ['-c', py, file, 'skin,shade,light,soft,glow,tint,diff'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const L = res.layers.find((l) => l.name === 'skin');
  let worstA = 0, worstC = 0, over3 = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lx = x - L.left, ly = y - L.top, i = (y * W + x) * 4;
    const ours = lx >= 0 && ly >= 0 && lx < L.width && ly < L.height ? [...L.rgba.subarray((ly * L.width + lx) * 4, (ly * L.width + lx) * 4 + 4)] : [0, 0, 0, 0];
    worstA = Math.max(worstA, Math.abs(ours[3] - ref[i + 3]));
    if (ours[3] > 8 && ref[i + 3] > 8) { const d = Math.max(...[0, 1, 2].map((k) => Math.abs(ours[k] - ref[i + k]))); worstC = Math.max(worstC, d); if (d > 3) over3++; n++; }
  }
  check(worstA <= 1 && worstC <= 3, `skin with its clipped layers painted in matches psd-tools' drawing of them (alpha ±${worstA}, colour ±${worstC}, ${over3} of ${n} pixels over 3)`);
} else console.log('     (psd-tools is not installed: the comparison with its drawing is skipped; pip install psd-tools)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall blend bake checks passed');
process.exit(failures ? 1 : 0);
