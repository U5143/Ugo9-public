// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Two models side by side (機能の比べ #94、利用者の声 #32): what changed between two .ug9 files (or working JSON, compiled
// first), for checking a new version before handing it on. Lists:
//   - the version, the file's size and the canvas
//   - each table of the binary: its records and bytes, before and after (the tables that changed)
//   - the names added and removed: parts, bones, parameters, animations, physics (by the parameter it moves),
//     chains, expressions
//   - the ones with the same name whose contents differ, and in what (the fields; for lists of numbers how many
//     changed and by how much at most)
// Both sides are read back the same way (tools/import_ug9.mjs), so only what the .ug9 holds is compared; what it
// does not keep (the editor's data, ids of deformers) is not.
//
//   ug9Diff(bytesA, bytesB, opts) -> { same, header, tables, names: { parts: { added, removed, changed: [{ id, fields }] }, ... } }
//     opts.tolerance (1e-4): numbers closer than this are the same
//   formatDiff(diff) -> text
//   node tools/ug9_diff.mjs before.ug9 after.ug9 [--json] [--all]   (exit 0 when the same, 1 when they differ)
// Works in Node and in the browser (no Node APIs outside the CLI block).
import { readUg9Tables, importUg9 } from './import_ug9.mjs';
import { compileUgo } from './compile.mjs';

// the binary's tables by kind (docs/形式.md, 配布用 .ug9) and their record sizes
const TABLES = {
  1: ['parameters', 16], 2: ['bones', 68], 3: ['constraints', 68], 4: ['parts', 48], 5: ['textures', 4], 6: ['positions', 8], 7: ['uvs', 8],
  8: ['boneIndices', 8], 9: ['boneWeights', 16], 10: ['vertexParts', 4], 11: ['deltaStarts', 4], 12: ['deltaItems', 12], 13: ['indices', 4],
  14: ['regions', 68], 15: ['morphs', 4], 16: ['boneDrivers', 28], 17: ['opacityDrivers', 12], 18: ['physics', 32], 19: ['physicsInputs', 8],
  20: ['animations', 24], 21: ['tracks', 20], 22: ['keys', 4], 23: ['strings', 1], 24: ['masks', 12], 25: ['maskParts', 4], 26: ['colors', 32],
  27: ['colorDrivers', 32], 28: ['extraWeightStarts', 4], 29: ['extraWeights', 8], 30: ['warps', 24], 31: ['warpPoints', 8], 32: ['warpDrivers', 12],
  33: ['warpDeltaPoints', 8], 34: ['warpBones', 40], 35: ['chains', 36], 36: ['chainBones', 4], 37: ['orders', 4], 38: ['orderDrivers', 12],
  39: ['expressions', 20], 40: ['expressionItems', 12], 41: ['tracks11', 12], 42: ['keys11', 4], 43: ['keyCurves', 16],
};
// 0.7's tables in their fixed order: [kind, the header's count (or a function of the counts)]
const ORDER07 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 23];

/** The tables a .ug9 holds: [{ kind, name, count, bytes }] (from the table of contents; 0.7 from the header's counts). */
export function ug9TableSizes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), major = dv.getUint16(4, true);
  const out = [];
  if (major === 0) {
    const t = readUg9Tables(u8), c = t.counts, nv = c.vertices;
    const n = { 1: c.params, 2: c.bones, 3: c.constraints, 4: c.parts, 5: c.textures, 6: nv, 7: nv, 8: nv, 9: nv, 10: nv, 11: nv + 1, 12: c.deltaEntries,
      13: c.indices, 14: c.regions, 15: c.morphs, 16: c.boneDrivers, 17: c.opacityDrivers, 18: c.physics, 19: c.physicsInputs, 20: c.animations, 21: c.tracks,
      22: c.keys, 23: c.stringBytes, 24: c.masks, 25: c.maskParts, 26: c.colors, 27: c.colorDrivers, 28: nv + 1, 29: c.extraWeights, 30: c.warps,
      31: c.warpPoints, 32: c.warpDrivers, 33: c.warpDeltaPoints, 34: c.warpBones, 35: c.chains, 36: c.chainBones };
    const size07 = { 34: 24 };
    for (const k of ORDER07) out.push({ kind: k, name: TABLES[k][0], count: n[k], bytes: n[k] * (size07[k] || TABLES[k][1]) });
    return out;
  }
  const headerSize = dv.getUint32(12, true), rows = dv.getUint32(32, true);
  for (let r = 0; r < rows; r++) {
    const q = headerSize + r * 16, kind = dv.getUint32(q, true), n = dv.getUint32(q + 8, true), rs = dv.getUint16(q + 12, true);
    out.push({ kind, name: TABLES[kind]?.[0] || `kind${kind}`, count: n, bytes: n * rs });
  }
  return out;
}

// the lists compared by name, and how each entry is named
const LISTS = {
  parts: (x) => x.id, bones: (x) => x.id, parameters: (x) => x.id, animations: (x) => x.id,
  physics: (x) => x.output ?? x.id, chains: (x) => x.id, expressions: (x) => x.id ?? x.name,
};

const isNum = (v) => typeof v === 'number';
function describe(a, b, tol, path, out) {
  if (isNum(a) && isNum(b)) { if (Math.abs(a - b) > tol) out.push({ field: path, before: a, after: b }); return; }
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(isNum)) {
    let changed = 0, most = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const d = Math.abs(a[i] - b[i]); if (d > tol) { changed++; most = Math.max(most, d); } }
    if (changed || a.length !== b.length) out.push({ field: path, numbers: [a.length, b.length], changed, most });
    return;
  }
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (plain(a) && plain(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ field: p, added: true });
      else if (!(k in b)) out.push({ field: p, removed: true });
      else describe(a[k], b[k], tol, p, out);
    }
    return;
  }
  if (a === undefined || b === undefined) { if (a !== b) out.push({ field: path, [a === undefined ? 'added' : 'removed']: true }); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === b.length) a.forEach((x, i) => describe(x, b[i], tol, `${path}[${i}]`, out));
    else out.push({ field: path, items: [a.length, b.length] });
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: path, before: a, after: b });
}

const toBytes = (x) => {
  if (x instanceof Uint8Array || x instanceof ArrayBuffer) {
    const u8 = x instanceof Uint8Array ? x : new Uint8Array(x);
    if (u8[0] === 0x55 && u8[1] === 0x47) return u8; // "UG": a .ug9
    return toBytes(JSON.parse(new TextDecoder().decode(u8)));
  }
  return new Uint8Array(compileUgo(x)); // a working JSON (as an object)
};

/** What changed from a to b (each a .ug9's bytes, or a working JSON as text bytes or an object). */
export function ug9Diff(a, b, opts = {}) {
  const tol = opts.tolerance ?? 1e-4;
  const A = toBytes(a), B = toBytes(b);
  const ta = readUg9Tables(A), tb = readUg9Tables(B);
  const ja = importUg9(A).json, jb = importUg9(B).json;
  const header = {
    version: [`${ta.major}.${ta.minor}`, `${tb.major}.${tb.minor}`], bytes: [A.length, B.length],
    canvas: [ta.canvas, tb.canvas],
  };
  const sa = ug9TableSizes(A), sb = ug9TableSizes(B), kinds = [...new Set([...sa, ...sb].map((t) => t.kind))].sort((x, y) => x - y);
  const tables = kinds.map((k) => {
    const x = sa.find((t) => t.kind === k), y = sb.find((t) => t.kind === k);
    return { kind: k, name: (x || y).name, count: [x?.count ?? 0, y?.count ?? 0], bytes: [x?.bytes ?? 0, y?.bytes ?? 0] };
  });
  const names = {};
  for (const [list, nameOf] of Object.entries(LISTS)) {
    const la = ja[list] || [], lb = jb[list] || [];
    const ma = new Map(la.map((x, i) => [String(nameOf(x) ?? `#${i}`), x])), mb = new Map(lb.map((x, i) => [String(nameOf(x) ?? `#${i}`), x]));
    const added = [...mb.keys()].filter((k) => !ma.has(k)), removed = [...ma.keys()].filter((k) => !mb.has(k)), changed = [];
    for (const [k, x] of ma) {
      if (!mb.has(k)) continue;
      const fields = [];
      describe(x, mb.get(k), tol, '', fields);
      if (fields.length) changed.push({ id: k, fields });
    }
    const orderA = la.map((x, i) => String(nameOf(x) ?? `#${i}`)).filter((k) => mb.has(k)), orderB = lb.map((x, i) => String(nameOf(x) ?? `#${i}`)).filter((k) => ma.has(k));
    const reordered = orderA.join('\0') !== orderB.join('\0');
    if (added.length || removed.length || changed.length || reordered) names[list] = { added, removed, changed, ...(reordered ? { reordered: true } : {}) };
  }
  // the rest of the model, as a whole (deformers keep no names in the .ug9; colours, masks and the canvas)
  const rest = [];
  for (const k of new Set([...Object.keys(ja), ...Object.keys(jb)])) {
    if (k in LISTS || k === 'editor' || k === 'format' || k === 'version') continue;
    describe(ja[k], jb[k], tol, k, rest);
  }
  const tablesChanged = tables.some((t) => t.count[0] !== t.count[1] || t.bytes[0] !== t.bytes[1]);
  const same = !tablesChanged && !Object.keys(names).length && !rest.length && header.version[0] === header.version[1] && A.length === B.length;
  return { same, header, tables, names, rest };
}

const num = (v) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(4)));
const show = (v) => (isNum(v) ? num(v) : v === undefined ? '—' : JSON.stringify(v).slice(0, 60));
const field = (f) => (f.added ? `${f.field} (added)` : f.removed ? `${f.field} (removed)` : f.items ? `${f.field} (${f.items[0]} → ${f.items[1]} entries)`
  : f.numbers ? `${f.field} (${f.numbers[0] === f.numbers[1] ? `${f.numbers[0]} numbers` : `${f.numbers[0]} → ${f.numbers[1]} numbers`}${f.changed ? `, ${f.changed} changed, at most ${num(f.most)}` : ''})`
  : `${f.field} ${show(f.before)} → ${show(f.after)}`);

/** The diff as text (opts.all: every table, not only the ones that changed). */
export function formatDiff(d, opts = {}) {
  const L = [], h = d.header;
  L.push(d.same ? 'same' : 'different');
  L.push(`version ${h.version[0]}${h.version[0] !== h.version[1] ? ` → ${h.version[1]}` : ''}, ${h.bytes[0]} → ${h.bytes[1]} bytes (${h.bytes[1] - h.bytes[0] >= 0 ? '+' : ''}${h.bytes[1] - h.bytes[0]})`);
  if (h.canvas[0].join() !== h.canvas[1].join()) L.push(`canvas ${h.canvas[0].map(num).join(',')} → ${h.canvas[1].map(num).join(',')}`);
  const tl = d.tables.filter((t) => opts.all || t.count[0] !== t.count[1] || t.bytes[0] !== t.bytes[1]);
  if (tl.length) {
    L.push('', 'tables (records, bytes):');
    for (const t of tl) L.push(`  ${t.name.padEnd(18)} ${String(t.count[0]).padStart(7)} → ${String(t.count[1]).padEnd(7)} ${String(t.bytes[0]).padStart(9)} → ${t.bytes[1]}`);
  }
  for (const [list, n] of Object.entries(d.names)) {
    L.push('', `${list}:`);
    if (n.added.length) L.push(`  added: ${n.added.join(', ')}`);
    if (n.removed.length) L.push(`  removed: ${n.removed.join(', ')}`);
    if (n.reordered) L.push('  the order changed');
    for (const c of n.changed) L.push(`  ${c.id}: ${c.fields.slice(0, 8).map(field).join('; ')}${c.fields.length > 8 ? `; and ${c.fields.length - 8} more` : ''}`);
  }
  if (d.rest.length) { L.push('', 'the rest:'); for (const f of d.rest.slice(0, 20)) L.push(`  ${field(f)}`); if (d.rest.length > 20) L.push(`  and ${d.rest.length - 20} more`); }
  return L.join('\n');
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs');
  const args = process.argv.slice(2), files = args.filter((x) => !x.startsWith('--'));
  if (files.length !== 2) { console.error('usage: node tools/ug9_diff.mjs before.ug9 after.ug9 [--json] [--all]   (a working .json is compiled first)'); process.exit(2); }
  const d = ug9Diff(fs.readFileSync(files[0]), fs.readFileSync(files[1]));
  console.log(args.includes('--json') ? JSON.stringify(d, null, 1) : formatDiff(d, { all: args.includes('--all') }));
  process.exit(d.same ? 0 : 1);
}
