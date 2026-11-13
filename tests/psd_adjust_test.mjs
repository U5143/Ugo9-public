// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Adjustment layers applied to the pixels below them at import (tools/adjustments.mjs, bakeAdjustments
// in tools/import_psd.mjs). Levels and invert against psd-tools' own drawing (where it is installed);
// curves, hue / saturation, colour balance and brightness / contrast by what they must do to known
// colours; which layers an adjustment reaches (below it, its folder, a clipped one only its base),
// its opacity, and the switch to keep the old way.
//   node tests/psd_adjust_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importPsd } from '../tools/import_psd.mjs';
import { writePsd, block } from './psd/make_big.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'psd_adjust');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const psdTools = (() => { try { execFileSync('python3', ['-c', 'import psd_tools'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const be = (v, n) => { const b = Buffer.alloc(n); if (n === 2) b.writeInt16BE(v); else b.writeInt32BE(v); return b; };

const W = 64, H = 48;
// the picture below: a colour gradient (every channel varies), opaque
const picture = (x, y) => [Math.round((x * 255) / (W - 1)), Math.round((y * 255) / (H - 1)), (x * 7 + y * 3) & 255, 255];
const pic = { name: 'picture', left: 0, top: 0, width: W, height: H, pixel: picture };
const adj = (name, blocks, more = {}) => ({ name, left: 0, top: 0, width: 0, height: 0, pixel: () => [0, 0, 0, 0], extra: blocks.map(([k, d]) => block(k, d)), ...more });
const read = (layers, opts = {}) => importPsd(writePsd(W, H, layers, { composite: () => [255, 255, 255] }), { inflate, keepPixels: true, ...opts });
const px = (L, x, y) => [...L.rgba.subarray(((y - L.top) * L.width + x - L.left) * 4, ((y - L.top) * L.width + x - L.left) * 4 + 4)];
const worst = (L, f) => { let w = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = px(L, x, y), b = f(picture(x, y)); w = Math.max(w, ...[0, 1, 2].map((k) => Math.abs(a[k] - b[k]))); } return w; };

// levels: version 2, 29 records (master, R, G, B, ...): input floor / ceiling, output floor / ceiling, gamma × 100
const levels = (recs) => Buffer.concat([be(2, 2), ...Array.from({ length: 29 }, (_, k) => { const r = recs[k] || [0, 255, 0, 255, 100]; return Buffer.concat(r.map((v) => be(v, 2))); })]);
const levelBlock = levels([[20, 230, 10, 240, 140], [0, 200, 30, 255, 100], null, [50, 255, 0, 200, 70]]);

{
  const r = read([pic, adj('invert', [['nvrt', Buffer.alloc(0)]])]), L = r.layers[0];
  check(r.notes.some((n) => n.code === 'layerAdjustmentBaked' && n.vars.kind === 'invert' && n.vars.layers === 1) && worst(L, ([a, b, c]) => [255 - a, 255 - b, 255 - c]) === 0, 'invert: every colour 255 − v (exact)');
}
{
  const bytes = writePsd(W, H, [pic, adj('levels', [['levl', levelBlock]])], { composite: () => [255, 255, 255] }), file = path.join(OUT, 'levels.psd');
  fs.writeFileSync(file, bytes);
  const r = importPsd(bytes, { inflate, keepPixels: true }), L = r.layers[0];
  check(r.notes.find((n) => n.code === 'layerAdjustmentBaked')?.vars.exact === true, 'levels: read, exact');
  if (psdTools) {
    const ref = JSON.parse(execFileSync('python3', ['-c', `import sys, json, numpy as np
from psd_tools import PSDImage
p = PSDImage.open(sys.argv[1])
print(json.dumps(np.asarray(p.composite(force=True).convert('RGB')).astype(int).ravel().tolist()))`, file], { encoding: 'utf8', maxBuffer: 1 << 26 }));
    let w = 0, sum = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = px(L, x, y), i = (y * W + x) * 3; for (let k = 0; k < 3; k++) { const d = Math.abs(a[k] - ref[i + k]); w = Math.max(w, d); sum += d; } }
    // psd-tools keeps floats between the channel's curve and the master's and truncates at the end; here each
    // step is a table of whole numbers, as 8-bit Photoshop does: they part by a little where gamma is steep
    const mean = sum / (W * H * 3);
    check(mean <= 1 && w <= 8, `levels (master with gamma 1.4, red and blue channels): close to psd-tools' drawing (mean ${mean.toFixed(2)}, worst ±${w})`);
  } else console.log('     (psd-tools is not installed: levels is not compared with it)');
}
{
  // curves, version 1 with the extra section: a straight master curve (0,64)-(255,192), and a 3-point red one
  const curve = (pts) => Buffer.concat([be(pts.length, 2), ...pts.flatMap(([i, o]) => [be(o, 2), be(i, 2)])]);
  const master = [[0, 64], [255, 192]], red = [[0, 0], [128, 200], [255, 255]];
  const data = Buffer.concat([Buffer.from([0]), be(1, 2), be(0b11, 4), curve(master), curve(red), Buffer.from('Crv ', 'latin1'), be(4, 2), be(2, 4), be(0, 2), curve(master), be(1, 2), curve(red)]);
  const r = read([pic, adj('curves', [['curv', data]])]), L = r.layers[0];
  const lin = (v) => 64 + (v * 128) / 255;
  const g = px(L, 0, H - 1), redAt = (x) => px(L, x, 0)[0];
  const x128 = Math.round((128 * (W - 1)) / 255);
  check(Math.abs(g[1] - Math.round(lin(255))) <= 1 && Math.abs(px(L, 0, 0)[1] - Math.round(lin(0))) <= 1 && Math.abs(redAt(W - 1) - 192) <= 1 && Math.abs(redAt(0) - 64) <= 1,
    `curves: the straight master curve maps green 0 → 64 and 255 → 192; red goes through its own curve, then the master's (red 255 → ${redAt(W - 1)}, 0 → ${redAt(0)})`);
  const mid = redAt(x128), want = Math.round(lin(200 * (Math.round((x128 * 255) / (W - 1)) / 128)));
  check(Math.abs(mid - lin(200)) <= 8, `curves: the red curve passes near its middle point (red ~128 → ~200 → master ${Math.round(lin(200))}; got ${mid}, ${want})`);
}
{
  // hue / saturation: master hue 180°, saturation 0, lightness 0 turns red into cyan; saturation −100 makes greys
  const hue = (colorize, cz, master) => Buffer.concat([be(2, 2), Buffer.from([colorize ? 1 : 0, 0]), ...cz.map((v) => be(v, 2)), ...master.map((v) => be(v, 2)), ...Array.from({ length: 6 }, () => Buffer.alloc(14))]);
  const red = { ...pic, pixel: (x, y) => (x < W / 2 ? [255, 0, 0, 255] : [40, 120, 200, 255]) };
  const a = read([red, adj('hue', [['hue2', hue(false, [0, 0, 0], [180, 0, 0])]])]).layers[0];
  const b = read([red, adj('grey', [['hue2', hue(false, [0, 0, 0], [0, -100, 0])]])]).layers[0];
  const c = read([red, adj('sepia', [['hue2', hue(true, [30, 25, 0], [0, 0, 0])]])]).layers[0];
  // lightness +25: a straight line over 0..255 towards white, cut to whole values: black becomes 63 (Photoshop's)
  const black = { ...pic, pixel: () => [0, 0, 0, 255] }, lit = px(read([black, adj('light', [['hue2', hue(false, [0, 0, 0], [0, 0, 25])]])]).layers[0], 1, 1);
  check(lit.slice(0, 3).join() === '63,63,63', `hue / saturation: lightness +25 turns black into 63 (${lit.slice(0, 3)})`);
  const g = px(b, W - 1, 0);
  check(px(a, 0, 0).slice(0, 3).join() === '0,255,255' && g[0] === g[1] && g[1] === g[2] && px(c, 0, 0)[0] > px(c, 0, 0)[2],
    `hue / saturation: hue 180° turns red cyan (${px(a, 0, 0).slice(0, 3)}), saturation −100 gives grey (${g.slice(0, 3)}), colorize gives a warm tone (${px(c, 0, 0).slice(0, 3)})`);
}
{
  // colour balance: midtones +100 towards red on mid grey, luminosity kept
  const grey = { ...pic, pixel: () => [128, 128, 128, 255] };
  const blnc = (keep) => Buffer.concat([...[0, 0, 0, 100, 0, 0, 0, 0, 0].map((v) => be(v, 2)), Buffer.from([keep ? 1 : 0])]);
  const a = px(read([grey, adj('balance', [['blnc', blnc(false)]])]).layers[0], 5, 5), b = px(read([grey, adj('balance', [['blnc', blnc(true)]])]).layers[0], 5, 5);
  const l = (c) => (Math.max(...c.slice(0, 3)) + Math.min(...c.slice(0, 3))) / 2;
  const r = read([grey, adj('balance', [['blnc', blnc(false)]])]);
  check(a[0] > 128 && a[1] === 128 && a[2] === 128 && b[0] > b[1] && Math.abs(l(b) - 128) <= 1 && r.notes.find((n) => n.code === 'layerAdjustmentBaked').vars.exact === false,
    `colour balance: midtones to red make grey redder (${a.slice(0, 3)}); with luminosity kept, as light as before (${b.slice(0, 3)}); said to be close, not exact`);
}
{
  // brightness / contrast, the legacy block: brightness +20, contrast 0 adds 20
  const brit = Buffer.concat([be(20, 2), be(0, 2), be(0, 2), Buffer.from([0])]);
  const L = read([pic, adj('bright', [['brit', brit]])]).layers[0];
  check(worst(L, ([a, b, c]) => [a, b, c].map((v) => Math.min(255, v + 20))) <= 1, 'brightness / contrast (legacy): brightness +20 adds 20');
}
// the rest (③): posterize, threshold and exposure against psd-tools; gradient map, black & white and
// photo filter by what they must do to known colours
const psdToolsDraw = (layers, name) => {
  const bytes = writePsd(W, H, layers, { composite: () => [255, 255, 255] }), file = path.join(OUT, `${name}.psd`);
  fs.writeFileSync(file, bytes);
  const ref = psdTools ? JSON.parse(execFileSync('python3', ['-c', `import sys, json, numpy as np
from psd_tools import PSDImage
p = PSDImage.open(sys.argv[1])
print(json.dumps(np.asarray(p.composite(force=True).convert('RGB')).astype(int).ravel().tolist()))`, file], { encoding: 'utf8', maxBuffer: 1 << 26 })) : null;
  return { L: importPsd(bytes, { inflate, keepPixels: true }).layers[0], ref };
};
const vsPsdTools = ({ L, ref }) => { let w = 0, sum = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = px(L, x, y), i = (y * W + x) * 3; for (let k = 0; k < 3; k++) { const d = Math.abs(a[k] - ref[i + k]); w = Math.max(w, d); sum += d; } } return { w, mean: sum / (W * H * 3) }; };
const short = (n) => Buffer.concat([be(n, 2), Buffer.alloc(2)]);
for (const [name, key, data, limit] of [['posterize', 'post', short(4), 1], ['threshold', 'thrs', short(128), 0], ['exposure', 'expA', (() => { const b = Buffer.alloc(14); b.writeUInt16BE(1, 0); b.writeFloatBE(0.8, 2); b.writeFloatBE(0.02, 6); b.writeFloatBE(1.2, 10); return b; })(), 2]]) {
  const got = psdToolsDraw([pic, adj(name, [[key, data]])], name);
  if (got.ref) { const d = vsPsdTools(got); check(d.w <= limit, `${name}: matches psd-tools' drawing (worst ±${d.w}, mean ${d.mean.toFixed(2)})`); }
  else check(true, `${name}: read (psd-tools is not installed)`);
}
{
  // gradient map: version 1, not reversed; name; colour stops (location 0..4096, midpoint %, mode, RGB 16-bit, 2 bytes)
  const stop = (at, mid, rgb) => Buffer.concat([be(at, 4), be(mid, 4), be(0, 2), ...[...rgb, 0].map((v) => { const x = Buffer.alloc(2); x.writeUInt16BE(v * 257); return x; }), Buffer.alloc(2)]); // 4 colour values (RGB and one unused), 2 bytes
  const grdm = (stops, rev = 0) => Buffer.concat([be(1, 2), Buffer.from([rev, 0]), be(0, 4), be(stops.length, 2), ...stops, be(0, 2), Buffer.alloc(32)]);
  const grey = { ...pic, pixel: (x) => [Math.round((x * 255) / (W - 1)), Math.round((x * 255) / (W - 1)), Math.round((x * 255) / (W - 1)), 255] };
  const bw = read([grey, adj('map', [['grdm', grdm([stop(0, 50, [0, 0, 0]), stop(4096, 50, [255, 255, 255])])]])]).layers[0];
  const duo = read([grey, adj('map', [['grdm', grdm([stop(0, 50, [255, 0, 0]), stop(4096, 50, [0, 0, 255])])]])]).layers[0];
  const rev = read([grey, adj('map', [['grdm', grdm([stop(0, 50, [255, 0, 0]), stop(4096, 50, [0, 0, 255])], 1)]])]).layers[0];
  const midX = Math.round((W - 1) / 2), m = px(duo, midX, 0);
  check(worst(bw, ([v]) => [v, v, v]) <= 1 && px(duo, 0, 0).slice(0, 3).join() === '255,0,0' && px(duo, W - 1, 0).slice(0, 3).join() === '0,0,255' && Math.abs(m[0] - m[2]) <= 6 && px(rev, 0, 0).slice(0, 3).join() === '0,0,255',
    `gradient map: black to white keeps the greys; red to blue maps dark to red, light to blue, the middle half and half (${m.slice(0, 3)}); reversed turns it round`);
}
{
  // black & white: a descriptor (version 16): class, the six colours (%), no tint; pure colours turn into their weight
  const uni = (s) => Buffer.concat([be(s.length, 4), ...[...s].map((c) => be(c.charCodeAt(0), 2))]);
  const id = (s) => Buffer.concat([be(s.length === 4 ? 0 : s.length, 4), Buffer.from(s, 'latin1')]);
  const long = (k, v) => Buffer.concat([id(k), Buffer.from('long', 'latin1'), be(v, 4)]);
  const items = [long('Rd  ', 40), long('Yllw', 60), long('Grn ', 40), long('Cyn ', 60), long('Bl  ', 20), long('Mgnt', 80), Buffer.concat([id('useTint'), Buffer.from('bool', 'latin1'), Buffer.from([0])])];
  const blwh = Buffer.concat([be(16, 4), uni(''), id('BanW'), be(items.length, 4), ...items]);
  const colours = { ...pic, pixel: (x) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [128, 128, 128]][Math.min(4, Math.floor(x / 13))].concat(255) };
  const L = read([colours, adj('bw', [['blwh', blwh]])]).layers[0], g = (x) => px(L, x, 0)[0];
  check(g(0) === 102 && g(13) === 102 && g(26) === 51 && g(39) === 153 && g(52) === 128 && px(L, 0, 0)[0] === px(L, 0, 0)[2],
    `black & white (the default weights): red ${g(0)}, green ${g(13)}, blue ${g(26)}, yellow ${g(39)} (40 / 40 / 20 / 60 %), grey stays ${g(52)}`);
}
{
  // photo filter, version 2: an RGB colour, density 0 changes nothing, 100 % multiplies by the colour
  const phfl = (dens) => Buffer.concat([be(2, 2), be(0, 2), ...[65535, 32768, 0, 0].map((v) => { const x = Buffer.alloc(2); x.writeUInt16BE(v); return x; }), be(dens, 4), Buffer.from([0])]);
  const zero = read([pic, adj('pf', [['phfl', phfl(0)]])]).layers[0], full = read([pic, adj('pf', [['phfl', phfl(100)]])]).layers[0];
  const f = px(full, W - 1, H - 1), p0 = picture(W - 1, H - 1);
  check(worst(zero, (c) => c) === 0 && f[0] === p0[0] && Math.abs(f[1] - Math.round(p0[1] * 32768 / 65535)) <= 1 && f[2] === 0, `photo filter: density 0 changes nothing; 100 % multiplies by the colour (${f.slice(0, 3)})`);
}
// which layers it reaches; its opacity; the old way
{
  const end = { name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] };
  const sq = (name, x, more = {}) => ({ name, left: x, top: 0, width: 16, height: 16, pixel: () => [100, 100, 100, 255], ...more });
  const r = read([sq('below', 0), end, sq('inFolder', 20), adj('folderInvert', [['nvrt', Buffer.alloc(0)]]), { name: 'folder', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0], blend: 'norm' },
    sq('base', 40), adj('clipInvert', [['nvrt', Buffer.alloc(0)]], { clipping: true }), sq('top', 50), adj('half', [['nvrt', Buffer.alloc(0)]], { opacity: 128 })]);
  const at = (n) => px(r.layers.find((l) => l.name === n), r.layers.find((l) => l.name === n).left, 0)[0];
  // folderInvert: only inFolder (its folder isolates). clipInvert: only base. half (opacity 128): everything below it, half way
  const half = (v) => Math.round(v + (255 - v - v) * 128 / 255); // inverted half way
  check(at('inFolder') === half(155) && at('below') === half(100) && at('base') === half(155) && at('top') === half(100),
    `reach: the folder's adjustment only inside it, the clipped one only its base, the half-opacity one everything below half way (below ${at('below')}, inFolder ${at('inFolder')}, base ${at('base')}, top ${at('top')})`);
  const off = importPsd(writePsd(W, H, [pic, adj('invert', [['nvrt', Buffer.alloc(0)]])]), { inflate, keepPixels: true, bakeAdjustments: false });
  check(off.notes.some((n) => n.code === 'layerAdjustment') && px(off.layers[0], 3, 3).join() === picture(3, 3).join(), 'bakeAdjustments: false: skipped with a note, as before');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall adjustment checks passed');
process.exit(failures ? 1 : 0);
