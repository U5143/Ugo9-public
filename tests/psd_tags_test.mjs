// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// More layer-name tags (tools/import_psd.mjs, 機能の比べ #14): [無視] / [ignore] leaves a layer (or a folder's layers)
// out; [結合] / [merge] draws a folder's layers together into one part (a multiply shading over its base gives the
// product of the colours, the folder's opacity kept); [メッシュ=四角|格子|輪郭] / [mesh=...] picks a layer's mesh (on a
// folder: its layers'); tags can follow each other and a bone tag; brackets that are not a tag stay in the name.
//   node tests/psd_tags_test.mjs
import zlib from 'node:zlib';
import { importPsd } from '../tools/import_psd.mjs';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const fill = (c) => () => c;
const blob = (c) => (x, y, w = 60, h = 60) => (Math.hypot(x - 30, y - 30) < 28 ? c : [0, 0, 0, 0]); // a round picture
const folder = (name, kids, more = {}) => [{ name: '</Layer group>', section: 3, width: 0, height: 0 }, ...kids, { name, section: 1, width: 0, height: 0, ...more }];
const layers = [
  { name: 'メモ [無視]', left: 0, top: 0, width: 20, height: 20, pixel: fill([255, 0, 0, 255]) },
  ...folder('下書き [ignore]', [{ name: 'a', left: 0, top: 30, width: 20, height: 20, pixel: fill([0, 255, 0, 255]) }, { name: 'b', left: 0, top: 60, width: 20, height: 20, pixel: fill([0, 0, 255, 255]) }]),
  ...folder('顔 [結合]', [
    { name: '肌', left: 100, top: 20, width: 60, height: 60, pixel: fill([200, 160, 120, 255]) },
    { name: '影', left: 100, top: 50, width: 60, height: 30, pixel: fill([128, 128, 255, 255]), blend: 'mul ' },
    { name: '光', left: 110, top: 25, width: 10, height: 10, pixel: fill([255, 255, 255, 255]) },
  ], { opacity: 204 }),
  { name: '髪 [メッシュ=四角]', left: 200, top: 10, width: 60, height: 60, pixel: blob([60, 40, 30, 255]) },
  { name: '体 [mesh=grid]', left: 200, top: 100, width: 60, height: 60, pixel: blob([90, 90, 160, 255]) },
  ...folder('飾り [メッシュ=四角]', [{ name: 'リボン', left: 280, top: 10, width: 60, height: 60, pixel: blob([220, 40, 80, 255]) }]),
  { name: '腕 [骨] [メッシュ=四角]', left: 280, top: 100, width: 60, height: 60, pixel: blob([200, 170, 150, 255]) },
  { name: '目 [左]', left: 40, top: 150, width: 20, height: 20, pixel: fill([10, 10, 10, 255]) },
];
const r = importPsd(writePsd(360, 200, layers, { composite: () => [255, 255, 255] }), { inflate, keepPixels: true });
const ids = r.model.parts.map((p) => p.id), part = (id) => r.model.parts.find((p) => p.id === id), note = (c) => r.notes.find((n) => n.code === c);

check(!ids.some((id) => /メモ|^a$|^b$/.test(id)) && note('psdTagIgnored')?.vars.count === 3, `[無視] / [ignore]: the layer and the folder's 2 layers left out, said (${note('psdTagIgnored')?.text})`);
const face = part('顔'), faceLayer = r.layers.find((l) => l.part === '顔');
const at = (L, x, y) => { const i = ((y - L.top) * L.width + x - L.left) * 4; return [...L.rgba.subarray(i, i + 4)]; };
const shaded = at(faceLayer, 130, 70), skin = at(faceLayer, 140, 40), shine = at(faceLayer, 115, 30);
check(face && !ids.includes('肌') && !ids.includes('影') && !ids.includes('光') && Math.abs(face.opacity - 0.8) < 0.01,
  `[結合] / [merge]: the folder's 3 layers as one part 顔, the folder's opacity (${face?.opacity})`);
check(Math.abs(shaded[0] - Math.round((200 * 128) / 255)) <= 1 && Math.abs(shaded[2] - Math.round((120 * 255) / 255)) <= 1 && skin.join() === '200,160,120,255' && shine.join() === '255,255,255,255',
  `drawn together as the drawing app shows it: the multiply shade over the skin (${shaded.slice(0, 3)}), the skin (${skin.slice(0, 3)}), the shine on top`);
check(part('髪').vertices.length === 8 && part('リボン').vertices.length === 8 && part('体').vertices.length > 8, '[メッシュ=四角]: 4 points (also from a tagged folder for its layers); [mesh=grid]: a grid');
const plainGrid = importPsd(writePsd(360, 200, [{ name: '体', left: 200, top: 100, width: 60, height: 60, pixel: blob([90, 90, 160, 255]) }], { composite: () => [255, 255, 255] }), { inflate, mesh: 'grid' });
check(part('体').vertices.length === plainGrid.model.parts[0].vertices.length, 'the [mesh=grid] layer gets the same mesh as importing it with mesh grid');
const arm = part('腕');
check(arm && arm.vertices.length === 8 && r.model.bones.some((b) => b.id === '腕') && arm.bone === '腕', 'tags after each other: 「腕 [骨] [メッシュ=四角]」 a bone 腕, its part 腕 with 4 points');
check(ids.includes('目 [左]'), 'brackets that are not a tag stay in the name (目 [左])');
check(note('psdTagMerged')?.vars.layers === 3, 'said: the merged folder and how many layers');

console.log(failures ? `\n${failures} check(s) failed` : '\nall PSD tag checks passed');
process.exit(failures ? 1 : 0);
