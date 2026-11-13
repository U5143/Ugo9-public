// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The PSD importer with the PSDs people really bring: flat pictures, CMYK, grayscale, indexed,
// adjustment / text / smart object / fill / effect layers, hidden layers, a layer it can't read,
// layers outside the canvas, a big canvas, and broken or cut-short files. Nothing may stop the
// import with an error the editor can't word: every skip is a note with a code.
//   node tests/psd_robust_test.mjs
import zlib from 'node:zlib';
import { importPsd, readPsd } from '../tools/import_psd.mjs';
import { writePsd, block, bigLayers } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (b) => zlib.inflateSync(b);
const codes = (res) => res.notes.map((n) => n.code);
const px = (atlas, uvs, k) => { const x = Math.floor(uvs[2 * k] * atlas.width), y = Math.floor(uvs[2 * k + 1] * atlas.height); return Array.from(atlas.rgba.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4)); };
const square = (name, left, top, size, colour, more = {}) => ({ name, left, top, width: size, height: size, pixel: () => colour, ...more });
// the colour in the middle of a part's picture
const middle = (res, id) => {
  const L = res.layers.find((l) => l.part === id), a = L.atlas, at = res.atlases[a.page || 0];
  const [x, y] = a.turned ? [a.x + a.height - 1 - (a.height >> 1), a.y + (a.width >> 1)] : [a.x + (a.width >> 1), a.y + (a.height >> 1)]; // a picture may lie turned 90° clockwise
  return Array.from(at.rgba.subarray((y * at.width + x) * 4, (y * at.width + x) * 4 + 4));
};

// a flat picture (no layers): the merged picture becomes one part
{
  const bytes = writePsd(64, 48, [], { composite: (x, y) => [x * 4, y * 5, 100] });
  const res = importPsd(bytes);
  check(res.model.parts.length === 1 && res.model.parts[0].id === 'image' && codes(res).includes('psdFlatImage') && middle(res, 'image').join() === '128,120,100,255',
    `a flat RGB picture: one part "image" (${codes(res)})`);
}
// CMYK layers: cyan ink -> (0, 255, 255); grayscale; an indexed flat picture through its palette
{
  const cmyk = importPsd(writePsd(40, 40, [square('cyan', 4, 4, 20, [255, 0, 0, 0, 255]), square('grey ink', 10, 10, 20, [0, 0, 0, 128, 255])], { mode: 4 }));
  check(middle(cmyk, 'cyan').join() === '0,255,255,255' && middle(cmyk, 'grey ink').join() === '127,127,127,255' && codes(cmyk).includes('psdCmyk'),
    `CMYK layers turned into RGB: cyan ${middle(cmyk, 'cyan')}, 50% black ${middle(cmyk, 'grey ink')} (${codes(cmyk)})`);
  const grey = importPsd(writePsd(40, 40, [square('grey', 4, 4, 20, [90, 255])], { mode: 1 }));
  check(middle(grey, 'grey').join() === '90,90,90,255', 'grayscale layers');
  const pal = Buffer.alloc(768); pal[7] = 200; pal[256 + 7] = 10; pal[512 + 7] = 30;
  const idx = importPsd(writePsd(30, 30, [], { mode: 2, palette: pal, composite: () => [7] }));
  check(idx.model.parts.length === 1 && middle(idx, 'image').join() === '200,10,30,255', `an indexed picture through its palette: ${middle(idx, 'image')}`);
}
// layer kinds, hidden layers, a layer the importer can't read, a layer partly off the canvas, unicode names
{
  const layers = [
    square('base', 0, 0, 30, [200, 200, 200, 255]),
    square('レベル補正', 0, 0, 30, [0, 0, 0, 0], { extra: [block('levl', Buffer.alloc(4))] }),
    square('文字', 2, 2, 10, [0, 0, 0, 255], { extra: [block('TySh', Buffer.alloc(4))] }),
    square('smart', 3, 3, 10, [10, 20, 30, 255], { extra: [block('SoLd', Buffer.alloc(4))] }),
    square('ベタ塗り', 0, 0, 30, [255, 0, 0, 255], { extra: [block('SoCo', Buffer.alloc(4))] }),
    square('縁取り', 5, 5, 10, [0, 0, 255, 255], { extra: [block('lfx2', Buffer.alloc(4))] }),
    square('下書き', 5, 5, 10, [0, 0, 0, 255], { hidden: true }),
    square('broken', 5, 5, 10, [0, 255, 0, 255], { compression: 7 }),
    square('off canvas', -10, -10, 20, [0, 255, 0, 255]),
    square('', 20, 20, 6, [1, 2, 3, 255]),
  ];
  const res = importPsd(writePsd(30, 30, layers));
  const c = codes(res), ids = res.model.parts.map((p) => p.id);
  check(['layerAdjustment', 'layerKind', 'layerEffects', 'layerHidden', 'layerUnreadable'].every((k) => c.includes(k))
    && res.notes.filter((n) => n.code === 'layerKind').map((n) => n.vars.kind).sort().join() === 'fill,smartObject,text', `kinds named: ${c.join(', ')}`);
  check(!ids.includes('broken') && !ids.includes('レベル補正') && ids.includes('文字') && ids.includes('off canvas') && ids.includes('layer') && res.notes.find((n) => n.code === 'layerUnreadable').vars.layer === 'broken',
    `the unreadable and adjustment layers are skipped, the others kept: ${ids.join(', ')}`);
  const off = res.model.parts.find((p) => p.id === 'off canvas');
  check(Math.min(...off.vertices.filter((_, i) => i % 2 === 0)) < -15 - 5, 'a layer reaching outside the canvas keeps its outside part');
  check(res.model.parts.find((p) => p.id === '下書き').opacity === 0, 'a hidden layer comes in with opacity 0');
}
// a big canvas is scaled down to the atlas page: positions and pixels at half size
{
  const checker = { name: 'checker', left: 100, top: 60, width: 200, height: 100, pixel: (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]) };
  const res = importPsd(writePsd(1200, 900, [checker, square('half', 400, 400, 100, [255, 0, 0, 128])]), { maxCanvas: 600 });
  const n = res.notes.find((q) => q.code === 'psdScaledDown');
  const L = res.layers.find((l) => l.part === 'checker');
  check(n && n.vars.scale === 0.5 && res.model.canvas.width === 600 && res.model.canvas.height === 450 && res.scale === 0.5, `1200x900 with maxCanvas 600: imported at ${n?.vars.scale} (${res.model.canvas.width}x${res.model.canvas.height})`);
  check(L.left === 50 && L.top === 30 && L.width === 100 && L.height === 50, `the layer's box is halved: ${L.left},${L.top} ${L.width}x${L.height}`);
  const m = middle(res, 'checker'), h = middle(res, 'half');
  check(Math.abs(m[0] - 128) <= 1 && m[3] === 255 && h.join() === '255,0,0,128', `pixels are area means: the checker turns grey ${m}, a half-transparent red stays ${h}`);
  check(importPsd(writePsd(1200, 900, [checker])).scale === 1, 'below the limit (default 4080): no scaling');
  // reading a redrawn PSD again at the first import's scale, even when its canvas grew
  const again = importPsd(writePsd(1400, 900, [checker]), { maxCanvas: 600, scale: 0.5 });
  const LA = again.layers.find((l) => l.part === 'checker');
  check(again.scale === 0.5 && LA.left === 50 && LA.width === 100 && importPsd(writePsd(1200, 900, [checker]), { maxCanvas: 600, scale: 1 }).scale === 1, 'opts.scale fixes the scale (over maxCanvas; 1 = not scaled)');
  check(importPsd(writePsd(9000, 100, [checker]), { scale: 0.5 }).notes.some((q) => q.code === 'psdLargeCanvas' && q.vars.width === 4500), 'a fixed scale leaving the canvas over 4080 px is noted');
}
// a big layer gets a coarser mesh that still covers every opaque pixel
{
  const res = importPsd(writePsd(3000, 3000, bigLayers(3000, 3000, 2)));
  const bg = res.model.parts.find((p) => p.id === 'background'), n = res.notes.find((q) => q.code === 'meshCoarser' && q.vars.layer === 'background');
  check(n && bg.vertices.length / 2 < 4000, `a 3000 px background: mesh points ${n?.vars.spacing} px apart, ${bg.vertices.length / 2} vertices`);
  const xs = bg.vertices.filter((_, i) => i % 2 === 0), ys = bg.vertices.filter((_, i) => i % 2 === 1);
  let area = 0;
  for (let t = 0; t < bg.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => bg.triangles[t + j] * 2), v = bg.vertices;
    area += Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  check(Math.min(...xs) <= -1500 && Math.max(...xs) >= 1500 && Math.min(...ys) <= -3000 && Math.max(...ys) >= 0 && area >= 3000 * 3000,
    `the mesh reaches every edge and its triangles cover the whole picture (${(area / 9e6 * 100).toFixed(1)}% of it)`);
}
// broken files: cut short anywhere, or with bytes changed. The import ends with a result (and
// notes), or with an error that has a code; never with an uncoded error
{
  const good = writePsd(80, 60, [square('a', 0, 0, 40, [255, 0, 0, 255]), square('b', 30, 20, 40, [0, 0, 255, 200]), { ...square('c', 10, 10, 30, [0, 255, 0, 255]), hidden: true }]);
  let uncoded = [], results = 0, coded = new Set(), tries = 0;
  const attempt = (bytes, label) => {
    tries++;
    try { importPsd(bytes, { inflate }); results++; } catch (e) { if (e.psd && e.code) coded.add(e.code); else uncoded.push(`${label}: ${e.message}`); }
  };
  for (let cutAt = 0; cutAt < good.length; cutAt += Math.max(1, good.length >> 7)) attempt(good.subarray(0, cutAt), `cut at ${cutAt}`);
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 300; t++) {
    const b = Buffer.from(good);
    for (let k = 0; k < 1 + (t % 4); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    attempt(b, `changed #${t}`);
  }
  check(!uncoded.length, `${tries} broken files: ${results} imported, the rest stopped with coded errors (${[...coded].join(', ')})${uncoded.length ? '; uncoded: ' + uncoded.slice(0, 3).join(' | ') : ''}`);
  const half = importPsd(good.subarray(0, Math.floor(good.length * 0.6)));
  check(half.notes.some((n) => ['psdLayersBroken', 'layerUnreadable', 'psdNoLayers', 'psdFlatImage'].includes(n.code)), `a file cut at 60%: imported with ${codes(half).join(', ')}`);
  let e1; try { readPsd(Buffer.from('hello world, not a psd at all')); } catch (e) { e1 = e; }
  let e2; try { const b = Buffer.from(good); b.writeUInt16BE(32, 22); readPsd(b); } catch (e) { e2 = e; }
  let e3; try { const b = Buffer.from(good); b.writeUInt16BE(9, 24); readPsd(b); } catch (e) { e3 = e; }
  check(e1?.code === 'psdNotPsd' && e2?.code === 'psdDepth' && e2.vars.depth === 32 && e3?.code === 'psdMode' && e3.vars.mode === 'Lab', `files that can't be read at all say why: ${e1?.code}, ${e2?.code} ${JSON.stringify(e2?.vars)}, ${e3?.code} ${JSON.stringify(e3?.vars)}`);
}

// clipping to a folder: the clipped layer right above a folder is drawn inside all the folder's
// unclipped layers (and the layers clipped inside the folder stay on their own base); opts.clipping
// false: no masks at all
{
  const end = { name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] };
  const layers = [square('back', 0, 0, 60, [250, 250, 250, 255]), end, square('face', 10, 10, 20, [240, 200, 180, 255]),
    { ...square('blush', 12, 20, 6, [255, 120, 120, 255]), clipping: true }, end, square('ear', 32, 14, 8, [240, 200, 180, 255]),
    { name: 'inner', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
    { name: 'head', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
    { ...square('shade', 8, 8, 40, [0, 0, 60, 255]), clipping: true, blend: 'mul ' }, { ...square('light', 8, 8, 30, [255, 255, 200, 255]), clipping: true }];
  const res = importPsd(writePsd(60, 60, layers)), mask = (id) => res.model.parts.find((p) => p.id === id)?.mask;
  check(mask('shade')?.join() === 'face,ear' && mask('light')?.join() === 'face,ear' && mask('blush')?.join() === 'face' && !mask('back'), `clipped above a folder: inside the folder's layers (shade: ${mask('shade')}, light: ${mask('light')}; blush in the folder: ${mask('blush')})`);
  const off = importPsd(writePsd(60, 60, layers), { clipping: false });
  check(off.model.parts.every((p) => !p.mask) && !off.notes.some((n) => n.code.startsWith('layerClip')) && off.layers.find((l) => l.name === 'shade').clipping, `clipping: false: no masks, no clipping notes (the layers still say they were clipped)`);
  const emptyFolder = importPsd(writePsd(60, 60, [square('back', 0, 0, 60, [250, 250, 250, 255]), end, square('ghost', 0, 0, 4, [0, 0, 0, 0]), { name: 'empty', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, { ...square('over', 5, 5, 10, [0, 0, 0, 255]), clipping: true }]));
  check(emptyFolder.notes.some((n) => n.code === 'layerClipEmptyBase') && emptyFolder.model.parts.find((p) => p.id === 'over').opacity === 0, 'clipped above a folder with nothing drawn in it: shows nothing (layerClipEmptyBase)');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall robustness checks passed');
process.exit(failures ? 1 : 0);
