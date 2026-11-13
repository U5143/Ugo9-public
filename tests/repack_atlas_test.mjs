// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Atlas pages packed by the pictures' shapes (tools/repack_atlas.mjs, 機能の比べ #16): rings, L shapes and diagonal
// strips read from a PSD (packed as boxes) take less page when packed by what their triangles sample; drawn by
// ugo_export, the repacked model is the same picture (pixels moved or turned a quarter, never resampled); a PSD of
// near-rectangles is not smaller packed by shape and is kept as it was; parts drawn from the same picture share it.
//   node tests/repack_atlas_test.mjs   (the drawing check needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { importPsd } from '../tools/import_psd.mjs';
import { repackAtlas } from '../tools/repack_atlas.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { encodePng } from '../tools/png.mjs';
import { writePsd } from './psd/make_big.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const ring = (cx, cy, r0, r1, seed) => (x, y) => { const d = Math.hypot(x - cx, y - cy); return d >= r0 && d <= r1 ? [(x * 7 + seed) & 255, (y * 5) & 255, 120, 255] : [0, 0, 0, 0]; };
const ell = (w, h, t, seed) => (x, y) => (x < t || y > h - t ? [(x * 3 + seed) & 255, 150, (y * 9) & 255, 255] : [0, 0, 0, 0]);
const diag = (w, h, t, seed) => (x, y) => (Math.abs(x / w - y / h) * Math.min(w, h) < t ? [90, (x + seed) & 255, (y * 2) & 255, 255] : [0, 0, 0, 0]);
const shapes = [];
for (let i = 0; i < 4; i++) shapes.push({ name: 'ring' + i, left: 10 + i * 30, top: 10, width: 160, height: 160, pixel: ring(80, 80, 55, 78, i * 40) });
for (let i = 0; i < 4; i++) shapes.push({ name: 'L' + i, left: 20 + i * 40, top: 200, width: 150, height: 150, pixel: ell(150, 150, 30, i * 30) });
for (let i = 0; i < 4; i++) shapes.push({ name: 'diag' + i, left: 30 + i * 50, top: 380, width: 200, height: 120, pixel: diag(200, 120, 14, i * 20) });
const res = importPsd(writePsd(600, 600, shapes, { composite: () => [255, 255, 255] }), { inflate, keepPixels: false });
const r = repackAtlas(res.model, res.atlases);
check(!r.kept && r.after < 0.85 * r.before, `rings, L shapes and strips: ${Math.round((100 * r.after) / r.before)}% of the page they took packed as boxes (${r.before} → ${r.after} px)`);
check(r.model.parts.some((p) => p.uvs.length) && JSON.stringify(r.model.parts.map((p) => p.vertices)) === JSON.stringify(res.model.parts.map((p) => p.vertices)), 'only the UVs (and pages) change: the meshes are as they were');

// drawn: the same picture
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (exe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repack-'));
  const draw = (model, pages, name) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d);
    pages.forEach((p, i) => fs.writeFileSync(path.join(d, model.textures[i]), encodePng(p.width, p.height, p.rgba)));
    fs.writeFileSync(path.join(d, 'm.ug9'), new Uint8Array(compileUgo(model, { warnings: [] })));
    const out = path.join(d, 'f.rgba');
    const run = spawnSync(exe, [path.join(d, 'm.ug9'), '--frames', '1', '--format', 'raw', '--out', out]);
    if (run.status) throw new Error(String(run.stderr));
    return fs.readFileSync(out);
  };
  const a = draw(res.model, res.atlases, 'before'), b = draw(r.model, r.pages, 'after');
  let most = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) n++; most = Math.max(most, d); }
  const turned = r.model.parts.filter((p, i) => { const u0 = res.model.parts[i].uvs, u1 = p.uvs; return Math.sign(u0[2] - u0[0]) !== Math.sign(u1[2] - u1[0]) || Math.sign(u0[3] - u0[1]) !== Math.sign(u1[3] - u1[1]); }).length;
  check(most <= 1, `drawn by ugo_export: the same picture (largest difference ${most}, ${n} values differ; ${turned} picture(s) lie turned)`);
  // every picture turned a quarter: still the same picture (the pixels and the UVs turn together)
  const all = repackAtlas(res.model, res.atlases, { turn: 'always', always: true }), c = draw(all.model, all.pages, 'turned');
  let most2 = 0;
  for (let i = 0; i < a.length; i++) most2 = Math.max(most2, Math.abs(a[i] - c[i]));
  check(most2 <= 1, `every picture turned a quarter: the same picture (largest difference ${most2})`);
  fs.rmSync(dir, { recursive: true, force: true });
} else console.log('skip the drawing check (no build/ugo_export)');

// near-rectangles: not smaller, kept
const face = importPsd(fs.readFileSync('tests/psd/face.psd'), { inflate, keepPixels: false });
const f = repackAtlas(face.model, face.atlases);
check(f.kept && f.pages === face.atlases && JSON.stringify(f.model) === JSON.stringify(face.model), `a PSD of near-rectangles: not smaller packed by shape, kept as it was (${f.before} px)`);

// the same picture drawn by two parts (Spine's slot copies): placed once
const twice = structuredClone(res.model);
twice.parts.push({ ...structuredClone(twice.parts[0]), id: 'copy' });
const t = repackAtlas(twice, res.atlases, { always: true });
check(t.placed === res.model.parts.length && JSON.stringify(t.model.parts.at(-1).uvs) === JSON.stringify(t.model.parts[0].uvs), 'two parts drawn from the same picture: placed once, both point at it');

console.log(failures ? `\n${failures} check(s) failed` : '\nall repack checks passed');
process.exit(failures ? 1 : 0);
