// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Every animation of a .ug9 in one sprite sheet, for game engines without a Ugo9 runtime (利用者の声 #2:
// GameMaker, Construct, GDevelop, Defold, Phaser, PixiJS...): ugo_export draws each animation (one loop of
// it, physics settled), web/sheet.js trims the frames, keeps a picture once where frames look the same and
// packs them; next to the PNG, the "JSON (Hash)" description (TexturePacker / Aseprite style) with one frame
// tag per animation.
//
//   node tools/export_sheet.mjs model.ug9 --out build/sheet/hero.png [--fps 12] [--size 256x256]
//        [--anims idle,walk] [--no-trim] [--no-dedupe] [--max-width 4096] [--ugo-export path]
//   -> hero.png and hero.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readUg9Tables } from './import_ug9.mjs';
import { findExporter } from './compare_frames.mjs';
import { encodePng } from './png.mjs';
import { packSheet } from '../web/sheet.js';

/**
 * model (.ug9 path) -> { png, json, width, height, frames, unique, anims }. opts: fps (12), size ('WxH'; the canvas's own size by default), anims (names; all by default), trim, dedupe, maxWidth, exporter (ugo_export's path), image (the
 * PNG's name in the description).
 */
export function exportSheet(model, opts = {}) {
  const exe = opts.exporter || findExporter();
  if (!exe) throw new Error('ugo_export is not built (build/ugo_export)');
  const t = readUg9Tables(fs.readFileSync(model));
  const all = t.animations.map((a) => ({ name: t.string(a.name), duration: a.duration, loop: a.loop }));
  const wanted = opts.anims ? opts.anims.map((n) => all.find((a) => a.name === n) || (() => { throw new Error(`no animation named ${n}`); })()) : all;
  if (!wanted.length) throw new Error('the model has no animations');
  const fps = opts.fps || 12, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo9-sheet-'));
  const size = opts.size ? ['--size', opts.size] : [];
  let w = 0, h = 0;
  try {
    const anims = wanted.map((a, i) => {
      const n = Math.max(1, Math.round((a.duration || 1) * fps)), out = path.join(tmp, `${i}.rgba`);
      const run = spawnSync(exe, [model, '--anim', a.name, '--frames', String(n), '--fps', String(fps), ...size, '--format', 'raw', '--out', out], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`ugo_export failed for ${a.name}: ${(run.stderr || '').trim()}`);
      const m = / (\d+)x(\d+), raw/.exec(run.stderr || ''); // "out: N frames, WxH, raw"
      if (!m) throw new Error('could not tell the frame size from ugo_export');
      [w, h] = [+m[1], +m[2]];
      const raw = fs.readFileSync(out);
      const frames = Array.from({ length: n }, (_, k) => new Uint8Array(raw.buffer, raw.byteOffset + k * w * h * 4, w * h * 4));
      return { name: a.name, fps, frames };
    });
    const sheet = packSheet(anims, w, h, { trim: opts.trim, dedupe: opts.dedupe, maxWidth: opts.maxWidth, image: opts.image || 'sheet.png' });
    return { ...sheet, png: encodePng(sheet.width, sheet.height, sheet.rgba), anims: anims.map((a) => ({ name: a.name, frames: a.frames.length })), frameWidth: w, frameHeight: h };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opts = {};
  let model = null, out = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => args[++i];
    if (a === '--out') out = v();
    else if (a === '--fps') opts.fps = Number(v());
    else if (a === '--size') opts.size = v();
    else if (a === '--anims') opts.anims = v().split(',').filter(Boolean);
    else if (a === '--no-trim') opts.trim = false;
    else if (a === '--no-dedupe') opts.dedupe = false;
    else if (a === '--max-width') opts.maxWidth = Number(v());
    else if (a === '--ugo-export') opts.exporter = v();
    else if (!model) model = a;
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  if (!model || !out) { console.error('usage: node tools/export_sheet.mjs model.ug9 --out sheet.png [--fps 12] [--size WxH] [--anims a,b] [--no-trim] [--no-dedupe] [--max-width N]'); process.exit(2); }
  const res = exportSheet(model, { ...opts, image: path.basename(out) });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, res.png);
  fs.writeFileSync(out.replace(/\.png$/i, '') + '.json', res.json);
  console.log(`${out}: ${res.width}x${res.height}, ${res.frames} frames (${res.unique} pictures) of ${res.anims.map((a) => `${a.name} ${a.frames}`).join(', ')}; frame ${res.frameWidth}x${res.frameHeight}`);
}
