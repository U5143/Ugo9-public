// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// SVG drawings as parts (tools/import_svg.mjs, 利用者の声 #14), drawn by headless Chromium's own SVG
// renderer: one part per top-level element, named by its Inkscape label, <title> or id; an Inkscape
// layer is a group of parts; the drawing's <defs> (a gradient) reach every part; parents' transforms
// apply; a hidden layer is imported hidden; the size from mm and from the viewBox; outside pictures,
// text and <foreignObject> said; broken input refused with a code. Then the parts drawn by ugo_export
// put the picture back together.
//   node tests/import_svg_test.mjs        (needs Playwright's Chromium; the picture needs build/ugo_export)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importSvgAsync, svgLayers } from '../tools/import_svg.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { encodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'import_svg_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
// Chromium draws the SVG: the same steps as the browser default in tools/import_svg.mjs
const rasterize = async (svg, w, h) => Uint8Array.from(await page.evaluate(async ([s, W, H]) => {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  return Array.from(g.getImageData(0, 0, W, H).data);
}, [svg, w, h]));

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a test drawing -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="160" height="120" viewBox="0 0 80 60">
  <defs><linearGradient id="grad"><stop offset="0" stop-color="#00ff00"/><stop offset="1" stop-color="#00ff00"/></linearGradient></defs>
  <rect id="back" x="0" y="0" width="80" height="60" fill="#ffffff"/>
  <circle cx="20" cy="20" r="10" fill="#0000ff"><title>目</title></circle>
  <g inkscape:groupmode="layer" inkscape:label="体" transform="translate(40 30)">
    <rect inkscape:label="胴" x="0" y="0" width="20" height="10" fill="url(#grad)"/>
    <rect id="tail" x="25" y="0" width="5" height="5" fill="#ff0000"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="下書き" style="display:none"><rect id="sketch" width="5" height="5" fill="#000"/></g>
</svg>`;

{
  const L = svgLayers(SVG);
  check(L.width === 160 && L.height === 120 && L.layers.map((l) => `${l.group ? l.group + '/' : ''}${l.name}`).join() === 'back,目,体/胴,体/tail,下書き/sketch' && L.layers.find((l) => l.name === 'sketch').hidden,
    `the parts: ${L.layers.map((l) => `${l.group ? l.group + '/' : ''}${l.name}`).join(', ')} (names from the id, <title> and Inkscape label; the layers as groups; the sketch layer hidden); 160×120`);
  const mm = svgLayers('<svg xmlns="http://www.w3.org/2000/svg" width="25.4mm" viewBox="0 0 10 5"><rect width="1" height="1"/></svg>');
  check(mm.width === 96 && mm.height === 48, `the size in mm (25.4 mm = 96 px) and the height from the viewBox (${mm.width}×${mm.height})`);
}
const res = await importSvgAsync(SVG, { rasterize, keepPixels: true });
{
  const part = (n) => res.layers.find((l) => l.name === n), px = (L, x, y) => { const i = ((y - L.top) * L.width + (x - L.left)) * 4; return [...L.rgba.subarray(i, i + 4)]; };
  const eye = part('目'), torso = part('胴'), tail = part('tail');
  let blue = 0; for (let i = 3; i < eye.rgba.length; i += 4) if (eye.rgba[i] > 128) blue++;
  check(res.model.parts.length === 5 && res.groups.some((g) => g.name === '体') && Math.abs(blue - Math.PI * 400) < 60 && px(eye, 40, 40).join() === '0,0,255,255',
    `5 parts and the group 体; the eye drawn at twice the viewBox (${blue} px, a circle of radius 20 is ${Math.round(Math.PI * 400)}), blue in its middle`);
  check(px(torso, 100, 70).join() === '0,255,0,255' && px(tail, 135, 65).join() === '255,0,0,255',
    'the gradient from <defs> reaches its part (green), the layer\'s translate(40 30) moves its parts (the tail at 130..140, 60..70)');
  check(part('sketch')?.visible === false && res.notes.some((n) => n.code === 'layerHidden'), 'the hidden layer: imported hidden (layerHidden)');
}
{
  const text = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20"><image href="https://example.com/a.png" width="10" height="10"/><text x="2" y="15">Hi</text><foreignObject width="5" height="5"/><rect width="4" height="4"/></svg>';
  const r = await importSvgAsync(text, { rasterize }), codes = r.notes.map((n) => n.code);
  check(codes.includes('svgExternal') && codes.includes('svgText') && codes.includes('svgForeignObject') && r.model.parts.length >= 2, `an outside picture, text and <foreignObject>: said (${codes.filter((c) => c.startsWith('svg')).join(', ')})`);
  const bad = [];
  for (const s of ['not svg at all', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs/></svg>']) {
    try { await importSvgAsync(s, { rasterize }); bad.push('none'); } catch (e) { bad.push(e.code); }
  }
  check(bad.join() === 'svgNotSvg,svgNoSize,svgEmpty', `refused with a code: ${bad.join(', ')}`);
}
await browser.close();
// the parts drawn by ugo_export: the picture put back together
const exe = findExporter();
if (exe) {
  fs.writeFileSync(path.join(OUT, 'model.ug9'), new Uint8Array(compileUgo(res.model)));
  res.atlases.forEach((a, i) => fs.writeFileSync(path.join(OUT, res.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
  execFileSync(exe, [path.join(OUT, 'model.ug9'), '--frames', '1', '--size', '160x120', '--format', 'raw', '--out', path.join(OUT, 'f.rgba')], { stdio: 'ignore' });
  const f = fs.readFileSync(path.join(OUT, 'f.rgba')), p = (x, y) => [...f.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 3)];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
  check(near(p(40, 40), [0, 0, 255]) && near(p(100, 70), [0, 255, 0]) && near(p(135, 65), [255, 0, 0]) && near(p(5, 110), [255, 255, 255]),
    'ugo_export: the parts put the drawing back together (blue eye, green torso, red tail, white back)');
} else console.log('skip the picture: build/ugo_export not built');

console.log(failures ? `\n${failures} check(s) failed` : '\nall SVG checks passed');
process.exit(failures ? 1 : 0);
