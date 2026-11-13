// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Photoshop layer effects painted into the layers' pixels at import (tools/layer_effects.mjs,
// bakeEffects in tools/import_psd.mjs). The 'lfx2' and 'lmfx' blocks are written here from the
// public descriptor layout; the checks are what each effect must do to a red square: a stroke of
// 3 px outside, inside and centred (whole pixels), a colour overlay, a drop shadow down-right of
// it (light from 120°), an outer glow round it, inner glow and shadow inside it only; the layer's
// fill thins its own pixels, not its effects; switched-off effects and the master switch; several
// shadows (lmfx); bevel and the like said by name; broken blocks keep the old warning; and the
// switch to keep the old way. Then the drawn picture: ugo_export draws the stroke round the square.
//   node tests/psd_effects_test.mjs        (the picture needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importPsd, importPsdParallel } from '../tools/import_psd.mjs';
import { readEffects } from '../tools/layer_effects.mjs';
import { replaceLayerPixels } from '../tools/psd_add_layer.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { writePsd, block } from './psd/make_big.mjs';
import { findExporter } from '../tools/compare_frames.mjs';
import { encodePng } from '../tools/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'psd_effects');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);

// ---- a descriptor writer (Adobe's "Descriptor structure"): values are [type, value] ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const uni = (s) => { const b = Buffer.alloc(4 + 2 * (s.length + 1)); b.writeUInt32BE(s.length + 1); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 4 + 2 * i); return b; };
const key = (k) => (k.length === 4 ? Buffer.concat([u32(0), Buffer.from(k, 'latin1')]) : Buffer.concat([u32(k.length), Buffer.from(k, 'latin1')]));
const f64 = (x) => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b; };
function val([type, v]) {
  if (type === 'bool') return Buffer.concat([Buffer.from('bool'), Buffer.from([v ? 1 : 0])]);
  if (type === 'doub') return Buffer.concat([Buffer.from('doub'), f64(v)]);
  if (type === 'long') return Buffer.concat([Buffer.from('long'), u32(v)]);
  if (type === 'UntF') return Buffer.concat([Buffer.from('UntF'), Buffer.from(v[0], 'latin1'), f64(v[1])]);
  if (type === 'enum') return Buffer.concat([Buffer.from('enum'), key(v[0]), key(v[1])]);
  if (type === 'Objc') return Buffer.concat([Buffer.from('Objc'), desc(v[0], v[1])]);
  if (type === 'VlLs') return Buffer.concat([Buffer.from('VlLs'), u32(v.length), ...v.map(val)]);
  if (type === 'tdta') return Buffer.concat([Buffer.from('tdta'), u32(v.length), v]);
  throw new Error(type);
}
const desc = (cls, items) => Buffer.concat([uni(''), key(cls), u32(Object.keys(items).length), ...Object.entries(items).flatMap(([k, v]) => [key(k), val(v)])]);
const rgb = (r, g, b) => ['Objc', ['RGBC', { 'Rd  ': ['doub', r], 'Grn ': ['doub', g], 'Bl  ': ['doub', b] }]];
const pct = (x) => ['UntF', ['#Prc', x]], pxl = (x) => ['UntF', ['#Pxl', x]], ang = (x) => ['UntF', ['#Ang', x]];
const fxBlock = (items, k = 'lfx2') => block(k, Buffer.concat([u32(0), u32(16), desc('null', { 'Scl ': pct(100), masterFXSwitch: ['bool', true], ...items })]));
const stroke = (pos, size = 3, more = {}) => ['Objc', ['FrFX', { enab: ['bool', true], Styl: ['enum', ['FStl', pos]], PntT: ['enum', ['FrFl', 'SClr']], 'Md  ': ['enum', ['BlnM', 'Nrml']], Opct: pct(100), 'Sz  ': pxl(size), 'Clr ': rgb(0, 0, 255), ...more }]];
const shadow = (more = {}) => ['Objc', ['DrSh', { enab: ['bool', true], 'Md  ': ['enum', ['BlnM', 'Mltp']], 'Clr ': rgb(0, 0, 0), Opct: pct(100), uglg: ['bool', true], lagl: ang(120), Dstn: pxl(6), Ckmt: pct(100), blur: pxl(0), ...more }]];

// ---- the picture: a red square, 20 px, in a 64 × 64 canvas ----
const W = 64, H = 64;
const square = (extra, more = {}) => ({ name: 'square', left: 22, top: 22, width: 20, height: 20, pixel: () => [255, 0, 0, 255], extra, ...more });
const read = (layers, opts = {}) => importPsd(writePsd(W, H, layers, { composite: () => [255, 255, 255] }), { inflate, keepPixels: true, ...opts });
const at = (L, x, y) => { if (x < L.left || y < L.top || x >= L.left + L.width || y >= L.top + L.height) return [0, 0, 0, 0]; const i = ((y - L.top) * L.width + x - L.left) * 4; return [...L.rgba.subarray(i, i + 4)]; };
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
const note = (r, code) => r.notes.find((n) => n.code === code);
// each layer's name and the keys of its additional blocks (read straight from the file, 8-bit PSD)
function readPsdFx(bytes) {
  const b = Buffer.from(bytes), out = [];
  let p = 26; p += 4 + b.readUInt32BE(p); p += 4 + b.readUInt32BE(p); p += 4; p += 4;
  const n = Math.abs(b.readInt16BE(p)); p += 2;
  for (let i = 0; i < n; i++) {
    p += 16; const nch = b.readUInt16BE(p); p += 2 + nch * 6 + 12;
    const end = p + 4 + b.readUInt32BE(p); p += 4;
    p += 4 + b.readUInt32BE(p); p += 4 + b.readUInt32BE(p);
    let name = b.toString('latin1', p + 1, p + 1 + b[p]); p += (b[p] + 4) & ~3;
    const keys = [];
    while (p + 12 <= end) { keys.push(b.toString('latin1', p + 4, p + 8)); p += 12 + b.readUInt32BE(p + 8); }
    out.push({ name, keys }); p = end;
  }
  return out;
}

// reading the block
{
  const fx = readEffects(fxBlock({ FrFX: stroke('OutF'), ebbl: ['Objc', ['ebbl', { enab: ['bool', true] }]], DrSh: shadow({ enab: ['bool', false] }) }).subarray(12));
  check(fx && fx.effects.length === 1 && fx.effects[0].kind === 'stroke' && fx.effects[0].size === 3 && fx.effects[0].position === 'outside' && same(fx.effects[0].color.map((c) => c * 255), [0, 0, 255]) && fx.skipped.join() === 'bevel',
    `the block read: a stroke of 3 px outside in blue; bevel said by name; a switched-off shadow left out (${JSON.stringify(fx?.skipped)})`);
}
// strokes: whole pixels outside, inside, centred
for (const [pos, inside, outside, name] of [['OutF', [], [19, 20, 21], 'outside'], ['InsF', [22, 23, 24], [], 'inside'], ['CtrF', [22, 23], [20, 21], 'centred']]) {
  const r = read([square([fxBlock({ FrFX: stroke(pos, pos === 'CtrF' ? 4 : 3) })])]), L = r.layers[0];
  const row = [18, 19, 20, 21, 22, 23, 24, 25].map((x) => at(L, x, 32));
  const want = [18, 19, 20, 21, 22, 23, 24, 25].map((x) => (inside.includes(x) || outside.includes(x) ? [0, 0, 255, 255] : x >= 22 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const blue = (x) => (inside.includes(x) || outside.includes(x));
  check(row.every((p, i) => same(p, want[i])) && note(r, 'layerEffectsPainted')?.vars.effects === 'stroke' && !note(r, 'layerEffects'),
    `a stroke of ${pos === 'CtrF' ? 4 : 3} px ${name}: ${[18, 19, 20, 21, 22, 23, 24, 25].map((x) => (blue(x) ? 'B' : x >= 22 ? 'R' : '.')).join('')} across the square's left edge, said as painted`);
}
// colour overlay at 50 %
{
  const r = read([square([fxBlock({ SoFi: ['Objc', ['SoFi', { enab: ['bool', true], 'Md  ': ['enum', ['BlnM', 'Nrml']], Opct: pct(50), 'Clr ': rgb(0, 255, 0) }]] })])]), L = r.layers[0];
  check(same(at(L, 30, 30), [128, 128, 0, 255]) && same(at(L, 10, 10), [0, 0, 0, 0]), `a green overlay at 50 % over red: ${at(L, 30, 30)} inside, nothing outside`);
}
// drop shadow: down-right (light from 120°), 6 px away; under the square
{
  const r = read([square([fxBlock({ DrSh: shadow() })])]), L = r.layers[0];
  const dx = Math.round(-Math.cos((120 * Math.PI) / 180) * 6), dy = Math.round(Math.sin((120 * Math.PI) / 180) * 6);
  check(same(at(L, 41 + dx, 41 + dy), [0, 0, 0, 255]) && same(at(L, 22 - 1, 22 - 1), [0, 0, 0, 0]) && same(at(L, 30, 30), [255, 0, 0, 255]) && note(r, 'layerEffectsPainted')?.vars.close === true,
    `a drop shadow (multiply, 6 px at 120°): black at (+${dx}, +${dy}) past the square's corner, none above-left, the square over it; said as close (multiply painted in normal)`);
}
// outer glow: round the square, fading out; inner glow and shadow: inside only
{
  const glow = ['Objc', ['OrGl', { enab: ['bool', true], 'Md  ': ['enum', ['BlnM', 'Nrml']], 'Clr ': rgb(255, 255, 0), Opct: pct(100), Ckmt: pct(0), blur: pxl(9) }]];
  const r = read([square([fxBlock({ OrGl: glow })])]), L = r.layers[0];
  const a1 = at(L, 20, 32)[3], a2 = at(L, 16, 32)[3], a3 = at(L, 10, 32)[3];
  check(a1 > a2 && a2 > a3 && a3 === 0 && same(at(L, 20, 32).slice(0, 3), [255, 255, 0]), `an outer glow of 9 px: yellow, fading out from the edge (alpha ${a1}, ${a2}, ${a3} at 2, 6, 12 px out)`);
  const inner = ['Objc', ['IrGl', { enab: ['bool', true], 'Md  ': ['enum', ['BlnM', 'Nrml']], 'Clr ': rgb(255, 255, 255), Opct: pct(100), Ckmt: pct(0), blur: pxl(6), glwS: ['enum', ['IGSr', 'SrcE']] }]];
  const r2 = read([square([fxBlock({ IrGl: inner })])]), L2 = r2.layers[0];
  check(at(L2, 22, 32)[1] > at(L2, 26, 32)[1] && same(at(L2, 32, 32), [255, 0, 0, 255]) && L2.width === 20 + 2 && at(L2, 21, 32)[3] === 0, `an inner glow: white at the edge, red in the middle, nothing outside (the box grows by 1 px only)`);
}
// fill 0: the square's own pixels gone, its stroke kept
{
  const r = read([square([fxBlock({ FrFX: stroke('OutF') }), block('iOpa', Buffer.from([0, 0, 0, 0]))])]), L = r.layers[0];
  check(same(at(L, 20, 32), [0, 0, 255, 255]) && at(L, 30, 32)[3] === 0 && L.opacity === 1, `fill 0: the square's own pixels gone, its stroke kept, the layer's opacity 1 (${L.opacity})`);
}
// switched off: the master switch
{
  const off = block('lfx2', Buffer.concat([u32(0), u32(16), desc('null', { 'Scl ': pct(100), masterFXSwitch: ['bool', false], FrFX: stroke('OutF') })]));
  const r = read([square([off])]), L = r.layers[0];
  check(L.width === 20 && !note(r, 'layerEffectsPainted') && !note(r, 'layerEffects'), 'the effects switched off (the master switch): nothing painted, nothing said');
}
// several shadows (lmfx)
{
  const two = block('lmfx', Buffer.concat([u32(0), u32(16), desc('null', { 'Scl ': pct(100), masterFXSwitch: ['bool', true], dropShadowMulti: ['VlLs', [shadow(), ['Objc', ['DrSh', { ...shadow()[1][1], lagl: ang(-60), 'Clr ': rgb(0, 128, 0) }]]]] })]));
  const r = read([square([two])]), L = r.layers[0];
  check(same(at(L, 44, 46), [0, 0, 0, 255]) && same(at(L, 19, 17), [0, 128, 0, 255]), `two drop shadows (lmfx): one down-right in black, one up-left in green (${at(L, 44, 46)}, ${at(L, 19, 17)})`);
}
// bevel only: said by name; a broken block: the old warning; the switch to keep the old way
{
  const r = read([square([fxBlock({ ebbl: ['Objc', ['ebbl', { enab: ['bool', true] }]] })])]);
  check(note(r, 'layerEffectsSkipped')?.vars.effects === 'bevel' && r.layers[0].width === 20, `bevel: not painted, said by name (${note(r, 'layerEffectsSkipped')?.text})`);
  const broken = block('lfx2', Buffer.concat([u32(0), u32(16), Buffer.from([0, 0, 0, 9])]));
  const r2 = read([square([broken])]);
  check(note(r2, 'layerEffects') && !note(r2, 'layerEffectsPainted'), 'a broken block: not painted, the old warning (layerEffects)');
  const r3 = read([square([fxBlock({ FrFX: stroke('OutF') })])], { bakeEffects: false });
  check(note(r3, 'layerEffects') && r3.layers[0].width === 20, 'bakeEffects false: as before (not painted, layerEffects)');
}
// read side by side (the editor's way, importPsdParallel): the same pixels
{
  const bytes = writePsd(W, H, [square([fxBlock({ FrFX: stroke('OutF'), DrSh: shadow() })])], { composite: () => [255, 255, 255] });
  const a = importPsd(bytes, { inflate, keepPixels: true }).layers[0], b = (await importPsdParallel(bytes, { inflate, keepPixels: true })).layers[0];
  check(a.left === b.left && a.width === b.width && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0, 'read side by side (importPsdParallel): the same box and pixels');
}
// the drawn picture: the stroke round the square, through the compiler and ugo_export
const exe = findExporter();
if (exe) {
  const r = importPsd(writePsd(W, H, [square([fxBlock({ FrFX: stroke('OutF') })])], { composite: () => [255, 255, 255] }), { inflate });
  check(r.layers[0].effects?.join() === 'stroke', `the layer's record says its picture has the effects in it (${JSON.stringify(r.layers[0].effects)})`);
  fs.writeFileSync(path.join(OUT, 'model.ug9'), new Uint8Array(compileUgo(r.model)));
  r.atlases.forEach((a, i) => fs.writeFileSync(path.join(OUT, r.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
  execFileSync(exe, [path.join(OUT, 'model.ug9'), '--frames', '1', '--size', `${W}x${H}`, '--format', 'raw', '--out', path.join(OUT, 'f.rgba')], { stdio: 'ignore' });
  const f = fs.readFileSync(path.join(OUT, 'f.rgba')), p = (x, y) => [...f.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
  check(p(20, 32)[2] > 200 && p(20, 32)[0] < 40 && p(32, 32)[0] > 200 && p(16, 32)[3] === 0, `ugo_export: blue round the square (${p(20, 32)}), red in it (${p(32, 32)}), nothing beyond the stroke`);
} else console.log('skip the picture: build/ugo_export not built');

// writing the painted pixels back (the editor's 書き戻し) with dropEffects: the effects taken off, so Photoshop does not
// draw them again; read back, the layer is the painted picture with no effects, the rest of the file as it was
for (const k of ['lfx2', 'lmfx']) {
  const psd = writePsd(W, H, [square([fxBlock({ FrFX: stroke('OutF') }, k)]), { name: 'other', left: 2, top: 2, width: 8, height: 8, pixel: () => [0, 255, 0, 255], extra: [fxBlock({ FrFX: stroke('OutF') }, k)] }], { composite: () => [255, 255, 255] });
  const r0 = importPsd(psd, { inflate, keepPixels: true }), L0 = r0.layers.find((l) => l.name === 'square');
  const pic = { left: L0.left, top: L0.top, width: L0.width, height: L0.height, rgba: L0.rgba };
  const notes = [], dropped = replaceLayerPixels(psd, 'square', pic, { inflate, dropEffects: true, notes }), kept = replaceLayerPixels(psd, 'square', pic, { inflate });
  fs.writeFileSync(path.join(OUT, `dropfx_${k}.psd`), dropped); // for opening elsewhere (psd-tools, Photoshop)
  const r1 = importPsd(dropped, { inflate, keepPixels: true }), L1 = r1.layers.find((l) => l.name === 'square'), O1 = r1.layers.find((l) => l.name === 'other');
  const r2 = importPsd(kept, { inflate, keepPixels: true }), L2 = r2.layers.find((l) => l.name === 'square');
  let most = 0; // compared on the canvas (reading again trims the transparent rim)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = at(L0, x, y), c = at(L1, x, y); for (let q = 0; q < 4; q++) most = Math.max(most, Math.abs(a[q] - c[q])); }
  check(most === 0 && !note(r1, 'layerEffectsPainted')?.vars?.layers?.includes?.('square'),
    `${k}, dropEffects: read back, the layer is the painted picture as it was given (the square with its stroke drawn in, ${L1.width}×${L1.height} at ${L1.left},${L1.top}; ${most} levels off)`);
  const fxOf = (bytes, name) => { const lay = readPsdFx(bytes).find((x) => x.name === name); return lay?.keys || []; };
  check(!fxOf(dropped, 'square').includes(k) && fxOf(dropped, 'other').includes(k) && fxOf(kept, 'square').includes(k) && fxOf(dropped, 'square').includes('luni'),
    `${k}: the square's ${k} block is gone (its name block kept), the other layer's effects and the file without dropEffects keep theirs`);
  check(L2.width > L1.width && notes.length === 1 && notes[0].code === 'psdEditEffectsDropped' && notes[0].vars.blocks.join() === k,
    `without dropEffects the stroke would be drawn again (${L2.width} px wide, not ${L1.width}); with it a note names the block (${notes[0]?.vars.blocks})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall layer effect checks passed');
process.exit(failures ? 1 : 0);
