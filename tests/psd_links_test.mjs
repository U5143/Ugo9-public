// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The PSD and the model side by side (tools/psd_links.mjs, 機能の比べ #20): a model read from a PSD, then the PSD
// redrawn with known changes (one layer left alone, one moved, one resized, one redrawn, one renamed, one deleted, one
// new): each shows as what was done; the rename, applied to the layers' list, lets reimportPsd keep that part.
//   node tests/psd_links_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { importPsd, layerMeta, reimportPsd } from '../tools/import_psd.mjs';
import { psdLinks, formatLinks } from '../tools/psd_links.mjs';
import { writePsd } from './psd/make_big.mjs';
import { encodePng } from '../tools/png.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const grad = (seed) => (x, y) => [(x * 37 + seed * 11) & 255, (y * 23 + seed * 7) & 255, ((x + y) * 13 + seed) & 255, 255];
const W = 300, H = 220;
const before = [
  { name: 'still', left: 10, top: 10, width: 40, height: 30, pixel: grad(1) },
  { name: 'mover', left: 70, top: 10, width: 30, height: 30, pixel: grad(2) },
  { name: 'grower', left: 120, top: 10, width: 30, height: 30, pixel: grad(3) },
  { name: 'painted', left: 170, top: 10, width: 40, height: 40, pixel: grad(4) },
  { name: 'eye_L', left: 10, top: 100, width: 50, height: 30, pixel: grad(5) },
  { name: 'gone', left: 100, top: 100, width: 30, height: 30, pixel: grad(6) },
];
const after = [
  before[0],
  { ...before[1], left: 82, top: 15 },
  { ...before[2], width: 44, height: 36 },
  { ...before[3], pixel: (x, y) => (x < 20 ? grad(4)(x, y) : [255, 255, 255, 255]) }, // the right half painted over
  { ...before[4], name: '左目' }, // renamed
  { name: 'new', left: 200, top: 120, width: 30, height: 20, pixel: grad(9) },
];
const first = importPsd(writePsd(W, H, before, { composite: () => [255, 255, 255] }), { inflate, keepPixels: false });
const doc = { canvas: first.model.canvas, parts: first.model.parts, layers: first.layers.map(layerMeta) };
const psd2 = writePsd(W, H, after, { composite: () => [255, 255, 255] });
const r = psdLinks(psd2, doc, first.atlases, { inflate });
const row = (part) => r.rows.find((x) => x.part === part);
check(row('still')?.status === 'same' && row('still').changed === 0, 'left alone: same');
check(row('mover')?.status === 'moved' && row('mover').dx === 12 && row('mover').dy === 5, `moved: 12, 5 (${JSON.stringify(row('mover'))})`);
check(row('grower')?.status === 'resized' && row('grower').size[1].join() === '44,36', `resized: 30×30 → ${row('grower')?.size?.[1]?.join('×')}`);
check(row('painted')?.status === 'redrawn' && row('painted').changed > 0.4 && row('painted').changed < 0.6, `redrawn: about half its pixels (${row('painted')?.changed})`);
check(row('eye_L')?.status === 'renamed' && row('eye_L').to.join() === '左目' && row('eye_L').alike > 0.95, `renamed: eye_L → 左目 (alike ${row('eye_L')?.alike})`);
check(row('gone')?.status === 'removed' && r.added.map((p) => p.join('/')).join() === 'new', 'deleted: removed; the new layer: added');
check(r.rows.length === 6 && r.notes.some((n) => n.code === 'psdLinkRenamed') && r.notes.some((n) => n.code === 'psdLinkRemoved') && r.notes.some((n) => n.code === 'psdLinkAdded'), 'a row per part, the renames, removals and new layers said in notes');

// the rename applied: reimportPsd keeps the part (and its mesh) instead of dropping it and adding a new one
const plain = reimportPsd(psd2, doc, { inflate }), withRename = reimportPsd(psd2, { ...doc, layers: r.layers }, { inflate });
check(plain.removed.includes('eye_L') && !withRename.removed.includes('eye_L') && 'eye_L' in withRename.uvs && withRename.added.length === plain.added.length - 1,
  `with the rename, reading again keeps eye_L (removed before: ${plain.removed.join(', ')}; after: ${withRename.removed.join(', ')})`);
const text = formatLinks(r);
check(/eye_L\s+eye_L\s+renamed\? → 左目/.test(text) && /mover\s+mover\s+moved 12,5/.test(text) && /\(new\)\s+new\s+added/.test(text), 'the table says each in a line');

// a picture that looks alike but is far away and differently sized: not a rename
{
  const far = [before[0], before[1], before[2], before[3], { name: 'other', left: 230, top: 160, width: 20, height: 50, pixel: grad(5) }];
  const r2 = psdLinks(writePsd(W, H, far, { composite: () => [255, 255, 255] }), doc, first.atlases, { inflate });
  check(r2.rows.find((x) => x.part === 'eye_L')?.status === 'removed', 'a different picture elsewhere is not taken for a rename');
}

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdlinks-'));
fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ ...first.model, source: { psd: { file: 'a.psd', layers: doc.layers } } }));
first.atlases.forEach((a, i) => fs.writeFileSync(path.join(dir, first.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
fs.writeFileSync(path.join(dir, 'b.psd'), psd2);
const out = execFileSync('node', ['tools/psd_links.mjs', path.join(dir, 'model.json'), path.join(dir, 'b.psd'), '--write', path.join(dir, 'm2.json')], { encoding: 'utf8' });
const m2 = JSON.parse(fs.readFileSync(path.join(dir, 'm2.json'), 'utf8'));
check(/renamed\?/.test(out) && m2.source.psd.layers.find((l) => l.part === 'eye_L').name === '左目', 'command line: the table, and --write keeps the rename in source.psd.layers');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall PSD link checks passed');
process.exit(failures ? 1 : 0);
