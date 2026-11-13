// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// One command for the work files (機能の比べ #96、利用者の声 #25): the tools in this folder behind five words.
//
//   node tools/ugo9.mjs pack   <folder | model.json> --out name.ugo9        the working JSON and its pictures in one .ugo9
//   node tools/ugo9.mjs unpack <name.ugo9> --out folder                     back to model.json and the pictures
//   node tools/ugo9.mjs import <picture | skeleton | .ug9> --out folder | name.ugo9 [-- the importer's options]
//       by what the file is (not its name): PSD/PSB (import_psd), Krita / OpenRaster / Procreate / Aseprite / a folder
//       of PNG (import_layers), Spine JSON or binary with its .atlas beside it (import_spine), .ug9 (import_ug9),
//       .ugo9 (unpack)
//   node tools/ugo9.mjs export <folder | model.json | name.ugo9 | model.ug9> --out FILE [--as KIND] [-- the exporter's options]
//       KIND from --as or the ending of FILE: ug9 (compile), spine (export_spine; FILE is the folder/name), html / js
//       (export_web), sheet (export_sheet, a .png), gif / apng / mp4 / webm / mov / frames (ugo_export)
//       --light [0.5] (with ug9): also a lighter version beside it, NAME@0.5x.ug9 and its atlas pages that many times as
//       large (atlas_sizes; 利用者の声 #400: pages of 8192-16384 px are slow to load). Without it, pages over 4096 px are
//       pointed out
//       --target 1.0 (with ug9): write a .ug9 that a 1.0 player reads (機能の比べ #13): the curve keys (1.1) cut into
//       the straight pieces a 1.1 player makes of them at load, so it moves the same. --target 1.1: the newest (the
//       default; a model without curves is 1.0 anyway)
//
//   node tools/ugo9.mjs info <folder | model.json | name.ugo9 | model.ug9> [--json]
//       how heavy the model is (model_info: counts, memory, draws, textures, drawn area, the heaviest parts)
//
// Each word runs the tool that does the work (its own messages and exit code); this file only finds the files and
// the tool. Exit 2 for a wrong command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeUgo9, readUgo9 } from './lib/ugo9file.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const tool = (name) => path.join(TOOLS, name);
const fail = (msg, code = 2) => { const e = new Error(msg); e.exit = code; throw e; };

/** What a file is, from its first bytes (and, for zips, what is inside): 'psd' | 'ugo9' | 'layers' | 'spine' | 'ug9' | 'svg' | 'folder' | null */
export function kindOf(file) {
  if (fs.statSync(file).isDirectory()) return fs.existsSync(path.join(file, 'model.json')) ? 'project' : 'folder';
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(512);
  const n = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  const h = head.subarray(0, n), text = h.toString('utf8');
  if (h.subarray(0, 4).toString('latin1') === '8BPS') return 'psd';
  if (h.subarray(0, 4).toString('latin1') === 'UGO9') return 'ug9';
  if (h[0] === 0x50 && h[1] === 0x4b) return h.subarray(30, 30 + h.readUInt16LE(26)).toString('utf8') === 'model.json' ? 'ugo9' : 'layers'; // a .ugo9 starts with model.json; else Krita / OpenRaster / Procreate
  if (n >= 6 && h[4] === 0xe0 && h[5] === 0xa5) return 'layers'; // Aseprite
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text)) return 'svg';
  if (/^\s*\{/.test(text)) {
    const j = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } })();
    if (j?.skeleton && j?.bones) return 'spine';
    if (j?.parts || j?.format === 'ugo9') return 'model';
    return null;
  }
  if (/\.skel(\.bytes)?$/i.test(file)) return 'spine';
  return null;
}

// the .atlas beside a Spine skeleton: name.atlas, name.atlas.txt, or the only .atlas in the folder
function atlasBeside(file) {
  const dir = path.dirname(file), base = path.basename(file).replace(/\.(json|skel|bytes)$/gi, '').replace(/\.skel$/i, '');
  for (const n of [`${base}.atlas`, `${base}.atlas.txt`]) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  const all = fs.readdirSync(dir).filter((f) => /\.atlas(\.txt)?$/i.test(f));
  if (all.length === 1) return path.join(dir, all[0]);
  return fail(`no .atlas beside ${file} (name it ${base}.atlas)`);
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (r.status !== 0) fail(`${path.basename(script)} stopped (exit ${r.status})`, r.status || 1);
}

/** A folder (model.json and its files) into a .ugo9's bytes. The pictures: the model's textures, and what a manifest.json beside it lists (with their roles). */
export async function pack(src) {
  const json = fs.statSync(src).isDirectory() ? path.join(src, 'model.json') : src, dir = path.dirname(json);
  if (!fs.existsSync(json)) fail(`no model.json in ${src}`);
  const text = fs.readFileSync(json, 'utf8'), model = JSON.parse(text), pics = [], seen = new Set();
  for (const t of model.textures || []) {
    if (!fs.existsSync(path.join(dir, t))) fail(`the model's texture ${t} is not in ${dir}`);
    pics.push([t, fs.readFileSync(path.join(dir, t)), 'texture']); seen.add(path.basename(t));
  }
  const card = path.join(dir, 'manifest.json');
  if (fs.existsSync(card)) {
    for (const f of JSON.parse(fs.readFileSync(card, 'utf8')).files || []) {
      if (seen.has(f.name) || !fs.existsSync(path.join(dir, f.name))) continue;
      pics.push([f.name, fs.readFileSync(path.join(dir, f.name)), f.role]); seen.add(f.name);
    }
  }
  return writeUgo9(text, pics, { savedBy: 'tools/ugo9.mjs' });
}

/** A .ugo9 into a folder: model.json, every file in it, and its card (manifest.json, so pack gives the roles back). -> the files written */
export async function unpack(bytes, out) {
  const { text, entries, manifest } = await readUgo9(new Uint8Array(bytes));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'model.json'), text);
  const written = ['model.json'];
  for (const e of entries) {
    const name = path.basename(e.path);
    fs.writeFileSync(path.join(out, name), new Uint8Array(await e.file.arrayBuffer())); written.push(name);
  }
  if (manifest) { fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1)); written.push('manifest.json'); }
  return written;
}

// a model to export from, as a folder with model.json (and, made on asking, model.ug9 beside its textures)
function projectOf(src, tmp) {
  const k = kindOf(src);
  if (k === 'project') return { dir: src, json: path.join(src, 'model.json') };
  if (k === 'model') return { dir: path.dirname(src), json: src };
  if (k === 'ugo9' || k === 'ug9') return { dir: tmp, json: path.join(tmp, 'model.json'), from: k };
  return fail(`${src} is not a model (a folder with model.json, a model.json, a .ugo9 or a .ug9)`);
}

// the format versions a .ug9 can be written for (#13): 1.0 (no curve keys) and 1.1 (the newest)
const TARGETS = ['1.0', '1.1'];

/** After a .ug9 is written: with --light (k), a version with its pages k times as large beside it (NAME@0.5x.ug9 and
 *  the pages' PNG); without, a word when a page is over 4096 px. */
async function lighter(json, texDir, out, k, target) {
  const model = JSON.parse(fs.readFileSync(json, 'utf8')), size = (t) => { try { const b = fs.readFileSync(path.join(texDir, t)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; } catch { return [0, 0]; } };
  const sizes = (model.textures || []).map(size), big = Math.max(0, ...sizes.flat());
  if (!k) {
    if (big > 4096) console.log(`note: atlas pages up to ${big} px are slow to load on phones and some engines: --light also writes a half-size version`);
    return;
  }
  const { atlasSizes } = await import('./atlas_sizes.mjs'), { decodePng, encodePng } = await import('./png.mjs');
  const pages = model.textures.map((t) => decodePng(fs.readFileSync(path.join(texDir, t))));
  const [r] = atlasSizes(model, pages, [k], { compile: target === '1.0' ? { curveKeys: false } : {} });
  const dir = path.dirname(out), file = path.join(dir, path.basename(out).replace(/\.ug9$/i, '') + r.suffix + '.ug9');
  for (const pg of r.pages) fs.writeFileSync(path.join(dir, pg.name), encodePng(pg.width, pg.height, pg.rgba));
  fs.writeFileSync(file, r.ug9);
  for (const n of r.notes) console.log(`note: ${n.text}`);
  console.log(`${file}: the lighter version (${r.pages.map((pg) => `${pg.name} ${pg.width}x${pg.height}`).join(', ')})`);
}

/** Compiles model.json into a .ug9 for a player of the given version. */
export async function compileFor(json, target) {
  const { compileUgo } = await import('./compile.mjs');
  const warnings = [], bytes = new Uint8Array(compileUgo(json, { warnings, curveKeys: target === '1.0' ? false : undefined }));
  return { bytes, warnings, version: `${bytes[4] | (bytes[5] << 8)}.${bytes[6] | (bytes[7] << 8)}` };
}

const EXPORT_KINDS = { '.ug9': 'ug9', '.html': 'html', '.js': 'js', '.gif': 'gif', '.apng': 'apng', '.mp4': 'mp4', '.webm': 'webm', '.mov': 'mov' };

export async function main(argv) {
  const dash = argv.indexOf('--'), pass = dash >= 0 ? argv.slice(dash + 1) : [], args = dash >= 0 ? argv.slice(0, dash) : argv;
  const [word, src] = args, opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null), out = opt('--out');
  const usage = () => fail([
    'usage: node tools/ugo9.mjs pack <folder|model.json> --out name.ugo9',
    '       node tools/ugo9.mjs unpack <name.ugo9> --out folder',
    '       node tools/ugo9.mjs import <file> --out folder|name.ugo9 [-- importer options]',
    '       node tools/ugo9.mjs export <folder|model.json|name.ugo9|model.ug9> --out FILE [--as ug9|spine|html|js|sheet|gif|apng|mp4|webm|mov|frames] [--target 1.0|1.1] [--light [0.5]] [-- exporter options]',
    '       node tools/ugo9.mjs info <folder|model.json|name.ugo9|model.ug9> [--json]',
  ].join('\n'));
  if (word === 'info' && src && fs.existsSync(src)) { // no --out: it only says
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo9-cli-'));
    try {
      const p = projectOf(src, tmp);
      if (p.from === 'ugo9') await unpack(fs.readFileSync(src), tmp);
      run(tool('model_info.mjs'), [p.from === 'ug9' ? src : p.json, ...(args.includes('--json') ? ['--json'] : [])]);
      return 0;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  if (!word || !src || !out || !fs.existsSync(src)) return usage();

  if (word === 'pack') { fs.writeFileSync(out, await pack(src)); console.log(`${out}: packed`); return 0; }
  if (word === 'unpack') { const w = await unpack(fs.readFileSync(src), out); console.log(`${out}: ${w.join(', ')}`); return 0; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo9-cli-'));
  try {
    if (word === 'import') {
      const k = kindOf(src), toUgo9 = /\.ugo9$/i.test(out), dir = toUgo9 ? tmp : out;
      if (k === 'psd') run(tool('import_psd.mjs'), [src, dir, ...pass]);
      else if (k === 'layers' || k === 'folder') run(tool('import_layers.mjs'), [src, dir, ...pass]);
      else if (k === 'spine') run(tool('import_spine.mjs'), [src, atlasBeside(src), dir, ...pass]);
      else if (k === 'ug9') run(tool('import_ug9.mjs'), [src, dir]);
      else if (k === 'ugo9') console.log(`${dir}: ${(await unpack(fs.readFileSync(src), dir)).join(', ')}`);
      else if (k === 'svg') fail('SVG needs a browser to draw its shapes: open it in the editor (ファイル → 開く)');
      else fail(`${src}: not a file this reads (PSD/PSB, Krita, OpenRaster, Procreate, Aseprite, a folder of PNG, Spine, .ug9, .ugo9)`);
      if (toUgo9) { fs.writeFileSync(out, await pack(dir)); console.log(`${out}: packed`); }
      return 0;
    }
    if (word === 'export') {
      const as = opt('--as') || EXPORT_KINDS[path.extname(out).toLowerCase()] || fail(`say what to write with --as (the ending of ${out} does not tell)`);
      const target = opt('--target');
      if (target && !TARGETS.includes(target)) fail(`--target: ${target} is not a version this writes (${TARGETS.join(', ')})`);
      if (target && as !== 'ug9') fail('--target is for a .ug9 (--as ug9): the other kinds carry their own player');
      const p = projectOf(src, tmp);
      if (p.from === 'ugo9') await unpack(fs.readFileSync(src), tmp);
      if (p.from === 'ug9') {
        if (as !== 'spine' && as !== 'ug9') { // the exporters that read a .ug9 take it as it is
          return exportUg9(src, as, out, pass);
        }
        run(tool('import_ug9.mjs'), [src, tmp]);
      }
      const li = args.indexOf('--light'), light = li < 0 ? null : Number(args[li + 1]) > 0 && Number(args[li + 1]) < 1 ? Number(args[li + 1]) : 0.5;
      if (li >= 0 && as !== 'ug9') fail('--light is for a .ug9 (--as ug9)');
      const texDir = p.from === 'ug9' ? path.dirname(src) : p.dir; // where the pictures are (a .ug9's beside it)
      if (as === 'ug9' && target) {
        const r = await compileFor(JSON.parse(fs.readFileSync(p.json, 'utf8')), target);
        fs.writeFileSync(out, r.bytes);
        for (const w of r.warnings) console.warn(`${w.code}: ${w.message}`);
        console.log(`${out}: ${r.bytes.length} bytes, format ${r.version}`);
        await lighter(p.json, texDir, out, light, target);
        return 0;
      }
      if (as === 'ug9') { run(tool('compile.mjs'), [p.json, out]); await lighter(p.json, texDir, out, light, target); return 0; }
      if (as === 'spine') { run(tool('export_spine.mjs'), [p.json, '--out', out, ...pass]); return 0; }
      // the rest read a .ug9 beside its textures
      const model = JSON.parse(fs.readFileSync(p.json, 'utf8')), ug9 = path.join(tmp, 'model.ug9');
      for (const t of model.textures || []) if (path.resolve(p.dir) !== path.resolve(tmp)) fs.copyFileSync(path.join(p.dir, t), path.join(tmp, path.basename(t)));
      model.textures = (model.textures || []).map((t) => path.basename(t));
      fs.writeFileSync(path.join(tmp, 'build.json'), JSON.stringify(model));
      run(tool('compile.mjs'), [path.join(tmp, 'build.json'), ug9]);
      return exportUg9(ug9, as, out, pass);
    }
    return usage();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function exportUg9(ug9, as, out, pass) {
  if (as === 'html' || as === 'js') run(tool('export_web.mjs'), [ug9, '--out', out, ...pass]);
  else if (as === 'sheet') run(tool('export_sheet.mjs'), [ug9, '--out', out, ...pass]);
  else if (['gif', 'apng', 'mp4', 'webm', 'mov', 'frames'].includes(as)) {
    const exe = ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe'].map((p) => path.join(TOOLS, '..', p)).find((p) => fs.existsSync(p)) || fail('ugo_export is not built (cmake --build build)');
    const r = spawnSync(exe, [ug9, '--out', out, '--format', as, ...pass], { stdio: 'inherit' });
    if (r.status !== 0) fail(`ugo_export stopped (exit ${r.status})`, r.status || 1);
  } else fail(`unknown kind to write: ${as}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(e.exit ?? 1); });
}
