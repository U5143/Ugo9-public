// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The moved picture as a PSD (tools/export_pose_psd.mjs, 機能の比べ #15): the sample in a pose, a layer per part,
// read back by our PSD reader: the layers put together give the core's own picture of the whole model; masks still
// cut (an iris stays inside its eye white); the pose is the one asked for; frames of an animation become folders,
// all but the first hidden, and an eye closes in them; layers per PSD folder; a part's blend mode becomes the layer's.
//   node tests/export_pose_psd_test.mjs   (needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { exportPosePsd } from '../tools/export_pose_psd.mjs';
import { readPsd } from '../tools/import_psd.mjs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { sp } from './sample_names.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const read = (r) => readPsd(r.psd, { inflate: (x) => zlib.inflateSync(x) });
const MODEL = 'samples/basic/model.ug9';

// the layers over each other (straight alpha, normal), on a W×H canvas: premultiplied 0..1
function composite(layers, W, H) {
  const out = new Float32Array(W * H * 4);
  for (const L of layers) {
    if (!L.width || L.visible === false) continue;
    for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) {
      const i = (y * L.width + x) * 4, a = L.rgba[i + 3] / 255, o = ((L.top + y) * W + L.left + x) * 4;
      if (!a) continue;
      for (let c = 0; c < 3; c++) out[o + c] = (L.rgba[i + c] / 255) * a + out[o + c] * (1 - a);
      out[o + 3] = a + out[o + 3] * (1 - a);
    }
  }
  return out;
}
function differ(A, B) { let most = 0, sum = 0; for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]) * 255; most = Math.max(most, d); sum += d; } return { most, mean: sum / A.length }; }

// a pose, a layer per part, and the whole model as one layer
const pose = { params: { [sp('AngleX')]: 20, MouthOpen: 1 } };
const parts = exportPosePsd(MODEL, pose), whole = exportPosePsd(MODEL, { ...pose, by: 'whole' });
const P = read(parts), Wl = read(whole), W = P.width, H = P.height;
check(P.layers.length === 16 && P.layers.map((l) => l.name).join() === 'hairBack,body,neck,face,eyeWhiteL,irisL,eyeClosedL,eyeWhiteR,irisR,eyeClosedR,mouth,hairSideL,hairSideR,bangs,browL,browR'
  && Wl.layers.length === 1 && W === 420 && H === 600 && !P.warnings.length,
  `a layer per part in drawing order (${P.layers.length}; the closed eyes are there, empty), read back without warnings`);
const d = differ(composite(P.layers, W, H), composite(Wl.layers, W, H));
check(d.most <= 24 && d.mean < 0.05, `the parts' layers put together give the core's picture of the whole model (most ${d.most.toFixed(1)}/255 at edges, mean ${d.mean.toFixed(3)})`);
const L = Object.fromEntries(P.layers.map((l) => [l.name, l]));
const at = (l, x, y) => (x >= l.left && y >= l.top && x < l.left + l.width && y < l.top + l.height ? l.rgba[((y - l.top) * l.width + x - l.left) * 4 + 3] : 0);
let iris = 0, outside = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(L.irisL, x, y) > 8) { iris++; if (!at(L.eyeWhiteL, x, y)) outside++; }
check(iris > 500 && outside === 0, `masks still cut: the iris's ${iris} pixels are all inside its eye white`);
const rest = read(exportPosePsd(MODEL, {})), face0 = rest.layers.find((l) => l.name === 'face'), mouth0 = rest.layers.find((l) => l.name === 'mouth');
check(L.face.left !== face0.left && L.mouth.height > mouth0.height, `the pose asked for: the face moved (${face0.left} → ${L.face.left}), the mouth opened (${mouth0.height} → ${L.mouth.height} px tall)`);

// frames of an animation: folders, all but the first hidden; the eyes close at 2.08 s in idle
const fr = exportPosePsd(MODEL, { anim: 'idle', frames: 4, fps: 25, start: 2.0 }), F = read(fr);
const folders = [...new Set(F.layers.map((l) => l.groupObjs?.[0]?.name))];
const closed = (f) => F.layers.find((l) => l.name === 'eyeClosedL' && (l.groupObjs?.[0]?.name) === `idle 00${f}`)?.width > 0;
check(F.layers.length === 64 && folders.join() === 'idle 000,idle 001,idle 002,idle 003' && !closed(0) && [1, 2, 3].some(closed),
  `4 frames → 4 folders of 16 layers; the eyes are open in the first, closed in a later one (${[0, 1, 2, 3].map((f) => (closed(f) ? 'closed' : 'open')).join(', ')})`);
const hiddenOf = (f) => F.layers.filter((l) => (l.groupObjs?.[0]?.name) === `idle 00${f}`).every((l) => l.groupObjs?.[0]?.visible === false);
check(!hiddenOf(0) && [1, 2, 3].every(hiddenOf), 'the first frame shows, the others are hidden');
const fw = read(exportPosePsd(MODEL, { anim: 'idle', frames: 3, fps: 10, by: 'whole' }));
check(fw.layers.map((l) => `${l.name}:${l.visible === false ? 'hidden' : 'shown'}`).join() === 'idle 000:shown,idle 001:hidden,idle 002:hidden', '--by whole: a layer per frame');

// layers per PSD folder, and a part's blend mode
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posepsd-'));
const json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
fs.copyFileSync('samples/basic/atlas.png', path.join(tmp, 'atlas.png'));
const folderOf = (id) => (/^(eye|iris)/.test(id) ? ['顔', '目'] : /^(brow|mouth)/.test(id) ? ['顔', 'パーツ'] : /^hair|bangs/.test(id) ? ['髪'] : []);
json.source = { psd: { file: 'x.psd', layers: json.parts.map((p) => ({ part: p.id, groups: folderOf(p.id) })) } };
json.parts.find((p) => p.id === 'mouth').blend = 'multiply';
fs.writeFileSync(path.join(tmp, 'model.json'), JSON.stringify(json));
const g1 = read(exportPosePsd(path.join(tmp, 'model.json'), { by: 'group' })), g2 = read(exportPosePsd(path.join(tmp, 'model.json'), { by: 'group', depth: 2 }));
check(g1.layers.map((l) => l.name).join() === '髪,body,neck,face,顔' && g2.layers.map((l) => l.name).join() === '髪,body,neck,face,目,パーツ',
  `--by group: a layer per folder (depth 1: ${g1.layers.map((l) => l.name).join(' ')}; depth 2: ${g2.layers.map((l) => l.name).join(' ')}), loose parts their own`);
const bl = read(exportPosePsd(path.join(tmp, 'model.json'), {}));
check(bl.layers.find((l) => l.name === 'mouth').blend === 'multiply' && bl.layers.find((l) => l.name === 'face').blend === 'normal', 'a part\'s blend mode becomes its layer\'s');
fs.rmSync(tmp, { recursive: true, force: true });

// the PSD writer by itself in a browser (tools/psd_write.mjs, for the editor's export window): a folder, opacity, blend
{
  const { chromium } = createRequire(import.meta.url)('playwright');
  const server = http.createServer((req, res) => {
    const f = path.join(process.cwd(), decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.mjs') || f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(fs.readFileSync(f));
  }).listen(0);
  const port = server.address().port, browser = await chromium.launch(), page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/README.md`);
  const bytes = await page.evaluate(async () => {
    const { writeLayeredPsd, trimLayer } = await import('/tools/psd_write.mjs');
    const W = 8, H = 6, full = new Uint8Array(W * H * 4);
    for (let y = 1; y < 3; y++) for (let x = 2; x < 5; x++) full.set([200, 40, 10, 255], (y * W + x) * 4);
    const t = trimLayer(full, W, H);
    const items = [{ name: '下', ...t, opacity: 0.5, blend: 'multiply' }, { folder: 'まとめ', hidden: true, children: [{ name: 'empty' }] }];
    return Array.from(writeLayeredPsd(W, H, items, { rgba: full }));
  });
  await browser.close(); server.close();
  const B = readPsd(new Uint8Array(bytes), { inflate: (x) => zlib.inflateSync(x) }), lo = B.layers.find((l) => l.name === '下');
  check(B.width === 8 && lo && lo.left === 2 && lo.top === 1 && lo.width === 3 && lo.height === 2 && lo.blend === 'multiply' && Math.abs(lo.opacity - 0.5) < 0.01
    && B.layers.find((l) => l.name === 'empty')?.groupObjs?.[0]?.name === 'まとめ' && B.layers.find((l) => l.name === 'empty').groupObjs[0].visible === false,
    'tools/psd_write.mjs in a browser: a trimmed layer (place, size, multiply, half opacity) and a hidden folder, read back here');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall pose PSD checks passed');
process.exit(failures ? 1 : 0);
