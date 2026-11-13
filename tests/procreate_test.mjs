// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Procreate (.procreate) read the way a PSD is (importProcreate, tools/import_layers.mjs). The files
// in tests/procreate are made by make_procreate.py as the public notes on the format lay it out,
// their tiles compressed by the system's own liblzo2 (LZO1X-1 and LZO1X-999) and liblz4 (Apple's
// "bv41" blocks): every layer comes back pixel for pixel (premultiplied in the file), with its
// group, blend mode, clipping, visibility and mask; a file whose rows run bottom up is turned
// the right way by its thumbnail; the background colour is a layer of its own.
//   node tests/procreate_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importProcreate, importProcreateAsync, layeredKind } from '../tools/import_layers.mjs';
import { compileUgo } from '../tools/compile.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'procreate');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const node = { inflate: (b) => zlib.inflateSync(b), inflateRaw: (b) => zlib.inflateRawSync(b), keepPixels: true };
const want = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const read = (f) => fs.readFileSync(path.join(DIR, f));

for (const [file, what] of [['scene.procreate', 'LZO1X tiles'], ['scene_lz4.procreate', 'LZ4 tiles (bv41)'], ['scene_flipped.procreate', 'rows stored bottom up']]) {
  const bytes = read(file), r = importProcreate(bytes, node);
  const bad = r.layers.filter((l) => want[l.name] !== sha(l.rgba)).map((l) => l.name);
  check(layeredKind(bytes) === 'procreate' && r.layers.length === 5 && !bad.length, `${file} (${what}): 5 layers, each pixel for pixel${bad.length ? ` (differ: ${bad.join(', ')})` : ''}`);
  if (file === 'scene_flipped.procreate') check(r.notes.some((n) => n.code === 'procreateRowsFlipped'), 'the thumbnail turns the upside-down rows the right way (procreateRowsFlipped)');
  else check(!r.notes.some((n) => n.code === 'procreateRowsFlipped'), `${file}: the rows as they are (the thumbnail agrees)`);
}
{
  const r = importProcreate(read('scene.procreate'), node), L = (n) => r.layers.find((l) => l.name === n), part = (n) => r.model.parts.find((p) => p.id === n);
  check(r.layers.map((l) => l.name).join() === '空,太陽,丘,影,メモ' && L('丘').path.join('/') === '景色/丘' && r.groups.length === 1 && r.groups[0].name === '景色',
    `bottom first (the file lists them top first), the group 景色 (${r.layers.map((l) => l.path.join('/')).join(', ')})`);
  check(part('太陽').blend === 'screen' && part('影').blend === 'multiply' && Math.abs(part('影').opacity - 0.5) < 1e-6 && part('影').mask?.length && part('メモ').opacity === 0,
    'screen, multiply at 50 %, clipped (a mask of the layer below), a hidden layer at opacity 0');
  check(compileUgo(r.model).byteLength > 0, 'the model compiles');
}
{
  const r = importProcreate(read('paper.procreate'), node), bg = r.layers[0];
  check(r.layers.map((l) => l.name).join() === 'background,ink' && [...bg.rgba.subarray(0, 4)].join() === '242,229,204,255', `the background colour shown: a layer of its own at the bottom (${[...bg.rgba.subarray(0, 4)].join(',')})`);
}
{
  const a = await importProcreateAsync(read('scene_lz4.procreate'), { keepPixels: true }), s = importProcreate(read('scene_lz4.procreate'), node);
  check(JSON.stringify(a.model) === JSON.stringify(s.model), 'in the browser way (DecompressionStream): the same model');
}
// LZO1X straight: streams of liblzo2's two compressors over noise, zeros, far matches (past 16 and 32 KB), text
{
  const { lzo1xDecompress } = await import('../tools/import_layers.mjs');
  const cases = JSON.parse(fs.readFileSync(path.join(DIR, 'lzo_cases.json'), 'utf8')), bad = [];
  for (const [k, c] of Object.entries(cases)) {
    const out = new Uint8Array(c.length), n = lzo1xDecompress(Buffer.from(c.lzo, 'base64'), out);
    if (n !== c.length || sha(out) !== c.sha256) bad.push(k);
  }
  check(!bad.length, `LZO1X: ${Object.keys(cases).length} streams of liblzo2 (LZO1X-1 and -999) come back byte for byte${bad.length ? ` (differ: ${bad.join(', ')})` : ''}`);
}
let e = null;
try { importProcreate(new Uint8Array(fs.readFileSync(path.join(DIR, '..', 'layers', 'png', 'rgba8.png'))), node); } catch (x) { e = x; }
check(e?.code === 'layersNotZip', `not a ZIP: ${e?.code}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall Procreate checks passed');
process.exit(failures ? 1 : 0);
