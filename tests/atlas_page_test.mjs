// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The atlas pages' sizes (atlasPage in tools/import_psd.mjs, 機能の比べ #16、利用者の声 #56): 'pow2' gives each side a
// power of two, 'square' a power-of-two square; the pictures stay where they were, so each part's points take the same
// atlas pixels as with 'tight' (the default, unchanged); padding sets the gap; the command line takes them.
//   node tests/atlas_page_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { importPsd } from '../tools/import_psd.mjs';
import { writePsd } from './psd/make_big.mjs';
import { decodePng } from '../tools/png.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const grad = (seed) => (x, y) => [(x * 37 + seed * 11) & 255, (y * 23 + seed * 7) & 255, ((x + y) * 13 + seed) & 255, 255];
const layers = [
  { name: 'wide', left: 10, top: 10, width: 150, height: 30, pixel: grad(1) },
  { name: 'tall', left: 170, top: 20, width: 24, height: 130, pixel: grad(2) },
  { name: 'dot', left: 60, top: 80, width: 40, height: 37, pixel: grad(3) },
];
const psd = writePsd(220, 170, layers, { composite: () => [255, 255, 255] });
const read = (o) => importPsd(psd, { inflate, keepPixels: false, ...o });
const isPow2 = (n) => Number.isInteger(Math.log2(n));

const tight = read({}), again = read({ atlasPage: 'tight' }), p2 = read({ atlasPage: 'pow2' }), sq = read({ atlasPage: 'square' });
check(JSON.stringify(tight.model) === JSON.stringify(again.model) && Buffer.compare(Buffer.from(tight.atlases[0].rgba), Buffer.from(again.atlases[0].rgba)) === 0,
  `'tight' is the default, as before (${tight.atlases[0].width}×${tight.atlases[0].height})`);
const A = (r) => r.atlases[0];
check(isPow2(A(p2).width) && isPow2(A(p2).height) && A(p2).height >= A(tight).height && !(isPow2(A(tight).height)),
  `'pow2': ${A(tight).width}×${A(tight).height} → ${A(p2).width}×${A(p2).height}`);
check(A(sq).width === A(sq).height && isPow2(A(sq).width) && A(sq).width >= Math.max(A(p2).width, A(p2).height), `'square': ${A(sq).width}×${A(sq).height}`);
// each point's atlas pixel: the same colour on every page size (the pictures did not move, the UVs follow the size)
const pixelAt = (r, part, i) => { const a = A(r), u = part.uvs[2 * i], v = part.uvs[2 * i + 1]; const x = Math.min(a.width - 1, Math.floor(u * a.width)), y = Math.min(a.height - 1, Math.floor(v * a.height)); return [...a.rgba.subarray((y * a.width + x) * 4, (y * a.width + x) * 4 + 4)].join(); };
let differ = 0, n = 0;
for (const r of [p2, sq]) r.model.parts.forEach((part, k) => { for (let i = 0; i < part.uvs.length / 2; i++) { n++; if (pixelAt(r, part, i) !== pixelAt(tight, tight.model.parts[k], i)) differ++; } });
check(differ === 0 && n > 20 && JSON.stringify(p2.layers.map((l) => [l.atlas.x, l.atlas.y])) === JSON.stringify(tight.layers.map((l) => [l.atlas.x, l.atlas.y])),
  `the pictures stay where they were: every point (${n}) takes the same atlas pixel; only the UVs follow the page size`);
const wide = read({ padding: 6 });
check(A(wide).width * A(wide).height > A(tight).width * A(tight).height && wide.layers.every((l) => l.atlas.x >= 6 && l.atlas.y >= 6), 'padding 6: a wider gap (every picture 6 px or more from the page\'s edge)');
check(read({ atlasPage: 'huge' }).notes.some((x) => x.code === 'atlasPageUnknown'), 'an unknown atlasPage: tight, with a note');

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlaspage-'));
fs.writeFileSync(path.join(dir, 'p.psd'), psd);
execFileSync('node', ['tools/import_psd.mjs', path.join(dir, 'p.psd'), path.join(dir, 'out'), '--atlas-page', 'square', '--padding', '4'], { encoding: 'utf8' });
const png = decodePng(fs.readFileSync(path.join(dir, 'out', 'atlas.png')));
check(png.width === png.height && isPow2(png.width), `command line: --atlas-page square --padding 4 → ${png.width}×${png.height}`);
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall atlas page checks passed');
process.exit(failures ? 1 : 0);
