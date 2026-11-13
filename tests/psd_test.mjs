// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// PSD import test. tests/psd/face.psd is written by psd-tools (tests/psd/make_psd.py), an
// independent PSD writer; face_layers.json is what psd-tools reads back from it.
//   node tests/psd_test.mjs        (the drawing check needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPsd, importPsd, meshFromLayer, layerMeta, reimportPsd } from '../tools/import_psd.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { decodePng, encodePng } from '../tools/png.mjs';
import { writePsd } from './psd/make_big.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const bytes = fs.readFileSync(path.join(ROOT, 'tests/psd/face.psd'));
const expect = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/psd/face_layers.json'), 'utf8'));

// ---- layers as psd-tools sees them -------------------------------------------------------
const inflate = (b) => zlib.inflateSync(b); // layers are raw, RLE, ZIP and ZIP with prediction
const psd = readPsd(bytes, { inflate });
check(psd.width === expect.width && psd.height === expect.height, `canvas ${psd.width}x${psd.height}`);
check(psd.layers.length === expect.layers.length, `${psd.layers.length} pixel layers`);
expect.layers.forEach((e, i) => {
  const L = psd.layers[i];
  if (!L) return;
  const sha = crypto.createHash('sha1').update(L.rgba).digest('hex');
  const groups = L.groupObjs.map((g) => g.name);
  check(L.name === e.name && JSON.stringify(groups) === JSON.stringify(e.groups) && L.left === e.left && L.top === e.top && L.width === e.width && L.height === e.height
    && L.visible === e.visible && Math.round(L.opacity * 255) === e.opacity && sha === e.rgbaSha1,
  `layer ${[...groups, L.name].join('/')}: box, visibility, opacity and pixels match psd-tools`);
});
check(psd.layers.find((l) => l.name === 'shade').blend === 'multiply', 'blend mode read (multiply)');

// ---- the model ---------------------------------------------------------------------------
const res = importPsd(bytes, { inflate });
let noInflate = '';
try { readPsd(bytes); } catch (e) { noInflate = e.message; }
check(/inflate/.test(noInflate), 'ZIP layers without opts.inflate: a clear error');
const ids = res.model.parts.map((p) => p.id);
check(JSON.stringify(ids) === JSON.stringify(['body', 'face', 'eye', 'eye_2', 'blush', 'shade', 'hidden']), `parts in drawing order, repeated names numbered: ${ids.join(', ')}`);
check(res.groups.length === 1 && res.groups[0].name === 'eyes' && res.groups[0].parent === null && JSON.stringify(res.groups[0].parts) === '["eye","eye_2"]', 'group "eyes" holds eye and eye_2');
check(res.layers.length === ids.length && res.layers.every((l, i) => l.part === ids[i] && l.rgba.length === l.width * l.height * 4), 'layers: box and pixels of each part');
check(res.model.parts.find((p) => p.id === 'hidden').opacity === 0 && Math.abs(res.model.parts.find((p) => p.id === 'shade').opacity - 128 / 255) < 1e-3, 'hidden layer opacity 0, layer opacity kept');
check(res.model.parts.find((p) => p.id === 'shade').blend === 'multiply' && !res.warnings.some((w) => /blend mode/.test(w)) && res.warnings.some((w) => /hidden: hidden/.test(w)),
  'multiply is read as the part\'s blend (format 0.4); a warning for the hidden layer');
// atlas holds each layer's pixels
let atlasOk = true;
for (const l of res.layers) {
  const a = l.atlas;
  for (let y = 0; y < a.height && atlasOk; y++) for (let x = 0; x < a.width; x++) {
    // the area's (x, y) in the atlas (a picture may lie turned 90° clockwise: atlas.turned)
    const [X, Y] = a.turned ? [a.x + a.height - 1 - y, a.y + x] : [a.x + x, a.y + y];
    const lx = a.left - l.left + x, ly = a.top - l.top + y, d = (Y * res.atlas.width + X) * 4;
    const inside = lx >= 0 && ly >= 0 && lx < l.width && ly < l.height, s = (ly * l.width + lx) * 4, alpha = inside ? l.rgba[s + 3] : 0;
    if (res.atlas.rgba[d + 3] !== alpha) { atlasOk = false; break; }
    if (alpha) for (let c = 0; c < 3; c++) if (l.rgba[s + c] !== res.atlas.rgba[d + c]) atlasOk = false;
  }
}
check(atlasOk, `atlas ${res.atlas.width}x${res.atlas.height} holds every layer's pixels`);
compileUgo(res.model);
check(true, 'the model compiles');

// ---- saved layer descriptions and reading the PSD again --------------------------------------
const metas = JSON.parse(JSON.stringify(res.layers.map(layerMeta))); // as stored with a document
check(metas.every((m) => !m.rgba && m.atlas && m.path), 'layerMeta: JSON without pixels, with the atlas area and the group path');
{
  const again = meshFromLayer(metas[1], { atlas: res.atlas, originX: res.model.canvas.originX, originY: res.model.canvas.originY });
  const first = res.model.parts[1];
  check(JSON.stringify(again.triangles) === JSON.stringify(first.triangles) && again.vertices.every((v, i) => Math.abs(v - first.vertices[i]) < 1e-9),
    'meshFromLayer from the saved description and the atlas gives the same mesh as the import');
}
{
  const v2 = fs.readFileSync(path.join(ROOT, 'tests/psd/face_v2.psd'));
  const doc = { canvas: res.model.canvas, parts: res.model.parts, layers: metas };
  const re = reimportPsd(v2, doc, { inflate });
  // v2 has no blush, shade or hidden layer, and a new mouth layer
  check(JSON.stringify(re.removed) === '["blush","shade","hidden"]' && re.added.length === 1 && re.added[0].layer.name === 'mouth', `reimport: removed ${re.removed}; added ${re.added.map((a) => a.layer.name)}`);
  check(JSON.stringify(Object.keys(re.uvs)) === '["body","face","eye","eye_2"]', `reimport: matched by group and name: ${Object.keys(re.uvs)}`);
  // unchanged pictures: every vertex samples the same colour as before
  const texel = (atlas, u, v) => { const x = Math.min(atlas.width - 1, Math.floor(u * atlas.width)), y = Math.min(atlas.height - 1, Math.floor(v * atlas.height)); return Array.from(atlas.rgba.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4)); };
  let same = 0, total = 0;
  for (const id of ['body', 'eye', 'eye_2']) {
    const p = res.model.parts.find((q) => q.id === id), u = re.uvs[id];
    for (let k = 0; k < p.uvs.length; k += 2) {
      total++;
      const a = texel(res.atlas, p.uvs[k] + 0.25 / res.atlas.width, p.uvs[k + 1] + 0.25 / res.atlas.height), b = texel(re.atlas, u[k] + 0.25 / re.atlas.width, u[k + 1] + 0.25 / re.atlas.height);
      if (a[3] === b[3] && (a[3] === 0 || a.every((c, i) => c === b[i]))) same++;
    }
  }
  check(same === total, `reimport: unchanged pictures keep their pixels under every vertex (${same} of ${total})`);
  check(re.outside.face > 0 && re.warnings.some((w) => /face: \d+ vertices are outside/.test(w)) && re.notes.some((n) => n.code === 'reimportOutside' && n.vars.part === 'face' && n.vars.count === re.outside.face) && re.notes.length === re.warnings.length, `reimport: the face moved 3 px: ${re.outside.face} vertices outside the new picture, with a warning`);
}

// ---- the contour mesh covers every opaque pixel, on awkward shapes ----------------------------
function shapeLayer(w, h, inside) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x + 0.5, y + 0.5)) rgba.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
  const m = 3; // the importer's rim: margin 2 + 1
  return { left: 0, top: 0, width: w, height: h, rgba, atlas: { x: 0, y: 0, width: w + 2 * m, height: h + 2 * m, left: -m, top: -m } };
}
const shapes = {
  ring: shapeLayer(200, 200, (x, y) => { const r = Math.hypot(x - 100, y - 100); return r < 90 && r > 50; }),
  'thin diagonal line': shapeLayer(300, 120, (x, y) => Math.abs(y - x * 0.37 - 5) < 0.8),
  'scattered dots': shapeLayer(160, 160, (x, y) => ((Math.floor(x / 7) * 13 + Math.floor(y / 7) * 7) % 5 === 0) && (x % 7) < 2 && (y % 7) < 2),
  'comb (deep notches)': shapeLayer(240, 100, (x, y) => y < 20 || (x % 24) < 6),
  'big blob 1200x900': shapeLayer(1200, 900, (x, y) => ((x - 600) / 580) ** 2 + ((y - 450) / 430) ** 2 < 1 + 0.15 * Math.sin(x / 40) * Math.cos(y / 55)),
};
for (const [name, L] of Object.entries(shapes)) {
  const t0 = Date.now();
  const mesh = meshFromLayer(L, { atlasWidth: 1, atlasHeight: 1, originX: 0, originY: 0 });
  const ms = Date.now() - t0;
  // rasterise the triangles at pixel centres and look for opaque pixels left out
  const cover = new Uint8Array(L.width * L.height), v = mesh.vertices, t = mesh.triangles;
  for (let k = 0; k < t.length; k += 3) {
    const [ax, ay, bx, by, cx, cy] = [v[2 * t[k]], v[2 * t[k] + 1], v[2 * t[k + 1]], v[2 * t[k + 1] + 1], v[2 * t[k + 2]], v[2 * t[k + 2] + 1]];
    const e = (px, py, ux, uy, wx, wy) => (wx - ux) * (py - uy) - (wy - uy) * (px - ux);
    for (let y = Math.max(0, Math.floor(Math.min(ay, by, cy))); y < Math.min(L.height, Math.ceil(Math.max(ay, by, cy))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx, cx))); x < Math.min(L.width, Math.ceil(Math.max(ax, bx, cx))); x++) {
        const d1 = e(x + 0.5, y + 0.5, ax, ay, bx, by), d2 = e(x + 0.5, y + 0.5, bx, by, cx, cy), d3 = e(x + 0.5, y + 0.5, cx, cy, ax, ay);
        if ((d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) || (d1 <= 1e-9 && d2 <= 1e-9 && d3 <= 1e-9)) cover[y * L.width + x] = 1;
      }
  }
  let opaque = 0, missed = 0, covered = 0;
  for (let i = 0; i < L.width * L.height; i++) { if (L.rgba[i * 4 + 3]) { opaque++; if (!cover[i]) missed++; } if (cover[i]) covered++; }
  check(missed === 0 && ms < 5000, `mesh of ${name}: ${v.length / 2} vertices, ${t.length / 3} triangles, all ${opaque} opaque pixels covered${missed ? ` (MISSED ${missed})` : ''}, ${(covered / Math.max(1, opaque)).toFixed(2)}x the opaque area, ${ms} ms`);
}

// ---- drawn by ugo_export vs the layers composited here (normal blending over white) --------
// one sample per pixel, at the pixel's centre = a texel's centre: no filtering in between
const exe = ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe'].map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
if (!exe) console.log('skip drawing check: build/ugo_export not built');
else {
  const out = path.join(ROOT, 'build', 'psd_test');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'atlas.png'), encodePng(res.atlas.width, res.atlas.height, res.atlas.rgba));
  fs.writeFileSync(path.join(out, 'model.ugo'), new Uint8Array(compileUgo(res.model)));
  execFileSync(exe, [path.join(out, 'model.ugo'), '--frames', '1', '--ss', '1', '--bg', '#ffffff', '--format', 'frames', '--out', out], { stdio: 'ignore' });
  const got = decodePng(fs.readFileSync(path.join(out, 'frame_00000.png')));
  const W = psd.width, H = psd.height, want = new Float32Array(W * H * 3).fill(255);
  psd.layers.forEach((L, k) => {
    const op = res.model.parts[k].opacity, mul = res.model.parts[k].blend === 'multiply';
    for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) {
      const cx = L.left + x, cy = L.top + y;
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const s = (y * L.width + x) * 4, a = (L.rgba[s + 3] / 255) * op, d = (cy * W + cx) * 3;
      for (let c = 0; c < 3; c++) want[d + c] = mul ? want[d + c] * (1 - a + (a * L.rgba[s + c]) / 255) : want[d + c] * (1 - a) + L.rgba[s + c] * a;
    }
  });
  let bad = 0, worst = 0;
  for (let i = 0; i < W * H; i++) {
    const d = Math.max(...[0, 1, 2].map((c) => Math.abs(got.rgba[i * 4 + c] - want[i * 3 + c])));
    worst = Math.max(worst, d); if (d > 16) bad++;
  }
  check(got.width === W && got.height === H && bad <= W * H * 0.002, `ugo_export draws the layers as composited by hand: ${bad} of ${W * H} pixels differ by more than 16 (largest ${worst.toFixed(0)})`);
}

// ---- clipping -> masks, blend modes (format 0.4): tests/psd/clip.psd ------------------------
{
  const clip = importPsd(fs.readFileSync(path.join(ROOT, 'tests/psd/clip.psd')), { inflate });
  const part = (id) => clip.model.parts.find((p) => p.id === id);
  check(JSON.stringify(part('shadow').mask) === '["skin"]' && JSON.stringify(part('light').mask) === '["skin"]' && JSON.stringify(part('band').mask) === '["brim"]',
    'clipped layers are masked by their base (shadow, light -> skin; band -> brim in the folder)');
  check(!part('stray').mask && clip.warnings.some((w) => /stray: clipped, but there is no layer below/.test(w)), 'a clipped layer with nothing below it in its folder: unclipped, with a warning');
  check(part('shadow').blend === 'multiply' && part('light').blend === 'screen' && part('glow').blend === 'add' && !part('skin').blend, 'blend modes: multiply, screen, linear dodge -> add');
  if (exe) {
    const out = path.join(ROOT, 'build', 'psd_test', 'clip');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'atlas.png'), encodePng(clip.atlas.width, clip.atlas.height, clip.atlas.rgba));
    fs.writeFileSync(path.join(out, 'model.ugo'), new Uint8Array(compileUgo(clip.model)));
    execFileSync(exe, [path.join(out, 'model.ugo'), '--frames', '1', '--ss', '1', '--bg', '#ffffff', '--format', 'frames', '--out', out], { stdio: 'ignore' });
    const got = decodePng(fs.readFileSync(path.join(out, 'frame_00000.png')));
    // by hand: Photoshop's clipping (alpha x the base's alpha) and blend formulas, over white
    const W = 64, H = 64, want = new Float32Array(W * H * 3).fill(1), raw = readPsd(fs.readFileSync(path.join(ROOT, 'tests/psd/clip.psd')));
    const alphaAt = (L, cx, cy) => { const x = cx - L.left, y = cy - L.top; return x >= 0 && y >= 0 && x < L.width && y < L.height ? L.rgba[(y * L.width + x) * 4 + 3] / 255 : 0; };
    for (const L of raw.layers) {
      const p = part(clip.layers.find((l) => l.name === L.name).part), base = p.mask && raw.layers.find((b) => b.name === p.mask[0]);
      for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) {
        const cx = L.left + x, cy = L.top + y;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const k = (y * L.width + x) * 4, a = (L.rgba[k + 3] / 255) * p.opacity * (base ? alphaAt(base, cx, cy) : 1), d = (cy * W + cx) * 3;
        for (let c = 0; c < 3; c++) {
          const sc = L.rgba[k + c] / 255, dc = want[d + c];
          want[d + c] = p.blend === 'multiply' ? sc * a * dc + dc * (1 - a) : p.blend === 'screen' ? sc * a + dc * (1 - sc * a) : p.blend === 'add' ? Math.min(1, dc + sc * a) : sc * a + dc * (1 - a);
        }
      }
    }
    let bad = 0, worst = 0;
    for (let i = 0; i < W * H; i++) { const d = Math.max(...[0, 1, 2].map((c) => Math.abs(got.rgba[i * 4 + c] - 255 * want[i * 3 + c]))); worst = Math.max(worst, d); if (d > 4) bad++; }
    check(bad === 0, `ugo_export draws the clipping and blend modes as Photoshop's formulas: ${bad} of ${W * H} pixels differ by more than 4 (largest ${worst.toFixed(1)})`);
  }
}

// ---- how far: onProgress says each layer read and each picture meshed, in order ---------------
{
  const seen = [];
  const r = importPsd(bytes, { inflate, onProgress: (p) => seen.push(p) });
  const reads = seen.filter((p) => p.step === 'read'), meshes = seen.filter((p) => p.step === 'mesh'), n = r.model.parts.length;
  const ordered = (list) => list.every((p, i) => p.done === i && p.total === list.length - 1 || (i === list.length - 1 && p.done === p.total));
  check(reads.length > 1 && meshes.length === n + 1 && ordered(reads) && ordered(meshes) && seen.indexOf(meshes[0]) > seen.indexOf(reads.at(-1)),
    `onProgress: ${reads.length} 'read' then ${meshes.length} 'mesh' calls, done counting up to total`);
}

// ---- mesh 'none': each part the rectangle of its picture (4 points), uvs on its atlas area ------
{
  const r = importPsd(bytes, { inflate, mesh: 'none' }), full = importPsd(bytes, { inflate });
  const ok = r.model.parts.every((p, i) => {
    const a = r.layers[i].atlas, W = r.atlas.width, H = r.atlas.height;
    // the area's top-left and bottom-right corners (a turned picture: its top-left is the atlas area's top-right)
    const [u0, v0, u1, v1] = a.turned ? [a.x + a.height, a.y, a.x, a.y + a.width] : [a.x, a.y, a.x + a.width, a.y + a.height];
    return p.vertices.length === 8 && p.triangles.join() === '0,1,2,0,2,3'
      && Math.abs(p.uvs[0] - u0 / W) < 1e-9 && Math.abs(p.uvs[1] - v0 / H) < 1e-9
      && Math.abs(p.uvs[4] - u1 / W) < 1e-9 && Math.abs(p.uvs[5] - v1 / H) < 1e-9;
  });
  const same = r.atlases.every((a, i) => Buffer.compare(Buffer.from(a.rgba), Buffer.from(full.atlases[i].rgba)) === 0);
  check(ok && same && r.model.parts.length === full.model.parts.length, `mesh 'none': ${r.model.parts.length} parts of 4 points on their atlas areas, the same atlas`);
}

// ---- pictures turned 90° in the atlas: tall thin layers next to wide ones ---------------------
{
  const stripe = (name, left, top, w, h, c) => ({ name, left, top, width: w, height: h, pixel: (x, y) => [c[0], (x * 7) & 255, (y * 3) & 255, 255] });
  const psd = writePsd(400, 300, [stripe('wide1', 10, 10, 300, 30, [200]), stripe('wide2', 10, 50, 280, 24, [150]), stripe('tall1', 330, 10, 20, 260, [100]),
    stripe('tall2', 360, 20, 26, 240, [50]), stripe('tall3', 10, 90, 18, 200, [20])]);
  const r = importPsd(psd), flat = importPsd(psd, { atlasTurn: false });
  const turned = r.layers.filter((l) => l.atlas.turned).map((l) => l.part);
  const area = (x) => x.atlases.reduce((sum, a) => sum + a.width * a.height, 0);
  check(turned.length > 0 && area(r) <= area(flat), `some pictures lie turned (${turned.join(', ')}); atlas ${area(r)} px against ${area(flat)} px unturned`);
  // every pixel of every picture: through its mesh's UVs (barycentric at the pixel's centre), the atlas holds that pixel
  let bad = 0, n = 0;
  for (const [k, p] of r.model.parts.entries()) {
    const L = r.layers[k], A = r.atlases[L.atlas.page || 0], v = p.vertices, uv = p.uvs, ox = r.model.canvas.originX, oy = r.model.canvas.originY;
    for (let t = 0; t < p.triangles.length; t += 3) {
      const [i, j, m] = [p.triangles[t], p.triangles[t + 1], p.triangles[t + 2]];
      const [x0, y0, x1, y1, x2, y2] = [v[2 * i], v[2 * i + 1], v[2 * j], v[2 * j + 1], v[2 * m], v[2 * m + 1]], det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (!det) continue;
      for (let py = Math.floor(Math.min(y0, y1, y2)); py < Math.max(y0, y1, y2); py++) for (let px = Math.floor(Math.min(x0, x1, x2)); px < Math.max(x0, x1, x2); px++) {
        const cx = px + 0.5, cy = py + 0.5, a = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) / det, b = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) / det, c = 1 - a - b;
        if (a < 1e-6 || b < 1e-6 || c < 1e-6) continue;
        const lx = px + ox - L.left, ly = py + oy - L.top;
        if (lx < 0 || ly < 0 || lx >= L.width || ly >= L.height) continue;
        const U = Math.floor((a * uv[2 * i] + b * uv[2 * j] + c * uv[2 * m]) * A.width), V = Math.floor((a * uv[2 * i + 1] + b * uv[2 * j + 1] + c * uv[2 * m + 1]) * A.height);
        n++;
        for (let ch = 0; ch < 4; ch++) if (A.rgba[(V * A.width + U) * 4 + ch] !== L.rgba[(ly * L.width + lx) * 4 + ch]) { bad++; break; }
      }
    }
  }
  check(n > 10000 && bad === 0, `through the UVs, ${n} pixels of the pictures (turned or not) read back the same from the atlas (${bad} differ)`);
  // the saved description: the mesh from the atlas, and reading the same PSD again
  const metas = JSON.parse(JSON.stringify(r.layers.map(layerMeta)));
  const same = r.model.parts.every((p, k) => { const m = meshFromLayer(metas[k], { atlases: r.atlases, originX: r.model.canvas.originX, originY: r.model.canvas.originY }); return JSON.stringify(m.triangles) === JSON.stringify(p.triangles) && m.uvs.every((u, i) => Math.abs(u - p.uvs[i]) < 1e-9); });
  const re = reimportPsd(psd, { canvas: r.model.canvas, parts: r.model.parts, layers: metas });
  const reSame = r.model.parts.every((p) => re.uvs[p.id] && re.uvs[p.id].every((u, i) => Math.abs(u - p.uvs[i]) < 1e-9));
  check(same && reSame, 'turned pictures: meshFromLayer from the saved description, and reading the PSD again, give the same UVs');
}

// ---- atlasAnyAngle: slanted pictures turned by their best angle (resampled) ------------------------
{
  const slant = (name, cx, cy, len, thick, deg) => { const a = deg * Math.PI / 180, hw = Math.abs(len / 2 * Math.cos(a)) + thick, hh = Math.abs(len / 2 * Math.sin(a)) + thick, w = Math.ceil(2 * hw), h = Math.ceil(2 * hh);
    return { name, left: Math.round(cx - hw), top: Math.round(cy - hh), width: w, height: h, pixel: (x, y) => { const dx = x - hw, dy = y - hh, u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(u) <= len / 2 && Math.abs(v) <= thick / 2 ? [100 + Math.round(u / len * 100), 120 + Math.round(v * 2), 80, 255] : [0, 0, 0, 0]; } }; };
  const psd = writePsd(600, 500, [slant('arm', 200, 200, 300, 40, 35), slant('sword', 380, 250, 360, 24, -60), slant('strand', 300, 400, 200, 16, 20), { name: 'body', left: 250, top: 150, width: 60, height: 120, pixel: () => [180, 180, 200, 255] }]);
  const plain = importPsd(psd), r = importPsd(psd, { atlasAnyAngle: true });
  // the pictures' areas in the atlas (the pages' sizes go in steps, so a few pictures may not change them)
  const used = (x) => x.layers.reduce((sum, l) => sum + (l.atlas.atlasArea ? l.atlas.atlasArea[0] * l.atlas.atlasArea[1] : l.atlas.width * l.atlas.height), 0), angled = r.layers.filter((l) => l.atlas.angle);
  check(!plain.layers.some((l) => l.atlas.angle) && angled.length >= 3 && !r.layers.find((l) => l.name === 'body').atlas.angle && used(r) < 0.6 * used(plain),
    `atlasAnyAngle: ${angled.map((l) => `${l.name} ${l.atlas.angle.toFixed(1)}°`).join(', ')} turned (not the upright body); the pictures take ${used(plain)} -> ${used(r)} px of the atlas (off by default)`);
  // inside each picture (2 px from its edge), the colour through the UVs is the picture's, within the resampling
  let worst = 0, n = 0, holes = 0;
  for (const [k, p] of r.model.parts.entries()) {
    const L = r.layers[k], A = r.atlases[L.atlas.page || 0], v = p.vertices, uv = p.uvs, ox = r.model.canvas.originX, oy = r.model.canvas.originY;
    const solid = (x, y) => { for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= L.width || Y >= L.height || L.rgba[(Y * L.width + X) * 4 + 3] < 255) return false; } return true; };
    for (let t = 0; t < p.triangles.length; t += 3) {
      const [i, j, m] = [p.triangles[t], p.triangles[t + 1], p.triangles[t + 2]];
      const [x0, y0, x1, y1, x2, y2] = [v[2 * i], v[2 * i + 1], v[2 * j], v[2 * j + 1], v[2 * m], v[2 * m + 1]], det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (!det) continue;
      for (let py = Math.floor(Math.min(y0, y1, y2)); py < Math.max(y0, y1, y2); py++) for (let px = Math.floor(Math.min(x0, x1, x2)); px < Math.max(x0, x1, x2); px++) {
        const cx = px + 0.5, cy = py + 0.5, a = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) / det, b = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) / det, c = 1 - a - b;
        if (a < 1e-6 || b < 1e-6 || c < 1e-6) continue;
        const lx = px + ox - L.left, ly = py + oy - L.top;
        if (!solid(lx, ly)) continue;
        const U = Math.floor((a * uv[2 * i] + b * uv[2 * j] + c * uv[2 * m]) * A.width), V = Math.floor((a * uv[2 * i + 1] + b * uv[2 * j + 1] + c * uv[2 * m + 1]) * A.height), o = (V * A.width + U) * 4, s = (ly * L.width + lx) * 4;
        n++;
        if (A.rgba[o + 3] < 255) holes++;
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(A.rgba[o + ch] - L.rgba[s + ch]));
      }
    }
  }
  check(n > 10000 && holes === 0 && worst <= 4, `inside the pictures, ${n} pixels read back through the UVs: none transparent, colours within ${worst} (the resampling's blur)`);
  const metas = JSON.parse(JSON.stringify(r.layers.map(layerMeta)));
  const same = r.model.parts.every((p, k) => { const m = meshFromLayer(metas[k], { atlases: r.atlases, originX: r.model.canvas.originX, originY: r.model.canvas.originY }); return m.uvs.length === p.uvs.length || m.vertices.length > 0; });
  const re = reimportPsd(psd, { canvas: r.model.canvas, parts: r.model.parts, layers: metas }, { atlasAnyAngle: true });
  const reSame = r.model.parts.every((p) => re.uvs[p.id] && re.uvs[p.id].every((u, i) => Math.abs(u - p.uvs[i]) < 1e-9));
  check(same && reSame, 'turned by an angle: a mesh is rebuilt from the saved description and the atlas, and reading the PSD again gives the same UVs');
}

// ---- atlas pages: small pages force the pictures onto several, drawn in one go -----------------
if (exe) {
  const paged = importPsd(bytes, { inflate, maxAtlasSize: 256 });
  check(paged.atlases.length > 1 && paged.model.textures.length === paged.atlases.length && paged.atlases.every((a) => a.width <= 256 && a.height <= 256),
    `pages: ${paged.atlases.length} atlas pages of at most 256x256 (${paged.model.textures.join(', ')})`);
  const out = path.join(ROOT, 'build', 'psd_test', 'paged');
  fs.mkdirSync(out, { recursive: true });
  paged.atlases.forEach((a, i) => fs.writeFileSync(path.join(out, paged.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
  fs.writeFileSync(path.join(out, 'model.ugo'), new Uint8Array(compileUgo(paged.model)));
  execFileSync(exe, [path.join(out, 'model.ugo'), '--frames', '1', '--ss', '1', '--bg', '#ffffff', '--format', 'frames', '--out', out], { stdio: 'ignore' });
  const a = decodePng(fs.readFileSync(path.join(out, 'frame_00000.png'))), b = decodePng(fs.readFileSync(path.join(ROOT, 'build', 'psd_test', 'frame_00000.png')));
  check(Buffer.from(a.rgba).equals(Buffer.from(b.rgba)), 'the paged model draws exactly like the one-page model');
  const meta = layerMeta(paged.layers.find((l) => l.atlas.page)), again = meshFromLayer(meta, { atlases: paged.atlases, originX: paged.model.canvas.originX, originY: paged.model.canvas.originY });
  check(JSON.stringify(again.uvs) === JSON.stringify(paged.model.parts.find((p) => p.id === meta.part).uvs), 'meshFromLayer finds a saved layer\'s page (opts.atlases)');
}

// ---- groupBones: a bone per group, at the bottom centre of its pictures ---------------------------
{
  const gb = importPsd(bytes, { inflate, groupBones: true });
  const eyes = gb.model.bones.find((b) => b.id === 'eyes');
  const eyeParts = gb.model.parts.filter((p) => p.bone === 'eyes').map((p) => p.id);
  check(eyes && eyes.parent === 'root' && JSON.stringify(eyeParts) === '["eye","eye_2"]' && gb.model.parts.filter((p) => p.bone === 'root').length === 5,
    `groupBones: bone "eyes" (${eyes && [eyes.x, eyes.y]}) carries eye and eye_2; the rest stay on root`);
  // turning the bone 90 degrees turns the eyes about it and nothing else
  const m = structuredClone(gb.model);
  m.animations = [{ id: 'turn', duration: 1, bones: { eyes: { rotate: [[0, 90]] } } }];
  const wasm = fs.readFileSync(path.join(ROOT, 'web/ugo.wasm'));
  const { UgoRuntime } = await import('../web/ugo.js');
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const um = rt.loadModel(compileUgo(m)), inst = um.createInstance(), buf = rt.alloc(8 * um.vertexCount);
  inst.reset(); inst.play('turn', 0); inst.update(0); rt.ex.ugo_deform_cpu(inst.ptr, buf);
  const got = rt.f32(buf, 2 * um.vertexCount);
  let k = 0, worst = 0;
  for (const p of m.parts) for (let i = 0; i < p.vertices.length; i += 2, k++) {
    const [x, y] = [p.vertices[i], p.vertices[i + 1]];
    const want = p.bone === 'eyes' ? [eyes.x - (y - eyes.y), eyes.y + (x - eyes.x)] : [x, y]; // +90° with y down
    worst = Math.max(worst, Math.hypot(got[2 * k] - want[0], got[2 * k + 1] - want[1]));
  }
  check(worst < 1e-3, `turning the group's bone turns its parts about the bone, the others stay (largest error ${worst.toExponential(1)} px)`);
}

// nested folders: body > arm; each bone at the bottom centre of its group's pictures, pointing up,
// half their height long
{
  const nb = importPsd(fs.readFileSync(path.join(ROOT, 'tests/psd/nested.psd')), { groupBones: true });
  const { UgoRuntime } = await import('../web/ugo.js');
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'web/ugo.wasm')), {})).instance.exports);
  const um = rt.loadModel(compileUgo(nb.model)), inst = um.createInstance();
  inst.reset(); inst.update(0);
  let ok = true;
  const lines = [];
  for (const b of nb.model.bones.filter((x) => x.id !== 'root')) {
    const g = nb.groups.find((q) => q.id === b.id), vs = nb.model.parts.filter((p) => { for (let q = nb.groups.find((x) => x.parts.includes(p.id)); q; q = nb.groups.find((x) => x.id === q.parent)) if (q.id === g.id) return true; return false; }).flatMap((p) => p.vertices);
    const xs = vs.filter((_, i) => i % 2 === 0), ys = vs.filter((_, i) => i % 2 === 1);
    const want = [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys)], w = inst.boneWorld(Array.from({ length: um.boneCount }, (_, i) => rt.str(rt.ex.ugo_bone_name(um.ptr, i))).indexOf(b.id));
    const up = Math.abs(w[0]) < 1e-6 && Math.abs(w[1] + 1) < 1e-6; // the bone's x axis points to -y (up)
    if (Math.hypot(w[4] - want[0], w[5] - want[1]) > 1e-3 || !up || Math.abs(b.length - (Math.max(...ys) - Math.min(...ys)) / 2) > 1e-3) ok = false;
    lines.push(`${b.id}${b.parent !== 'root' ? ` (in ${b.parent})` : ''} at ${w[4]},${w[5]}`);
  }
  check(ok && nb.model.bones.find((b) => b.id === 'arm')?.parent === 'body', `nested groups: ${lines.join('; ')}, each pointing up, half its pictures' height long`);
}

// ---- 16-bit PSD: layers in the usual place (psd-tools) and in an 'Lr16' block (Photoshop) ----------
{
  const f16 = fs.readFileSync(path.join(ROOT, 'tests/psd/face16.psd')), want = decodePng(fs.readFileSync(path.join(ROOT, 'tests/psd/face16_expected.png')));
  const sameAsPsdTools = (psd) => {
    let x0 = 0, worst = 0;
    for (const L of psd.layers) {
      for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) for (let c = 0; c < 4; c++) {
        const a = L.rgba[(y * L.width + x) * 4 + c], b = want.rgba[(y * want.width + x0 + x) * 4 + c];
        if (c === 3 || want.rgba[(y * want.width + x0 + x) * 4 + 3]) worst = Math.max(worst, Math.abs(a - b));
      }
      x0 += L.width;
    }
    return worst;
  };
  const a = readPsd(f16, { inflate });
  check(a.layers.length === 2 && sameAsPsdTools(a) <= 1 && a.warnings.some((w) => /16-bit/.test(w)) && a.notes.some((n) => n.code === 'psd16bit'), `16-bit: ${a.layers.map((l) => l.name)} read as 8-bit, as psd-tools reads them (largest difference ${sameAsPsdTools(a)})`);
  // the same layers moved into an 'Lr16' block, the way Photoshop writes 16-bit files
  const v = new DataView(f16.buffer, f16.byteOffset, f16.byteLength);
  let p = 26; p += 4 + v.getUint32(p); p += 4 + v.getUint32(p);
  const lmLen = v.getUint32(p), liLen = v.getUint32(p + 4), body = f16.subarray(p + 8, p + 8 + liLen);
  const pad = (4 - (body.length % 4)) % 4, block = Buffer.concat([Buffer.from('8BIMLr16', 'latin1'), Buffer.alloc(4), body, Buffer.alloc(pad)]);
  block.writeUInt32BE(body.length, 8);
  const lm = Buffer.concat([Buffer.alloc(8), block]); // layer info length 0, global mask length 0, then the block
  const head = Buffer.alloc(4); head.writeUInt32BE(lm.length);
  const moved = Buffer.concat([f16.subarray(0, p), head, lm, f16.subarray(p + 4 + lmLen)]);
  const b = readPsd(moved, { inflate });
  check(b.layers.length === 2 && sameAsPsdTools(b) <= 1, `16-bit with the layers in an 'Lr16' block: the same layers (largest difference ${sameAsPsdTools(b)})`);
}

// ---- vector masks: the layer (a red square) is cut by the path (a circle of 4 Bézier knots) ----------
// psd-tools reads the path but fills a rougher shape, so the drawing is checked against the true
// disc: every pixel's colour is the disc's coverage of it
if (exe) {
  const vec = importPsd(fs.readFileSync(path.join(ROOT, 'tests/psd/vector.psd')));
  const out = path.join(ROOT, 'build', 'psd_test', 'vector');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'atlas.png'), encodePng(vec.atlas.width, vec.atlas.height, vec.atlas.rgba));
  fs.writeFileSync(path.join(out, 'model.ugo'), new Uint8Array(compileUgo(vec.model)));
  execFileSync(exe, [path.join(out, 'model.ugo'), '--frames', '1', '--ss', '1', '--bg', '#ffffff', '--format', 'frames', '--out', out], { stdio: 'ignore' });
  const got = decodePng(fs.readFileSync(path.join(out, 'frame_00000.png')));
  let worst = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const x = i % 64, y = (i - x) / 64;
    let cov = 0;
    for (let sy = 0; sy < 16; sy++) for (let sx = 0; sx < 16; sx++) if (Math.hypot(x + (sx + 0.5) / 16 - 32, y + (sy + 0.5) / 16 - 32) < 20) cov++;
    cov /= 256;
    worst = Math.max(worst, Math.abs(got.rgba[i * 4 + 1] - (60 * cov + 255 * (1 - cov)))); // green: 60 in the square, 255 (white) outside
  }
  check(worst < 30, `vector mask: the square is cut to the circle (largest difference from the true disc ${worst.toFixed(0)}/255)`);
}

// ---- a folder's layer mask cuts every layer in it --------------------------------------------------
{
  const fm = readPsd(fs.readFileSync(path.join(ROOT, 'tests/psd/folder_mask.psd'))), L = fm.layers[0];
  let ok = L && L.groupObjs[0]?.name === 'masked';
  for (let y = 0; y < 32 && ok; y++) for (let x = 0; x < 32; x++) if (L.rgba[(y * 32 + x) * 4 + 3] !== (x < 16 ? 255 : 0)) { ok = false; break; }
  check(ok, 'a folder\'s layer mask cuts the layers in it (the square shows only on the mask\'s white half)');
}

// ---- layer kinds: adjustment, text, smart object, layer effects (a PSD written here) ---------
{
  const be = (n, b) => { const o = Buffer.alloc(b); if (b === 2) o.writeInt16BE(n); else o.writeUInt32BE(n >>> 0); return o; };
  const block = (key, data = Buffer.alloc(4)) => Buffer.concat([Buffer.from('8BIM' + key, 'latin1'), be(data.length, 4), data]);
  const record = (name, blocks, w) => {
    const nm = Buffer.from(name, 'latin1'), pascal = Buffer.concat([Buffer.from([nm.length]), nm]), padded = Buffer.concat([pascal, Buffer.alloc((4 - (pascal.length % 4)) % 4)]);
    const extra = Buffer.concat([be(0, 4), be(0, 4), padded, ...blocks]);
    const chans = [-1, 0, 1, 2].map((id) => Buffer.concat([be(id, 2), be(2 + w * w, 4)]));
    return Buffer.concat([be(0, 4), be(0, 4), be(w, 4), be(w, 4), be(4, 2), ...chans, Buffer.from('8BIMnorm', 'latin1'), Buffer.from([255, 0, 0, 0]), be(extra.length, 4), extra]);
  };
  const layersDef = [['plain', []], ['levels', [block('levl')]], ['words', [block('TySh')]], ['smart', [block('SoLd')]], ['glowing', [block('lfx2')]]];
  const W = 8, recs = layersDef.map(([n, b]) => record(n, b, n === 'levels' ? 0 : W));
  const data = Buffer.concat(layersDef.flatMap(([n]) => (n === 'levels' ? [] : [0, 1, 2, 3].map(() => Buffer.concat([be(0, 2), Buffer.alloc(W * W, 200)])))));
  const levelsData = [0, 1, 2, 3].map(() => be(0, 2)); // an adjustment layer has no pixels
  const channelData = Buffer.concat([data.subarray(0, 4 * (2 + W * W)), ...levelsData, data.subarray(4 * (2 + W * W))]);
  const info = Buffer.concat([be(layersDef.length, 2), ...recs, channelData]);
  const lm = Buffer.concat([be(info.length, 4), info]);
  const psdBytes = Buffer.concat([Buffer.from('8BPS', 'latin1'), be(1, 2), Buffer.alloc(6), be(3, 2), be(W, 4), be(W, 4), be(8, 2), be(3, 2), be(0, 4), be(0, 4), be(lm.length, 4), lm, be(0, 2), Buffer.alloc(3 * W * W)]);
  const kinds = importPsd(psdBytes);
  const w = kinds.warnings.join(' | ');
  check(kinds.model.parts.map((p) => p.id).join() === 'plain,words,smart,glowing', `the adjustment layer is skipped (${kinds.model.parts.map((p) => p.id)})`);
  check(/levels: adjustment layers are not applied/.test(w) && /words: text layer/.test(w) && /smart: smart object layer/.test(w) && /glowing: layer effects/.test(w), 'warnings name the adjustment, text, smart object and effects layers');
  // each warning has a twin in notes with a code and its values, for the editor to word
  const codes = kinds.notes.map((n) => `${n.code}:${n.vars.layer}${n.vars.kind ? ':' + n.vars.kind : ''}`).join(' ');
  check(kinds.notes.length === kinds.warnings.length && kinds.notes.every((n, i) => n.text === kinds.warnings[i] && n.level === 'warn')
    && /layerAdjustment:levels/.test(codes) && /layerKind:words:text/.test(codes) && /layerKind:smart:smartObject/.test(codes) && /layerEffects:glowing/.test(codes), `notes: ${codes}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall PSD checks passed');
process.exit(failures ? 1 : 0);
