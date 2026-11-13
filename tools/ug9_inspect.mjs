// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// What is in a .ug9, and what differs between two (Live2D's "compare two exported files", Spine's CLI info):
// the version, the table of contents (each table's kind, records, bytes, flags and a hash of its bytes), and
// what the core reads from it (parameters, bones, parts, animations, expressions, warp grids, chains, sizes).
//
//   node tools/ug9_inspect.mjs model.ug9               -> a summary
//   node tools/ug9_inspect.mjs old.ug9 new.ug9         -> what differs
//   node tools/ug9_inspect.mjs model.ug9 --json        -> the summary as JSON
//
//   import { inspect, compare } from './tools/ug9_inspect.mjs';
//
// Reads through the real core (web/ugo.wasm), so it says what a player sees, refusals included.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TABLE_KIND } from './compile.mjs';
import { readTables } from './curve_keys.mjs';
import { UgoRuntime } from '../web/ugo.js';

const KIND_NAME = Object.fromEntries(Object.entries(TABLE_KIND).map(([k, v]) => [v, k]));
let runtime = null;
async function rt() {
  if (!runtime) runtime = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
  return runtime;
}

/** bytes (Uint8Array, Buffer or ArrayBuffer) -> a plain summary object. */
export async function inspect(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const out = { bytes: u8.length };
  const magic = String.fromCharCode(...u8.slice(0, 4));
  if (magic !== 'UGO9' || u8.length < 40) return { ...out, error: 'not a .ug9 (no UGO9 header)' };
  const t = readTables(buf);
  out.version = `${t.major}.${t.minor}`;
  out.tables = [...t.tables].map(([kind, x]) => ({ kind, name: KIND_NAME[kind] ?? `unknown ${kind}`, records: x.count, recordSize: x.recSize, bytes: x.bytes.length,
    flag: x.flags & 3, hash: createHash('sha256').update(x.bytes).digest('hex').slice(0, 16) }));
  try {
    const m = (await rt()).loadModel(buf);
    const s = m.stats();
    out.read = {
      warnings: m.warnings, format: `${m.format.major}.${m.format.minor}`, counts: { ...s, bytes: undefined }, memory: s.bytes,
      parameters: m.params.map((p) => ({ name: p.name, min: p.min, default: p.def, max: p.max })),
      bones: m.bones.map((b) => b.name), parts: m.partData().parts.map((p) => p.name), textures: m.textures,
      animations: m.animations.map((a) => ({ name: a.name, duration: a.duration, loop: a.loop })),
      expressions: m.expressions.map((e) => e.name), warps: m.warps.map((w) => w.name), chains: m.chains.map((c) => c.name),
      hitAreas: m.hitAreas.map((h) => h.name),
    };
  } catch (e) {
    out.refused = e.message;
  }
  return out;
}

const listDiff = (a = [], b = []) => {
  const A = new Set(a), B = new Set(b);
  return { added: b.filter((x) => !A.has(x)), removed: a.filter((x) => !B.has(x)), reordered: a.length === b.length && a.every((x) => B.has(x)) && a.some((x, i) => x !== b[i]) };
};

/** Two files' bytes -> what differs (an empty `changes` list when they read the same). */
export async function compare(aBytes, bBytes) {
  const a = await inspect(aBytes), b = await inspect(bBytes), changes = [];
  if (a.error || b.error) return { a, b, changes: [a.error ? `first: ${a.error}` : `second: ${b.error}`] };
  if (a.version !== b.version) changes.push(`version ${a.version} -> ${b.version}`);
  const ta = new Map(a.tables.map((x) => [x.kind, x])), tb = new Map(b.tables.map((x) => [x.kind, x]));
  for (const k of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(k), y = tb.get(k), name = (x ?? y).name;
    if (!x) changes.push(`table ${name}: added (${y.records} records)`);
    else if (!y) changes.push(`table ${name}: removed (${x.records} records)`);
    else if (x.hash !== y.hash) changes.push(`table ${name}: ${x.records === y.records ? `${x.records} records, contents changed` : `${x.records} -> ${y.records} records`} (${x.bytes} -> ${y.bytes} bytes)`);
  }
  if (a.refused || b.refused) { if (a.refused !== b.refused) changes.push(`refused: ${a.refused ?? 'no'} -> ${b.refused ?? 'no'}`); return { a, b, changes }; }
  for (const key of ['bones', 'parts', 'textures', 'expressions', 'warps', 'chains', 'hitAreas']) {
    const d = listDiff(a.read[key], b.read[key]);
    if (d.added.length) changes.push(`${key}: added ${d.added.join(', ')}`);
    if (d.removed.length) changes.push(`${key}: removed ${d.removed.join(', ')}`);
    if (d.reordered) changes.push(`${key}: the same, in another order`);
  }
  const pa = new Map(a.read.parameters.map((p) => [p.name, p])), pb = new Map(b.read.parameters.map((p) => [p.name, p]));
  const pd = listDiff([...pa.keys()], [...pb.keys()]);
  if (pd.added.length) changes.push(`parameters: added ${pd.added.join(', ')}`);
  if (pd.removed.length) changes.push(`parameters: removed ${pd.removed.join(', ')}`);
  for (const [n, p] of pa) { const q = pb.get(n); if (q && (p.min !== q.min || p.max !== q.max || p.default !== q.default)) changes.push(`parameter ${n}: ${p.min}..${p.default}..${p.max} -> ${q.min}..${q.default}..${q.max}`); }
  const aa = new Map(a.read.animations.map((x) => [x.name, x])), ab = new Map(b.read.animations.map((x) => [x.name, x]));
  const ad = listDiff([...aa.keys()], [...ab.keys()]);
  if (ad.added.length) changes.push(`animations: added ${ad.added.join(', ')}`);
  if (ad.removed.length) changes.push(`animations: removed ${ad.removed.join(', ')}`);
  for (const [n, x] of aa) { const y = ab.get(n); if (y && (x.duration !== y.duration || x.loop !== y.loop)) changes.push(`animation ${n}: ${x.duration} s${x.loop ? ' loop' : ''} -> ${y.duration} s${y.loop ? ' loop' : ''}`); }
  for (const [k, v] of Object.entries(a.read.counts)) if (v !== undefined && v !== b.read.counts[k]) changes.push(`${k}: ${v} -> ${b.read.counts[k]}`);
  return { a, b, changes };
}

function summary(r, file) {
  if (r.error) return `${file}: ${r.error}`;
  const lines = [`${file}: format ${r.version}, ${r.bytes} bytes, ${r.tables.length} tables`];
  for (const t of r.tables) lines.push(`  ${String(t.kind).padStart(3)} ${t.name.padEnd(16)} ${String(t.records).padStart(8)} × ${t.recordSize} B${t.flag !== 2 ? `  (flag ${t.flag}: ${t.flag ? 'skipped, with a warning' : 'skipped quietly'} by a core that does not know it)` : ''}`);
  if (r.refused) { lines.push(`  refused by the core: ${r.refused}`); return lines.join('\n'); }
  const c = r.read.counts;
  lines.push(`  ${c.parameters} parameters, ${c.bones} bones, ${c.parts} parts, ${c.vertices} vertices, ${c.triangles} triangles, ${c.morphs} morphs, ${c.warps} warp grids, ${c.chains} chains, ${c.physics} physics`);
  lines.push(`  ${c.animations} animations (${c.tracks} tracks, ${c.keys} keys), ${c.expressions} expressions, ${c.textures} textures`);
  lines.push(`  memory: model ${r.read.memory.model} B, instance ${r.read.memory.instance} B, frame ${r.read.memory.frame} B${r.read.warnings ? `; skipped by this core: ${r.read.warnings}` : ''}`);
  if (r.read.animations.length) lines.push(`  animations: ${r.read.animations.map((a) => `${a.name} ${a.duration}s${a.loop ? '' : ' once'}`).join(', ')}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), json = args.includes('--json'), files = args.filter((a) => a !== '--json');
  if (!files.length || files.length > 2) { console.error('usage: node tools/ug9_inspect.mjs model.ug9 [other.ug9] [--json]'); process.exit(2); }
  const read = (f) => fs.readFileSync(f);
  if (files.length === 1) {
    const r = await inspect(read(files[0]));
    console.log(json ? JSON.stringify(r, null, 2) : summary(r, files[0]));
    process.exit(r.error || r.refused ? 1 : 0);
  }
  const r = await compare(read(files[0]), read(files[1]));
  if (json) console.log(JSON.stringify(r.changes, null, 2));
  else console.log(r.changes.length ? r.changes.map((c) => `- ${c}`).join('\n') : 'the same (every table and everything the core reads)');
  process.exit(r.changes.length ? 1 : 0);
}
