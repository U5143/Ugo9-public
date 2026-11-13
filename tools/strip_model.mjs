// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// What goes into an export (機能の比べ #91、利用者の声 #25): a copy of the working JSON with only the animations asked
// for, and without the physics, the swaying chains or the expressions when they are not wanted (a game that plays two
// animations and has its own physics need not carry the rest). The editor's own data (editor, source) is left out too:
// the compiler does not read it. Nothing else changes, so the parts, bones, parameters and deformers are as they were.
//
//   stripModel(json, opts) -> { model, removed: { animations: [ids], physics, chains, expressions }, notes }
//     opts: { anims: [ids] (all by default), physics: false, chains: false, expressions: false, editorData (true: keep editor and source) }
//   node tools/strip_model.mjs model.json --out game.ug9 | game.json [--anims idle,walk] [--no-physics] [--no-chains]
//     [--no-expressions]   (a .ug9 is read back to its working JSON first, tools/import_ug9.mjs)
// Works in the browser (no Node APIs outside the CLI block).
import { compileUgo } from './compile.mjs';

/** The model with only what is asked for. */
export function stripModel(json, opts = {}) {
  const model = structuredClone(json), notes = [], removed = { animations: [], physics: 0, chains: 0, expressions: 0 };
  if (opts.anims) {
    const want = new Set(opts.anims), have = new Set((model.animations || []).map((a) => a.id));
    for (const id of want) if (!have.has(id)) notes.push({ code: 'stripNoAnimation', vars: { anim: id }, text: `no animation named ${id}` });
    removed.animations = (model.animations || []).filter((a) => !want.has(a.id)).map((a) => a.id);
    model.animations = (model.animations || []).filter((a) => want.has(a.id));
  }
  for (const k of ['physics', 'chains', 'expressions']) {
    if (opts[k] === false && model[k]?.length) { removed[k] = model[k].length; delete model[k]; }
  }
  if (opts.editorData !== true) { delete model.editor; delete model.source; } // the .ug9 has no place for them
  return { model, removed, notes };
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const args = process.argv.slice(2), src = args.find((a, i) => !a.startsWith('--') && !['--out', '--anims'].includes(args[i - 1])), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!src || !out) { console.error('usage: node tools/strip_model.mjs model.json|model.ug9 --out game.ug9|game.json [--anims a,b] [--no-physics] [--no-chains] [--no-expressions]'); process.exit(2); }
  let json;
  if (/\.ug9$/i.test(src)) { const { importUg9 } = await import('./import_ug9.mjs'); json = importUg9(fs.readFileSync(src)).json; }
  else json = JSON.parse(fs.readFileSync(src, 'utf8'));
  const before = compileUgo(json, { warnings: [] }).byteLength;
  const r = stripModel(json, {
    anims: args.includes('--anims') ? args[args.indexOf('--anims') + 1].split(',').filter(Boolean) : undefined,
    physics: !args.includes('--no-physics'), chains: !args.includes('--no-chains'), expressions: !args.includes('--no-expressions'),
  });
  for (const n of r.notes) console.log(`warning: ${n.text}`);
  if (r.notes.some((n) => n.code === 'stripNoAnimation')) process.exit(1);
  const bin = new Uint8Array(compileUgo(r.model, { warnings: [] }));
  if (/\.ug9$/i.test(out)) fs.writeFileSync(out, bin);
  else fs.writeFileSync(out, JSON.stringify(r.model, null, 1));
  const gone = [r.removed.animations.length ? `animations ${r.removed.animations.join(', ')}` : '', ...['physics', 'chains', 'expressions'].filter((k) => r.removed[k]).map((k) => `${r.removed[k]} ${k}`)].filter(Boolean);
  console.log(`${out}: ${gone.length ? `left out ${gone.join('; ')}` : 'nothing left out'} (.ug9 ${before} → ${bin.byteLength} bytes)`);
}
