// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Atlases at several sizes (tools/atlas_sizes.mjs, 機能の比べ #17): shrinking keeps colours at transparent edges and
// a flat page flat; the sample at 1, 0.5 and 0.25 gives pages of 1024, 512, 256 and .ug9 files that differ only in the
// texture's name (the 1 the same bytes as compiling the model); no small pixel takes colour from two parts' pictures;
// drawn small, the half-size atlas looks as the full one; the command line writes the files.
//   node tests/atlas_sizes_test.mjs   (the drawing check needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { atlasSizes, scalePage } from '../tools/atlas_sizes.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { readUg9Tables } from '../tools/import_ug9.mjs';
import { decodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// shrinking: an opaque red pixel beside transparent black ones stays red (half covered), a flat page stays flat
{
  const W = 4, H = 4, rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) if ((i % W + Math.floor(i / W)) % 2 === 0) rgba.set([255, 0, 0, 255], i * 4); // red and transparent black
  const s = scalePage({ width: W, height: H, rgba }, 0.5);
  const flat = scalePage({ width: 6, height: 6, rgba: new Uint8Array(144).fill(77) }, 0.5);
  check(s.width === 2 && [...s.rgba].join() === '255,0,0,128,255,0,0,128,255,0,0,128,255,0,0,128' && flat.rgba.every((v) => v === 77),
    'half of each 2×2 red, half transparent: red at half opacity (no dark rim); a flat page stays flat');
  const odd = scalePage({ width: 5, height: 3, rgba: new Uint8Array(60).fill(200) }, 0.5);
  check(odd.width === 3 && odd.height === 2 && odd.rgba.every((v) => v === 200), 'a size that does not halve evenly is rounded (5×3 → 3×2), still flat');
}

const json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
const pages = json.textures.map((t) => decodePng(fs.readFileSync(path.join('samples/basic', t))));
const res = atlasSizes(json, pages, [1, 0.5, 0.25]);
check(res.map((r) => `${r.pages[0].name} ${r.pages[0].width}x${r.pages[0].height}`).join() === 'atlas.png 1024x1024,atlas@0.5x.png 512x512,atlas@0.25x.png 256x256' && res.every((r) => !r.notes.length),
  `pages: ${res.map((r) => `${r.pages[0].name} ${r.pages[0].width}`).join(', ')}`);
check(Buffer.compare(Buffer.from(res[0].ug9), Buffer.from(compileUgo(json, { warnings: [] }))) === 0, 'at 1: the same .ug9 as compiling the model');
const T = res.map((r) => readUg9Tables(r.ug9));
const view = (t, k) => (k === 'animations' ? t.animations.map((a) => ({ ...a, name: t.string(a.name) })) : t[k]); // names by their text (the longer texture name moves them in the strings)
const same = (k) => T.every((t) => JSON.stringify(view(t, k)) === JSON.stringify(view(T[0], k)));
check(['pos', 'uv', 'parts', 'bones', 'params', 'indices', 'deltas', 'animations', 'keys'].every(same) && T.map((t) => t.string(t.textures[0].name ?? t.textures[0])).join() === 'atlas.png,atlas@0.5x.png,atlas@0.25x.png',
  'the .ug9 files hold the same model (positions, UVs, parts, bones, ...); only the texture\'s name differs');

// no bleeding: a small pixel takes opaque colour from at most one part's picture (each part's UV box on the page)
{
  const boxes = json.parts.map((p) => { const u = p.uvs.filter((_, i) => i % 2 === 0), v = p.uvs.filter((_, i) => i % 2 === 1); return [Math.min(...u), Math.min(...v), Math.max(...u), Math.max(...v)]; });
  const P = pages[0], counts = [];
  for (const k of [0.5, 0.25]) {
    const f = 1 / k;
    let two = 0;
    for (let Y = 0; Y < P.height * k; Y++) for (let X = 0; X < P.width * k; X++) {
      const from = new Set();
      for (let y = Y * f; y < (Y + 1) * f; y++) for (let x = X * f; x < (X + 1) * f; x++) {
        if (P.rgba[(y * P.width + x) * 4 + 3] < 8) continue;
        const u = (x + 0.5) / P.width, v = (y + 0.5) / P.height;
        boxes.forEach((b, i) => { if (u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]) from.add(i); });
      }
      if (from.size > 1) two++;
    }
    counts.push(two);
  }
  check(counts.every((n) => n === 0), `no small pixel mixes two parts' pictures (0.5: ${counts[0]}, 0.25: ${counts[1]}; the atlas's gaps are wide enough)`);
}

// the command line, and (with ugo_export) drawn small: the half-size atlas as the full one
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlassizes-'));
execFileSync('node', ['tools/atlas_sizes.mjs', 'samples/basic/model.json', '--scales', '1,0.5', '--out', dir], { encoding: 'utf8' });
check(['model.ug9', 'atlas.png', 'model@0.5x.ug9', 'atlas@0.5x.png'].every((f) => fs.existsSync(path.join(dir, f))) && Buffer.compare(fs.readFileSync(path.join(dir, 'atlas.png')), fs.readFileSync('samples/basic/atlas.png')) === 0,
  'command line: model.ug9 + atlas.png (copied as it is), model@0.5x.ug9 + atlas@0.5x.png');
let exe = null;
try { exe = findExporter(); } catch { /* not built */ }
if (exe) {
  const draw = (f) => { const out = path.join(dir, `${f}.rgba`); const r = spawnSync(exe, [path.join(dir, f), '--frames', '1', '--format', 'raw', '--size', '105x150', '--out', out]); if (r.status) throw new Error(String(r.stderr)); return fs.readFileSync(out); };
  const a = draw('model.ug9'), b = draw('model@0.5x.ug9');
  let most = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 4; c++) { const x = c < 3 ? (a[i + c] * a[i + 3]) / 255 : a[i + 3], y = c < 3 ? (b[i + c] * b[i + 3]) / 255 : b[i + 3], d = Math.abs(x - y); most = Math.max(most, d); sum += d; }
  check(most <= 16 && sum / a.length < 0.2, `drawn at a quarter of the canvas (105×150, 2× supersampling), the half-size atlas looks as the full one (most ${most.toFixed(0)}/255, mean ${(sum / a.length).toFixed(3)})`);
} else console.log('skip drawing check (no build/ugo_export)');
fs.rmSync(dir, { recursive: true, force: true });

let threw = null;
try { atlasSizes(json, pages, [2]); } catch (e) { threw = e.message; }
check(/at most 1/.test(threw || ''), 'a scale above 1 is refused');

console.log(failures ? `\n${failures} check(s) failed` : '\nall atlas size checks passed');
process.exit(failures ? 1 : 0);
