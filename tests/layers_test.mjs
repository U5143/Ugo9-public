// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Krita (.kra), OpenRaster (.ora) and a set of PNG files, read the way a PSD is
// (tools/import_layers.mjs): the PNG reader against Pillow's reading of every colour type
// (tests/layers/png, made by make_png.py), and .ora / .kra files written here (folders, hidden
// layers, opacity, blend modes, offsets, 8- and 16-bit and grey Krita layers, LZF tiles, a
// transparency mask, layers that keep no pixels) read back pixel for pixel. With KRITA_DATA
// (a Krita source checkout) or MYPAINT_DATA set, their test files are read too and drawn
// against the merged picture the file keeps.
//   node tests/layers_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importKra, importKraAsync, importOra, importOraAsync, importPngSet, importPngSetAsync, decodePng, decodePngAsync, layeredKind, readZip } from '../tools/import_layers.mjs';
import { importPsd } from '../tools/import_psd.mjs';
import { encodePng } from '../tools/png.mjs';
import { compileUgo } from '../tools/compile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const node = { inflate: (b) => zlib.inflateSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// ---- PNG: every colour type and depth, as Pillow reads them ----
{
  const dir = path.join(HERE, 'layers', 'png'), want = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const bad = [];
  for (const [name, h] of Object.entries(want)) {
    const png = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)), node);
    if (sha(png.rgba) !== h) bad.push(name);
  }
  check(!bad.length, `PNG: ${Object.keys(want).length} colour types / depths read as Pillow reads them${bad.length ? ` (differ: ${bad.join(', ')})` : ''}`);
  // interlaced (Adam7): written here, every pass and filter
  const W = 13, H = 11, rgba = new Uint8Array(W * H * 4).map((_, i) => (i * 37 + (i >> 2) * 11) & 255);
  check(sha(decodePng(interlaced(W, H, rgba), node).rgba) === sha(rgba), 'PNG: interlaced (Adam7, 13×11) reads back the same pixels');
  const a = await decodePngAsync(fs.readFileSync(path.join(dir, 'palette_trns.png')));
  check(sha(a.rgba) === want.palette_trns, 'PNG in the browser way (DecompressionStream): the same pixels');
  let e = null; try { decodePng(new Uint8Array(40), node); } catch (x) { e = x; }
  check(e?.code === 'pngBad', 'not a PNG: pngBad');
}

// ---- files written here ----
const W = 96, H = 80;
const pic = (w, h, f) => { const p = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.set(f(x, y), (y * w + x) * 4); return p; };
const body = pic(40, 50, (x, y) => [200, 120 + (x & 15), 90 + (y & 7), (x + y) % 11 ? 255 : 128]);
const eye = pic(10, 6, (x, y) => [20 + x, 40, 200 - y, 255]);
const shade = pic(30, 20, (x, y) => [60, 60, 120, x < 15 ? 255 : 90]);
const hidden = pic(8, 8, () => [255, 0, 0, 255]);
const at = (img, w, x, y) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
// a layer of the result against its picture: the same pixels where the source has any
const same = (L, src, sw, sh, left, top) => {
  if (!L?.rgba) return false;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const s = at(src, sw, x, y), lx = left + x - L.left, ly = top + y - L.top;
    if (lx < 0 || ly < 0 || lx >= L.width || ly >= L.height) { if (s[3]) return false; continue; }
    const d = at(L.rgba, L.width, lx, ly);
    if (s[3] !== d[3] || (s[3] && [0, 1, 2].some((k) => Math.abs(s[k] - d[k]) > 1))) return false;
  }
  return true;
};

// ZIP: stored or deflated entries, the mimetype first and stored (as both formats want)
function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, data0, store] of files) {
    const data = Buffer.from(data0), nm = Buffer.from(name), comp = store ? data : zlib.deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(store ? 0 : 8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, comp); central.push(c, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

// ---- OpenRaster ----
{
  const png = (w, h, p) => encodePng(w, h, p);
  const stack = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.6" w="${W}" h="${H}">
 <stack>
  <layer name="secret" src="data/hidden.png" x="2" y="2" visibility="hidden"/>
  <stack name="顔 &amp; 目" opacity="0.8" visibility="visible">
   <layer name="shade" src="data/shade.png" x="30" y="40" opacity="0.5" composite-op="svg:multiply"/>
   <layer name="eye" src="data/eye.png" x="-3" y="12"/>
  </stack>
  <layer name="glow" src="data/eye.png" x="70" y="70" composite-op="svg:color-dodge"/>
  <layer name="body" src="data/body.png" x="20" y="25"/>
 </stack>
</image>`;
  const bytes = zip([['mimetype', 'image/openraster', true], ['stack.xml', stack], ['data/body.png', png(40, 50, body)], ['data/eye.png', png(10, 6, eye)],
    ['data/shade.png', png(30, 20, shade), true], ['data/hidden.png', png(8, 8, hidden)], ['mergedimage.png', png(4, 4, new Uint8Array(64))]]);
  const r = importOra(bytes, { ...node, keepPixels: true }), L = (n) => r.layers.find((l) => l.name === n);
  check(layeredKind(bytes) === 'ora' && r.layers.map((l) => l.name).join() === 'body,glow,eye,shade,secret', `ORA: bottom first, as the stack lists them top first (${r.layers.map((l) => l.name).join(', ')})`);
  check(same(L('body'), body, 40, 50, 20, 25) && same(L('eye'), eye, 10, 6, -3, 12) && same(L('shade'), shade, 30, 20, 30, 40), 'ORA: pixels and offsets (one off the left edge) as written');
  check(r.groups.length === 1 && r.groups[0].name === '顔 & 目' && L('eye').path.join('/') === '顔 & 目/eye' && Math.abs(r.groups[0].opacity - 0.8) < 0.01, 'ORA: a stack is a group (its name with an entity, its opacity)');
  const part = (n) => r.model.parts.find((p) => p.id === n);
  check(part('shade').blend === 'multiply' && Math.abs(part('shade').opacity - 0.5) < 1e-6 && part('secret').opacity === 0 && !part('glow').blend, 'ORA: multiply, opacity 0.5, a hidden layer at opacity 0, color-dodge drawn as normal');
  check(r.notes.some((n) => n.code === 'layerBlend' && n.vars.blend === 'color-dodge') && r.notes.some((n) => n.code === 'layerHidden'), `ORA: notes say what is not kept (${r.notes.map((n) => n.code).join(', ')})`);
  check(compileUgo(r.model).byteLength > 0, 'ORA: the model compiles');
  const a = await importOraAsync(bytes, { keepPixels: true });
  check(JSON.stringify(a.model) === JSON.stringify(r.model), 'ORA in the browser way (DecompressionStream): the same model');
  let e = null; try { importOra(zip([['mimetype', 'image/openraster', true]]), node); } catch (x) { e = x; }
  check(e?.code === 'layersNoStack', 'ORA without stack.xml: layersNoStack');
}

// ---- Krita ----
function lzfPack(src) { // a simple LZF writer: back references of 3 bytes or more, else literals
  const out = [], table = new Map();
  let lit = [];
  const flush = () => { while (lit.length) { const n = Math.min(32, lit.length); out.push(n - 1, ...lit.splice(0, n)); } };
  for (let i = 0; i < src.length;) {
    const key = i + 2 < src.length ? src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) : -1, ref = table.get(key);
    if (key >= 0) table.set(key, i);
    if (ref !== undefined && i - ref - 1 < 8192) {
      let len = 0; while (i + len < src.length && len < 264 && src[ref + len] === src[i + len]) len++;
      if (len >= 3) {
        flush(); const off = i - ref - 1, l = len - 2;
        if (l < 7) out.push((l << 5) | (off >> 8), off & 255); else out.push((7 << 5) | (off >> 8), l - 7, off & 255);
        i += len; continue;
      }
    }
    lit.push(src[i++]);
  }
  flush();
  return Uint8Array.from(out);
}
// a paint device: 64×64 tiles, each channel's plane in turn; ps bytes a pixel; px(x, y) -> its bytes
function device(w, h, ps, px, { lzf = true, origin = [0, 0] } = {}) {
  const parts = [], tiles = [];
  for (let ty = Math.floor(origin[1] / 64) * 64; ty < origin[1] + h; ty += 64) for (let tx = Math.floor(origin[0] / 64) * 64; tx < origin[0] + w; tx += 64) {
    const raw = new Uint8Array(64 * 64 * ps);
    let any = false;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const X = tx + x - origin[0], Y = ty + y - origin[1];
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const p = px(X, Y);
      for (let c = 0; c < ps; c++) { raw[c * 4096 + y * 64 + x] = p[c]; if (p[c]) any = true; }
    }
    if (!any) continue;
    const data = lzf ? Uint8Array.from([1, ...lzfPack(raw)]) : Uint8Array.from([0, ...raw]);
    tiles.push(Buffer.concat([Buffer.from(`${tx},${ty},LZF,${data.length}\n`), Buffer.from(data)]));
  }
  parts.push(Buffer.from(`VERSION 2\nTILEWIDTH 64\nTILEHEIGHT 64\nPIXELSIZE ${ps}\nDATA ${tiles.length}\n`), ...tiles);
  return Buffer.concat(parts);
}
{
  const bgra = (img, w) => (x, y) => { const [r, g, b, a] = at(img, w, x, y); return [b, g, r, a]; };
  const bgra16 = (img, w) => (x, y) => { const [r, g, b, a] = at(img, w, x, y); return [b, b, g, g, r, r, a, a].map((v, i) => (i % 2 ? v : (v * 3) & 255)); }; // v * 257 + small: the high byte is v
  const grey = pic(20, 20, (x, y) => [x * 12, x * 12, x * 12, y < 10 ? 255 : 100]);
  const mask = (x, y) => [x < 20 ? 255 : 0]; // the left half of body kept
  const maindoc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DOC PUBLIC '-//KDE//DTD krita 2.0//EN' 'http://www.calligra.org/DTD/krita-2.0.dtd'>
<DOC xmlns="http://www.calligra.org/DTD/krita" editor="Krita" syntaxVersion="2" kritaVersion="5.2.0">
 <IMAGE width="${W}" height="${H}" colorspacename="RGBA" name="テスト" mime="application/x-kra">
  <layers>
   <layer name="text" nodetype="shapelayer" filename="layer9" visible="1" opacity="255" x="0" y="0" compositeop="normal"/>
   <layer name="levels" nodetype="adjustmentlayer" filename="layer8" visible="1" opacity="255" x="0" y="0" compositeop="normal"/>
   <layer name="face" nodetype="grouplayer" filename="layer5" visible="1" opacity="200" passthrough="1" x="0" y="0" compositeop="normal">
    <layers>
     <layer name="shade" nodetype="paintlayer" colorspacename="RGBA16" filename="layer7" visible="1" opacity="128" x="30" y="40" compositeop="multiply"/>
     <layer name="eye" nodetype="paintlayer" colorspacename="RGBA" filename="layer6" visible="0" opacity="255" x="70" y="-2" compositeop="normal"/>
    </layers>
   </layer>
   <layer name="grey" nodetype="paintlayer" colorspacename="GRAYA" filename="layer4" visible="1" opacity="255" x="0" y="60" compositeop="screen"/>
   <layer name="body" nodetype="paintlayer" colorspacename="RGBA" filename="layer3" visible="1" opacity="255" x="20" y="25" compositeop="normal">
    <masks>
     <mask name="cut" nodetype="transparencymask" filename="mask2" visible="1" x="20" y="25"/>
     <mask name="blur" nodetype="filtermask" filename="mask10" visible="1" x="0" y="0"/>
    </masks>
   </layer>
  </layers>
 </IMAGE>
</DOC>`;
  const d = 'テスト/layers/';
  const bytes = zip([['mimetype', 'application/x-krita', true], ['maindoc.xml', maindoc],
    [`${d}layer3`, device(40, 50, 4, bgra(body, 40), { origin: [0, 0] })], [`${d}layer3.defaultpixel`, new Uint8Array(4)],
    [`${d}mask2.pixelselection`, device(40, 50, 1, mask)], [`${d}mask2.pixelselection.defaultpixel`, new Uint8Array(1)],
    [`${d}layer4`, device(20, 20, 2, (x, y) => [grey[(y * 20 + x) * 4], grey[(y * 20 + x) * 4 + 3]], { lzf: false })],
    [`${d}layer6`, device(10, 6, 4, bgra(eye, 10))], [`${d}layer7`, device(30, 20, 8, bgra16(shade, 30))],
    ['mergedimage.png', encodePng(4, 4, new Uint8Array(64))]]);
  const r = importKra(bytes, { ...node, keepPixels: true }), L = (n) => r.layers.find((l) => l.name === n);
  check(layeredKind(bytes) === 'kra' && r.layers.map((l) => l.name).join() === 'body,grey,eye,shade', `Krita: paint layers bottom first (${r.layers.map((l) => l.name).join(', ')})`);
  const cut = pic(40, 50, (x, y) => (x < 20 ? at(body, 40, x, y) : [0, 0, 0, 0]));
  check(same(L('body'), cut, 40, 50, 20, 25), 'Krita: 8-bit RGBA from LZF tiles, at its offset, with its transparency mask (the right half cut away)');
  check(same(L('grey'), grey, 20, 20, 0, 60) && same(L('shade'), shade, 30, 20, 30, 40) && same(L('eye'), eye.map((v, i) => (i < 2 * 10 * 4 ? 0 : v)), 10, 6, 70, -2) && L('eye').top === 0,
    'Krita: grey (tiles kept as they are), 16-bit RGBA, and a layer above the canvas (cut at its edge): the same pixels');
  const part = (n) => r.model.parts.find((p) => p.id === n);
  check(part('shade').blend === 'multiply' && Math.abs(part('shade').opacity - 128 / 255) < 1e-3 && part('grey').blend === 'screen' && part('eye').opacity === 0, 'Krita: multiply, opacity 128/255, screen, a hidden layer at opacity 0');
  check(r.groups.length === 1 && r.groups[0].name === 'face' && r.groups[0].blend === 'passThrough' && L('eye').path.join('/') === 'face/eye', 'Krita: a group layer is a group (pass-through)');
  const codes = r.notes.map((n) => `${n.code}${n.vars.kind ? `:${n.vars.kind}` : ''}`).join(' ');
  check(/layerNoPixels:shapelayer/.test(codes) && /layerAdjustment/.test(codes) && /layerMaskSkipped:filtermask/.test(codes), `Krita: what is left out is said (${codes})`);
  check(compileUgo(r.model).byteLength > 0, 'Krita: the model compiles');
  const a = await importKraAsync(bytes, { keepPixels: true });
  check(JSON.stringify(a.model) === JSON.stringify(r.model), 'Krita in the browser way (DecompressionStream): the same model');
  const old = zip([['mimetype', 'application/x-krita', true], ['maindoc.xml', '<DOC syntaxVersion="1"><IMAGE width="4" height="4" name="x"><LAYERS/></IMAGE></DOC>']]);
  const cmyk = zip([['mimetype', 'application/x-krita', true], ['maindoc.xml', maindoc.replace(/colorspacename="RGBA(16)?"/g, 'colorspacename="CMYK"').replace(/colorspacename="GRAYA"/, 'colorspacename="CMYK"')]]);
  const err = (b) => { try { importKra(b, node); return null; } catch (x) { return x; } };
  check(err(old)?.code === 'layersKraOld' && err(cmyk)?.code === 'layersNone' && err(cmyk).vars.reasons.includes('layerColorSpace'), 'Krita 1 file: layersKraOld; only CMYK layers: layersNone, saying layerColorSpace');
}

// ---- Krita filter layers: applied to the layers below them in their group ----
{
  const flat = (w, h, c) => pic(w, h, () => c);
  const doc = (filters) => `<?xml version="1.0" encoding="UTF-8"?>
<DOC xmlns="http://www.calligra.org/DTD/krita" editor="Krita" syntaxVersion="2">
 <IMAGE width="40" height="20" colorspacename="RGBA" name="f">
  <layers>
   ${filters.map(([n, f, op]) => `<layer name="${n}" nodetype="adjustmentlayer" filtername="${f}" filename="${n}" visible="1" opacity="${op ?? 255}" x="0" y="0" compositeop="normal"/>`).join('\n   ')}
   <layer name="g" nodetype="grouplayer" filename="g" visible="1" opacity="255" x="0" y="0" compositeop="normal">
    <layers>
     <layer name="inner" nodetype="adjustmentlayer" filtername="invert" filename="inner" visible="1" opacity="255" x="0" y="0" compositeop="normal"/>
     <layer name="a" nodetype="paintlayer" colorspacename="RGBA" filename="a" visible="1" opacity="255" x="0" y="0" compositeop="normal"/>
    </layers>
   </layer>
   <layer name="b" nodetype="paintlayer" colorspacename="RGBA" filename="b" visible="1" opacity="255" x="20" y="0" compositeop="normal"/>
  </layers>
 </IMAGE>
</DOC>`;
  const conf = (params) => `<!DOCTYPE params>\n<params version="1">${Object.entries(params).map(([k, v]) => `<param type="string" name="${k}"><![CDATA[${v}]]></param>`).join('')}</params>`;
  const kra = (filters, confs) => zip([['mimetype', 'application/x-krita', true], ['maindoc.xml', doc(filters)],
    ['f/layers/a', device(20, 20, 4, () => [50, 100, 200, 255])], ['f/layers/b', device(20, 20, 4, () => [50, 100, 200, 255])], ['f/layers/inner.filterconfig', '<!DOCTYPE params>\n<params version="0"/>'],
    ...Object.entries(confs).map(([n, c]) => [`f/layers/${n}.filterconfig`, conf(c)])]);
  const colour = (r, n) => { const L = r.layers.find((l) => l.name === n); return [...L.rgba.subarray(0, 3)]; };
  const r = importKra(kra([], {}), { ...node, keepPixels: true });
  // the paint layers are (200, 100, 50) (Krita keeps blue first: the bytes 50, 100, 200)
  check(colour(r, 'a').join() === '55,155,205' && colour(r, 'b').join() === '200,100,50' && r.notes.some((n) => n.code === 'layerAdjustmentBaked' && n.vars.kind === 'invert'),
    `Krita: an invert filter layer inside a group changes only the layer below it in the group (a ${colour(r, 'a')}; b, outside it, stays ${colour(r, 'b')})`);
  // above everything: HSV adjustment (HSL, hue 180) at full opacity, levels (output 0..128) at half
  const r2 = importKra(kra([['hue', 'hsvadjustment'], ['lev', 'levels', 128]], { hue: { h: 180, s: 0, v: 0, type: 1, colorize: 'false' }, lev: { blackvalue: 0, whitevalue: 255, gammavalue: 1, outblackvalue: 0, outwhitevalue: 128 } }), { ...node, keepPixels: true });
  // order: lev is the bottom one of the two (applied first), then hue: b = hue(lev(200,100,50) half way)
  const lev = [200, 100, 50].map((v) => Math.round(v + (Math.round(v * 128 / 255) - v) * 128 / 255)), b2 = colour(r2, 'b');
  const kinds = r2.notes.filter((n) => n.code === 'layerAdjustmentBaked').map((n) => `${n.vars.kind}:${n.vars.layers}:${n.vars.exact}`);
  check(Math.abs(b2[0] - lev[2]) <= 2 && Math.abs(b2[2] - lev[0]) <= 2 && kinds.join() === 'invert:1:true,levels:2:false,hueSaturation:2:false',
    `Krita: filter layers above everything reach the layers in the group too; levels at half opacity, then hue 180° (b ${b2}, from ${lev}); said to be close (${kinds.join(', ')})`);
  void flat;
}
// ---- a set of PNG files ----
{
  const files = [{ path: 'body.png', bytes: encodePng(40, 50, body), left: 20, top: 25 }, { path: '顔/eye.png', bytes: encodePng(10, 6, eye) }, { path: '顔/shade.png', bytes: encodePng(W, H, pic(W, H, (x, y) => (x >= 30 && x < 60 && y >= 40 && y < 60 ? at(shade, 30, x - 30, y - 40) : [0, 0, 0, 0]))), blend: 'multiply' }];
  const r = importPngSet(files, { ...node, keepPixels: true }), L = (n) => r.layers.find((l) => l.name === n);
  check(r.model.canvas.width === W && r.model.canvas.height === H && r.layers.map((l) => l.name).join() === 'body,eye,shade', `PNG set: bottom first, the canvas the largest picture (${r.model.canvas.width}×${r.model.canvas.height})`);
  check(same(L('body'), body, 40, 50, 20, 25) && same(L('shade'), shade, 30, 20, 30, 40) && L('eye').path.join('/') === '顔/eye' && r.groups[0].name === '顔', 'PNG set: pixels, places, a folder as a group, the empty canvas around a picture cut away');
  const a = await importPngSetAsync(files, { keepPixels: true });
  check(JSON.stringify(a.model) === JSON.stringify(r.model) && r.model.parts.find((p) => p.id === 'shade').blend === 'multiply', 'PNG set in the browser way: the same model; a blend given with a file is kept');
}

// ---- the same layers as a PSD give the same model ----
{
  const { writePsd } = await import('./psd/make_big.mjs');
  const sq = (name, left, top, w, h, img) => ({ name, left, top, width: w, height: h, pixel: (x, y) => at(img, w, x, y) });
  const psd = importPsd(writePsd(W, H, [sq('body', 20, 25, 40, 50, body), sq('eye', 3, 12, 10, 6, eye)]), node);
  const set = importPngSet([{ path: 'body.png', bytes: encodePng(40, 50, body), left: 20, top: 25 }, { path: 'eye.png', bytes: encodePng(10, 6, eye), left: 3, top: 12 }, { path: 'pad.png', bytes: encodePng(W, H, new Uint8Array(W * H * 4)) }], node);
  check(JSON.stringify(set.model.parts.slice(0, 2)) === JSON.stringify(psd.model.parts) && sha(set.atlas.rgba) === sha(psd.atlas.rgba), 'the same two layers as a PSD and as PNG files: the same parts and atlas');
}

// ---- other programs' files, where a checkout is given ----
const merged = (bytes) => { const z = readZip(bytes), e = z.entries.get('mergedimage.png'); if (!e) return null; const v = new DataView(z.bytes.buffer, z.bytes.byteOffset), s = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true), raw = z.bytes.subarray(s, s + e.csize); return decodePng(e.method ? zlib.inflateRawSync(raw) : raw, node); };
function drawn(r) { // the visible layers over each other (normal, multiply, screen, add), as the merged picture
  const { width: w, height: h } = r.model.canvas, out = new Float64Array(w * h * 4);
  for (const L of r.layers) {
    if (!L.visible || !L.rgba) continue;
    for (let y = Math.max(0, -L.top); y < Math.min(L.height, h - L.top); y++) for (let x = Math.max(0, -L.left); x < Math.min(L.width, w - L.left); x++) {
      const i = (y * L.width + x) * 4, j = ((L.top + y) * w + L.left + x) * 4, a = (L.rgba[i + 3] / 255) * L.opacity, ab = out[j + 3];
      if (!a) continue;
      for (let k = 0; k < 3; k++) { const s = L.rgba[i + k] / 255, d = out[j + k], bl = L.blend === 'multiply' ? s * d : L.blend === 'screen' ? s + d - s * d : L.blend === 'add' ? Math.min(1, s + d) : s; out[j + k] = (((1 - ab) * s + ab * bl) * a + d * ab * (1 - a)) / (a + ab * (1 - a)); }
      out[j + 3] = a + ab * (1 - a);
    }
  }
  return out;
}
for (const [env, list] of [['KRITA_DATA', ['plugins/impex/libkra/tests/data/single_layer_no_channel_flags_transp_def_pixel.kra', 'libs/ui/tests/data/flood_fill_16bit.kra', 'plugins/impex/jxl/tests/data/results/jxl-multipage.kra', 'krita/data/templates/texture/Texture256x2568bitsrgb.kra']], ['MYPAINT_DATA', ['tests/smallimage.ora']]]) {
  const root = process.env[env];
  if (!root) { console.log(`     (${env} is not set: ${env === 'KRITA_DATA' ? 'Krita' : 'MyPaint'}'s own files are not read)`); continue; }
  for (const f of list) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { console.log(`     (${f}: not there)`); continue; }
    const bytes = fs.readFileSync(p), r = (f.endsWith('.kra') ? importKra : importOra)(bytes, { ...node, keepPixels: true, maxCanvas: 0 }), m = merged(bytes);
    if (!m || m.width !== r.model.canvas.width) { check(r.layers.length > 0, `${f}: read (${r.layers.length} layers; no merged picture of the canvas size to draw against)`); continue; }
    const out = drawn(r);
    let worst = 0;
    for (let q = 0; q < out.length; q += 4) worst = Math.max(worst, Math.abs(out[q + 3] * 255 - m.rgba[q + 3]), ...(m.rgba[q + 3] ? [0, 1, 2].map((k) => Math.abs(out[q + k] * 255 - m.rgba[q + k])) : [0]));
    check(worst <= 2, `${f}: its layers drawn over each other match the merged picture it keeps (worst ${worst.toFixed(1)}/255)`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall layered file checks passed');
process.exit(failures ? 1 : 0);

// Adam7 PNG, written here (filters per row: none, sub, up, average, paeth in turn)
function interlaced(w, h, rgba) {
  const rows = [];
  let f = 0;
  for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    let prev = new Uint8Array(pw * 4);
    for (let y = 0; y < ph; y++) {
      const cur = new Uint8Array(pw * 4);
      for (let x = 0; x < pw; x++) cur.set(rgba.subarray(((y0 + y * dy) * w + x0 + x * dx) * 4, ((y0 + y * dy) * w + x0 + x * dx) * 4 + 4), x * 4);
      const kind = f++ % 5, out = new Uint8Array(cur.length + 1);
      out[0] = kind;
      for (let i = 0; i < cur.length; i++) {
        const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out[i + 1] = (cur[i] - [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][kind]) & 255;
      }
      rows.push(out); prev = cur;
    }
  }
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); Buffer.from(data).copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 1;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}
