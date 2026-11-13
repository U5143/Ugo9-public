// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The moved picture as a PSD (機能の比べ #15、利用者の声 #17): a pose (parameters held, or a moment of an animation),
// or each frame of an animation, drawn by the core (ugo_export) and written as PSD layers, to paint over or to take
// into another app.
//   --by part   a layer per part (the default), its blend mode kept as the layer's
//   --by group  a layer per PSD folder the parts came from (source.psd in the working JSON; --depth N: how deep)
//   --by whole  the whole model as one layer
//   --anim NAME --frames N [--fps F]: each frame a folder (--by whole: a layer), all but the first hidden
// Each layer is the core's own drawing of only its parts (the rest are left out of the picture but still cut
// masks), in place on the canvas and trimmed to what it covers. The merged picture (for apps that read only it)
// is the first frame over white.
//
//   exportPosePsd(modelPath, opts) -> { psd: Uint8Array, width, height, layers, frames }
//     opts: by, depth (1), anim, frames (1), fps (30), start (0), params { NAME: value }, pad, ss, exporter
//   writeLayeredPsd: tools/psd_write.mjs (no Node API, for the browser too); exported here as well
//   node tools/export_pose_psd.mjs model.ug9|model.json --out pose.psd [--by part|group|whole] [--depth N]
//     [--anim NAME [--frames N] [--fps F] [--start S]] [--param NAME=V ...] [--pad P] [--ss N]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importUg9 } from './import_ug9.mjs';
import { compileUgo } from './compile.mjs';
import { findExporter } from './compare_frames.mjs';
import { writeLayeredPsd, trimLayer } from './psd_write.mjs';

export { writeLayeredPsd };

/** The layers to draw: [{ name, parts: Set, blend? }], in drawing order. */
export function layerSets(json, by = 'part', depth = 1) {
  const drawn = (json.parts || []).map((p, i) => ({ p, i })).filter(({ p }) => !p.maskOnly)
    .sort((a, b) => (a.p.order ?? 500) - (b.p.order ?? 500) || a.i - b.i).map(({ p }) => p);
  if (by === 'whole') return [{ name: 'model', parts: new Set(drawn.map((p) => p.id)) }];
  if (by === 'part') return drawn.map((p) => ({ name: p.id, parts: new Set([p.id]), blend: p.blend || 'normal' }));
  const folders = new Map((json.source?.psd?.layers || []).map((l) => [l.part, (l.groups || []).slice(0, depth)]));
  const sets = new Map();
  for (const p of drawn) {
    const g = folders.get(p.id) || [], key = g.length ? `/${g.join('/')}` : p.id;
    if (!sets.has(key)) sets.set(key, { name: g.length ? g[g.length - 1] : p.id, parts: new Set() });
    sets.get(key).parts.add(p.id);
  }
  return [...sets.values()];
}

/** Draws the layers and writes the PSD. */
export function exportPosePsd(modelPath, opts = {}) {
  const exe = opts.exporter || findExporter(), dir = path.dirname(modelPath);
  const json = /\.json$/i.test(modelPath) ? JSON.parse(fs.readFileSync(modelPath, 'utf8')) : importUg9(fs.readFileSync(modelPath)).json;
  const by = opts.by || 'part', frames = opts.anim ? Math.max(1, opts.frames || 1) : 1, fps = opts.fps || 30;
  if (opts.anim && !(json.animations || []).some((a) => a.id === opts.anim)) throw new Error(`no animation named ${opts.anim}`);
  const notes = [];
  if (by === 'group' && !json.source?.psd?.layers) notes.push('the model keeps no PSD folders (source.psd): a layer per part');
  const sets = layerSets(json, by === 'group' && !json.source?.psd?.layers ? 'part' : by, opts.depth || 1);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo9-posepsd-'));
  for (const t of json.textures || []) fs.copyFileSync(path.join(dir, t), path.join(tmp, path.basename(t)));
  let W = 0, H = 0;
  const draw = (only, blendNormal, i) => { // only: the parts drawn (null: all) -> [frame rgba]
    const m = structuredClone(json);
    m.textures = (m.textures || []).map((t) => path.basename(t));
    if (!opts.anim) m.animations = [];
    if (only) for (const p of m.parts) { if (!only.has(p.id)) p.maskOnly = true; else if (blendNormal) delete p.blend; }
    const file = path.join(tmp, `${i}.ug9`), out = path.join(tmp, `${i}.rgba`);
    fs.writeFileSync(file, new Uint8Array(compileUgo(m, { warnings: [] })));
    const args = [file, '--format', 'raw', '--out', out, '--frames', String(frames), '--fps', String(fps), '--start', String(opts.start || 0)];
    if (opts.anim) args.push('--anim', opts.anim);
    for (const [k, v] of Object.entries(opts.params || {})) args.push('--param', `${k}=${v}`);
    if (opts.pad) args.push('--pad', String(opts.pad));
    if (opts.ss) args.push('--ss', String(opts.ss));
    const run = spawnSync(exe, args, { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`ugo_export failed: ${(run.stderr || '').trim()}`);
    const sz = / (\d+)x(\d+), raw/.exec(run.stderr || '');
    if (!sz) throw new Error('could not tell the frame size from ugo_export');
    [W, H] = [+sz[1], +sz[2]];
    const raw = fs.readFileSync(out);
    return Array.from({ length: frames }, (_, k) => new Uint8Array(raw.buffer, raw.byteOffset + k * W * H * 4, W * H * 4));
  };
  try {
    const whole = draw(null, false, 'all');
    const drawnSets = by === 'whole' ? [{ ...sets[0], frames: whole }] : sets.map((s, i) => ({ ...s, frames: draw(s.parts, !!s.blend, i) }));
    // a layer that covers nothing at this moment (a closed eye's part with the eyes open) stays, empty, so that every part is there
    const layerOf = (s, f, hidden, name) => ({ name, ...(trimLayer(s.frames[f], W, H) || {}), blend: s.blend || 'normal', hidden });
    const frameName = (f) => `${opts.anim} ${String(f).padStart(3, '0')}`;
    let items;
    if (frames === 1) items = drawnSets.map((s) => layerOf(s, 0, false, s.name));
    else if (by === 'whole') items = Array.from({ length: frames }, (_, f) => layerOf(drawnSets[0], f, f > 0, frameName(f)));
    else items = Array.from({ length: frames }, (_, f) => ({ folder: frameName(f), hidden: f > 0, children: drawnSets.map((s) => layerOf(s, f, false, s.name)) }));
    const psd = writeLayeredPsd(W, H, items, { rgba: whole[0] });
    return { psd, width: W, height: H, layers: drawnSets.length, frames, notes };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opts = { params: {} };
  let model = null, out = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => args[++i];
    if (a === '--out') out = v();
    else if (a === '--by') opts.by = v();
    else if (a === '--depth') opts.depth = Number(v());
    else if (a === '--anim') opts.anim = v();
    else if (a === '--frames') opts.frames = Number(v());
    else if (a === '--fps') opts.fps = Number(v());
    else if (a === '--start') opts.start = Number(v());
    else if (a === '--param') { const [k, x] = v().split('='); opts.params[k] = Number(x); }
    else if (a === '--pad') opts.pad = Number(v());
    else if (a === '--ss') opts.ss = Number(v());
    else if (!a.startsWith('--')) model = a;
  }
  if (!model || !out || !['part', 'group', 'whole', undefined].includes(opts.by)) {
    console.error('usage: node tools/export_pose_psd.mjs model.ug9|model.json --out pose.psd [--by part|group|whole] [--depth N] [--anim NAME [--frames N] [--fps F] [--start S]] [--param NAME=V ...] [--pad P] [--ss N]');
    process.exit(2);
  }
  const r = exportPosePsd(model, opts);
  fs.writeFileSync(out, r.psd);
  for (const n of r.notes) console.log(`note: ${n}`);
  console.log(`${out}: ${r.width}x${r.height}, ${r.layers} layer(s)${r.frames > 1 ? ` × ${r.frames} frames` : ''}, ${r.psd.length} bytes`);
}
