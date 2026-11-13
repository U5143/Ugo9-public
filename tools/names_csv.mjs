// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The model's ids as a CSV, to rename many at once in a spreadsheet (機能の比べ #11、利用者の声 #33): one row per
// parameter, part, bone, colour, warp grid, chain, animation and expression: kind, id, new_id (empty: kept), info (what it
// is: a parameter's range, a part's PSD layer, a bone's parent, ...: only for reading). Read back, each id is renamed
// everywhere it is used (tools/rename_ids.mjs, the same as the editor renames), the PSD layers' list (source.psd.layers) too; ids can be
// swapped (two passes through names no one uses). A new id already taken, given twice or empty stops it, with nothing
// changed.
//
//   namesCsv(json) -> text (UTF-8 with a BOM, so spreadsheet apps read it as UTF-8)
//   applyNamesCsv(json, text) -> { model, renamed: [{ kind, from, to }], notes } (notes with level 'error': model unchanged)
//   node tools/names_csv.mjs model.json --out names.csv
//   node tools/names_csv.mjs model.json --apply names.csv --out renamed.json
// Works in the browser (no Node APIs outside the CLI block).
import { renameId } from './rename_ids.mjs';

// kind -> [the model's list, renamed through tools/rename_ids.mjs (true) or here]
const KINDS = { param: ['parameters', true], part: ['parts', true], bone: ['bones', true], color: ['colors', true], warp: ['warps', true], chain: ['chains', true], anim: ['animations', false], expression: ['expressions', false] };

const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function info(json, kind, x) {
  if (kind === 'param') return `${x.min ?? 0}..${x.max ?? 1} (default ${x.default ?? x.min ?? 0})`;
  if (kind === 'part') { const l = json.source?.psd?.layers?.find((m) => m.part === x.id); return l ? `PSD: ${(l.path || [l.name]).join('/')}` : x.bone ? `bone ${x.bone}` : ''; }
  if (kind === 'bone') return x.parent ? `parent ${x.parent}` : '';
  if (kind === 'warp') return x.parent ? `in ${x.parent}` : '';
  if (kind === 'chain') return (x.bones || []).join(' ');
  if (kind === 'anim') return `${x.duration ?? 0} s${x.loop ? ', loop' : ''}`;
  return '';
}

/** The ids as CSV text. */
export function namesCsv(json) {
  const rows = [['kind', 'id', 'new_id', 'info']];
  for (const [kind, [list]] of Object.entries(KINDS)) for (const x of json[list] || []) if (x.id !== undefined) rows.push([kind, x.id, '', info(json, kind, x)]);
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** CSV text -> rows of cells (RFC 4180: quotes, "" inside them, line breaks inside them; a BOM skipped). */
export function parseCsv(text) {
  const s = text.replace(/^﻿/, ''), rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** The renames in the CSV applied to a copy of the model. */
export function applyNamesCsv(json, text) {
  const rows = parseCsv(text), notes = [], err = (code, vars, t) => notes.push({ code, vars, level: 'error', text: t });
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) || [];
  const ci = { kind: head.indexOf('kind'), id: head.indexOf('id'), to: head.indexOf('new_id') };
  if (ci.kind < 0 || ci.id < 0 || ci.to < 0) { err('namesCsvHeader', {}, 'the first row needs the columns kind, id and new_id'); return { model: json, renamed: [], notes }; }
  const plan = {}; // kind -> [[from, to]]
  rows.forEach((r, n) => {
    const kind = (r[ci.kind] || '').trim(), id = r[ci.id] ?? '', to = (r[ci.to] ?? '').trim();
    if (!to || to === id) return;
    if (!KINDS[kind]) { err('namesCsvKind', { row: n + 2, kind }, `row ${n + 2}: kind ${kind} is not known`); return; }
    if (!(json[KINDS[kind][0]] || []).some((x) => x.id === id)) { err('namesCsvNoId', { row: n + 2, kind, id }, `row ${n + 2}: there is no ${kind} ${id}`); return; }
    (plan[kind] ||= []).push([id, to]);
  });
  for (const [kind, pairs] of Object.entries(plan)) {
    const ids = new Set((json[KINDS[kind][0]] || []).map((x) => x.id)), from = new Set(pairs.map((p) => p[0])), tos = pairs.map((p) => p[1]);
    for (const [, to] of pairs) {
      if (tos.indexOf(to) !== tos.lastIndexOf(to)) err('namesCsvTwice', { kind, id: to }, `${kind} ${to}: given as the new id twice`);
      else if (ids.has(to) && !from.has(to)) err('namesCsvTaken', { kind, id: to }, `${kind} ${to}: that id is taken (rename that one too, or choose another)`);
    }
    for (const [a] of pairs) if (pairs.filter((p) => p[0] === a).length > 1) err('namesCsvTwice', { kind, id: a }, `${kind} ${a}: renamed in two rows`);
  }
  if (notes.some((x) => x.level === 'error')) return { model: json, renamed: [], notes };
  const model = structuredClone(json), renamed = [];
  const step = (kind, a, b) => {
    const [list, viaRefs] = KINDS[kind];
    if (viaRefs) renameId(model, kind, a, b); // the PSD layers' list follows too (to read the PSD again)
    else for (const x of model[list]) if (x.id === a) x.id = b;
  };
  for (const [kind, pairs] of Object.entries(plan)) {
    pairs.forEach(([a], i) => step(kind, a, `\u0001csv${i}`)); // through names no one uses, so ids can be swapped
    pairs.forEach(([a, b], i) => { step(kind, `\u0001csv${i}`, b); renamed.push({ kind, from: a, to: b }); });
  }
  return { model, renamed, notes };
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const args = process.argv.slice(2), opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const src = args.find((a, i) => !a.startsWith('--') && !['--out', '--apply'].includes(args[i - 1])), out = opt('--out'), csv = opt('--apply');
  if (!src || !out) { console.error('usage: node tools/names_csv.mjs model.json --out names.csv\n       node tools/names_csv.mjs model.json --apply names.csv --out renamed.json'); process.exit(2); }
  const json = JSON.parse(fs.readFileSync(src, 'utf8'));
  if (!csv) { fs.writeFileSync(out, namesCsv(json)); console.log(`${out}: the ids (fill new_id where one changes, then --apply)`); process.exit(0); }
  const r = applyNamesCsv(json, fs.readFileSync(csv, 'utf8'));
  for (const n of r.notes) console.log(`${n.level}: ${n.text}`);
  if (r.notes.some((n) => n.level === 'error')) process.exit(1);
  fs.writeFileSync(out, JSON.stringify(r.model, null, 1));
  console.log(`${out}: ${r.renamed.length} renamed${r.renamed.length ? ` (${r.renamed.slice(0, 5).map((x) => `${x.from} → ${x.to}`).join(', ')}${r.renamed.length > 5 ? ', ...' : ''})` : ''}`);
}
