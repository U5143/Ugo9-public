// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export --nearest (pixel art, 利用者の声 #54): a 4×4 checker drawn 8 times bigger keeps its
// dots (each 8×8 block one texel's colour), with --ss 1 and with the default --ss 2; without it the
// colours blend; the preset's "sampling" does the same as the option.
//   node tests/export_nearest_test.mjs        (needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileUgo } from '../tools/compile.mjs';
import { encodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_nearest_test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = findExporter();

// a 4×4 texture of strong, different colours, on one square part that fills the 4×4 canvas
const texel = (x, y) => [(x * 70 + 20) & 255, (y * 80 + 10) & 255, ((x + y) % 2) * 200 + 30, 255];
const tex = new Uint8Array(64);
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) tex.set(texel(x, y), (y * 4 + x) * 4);
fs.writeFileSync(path.join(OUT, 'dots.png'), encodePng(4, 4, tex));
const model = {
  format: 'ugo9', canvas: { width: 4, height: 4, originX: 0, originY: 0 }, textures: ['dots.png'],
  parts: [{ id: 'dots', vertices: [0, 0, 4, 0, 4, 4, 0, 4], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
};
const MODEL = path.join(OUT, 'dots.ug9');
fs.writeFileSync(MODEL, new Uint8Array(compileUgo(model)));

let n = 0;
const draw = (args) => {
  const out = path.join(OUT, `d${n++}.rgba`);
  execFileSync(exe, [MODEL, '--frames', '1', '--size', '32x32', ...args, '--format', 'raw', '--out', out], { stdio: 'ignore' });
  return fs.readFileSync(out);
};
// how many of the 32×32 pixels are not exactly the colour of their texel
const offDots = (img) => {
  let off = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const want = texel(x >> 3, y >> 3), i = (y * 32 + x) * 4;
    if (want.some((v, k) => img[i + k] !== v)) off++;
  }
  return off;
};

const sharp1 = draw(['--nearest', '--ss', '1']), sharp2 = draw(['--nearest']), soft = draw(['--ss', '1']);
check(offDots(sharp1) === 0, `--nearest --ss 1: every 8×8 block is exactly its texel's colour (${offDots(sharp1)} of 1024 px off)`);
check(offDots(sharp2) === 0, `--nearest with the default --ss 2: the same (${offDots(sharp2)} px off; the blocks line up with the pixels)`);
check(offDots(soft) > 300, `without --nearest the colours blend between the dots (${offDots(soft)} of 1024 px not a texel's colour)`);

const preset = (obj) => { const f = path.join(OUT, `p${n++}.json`); fs.writeFileSync(f, JSON.stringify({ ugo9ExportPreset: 1, ...obj })); return f; };
check(Buffer.compare(draw(['--preset', preset({ sampling: 'nearest' }), '--ss', '1']), sharp1) === 0, 'a preset with "sampling": "nearest" gives the same bytes as --nearest');
check(Buffer.compare(draw(['--preset', preset({ sampling: 'linear' }), '--ss', '1']), soft) === 0, '"sampling": "linear" gives the same bytes as without --nearest');
check(Buffer.compare(draw(['--preset', preset({ sampling: 'linear' }), '--nearest', '--ss', '1']), sharp1) === 0, '--nearest after a "linear" preset wins (written later)');

// the sample: --nearest changes only how textures are read (the picture stays where it is)
const sample = path.join(ROOT, 'samples/basic/model.ug9');
const a = path.join(OUT, 'a.rgba'), b = path.join(OUT, 'b.rgba');
execFileSync(exe, [sample, '--frames', '1', '--format', 'raw', '--out', a], { stdio: 'ignore' });
execFileSync(exe, [sample, '--frames', '1', '--nearest', '--format', 'raw', '--out', b], { stdio: 'ignore' });
const A = fs.readFileSync(a), B = fs.readFileSync(b);
let covered = 0, differ = 0;
for (let i = 3; i < A.length; i += 4) { if ((A[i] > 0) !== (B[i] > 0)) covered++; if (A[i - 3] !== B[i - 3]) differ++; }
check(covered < A.length / 4 * 0.01 && differ > 0, `the sample with --nearest: the same shape (${covered} of ${A.length / 4} px change coverage: the edges read the nearest texel's alpha), the colours read differently (${differ} px)`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall nearest checks passed');
process.exit(failures ? 1 : 0);
