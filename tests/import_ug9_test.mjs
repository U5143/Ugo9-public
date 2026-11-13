// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A work file back from a .ug9 (tools/import_ug9.mjs, 利用者の声 #41): for the sample, the test
// models and every Spine character found in samples/提供/spine (converted under build/ only; none there: skipped), compile the
// JSON (A), read A back to JSON, compile that (B), and compare: the bytes, each table's numbers,
// the pictures ugo_export draws from A and B, and B read back once more (a fixed point). Then
// what is noted, the restoredFrom mark, files that do not read, and the CLI.
//   node tests/import_ug9_test.mjs        (the pictures need build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileUgo } from '../tools/compile.mjs';
import { importUg9, readUg9Tables } from '../tools/import_ug9.mjs';
import { importSpine, loadSkeleton } from '../tools/import_spine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'import_ug9_test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let exe = null;
for (const p of ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe']) if (fs.existsSync(path.join(ROOT, p))) { exe = path.join(ROOT, p); break; }
if (!exe) console.log('skip the pictures: build/ugo_export not built');

// ---- the models ----
const models = [];
const local = (name, file) => { const json = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); models.push({ name, json, texDir: path.dirname(path.join(ROOT, file)) }); };
local('basic', 'samples/basic/model.json');
local('warp', 'tests/warp/model.json');
local('pose', 'tests/pose/rig.json');
local('order', 'tests/order/model.json');
// 1.0: turned grids (one inside another), a bone in a turned grid, draw order (parts, a region, a track), expressions
models.push({ name: 'turned', texDir: ROOT, json: {
  format: 'ugo9', canvas: { width: 200, height: 200, originX: 100, originY: 100 }, textures: [],
  parameters: [{ id: 'A', min: 0, max: 1 }, { id: 'B', min: -1, max: 1 }],
  bones: [{ id: 'root' }, { id: 'pin', warp: 'g1', x: 5, y: -10 }],
  warps: [{ id: 'g1', cols: 2, rows: 2, rect: [-50, -60, 100, 80], angle: 20, bone: 'root' }, { id: 'g2', cols: 1, rows: 1, rect: [-20, -30, 30, 30], angle: -15, parent: 'g1' }],
  parts: [
    { id: 'p1', warp: 'g1', vertices: [-40, -50, 40, -50, 40, 10, -40, 10], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] },
    { id: 'p2', warp: 'g2', vertices: [-15, -25, 5, -25, 5, -5, -15, -5], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], order: 700 },
    { id: 'p3', bone: 'pin', vertices: [0, 0, 10, 0, 10, 10, 0, 10], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], order: 600 },
  ],
  deformers: [
    { region: { A: [0, 1, 1] }, morphs: { p1: { vertices: [1], deltas: [4, -3] }, p2: { vertices: [2], deltas: [-2, 5] } }, warps: { g2: { points: [3], deltas: [6, 1] } }, order: { p3: 300 } },
    { region: { B: [-1, -1, 0] }, warps: { g1: { points: [4], deltas: [0, 8] } } },
  ],
  animations: [{ id: 'swap', duration: 1, tracks: { A: [[0, 0], [1, 1, 'smooth']], B: [[0, -1, 'bezier', 0.2, 1, 0.6, -0.5], [0.5, 0.5, 'smooth'], [0.8, 0], [1, 0.5]] }, order: { p2: [[0, 700, 'step'], [0.5, 100], [1, 100]] } }],
  expressions: [{ id: 'smile', fadeIn: 0.3, fadeOut: 0.2, params: { A: ['add', 1], B: ['multiply', 0.5] } }],
} });
const SPINE = path.join(ROOT, 'samples/提供/spine');
// every Spine character under samples/提供/spine (none there: none tried): a folder with a skeleton (.skel, .skel.bytes,
// or a .json with "skeleton" and "bones") and its atlas (.atlas, .atlas.txt; the one of the same name if there are more)
function spineModels(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [], entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  const stem = (f) => f.replace(/\.(skel\.bytes|skel|json|atlas\.txt|atlas)$/i, '');
  const isSkel = (f) => /\.skel(\.bytes)?$/i.test(f) || (/\.json$/i.test(f) && (() => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return !!(j && j.skeleton && j.bones); } catch { return false; } })());
  const files = entries.filter((e) => e.isFile()).map((e) => e.name), atlases = files.filter((f) => /\.atlas(\.txt)?$/i.test(f));
  for (const skel of files.filter(isSkel)) {
    const atlas = atlases.find((a) => stem(a) === stem(skel)) || (atlases.length === 1 ? atlases[0] : null);
    if (atlas) out.push({ name: path.relative(SPINE, dir).split(path.sep).join(' ') || stem(skel), d: dir, skel, atlas });
  }
  for (const e of entries) if (e.isDirectory()) out.push(...spineModels(path.join(dir, e.name)));
  return out;
}
const spines = spineModels(SPINE);
if (!spines.length) console.log('skip the Spine characters: none in samples/提供/spine');
for (const { name, d, skel, atlas } of spines) {
  const { model, pages } = importSpine(loadSkeleton(fs.readFileSync(path.join(d, skel))), fs.readFileSync(path.join(d, atlas), 'utf8'));
  model.textures = pages.map((p) => path.basename(p.name));
  models.push({ name, json: model, texDir: d, spine: true });
}

// ---- compare two .ug9: the tables' numbers ----
const f32ulp = (x, y) => { const f = new Float32Array([x, y]), u = new Int32Array(f.buffer); return Math.abs(u[0] - u[1]); };
function tableDiff(A, B) { // -> { table: { n, worst } }: how many numbers differ, by how much
  const out = {};
  const walk = (a, b, table) => {
    if (typeof a === 'number') { if (a !== b) { const e = out[table] ||= { n: 0, worst: 0, ulp: 0 }; e.n++; e.worst = Math.max(e.worst, Math.abs(a - b)); e.ulp = Math.max(e.ulp, f32ulp(a, b)); } return; }
    if (Array.isArray(a)) { if (a.length !== b?.length) { out[`${table} (count)`] = { n: 1, worst: Infinity }; return; } a.forEach((x, i) => walk(x, b[i], table)); return; }
    if (a && typeof a === 'object') for (const k of Object.keys(a)) if (typeof a[k] !== 'function') walk(a[k], b?.[k], table ?? k);
  };
  walk(A, B, null);
  return out;
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const rows = [];
for (const m of models) {
  const t0 = performance.now();
  const A = new Uint8Array(compileUgo(m.json));
  const res = importUg9(A, { file: `${m.name}.ug9` });
  const B = new Uint8Array(compileUgo(res.json));
  const C = new Uint8Array(compileUgo(importUg9(B).json));
  const ms = performance.now() - t0;
  const diff = tableDiff(readUg9Tables(A), readUg9Tables(B));
  let bytesDiffer = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) bytesDiffer++;
  // bind matrices from f32 rest poses, 16-bit keys re-rounded; a turned grid's points and bones from its angle found again (1.0)
  const allowed = new Set(['bones', 'tracks', 'keys', 'weights', 'extraWeights', 'warpPoints', 'warpBones']);
  const sem = Object.entries(diff).filter(([k]) => !allowed.has(k));
  const keyDiff = diff.keys?.n || 0, keyTotal = readUg9Tables(A).keys.length * 2;
  rows.push({ name: m.name, size: A.length, bytesDiffer, diff, keyDiff, keyTotal, ms, notes: res.notes.map((n) => n.code) });
  check(A.length === B.length && sem.length === 0 && keyDiff <= Math.max(16, keyTotal * 1e-3) && (diff.bones?.worst ?? 0) < 1e-3 && (diff.weights?.ulp ?? 0) <= 1 && (diff.warpPoints?.worst ?? 0) < 1e-4 && (diff.warpBones?.worst ?? 0) < 1e-6,
    `${m.name}: back and compiled again, ${A.length} bytes, ${bytesDiffer ? `${bytesDiffer} bytes differ (${Object.entries(diff).map(([k, e]) => `${k}: ${e.n} numbers, up to ${e.worst.toExponential(1)}`).join('; ')})` : 'the same bytes'} (${ms.toFixed(0)} ms)`);
  const again = tableDiff(readUg9Tables(B), readUg9Tables(C)), drift = Object.entries(again);
  check(sameBytes(B, C) || drift.every(([k, e]) => (k === 'warpPoints' || k === 'warpBones') && e.worst < 1e-4),
    `${m.name}: read back again, ${sameBytes(B, C) ? 'the same bytes (a fixed point)' : `only a turned grid's numbers move, by up to ${Math.max(...drift.map(([, e]) => e.worst)).toExponential(1)}`}`);
  m.A = A; m.B = B; m.res = res;
}

// ---- the pictures: ugo_export from A and from B ----
if (exe) {
  for (const m of models) {
    if (!(m.json.textures || []).length || !m.json.textures.every((tex) => fs.existsSync(path.join(m.texDir, tex)))) { console.log(`skip the pictures of ${m.name}: its textures are not there`); continue; }
    const dir = path.join(OUT, m.name.replace(/ /g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    for (const tex of m.json.textures) fs.copyFileSync(path.join(m.texDir, tex), path.join(dir, path.basename(tex)));
    fs.writeFileSync(path.join(dir, 'a.ug9'), m.A);
    fs.writeFileSync(path.join(dir, 'b.ug9'), m.B);
    const anims = m.json.animations.slice(0, m.spine ? 3 : 2).map((a) => a.id);
    let worst = 0, bad = 0, total = 0;
    for (const anim of anims.length ? anims : [null]) {
      const draw = (f) => {
        const out = path.join(dir, `${f}.rgba`);
        execFileSync(exe, [path.join(dir, `${f}.ug9`), ...(anim ? ['--anim', anim] : []), '--frames', '4', '--fps', '4', '--size', '200x200', '--format', 'raw', '--out', out], { stdio: 'ignore' });
        return fs.readFileSync(out);
      };
      const a = draw('a'), b = draw('b');
      total += a.length / 4;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
        worst = Math.max(worst, d); if (d > 2) bad++;
      }
    }
    const row = rows.find((r) => r.name === m.name);
    row.picture = { worst, bad, total };
    check(bad <= total * 1e-5, `${m.name}: ugo_export draws A and B alike (${anims.length || 1} animation(s) × 4 frames at 200×200: ${bad} of ${total} px differ by more than 2, largest ${worst})`);
  }
}

// ---- 1.1: the Spine characters' curves (bones' and slots' alpha) come back as bezier keys ----
{
  const sp = models.filter((m) => m.spine);
  const counts = sp.map((m) => {
    let n = 0;
    for (const a of m.res.json.animations) {
      for (const bone of Object.values(a.bones || {})) for (const ks of Object.values(bone)) n += ks.filter((k) => k[2] === 'bezier').length;
      for (const ks of Object.values(a.opacity || {})) n += ks.filter((k) => k[2] === 'bezier').length; // a slot's alpha curves
    }
    return [m.name, n, readUg9Tables(m.A).curves.size];
  });
  check(sp.length === 0 || counts.every(([, n, c]) => n > 0 && n === c), `the Spine characters: 1.1 files, their curves back as bezier keys (${counts.map(([nm, n, c]) => `${nm} ${n} of ${c}`).join(', ')})`);
}

// ---- notes and the mark ----
{
  const m = models.find((x) => x.name === 'pose');
  check(m.res.json.editor?.restoredFrom?.file === 'pose.ug9' && m.res.json.editor.restoredFrom.format === `${new DataView(m.A.buffer).getUint16(4, true)}.${new DataView(m.A.buffer).getUint16(6, true)}`, 'the work file says where it came from: editor.restoredFrom { file, format }');
  const codes = new Set(m.res.notes.map((n) => n.code));
  check(['ug9Lost', 'ug9ConstraintIds', 'ug9DeformerIds'].every((c) => codes.has(c)), `what does not come back is noted (${[...codes].join(', ')})`);
  const basic = models.find((x) => x.name === 'basic');
  check(basic.res.json.parts.every((p) => basic.json.parts.find((q) => q.id === p.id)) && basic.res.json.parameters.map((p) => p.id).join() === basic.json.parameters.map((p) => p.id).join(),
    'names come back: parts, parameters (and bones, animations, warps, chains)');
}

// ---- 1.0: what came back of the turned grids, draw order and expressions; newer 1.x files ----
{
  const m = models.find((x) => x.name === 'turned'), j = m.res.json;
  const g1 = j.warps.find((w) => w.id === 'g1'), g2 = j.warps.find((w) => w.id === 'g2');
  check(Math.abs(g1.angle - 20) < 1e-4 && Math.abs(g2.angle + 15) < 1e-4 && g1.rect.every((v, i) => Math.abs(v - [-50, -60, 100, 80][i]) < 1e-3) && g2.rect.every((v, i) => Math.abs(v - [-20, -30, 30, 30][i]) < 1e-3),
    `turned grids come back with their rect and angle (g1 ${g1.angle.toFixed(4)}°, g2 ${g2.angle.toFixed(4)}° inside g1)`);
  const p = (id) => j.parts.find((x) => x.id === id);
  check(p('p2').order === 700 && p('p3').order === 600 && p('p1').order === undefined && j.deformers.some((d) => d.order?.p3 === 300) && (() => { const k = j.animations[0].order.p2; return k.map((x) => x[1]).join() === '700,700,100,100' && Math.abs(k[1][0] - 0.5) < 1e-3 && k[1][0] === k[2][0]; })(),
    'draw order: the parts\' values (500 left out), the region\'s value, the animation\'s keys (a step as two keys at one time)');
  const kb = j.animations[0].tracks.B;
  check(kb[0][2] === 'bezier' && Math.abs(kb[0][3] - 0.2) < 1e-4 && Math.abs(kb[0][4] - 1) < 1e-3 && Math.abs(kb[0][5] - 0.6) < 1e-4 && Math.abs(kb[0][6] + 0.5) < 1e-3 && kb.length > 10 && kb.slice(1).every((k) => k.length === 2),
    `1.1: a bezier key comes back with its handles (${kb[0].slice(2).map((x) => (typeof x === 'number' ? +x.toFixed(4) : x)).join(', ')}), a smooth piece in a mixed track as the straight keys it was written as (${kb.length - 1})`);
  check(JSON.stringify(j.expressions) === JSON.stringify([{ id: 'smile', fadeIn: Math.fround(0.3), fadeOut: Math.fround(0.2), params: { A: ['add', 1], B: ['multiply', 0.5] } }]), 'expressions come back by the parameters\' names');
  check(j.bones.find((b) => b.id === 'pin').warp === 'g1' && p('p1').vertices.every((v, i) => Math.abs(v - [-40, -50, 40, -50, 40, 10, -40, 10][i]) < 1e-3), 'a bone in a turned grid; a part\'s vertices back in model space');
  const later = (future) => new Uint8Array(compileUgo(models[0].json, { future }));
  const skip = importUg9(later({ minor: 3, headerExtra: 8, tables: [{ kind: 200, flag: 0, count: 3, recSize: 8 }, { kind: 201, flag: 1, count: 2, recSize: 12 }], tracks: [{ kind: 99, index: 0, value: 5 }] }));
  const sk = skip.notes.find((n) => n.code === 'ug9SkippedTable');
  check(sk && sk.vars.kinds.join() === '200,201' && sk.vars.changesPicture.join() === '201' && sk.level === 'warn' && skip.notes.some((n) => n.code === 'ug9SkippedTracks') && skip.json.version === '1.3',
    'a newer 1.3 file (a longer header, unknown tables marked 0 and 1, an unknown track kind): read, the unknown parts left out and noted');
  let code = '';
  try { importUg9(later({ minor: 3, tables: [{ kind: 202, flag: 2, count: 0, recSize: 4 }] })); } catch (e) { code = e.code; }
  check(code === 'ug9Newer', `an unknown table marked "needs a newer version" (flag 2): ug9Newer (${code})`);
  check(importUg9(fs.readFileSync(path.join(ROOT, 'tests/future/model.ug9'))).json.parts.length > 0, 'tests/future/model.ug9 (the core\'s later-1.x sample) reads');
}

// ---- files that do not read ----
{
  const A = models[0].A;
  const codeOf = (bytes) => { try { importUg9(bytes); return 'read'; } catch (e) { return e.code || `other: ${e.message}`; } };
  check(codeOf(new TextEncoder().encode('{"format":"ugo9"}')) === 'ug9NotUg9', 'a JSON file: ug9NotUg9');
  const old = A.slice(); new DataView(old.buffer).setUint16(4, 0, true); new DataView(old.buffer).setUint16(6, 6, true);
  check(codeOf(old) === 'ug9Version', 'format 0.6: ug9Version (the message names the versions read)');
  check(codeOf(A.slice(0, A.length - 8)) === 'ug9Broken', 'cut short: ug9Broken');
  let seed = 3, other = 0, read = 0;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  for (let i = 0; i < 400; i++) {
    const b = A.slice();
    for (let k = 0; k < 4; k++) b[160 + rnd(Math.min(b.length - 160, 4000))] = rnd(256);
    const c = codeOf(b);
    if (c === 'read') read++; else if (!c.startsWith('ug9')) { other++; if (other < 3) console.log('  ', c); }
  }
  check(other === 0, `400 files with 4 bytes changed in the tables: each reads (${read}) or stops with a ug9 code (${400 - read}), nothing else thrown`);
}

// ---- the CLI ----
{
  const dir = path.join(OUT, 'cli');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, 'samples/basic/model.ug9'), path.join(dir, 'face.ug9'));
  fs.copyFileSync(path.join(ROOT, 'samples/basic/atlas.png'), path.join(dir, 'atlas.png'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/import_ug9.mjs'), path.join(dir, 'face.ug9'), path.join(dir, 'out')], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.existsSync(path.join(dir, 'out/face.json')) && fs.existsSync(path.join(dir, 'out/atlas.png'));
  const again = ok && compileUgo(JSON.parse(fs.readFileSync(path.join(dir, 'out/face.json'), 'utf8'))).byteLength === fs.statSync(path.join(dir, 'face.ug9')).size;
  check(ok && again, `node tools/import_ug9.mjs face.ug9 out: out/face.json and the atlas beside it, and it compiles again (${r.stdout.trim()})`);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools/import_ug9.mjs'), path.join(ROOT, 'samples/basic/model.json')], { encoding: 'utf8' });
  check(bad.status === 2 && /not a \.ug9/.test(bad.stderr), `not a .ug9: exit 2 (${bad.stderr.trim()})`);
}

console.log('\n| model | .ug9 bytes | bytes that differ | numbers that differ | picture | ms |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.name} | ${r.size} | ${r.bytesDiffer} | ${Object.entries(r.diff).map(([k, e]) => `${k} ${e.n}`).join(', ') || '0'} | ${r.picture ? `${r.picture.bad}/${r.picture.total} px > 2, largest ${r.picture.worst}` : '-'} | ${r.ms.toFixed(0)} |`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall .ug9 import checks passed');
process.exit(failures ? 1 : 0);
