// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A work file back from a distributed .ug9 (利用者の声 #41): reads the binary as docs/形式.md
// describes it (header, then the tables in their order) and writes the authoring JSON again.
// What the binary does not keep (ids of constraints, colours and deformers, curves baked into
// straight pieces, glue, the editor's own data, ...) comes back as close as it can, with a note
// for each kind; the JSON gets editor.restoredFrom so the editor can say where it came from.
// Compiling the JSON again gives the same model (tests/import_ug9_test.mjs).
//
//   import { importUg9 } from './import_ug9.mjs';
//   const { json, notes, warnings } = importUg9(bytes, { file: 'model.ug9' });
//
//   node tools/import_ug9.mjs model.ug9 [out_dir]     -> out_dir/model.json (+ the textures beside it)
//
// Works in Node and in the browser (no Node APIs outside the CLI block).

import { makeNotes } from './notes.mjs';
import { expandTracks, curvePoints } from './curve_keys.mjs';

const HEADER_SIZE = 160;
const NONE = 0xffffffff;
const DEG = 180 / Math.PI;
const BLEND = ['normal', 'add', 'multiply', 'screen'];
const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const COLOR_MODES = [['multiply', 'screen'], ['tint', 'dark']];
const EXPR_OPS = ['set', 'add', 'multiply'];
const BONE_TRACK = { 1: 'rotate', 2: 'x', 3: 'y', 4: 'scaleX', 5: 'scaleY', 8: 'shearX', 9: 'shearY' };
const IK_CHANNEL = { 0: 'mix', 6: 'bend' };
const TRANSFORM_CHANNEL = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
// the header's 30 counts, in their order (docs/形式.md, ヘッダ)
const COUNTS = ['params', 'bones', 'constraints', 'parts', 'textures', 'vertices', 'indices', 'deltaEntries', 'regions', 'morphs',
  'boneDrivers', 'opacityDrivers', 'physics', 'physicsInputs', 'animations', 'tracks', 'keys', 'stringBytes', 'masks', 'maskParts',
  'colors', 'colorDrivers', 'extraWeights', 'warps', 'warpPoints', 'warpDrivers', 'warpDeltaPoints', 'warpBones', 'chains', 'chainBones'];

function bad(msg, code = 'ug9Broken', vars = {}) {
  const e = new Error(`.ug9: ${msg}`);
  e.code = code;
  e.vars = vars;
  return e;
}

/**
 * Reads a .ug9 into its tables, as plain numbers (f32 read as JS numbers): format 0.7 (tables one
 * after another, their counts in the header) and 1.x (a table of contents: each table where it says;
 * unknown kinds skipped or refused by their flag).
 * Throws { code: 'ug9NotUg9' | 'ug9Version' | 'ug9Newer' | 'ug9Broken' } for files that do not read.
 */
export function readUg9Tables(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 40 || dv.getUint32(0, false) !== 0x55474f39) throw bad('not a .ug9 file (no "UGO9" at the start)', 'ug9NotUg9');
  const major = dv.getUint16(4, true), minor = dv.getUint16(6, true);
  if (!(major === 0 && minor === 7) && major !== 1) {
    const newer = major > 1; // a later major: a newer Ugo9 made it; else an old one (before 0.7)
    throw bad(newer ? `made with a newer Ugo9: format ${major}.${minor} needs a newer version of Ugo9 (this reads 0.7 and 1.x)`
      : `made with an old Ugo9: format ${major}.${minor} is not read here (this reads 0.7 and 1.x); compile it again from its working file`,
    'ug9Version', { version: `${major}.${minor}`, newer, reads: '1.x' });
  }
  const size = dv.getUint32(8, true);
  if (size !== u8.length) throw bad(`the header says ${size} bytes, the file has ${u8.length}`, 'ug9Broken', { what: 'size' });
  const canvas = [16, 20, 24, 28].map((o) => dv.getFloat32(o, true));
  const t = { major, minor, canvas, skipped: [] };

  // where each table is: [offset, count] by kind (1.x numbers; 0.7 laid out in its fixed order)
  const where = new Map();
  if (major === 0) {
    if (u8.length < HEADER_SIZE) throw bad('the header is cut short', 'ug9Broken', { what: 'size' });
    const c = {};
    COUNTS.forEach((k, i) => { c[k] = dv.getUint32(32 + 4 * i, true); });
    const nv = c.vertices;
    const order07 = [[1, c.params, 16], [2, c.bones, 68], [3, c.constraints, 68], [4, c.parts, 48], [5, c.textures, 4],
      [6, nv, 8], [7, nv, 8], [8, nv, 8], [9, nv, 16], [10, nv, 4], [11, nv + 1, 4], [12, c.deltaEntries, 12], [13, c.indices, 4],
      [14, c.regions, 68], [15, c.morphs, 4], [16, c.boneDrivers, 28], [17, c.opacityDrivers, 12], [18, c.physics, 32], [19, c.physicsInputs, 8],
      [20, c.animations, 24], [21, c.tracks, 20], [22, c.keys, 4], [24, c.masks, 12], [25, c.maskParts, 4], [26, c.colors, 32], [27, c.colorDrivers, 32],
      [28, nv + 1, 4], [29, c.extraWeights, 8], [30, c.warps, 24], [31, c.warpPoints, 8], [32, c.warpDrivers, 12], [33, c.warpDeltaPoints, 8],
      [34, c.warpBones, 24], [35, c.chains, 36], [36, c.chainBones, 4], [23, c.stringBytes, 1]];
    let o = HEADER_SIZE;
    for (const [kind, n, rs] of order07) { where.set(kind, [o, n, rs]); o += n * rs; }
    if (((o + 3) & ~3) !== u8.length) throw bad(`the tables end at byte ${o}, the file has ${u8.length}`, 'ug9Broken', { what: 'size' });
  } else {
    const headerSize = dv.getUint32(12, true), rows = dv.getUint32(32, true);
    if (headerSize < 40 || headerSize % 4 || rows > 256 || headerSize + rows * 16 > u8.length) throw bad('the header or its table of contents is broken', 'ug9Broken', { what: 'toc' });
    const spans = [];
    for (let r = 0; r < rows; r++) {
      const q = headerSize + r * 16, kind = dv.getUint32(q, true), off = dv.getUint32(q + 4, true), n = dv.getUint32(q + 8, true);
      const rs = dv.getUint16(q + 12, true), flag = dv.getUint16(q + 14, true) & 3;
      if (!kind || where.has(kind)) throw bad(`table kind ${kind} is listed twice (or is 0)`, 'ug9Broken', { what: 'toc' });
      if (n && (off % 4 || off < headerSize + rows * 16 || off + n * rs > u8.length)) throw bad(`table kind ${kind} lies outside the file`, 'ug9Broken', { what: 'toc' });
      if (!KNOWN_SIZE[kind]) {
        if (flag === 2) throw bad(`made with a newer Ugo9: format ${major}.${minor} needs a newer version of Ugo9 (table kind ${kind} is needed and not known here)`, 'ug9Newer', { kind, version: `${major}.${minor}` });
        t.skipped.push({ kind, flag });
        continue;
      }
      if (rs !== KNOWN_SIZE[kind]) throw bad(`table kind ${kind} has records of ${rs} bytes (${KNOWN_SIZE[kind]} expected)`, 'ug9Broken', { what: 'toc' });
      where.set(kind, [off, n, rs]);
      if (n) spans.push([off, off + n * rs]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    for (let k = 1; k < spans.length; k++) if (spans[k][0] < spans[k - 1][1]) throw bad('two tables overlap', 'ug9Broken', { what: 'toc' });
  }
  const count = (kind) => where.get(kind)?.[1] ?? 0;
  const nv = count(6);
  t.counts = {
    params: count(1), bones: count(2), constraints: count(3), parts: count(4), textures: count(5), vertices: nv, indices: count(13), deltaEntries: count(12),
    regions: count(14), morphs: count(15), boneDrivers: count(16), opacityDrivers: count(17), physics: count(18), physicsInputs: count(19),
    animations: count(20), tracks: count(21) || count(41), keys: count(22), stringBytes: count(23), masks: count(24), maskParts: count(25), colors: count(26),
    colorDrivers: count(27), extraWeights: count(29), warps: count(30), warpPoints: count(31), warpDrivers: count(32), warpDeltaPoints: count(33),
    warpBones: count(34), chains: count(35), chainBones: count(36), orders: count(37), orderDrivers: count(38), expressions: count(39), expressionItems: count(40),
  };
  for (const [kind, need] of [[7, nv], [8, nv], [9, nv], [10, nv], [11, nv ? nv + 1 : 0], [28, nv ? nv + 1 : 0]]) {
    if (count(kind) !== need && !(need === 0 && count(kind) === 1)) throw bad(`table kind ${kind} has ${count(kind)} records (${need} expected)`, 'ug9Broken', { what: 'toc' });
  }
  if (count(37) && count(37) !== count(4)) throw bad('the draw order table does not have one value per part', 'ug9Broken', { what: 'order' });

  let o = 0;
  const U32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const I32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const F32 = () => {
    const v = dv.getFloat32(o, true); o += 4;
    if (!Number.isFinite(v)) throw bad(`a number at byte ${o - 4} is not finite`, 'ug9Broken', { what: 'number' });
    return v;
  };
  const U16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const table = (kind, read) => { const w = where.get(kind); if (!w) return []; o = w[0]; return Array.from({ length: w[1] }, read); };

  t.params = table(1, () => ({ min: F32(), def: F32(), max: F32(), name: U32() }));
  t.bones = table(2, () => ({
    parent: I32(), x: F32(), y: F32(), rot: F32(), sx: F32(), sy: F32(), name: U32(), bindInv: [F32(), F32(), F32(), F32(), F32(), F32()],
    shx: F32(), shy: F32(), length: F32(), inherit: U32(),
  }));
  t.constraints = table(3, () => ({
    type: U32(), flags: U32(), bone: I32(), bone2: I32(), target: I32(), mix: [F32(), F32(), F32(), F32(), F32(), F32()], off: [F32(), F32(), F32(), F32(), F32(), F32()],
  }));
  t.parts = table(4, () => ({
    firstVert: U32(), vertCount: U32(), firstIndex: U32(), indexCount: U32(), opacity: F32(), blend: U32(), texture: U32(), name: U32(),
    mask: U32(), flags: U32(), color: U32(), warp: U32(),
  }));
  t.textures = table(5, () => U32());
  t.pos = table(6, () => [F32(), F32()]);
  t.uv = table(7, () => [F32(), F32()]);
  t.joints = table(8, () => [U16(), U16(), U16(), U16()]);
  t.weights = table(9, () => [F32(), F32(), F32(), F32()]);
  t.vparts = table(10, () => U32());
  t.deltaStart = nv ? table(11, () => U32()) : [0];
  t.deltas = table(12, () => ({ morph: U32(), dx: F32(), dy: F32() }));
  t.indices = table(13, () => U32());
  t.regions = table(14, () => {
    const n = U32(), axes = [];
    for (let k = 0; k < 4; k++) { const ax = [U32(), F32(), F32(), F32()]; if (k < n) axes.push(ax); }
    if (n > 4) throw bad('a region with more than 4 axes', 'ug9Broken', { what: 'region' });
    return axes;
  });
  t.morphs = table(15, () => U32());
  t.boneDrivers = table(16, () => ({ region: U32(), bone: U32(), drot: F32(), dx: F32(), dy: F32(), dsx: F32(), dsy: F32() }));
  t.opacityDrivers = table(17, () => ({ region: U32(), part: U32(), dop: F32() }));
  t.physics = table(18, () => ({ firstInput: U32(), inputCount: U32(), output: U32(), stiffness: F32(), damping: F32(), gain: F32(), outMin: F32(), outMax: F32() }));
  t.physicsInputs = table(19, () => [U32(), F32()]);
  t.animations = table(20, () => ({ name: U32(), duration: F32(), loop: U32(), firstTrack: U32(), trackCount: U32(), tick: F32() }));
  t.tracks = table(21, () => ({ target: U32(), firstKey: U32(), keyCount: U32(), base: F32(), step: F32() }));
  t.keys = table(22, () => [U16(), U16()]);
  t.curves = new Map(); // 1.1: key index (in t.keys) -> the curve of the segment it starts { n, cx1, cy1, cx2, cy2 }
  if (where.has(41)) { // 1.1 (curve keys): tables 41-43 in place of 21-22, read as tracks and keys with their curves
    if (where.has(21) || where.has(22)) throw bad('both the 1.0 and the 1.1 track tables', 'ug9Broken', { what: 'track' });
    const t11 = table(41, () => ({ target: U32(), base: F32(), step: F32() }));
    const words = Uint32Array.from(table(42, () => U32()));
    const cv = table(43, () => ({ key: U32(), n: U16(), cx1: U16(), cy1: U16(), cx2: U16(), cy2: U16(), reserved: U16() }));
    try { expandTracks(t11, words, cv); } catch (e) { throw bad(`the curve key tables do not read (${e.message})`, 'ug9Broken', { what: 'track' }); } // as the core checks them
    const wordKey = new Map();
    let at = 0;
    for (const tr of t11) {
      if (tr.step === 0) { t.tracks.push({ target: tr.target, firstKey: 0, keyCount: 1, base: tr.base, step: 0 }); continue; }
      const c = words[at], firstKey = t.keys.length;
      for (let j = at + 1; j <= at + c; j++) { wordKey.set(j, t.keys.length); t.keys.push([words[j] & 0xffff, words[j] >>> 16]); }
      t.tracks.push({ target: tr.target, firstKey, keyCount: c, base: tr.base, step: tr.step });
      at += c + 1;
    }
    for (const c of cv) t.curves.set(wordKey.get(c.key), c);
    t.counts.tracks = t.tracks.length;
    t.counts.keys = t.keys.length;
  }
  t.masks = table(24, () => ({ firstPart: U32(), count: U32(), channel: U32() }));
  t.maskParts = table(25, () => U32());
  t.colors = table(26, () => { const c = { mode: U32(), a: [F32(), F32(), F32()], b: [F32(), F32(), F32()] }; U32(); return c; });
  t.colorDrivers = table(27, () => ({ region: U32(), slot: U32(), da: [F32(), F32(), F32()], db: [F32(), F32(), F32()] }));
  t.extraStart = nv ? table(28, () => U32()) : [0];
  t.extraWeights = table(29, () => [U32(), F32()]);
  t.warps = table(30, () => ({ cols: U32(), rows: U32(), parent: U32(), bone: U32(), firstPoint: U32(), name: U32() }));
  t.warpPoints = table(31, () => [F32(), F32()]);
  t.warpDrivers = table(32, () => ({ region: U32(), warp: U32(), firstDelta: U32() }));
  t.warpDeltas = table(33, () => [F32(), F32()]);
  t.warpBones = major === 0
    ? table(34, () => { const q = { bone: U32(), warp: U32(), ox: F32(), oy: F32(), sx: F32(), sy: F32() }; return { ...q, a: q.sx, b: 0, c: 0, d: q.sy, rc: 1, rs: 0 }; })
    : table(34, () => ({ bone: U32(), warp: U32(), ox: F32(), oy: F32(), a: F32(), b: F32(), c: F32(), d: F32(), rc: F32(), rs: F32() }));
  t.chains = table(35, () => ({ firstBone: U32(), boneCount: U32(), stiffness: F32(), damping: F32(), gx: F32(), gy: F32(), inertia: F32(), mix: F32(), name: U32() }));
  t.chainBones = table(36, () => U32());
  t.orders = table(37, () => F32());
  t.orderDrivers = table(38, () => ({ region: U32(), part: U32(), d: F32() }));
  t.expressions = table(39, () => ({ name: U32(), firstItem: U32(), itemCount: U32(), fadeIn: F32(), fadeOut: F32() }));
  t.expressionItems = table(40, () => ({ param: U32(), op: U32(), value: F32() }));
  const sw = where.get(23);
  if (!sw || sw[1] < 1 || u8[sw[0] + sw[1] - 1] !== 0) throw bad('the string table does not end with 0', 'ug9Broken', { what: 'string' });
  const strBytes = u8.subarray(sw[0], sw[0] + sw[1]);
  const dec = new TextDecoder();
  t.string = (off) => {
    if (off >= strBytes.length) throw bad(`a name points outside the strings (${off})`, 'ug9Broken', { what: 'string' });
    const end = strBytes.indexOf(0, off);
    return dec.decode(strBytes.subarray(off, end));
  };
  checkIndices(t);
  return t;
}
// record sizes of the kinds read here (1.x table of contents)
const KNOWN_SIZE = { 1: 16, 2: 68, 3: 68, 4: 48, 5: 4, 6: 8, 7: 8, 8: 8, 9: 16, 10: 4, 11: 4, 12: 12, 13: 4, 14: 68, 15: 4, 16: 28, 17: 12, 18: 32, 19: 8,
  20: 24, 21: 20, 22: 4, 23: 1, 41: 12, 42: 4, 43: 16, 24: 12, 25: 4, 26: 32, 27: 32, 28: 4, 29: 8, 30: 24, 31: 8, 32: 12, 33: 8, 34: 40, 35: 36, 36: 4, 37: 4, 38: 12, 39: 20, 40: 12 };

// every number that points into another table points inside it
function checkIndices(t) {
  const n = t.counts;
  const ok = (v, max, what) => { if (!(Number.isInteger(v) && v >= 0 && v < max)) throw bad(`${what} ${v} is out of range (0..${max - 1})`, 'ug9Broken', { what }); };
  const opt = (v, max, what) => { if (v !== NONE) ok(v, max, what); };
  t.params.forEach((p) => { if (!(p.min <= p.def && p.def <= p.max)) throw bad('a parameter with min > default or default > max', 'ug9Broken', { what: 'parameter' }); });
  t.bones.forEach((b, i) => { if (b.parent !== -1) ok(b.parent, i, 'bone parent'); ok(b.inherit, INHERIT.length, 'bone inherit'); });
  t.constraints.forEach((c) => { ok(c.type, 2, 'constraint type'); ok(c.bone, n.bones, 'constraint bone'); if (c.bone2 !== -1) ok(c.bone2, n.bones, 'constraint bone'); ok(c.target, n.bones, 'constraint target'); });
  t.parts.forEach((p) => {
    if (p.firstVert + p.vertCount > n.vertices || p.firstIndex + p.indexCount > n.indices) throw bad('a part reaches past the vertices or indices', 'ug9Broken', { what: 'part' });
    ok(p.blend, BLEND.length, 'blend'); if (n.textures) ok(p.texture, n.textures, 'texture');
    opt(p.mask, n.masks, 'mask'); opt(p.color, n.colors, 'color'); opt(p.warp, n.warps, 'warp');
    for (let k = p.firstIndex; k < p.firstIndex + p.indexCount; k++) if (t.indices[k] < p.firstVert || t.indices[k] >= p.firstVert + p.vertCount) throw bad('a triangle uses a vertex of another part', 'ug9Broken', { what: 'index' });
  });
  t.joints.forEach((j) => j.forEach((b) => ok(b, Math.max(1, n.bones), 'bone index')));
  t.vparts.forEach((p) => ok(p, n.parts, 'vertex part'));
  for (let v = 0; v < n.vertices; v++) if (t.deltaStart[v] > t.deltaStart[v + 1] || t.extraStart[v] > t.extraStart[v + 1]) throw bad('delta or weight ranges out of order', 'ug9Broken', { what: 'delta' });
  if (t.deltaStart[n.vertices] !== n.deltaEntries || t.extraStart[n.vertices] !== n.extraWeights) throw bad('delta or weight ranges do not end at the table\'s end', 'ug9Broken', { what: 'delta' });
  t.deltas.forEach((d) => ok(d.morph, n.morphs, 'morph'));
  t.regions.forEach((r) => r.forEach((a) => ok(a[0], n.params, 'region parameter')));
  t.morphs.forEach((r) => opt(r, n.regions, 'morph region'));
  t.boneDrivers.forEach((d) => { ok(d.region, n.regions, 'region'); ok(d.bone, n.bones, 'bone'); });
  t.opacityDrivers.forEach((d) => { ok(d.region, n.regions, 'region'); ok(d.part, n.parts, 'part'); });
  t.physics.forEach((p) => { ok(p.output, n.params, 'physics output'); if (p.firstInput + p.inputCount > n.physicsInputs) throw bad('physics inputs out of range', 'ug9Broken', { what: 'physics' }); });
  t.physicsInputs.forEach(([p]) => ok(p, n.params, 'physics input'));
  t.animations.forEach((a) => { if (a.firstTrack + a.trackCount > n.tracks) throw bad('animation tracks out of range', 'ug9Broken', { what: 'animation' }); });
  t.tracks.forEach((tr) => { if (tr.keyCount < 1 || (tr.keyCount > 1 && tr.firstKey + tr.keyCount > n.keys)) throw bad('track keys out of range', 'ug9Broken', { what: 'track' }); });
  t.masks.forEach((m) => { if (m.count < 1 || m.firstPart + m.count > n.maskParts) throw bad('mask parts out of range', 'ug9Broken', { what: 'mask' }); });
  t.maskParts.forEach((p) => ok(p, n.parts, 'mask part'));
  t.colors.forEach((c) => ok(c.mode, 2, 'color mode'));
  t.colorDrivers.forEach((d) => { ok(d.region, n.regions, 'region'); ok(d.slot, n.colors, 'color'); });
  t.extraWeights.forEach(([b]) => ok(b, n.bones, 'bone'));
  t.warps.forEach((w, i) => {
    if (w.cols < 1 || w.rows < 1 || w.cols > 64 || w.rows > 64) throw bad('a warp grid with cols or rows outside 1..64', 'ug9Broken', { what: 'warp' });
    if (w.parent !== NONE) ok(w.parent, i, 'warp parent');
    ok(w.bone, Math.max(1, n.bones), 'warp bone');
    if (w.firstPoint + (w.cols + 1) * (w.rows + 1) > n.warpPoints) throw bad('warp points out of range', 'ug9Broken', { what: 'warp' });
  });
  t.warpDrivers.forEach((d) => {
    ok(d.region, n.regions, 'region'); ok(d.warp, n.warps, 'warp');
    const w = t.warps[d.warp];
    if (d.firstDelta + (w.cols + 1) * (w.rows + 1) > n.warpDeltaPoints) throw bad('warp motion points out of range', 'ug9Broken', { what: 'warp' });
  });
  t.warpBones.forEach((q) => { ok(q.bone, n.bones, 'bone'); ok(q.warp, n.warps, 'warp'); });
  t.chains.forEach((c) => { if (c.boneCount < 1 || c.firstBone + c.boneCount > n.chainBones) throw bad('chain bones out of range', 'ug9Broken', { what: 'chain' }); });
  t.chainBones.forEach((b) => ok(b, n.bones, 'chain bone'));
  t.orderDrivers.forEach((d) => { ok(d.region, n.regions, 'region'); ok(d.part, n.parts, 'part'); });
  t.expressions.forEach((e) => { if (e.firstItem + e.itemCount > n.expressionItems) throw bad('expression items out of range', 'ug9Broken', { what: 'expression' }); });
  t.expressionItems.forEach((it) => { ok(it.param, n.params, 'expression parameter'); ok(it.op, EXPR_OPS.length, 'expression kind'); });
}

/**
 * The authoring JSON back from a .ug9.
 * opts: { file } the .ug9's name (kept in editor.restoredFrom).
 * -> { json, notes, warnings }: notes (tools/notes.mjs) name what could not come back as it was.
 */
export function importUg9(bytes, opts = {}) {
  const t = readUg9Tables(bytes);
  const { warnings, notes, note } = makeNotes();
  const S = t.string;
  const uniq = (names, fallback) => { // names as ids, made unique (the binary does not require it)
    const seen = new Set();
    return names.map((s, i) => {
      let id = s || `${fallback}${i}`;
      if (seen.has(id)) { let k = 2; while (seen.has(`${id}_${k}`)) k++; id = `${id}_${k}`; }
      seen.add(id);
      return id;
    });
  };
  const paramIds = uniq(t.params.map((p) => S(p.name)), 'param');
  const boneIds = uniq(t.bones.map((b) => S(b.name)), 'bone');
  const partIds = uniq(t.parts.map((p) => S(p.name)), 'part');
  const warpIds = uniq(t.warps.map((w) => S(w.name)), 'warp');
  const animIds = uniq(t.animations.map((a) => S(a.name)), 'anim');
  const colorIds = t.colors.map((_, i) => `color${i}`);
  const consIds = t.constraints.map((_, i) => `constraint${i}`);
  const morphIds = t.morphs.map((_, i) => `morph${i}`);
  if (paramIds.some((id, i) => id !== S(t.params[i].name)) || boneIds.some((id, i) => id !== S(t.bones[i].name)) || partIds.some((id, i) => id !== S(t.parts[i].name))) {
    note('ug9NamesRenamed', {}, 'some names were empty or used twice: they got new ids');
  }

  const json = {
    format: 'ugo9',
    version: `${t.major}.${t.minor}`,
    canvas: { width: t.canvas[0], height: t.canvas[1], originX: t.canvas[2], originY: t.canvas[3] },
    textures: t.textures.map((off) => S(off)),
    parameters: t.params.map((p, i) => ({ id: paramIds[i], min: p.min, default: p.def, max: p.max })),
  };

  // bones (already parents first); a bone in a warp grid names its grid
  const warpOfBone = new Map(t.warpBones.map((q) => [q.bone, q.warp]));
  json.bones = t.bones.map((b, i) => {
    const out = { id: boneIds[i] };
    if (b.parent >= 0) out.parent = boneIds[b.parent];
    if (warpOfBone.has(i)) out.warp = warpIds[warpOfBone.get(i)];
    Object.assign(out, { x: b.x, y: b.y, rotation: deg(b.rot), scaleX: b.sx, scaleY: b.sy });
    if (b.shx) out.shearX = deg(b.shx);
    if (b.shy) out.shearY = deg(b.shy);
    if (b.length) out.length = b.length;
    if (b.inherit) out.inherit = INHERIT[b.inherit];
    return out;
  });

  if (t.constraints.length) {
    json.constraints = t.constraints.map((c, i) => {
      if (c.type === 0) {
        const out = { id: consIds[i], type: 'ik', bones: c.bone2 >= 0 ? [boneIds[c.bone], boneIds[c.bone2]] : [boneIds[c.bone]], target: boneIds[c.target], mix: c.mix[0], bend: c.off[0] < 0 ? -1 : 1 };
        if (c.flags & 1) out.compress = true;
        if (c.flags & 2) out.stretch = true;
        if (c.flags & 4) out.uniform = true;
        return out;
      }
      const [r, x, y, sx, sy, shy] = c.off;
      const out = { id: consIds[i], type: 'transform', bones: [boneIds[c.bone]], target: boneIds[c.target], local: !!(c.flags & 1), relative: !!(c.flags & 2),
        rotation: deg(r), x, y, scaleX: sx, scaleY: sy, shearY: deg(shy) };
      TRANSFORM_CHANNEL.forEach((k, j) => { out[k] = c.mix[j]; });
      return out;
    });
    note('ug9ConstraintIds', { count: t.constraints.length }, `constraints have no names in a .ug9: they are called constraint0.. (a transform constraint on several bones comes back as one per bone)`, 'info');
  }

  if (t.colors.length) {
    json.colors = t.colors.map((c, i) => { const [an, bn] = COLOR_MODES[c.mode]; return { id: colorIds[i], [an]: c.a, [bn]: c.b }; });
    note('ug9ColorIds', { count: t.colors.length }, 'colours have no names in a .ug9: they are called color0..', 'info');
  }

  // warp grids: rest points are a regular grid over a rectangle (in model space, or in the parent's
  // cells), turned about its centre by an angle (1.0); the JSON gives rect (its own axes) and angle
  const grids = []; // per warp: { rect, cos, sin, cx, cy }
  const turn = (g, x, y) => { const dx = x - g.cx, dy = y - g.cy; return [g.cx + g.cos * dx - g.sin * dy, g.cy + g.sin * dx + g.cos * dy]; };
  const cellToModel = (wi, x, y) => { const g = grids[wi], w = t.warps[wi]; return turn(g, g.rect[0] + x / w.cols * g.rect[2], g.rect[1] + y / w.rows * g.rect[3]); };
  const cellDeltaToPx = (wi, dx, dy) => {
    const g = grids[wi], w = t.warps[wi], x = dx / w.cols * g.rect[2], y = dy / w.rows * g.rect[3];
    return [g.cos * x - g.sin * y, g.sin * x + g.cos * y];
  };
  const angles = [];
  t.warps.forEach((w, i) => {
    const pts = t.warpPoints.slice(w.firstPoint, w.firstPoint + (w.cols + 1) * (w.rows + 1));
    const m = w.parent === NONE ? pts : pts.map(([x, y]) => cellToModel(w.parent, x, y));
    const p00 = m[0], p10 = m[w.cols], p01 = m[(w.cols + 1) * w.rows];
    const ex = [p10[0] - p00[0], p10[1] - p00[1]], ey = [p01[0] - p00[0], p01[1] - p00[1]];
    const width = Math.hypot(...ex), height = Math.hypot(...ey);
    let angle = Math.atan2(ex[1], ex[0]);
    if (Math.abs(angle) < 1e-7) angle = 0;
    const cx = p00[0] + (ex[0] + ey[0]) / 2, cy = p00[1] + (ex[1] + ey[1]) / 2;
    const g = { rect: angle ? [cx - width / 2, cy - height / 2, width, height] : [p00[0], p00[1], ex[0], ey[1]], cos: angle ? Math.cos(angle) : 1, sin: angle ? Math.sin(angle) : 0, cx, cy };
    grids[i] = g;
    angles[i] = angle;
    // a grid the compiler did not make (not regular): the JSON can only say rect and angle, so note it
    let worst = 0;
    m.forEach(([x, y], k) => { const q = cellToModel(i, k % (w.cols + 1), Math.floor(k / (w.cols + 1))); worst = Math.max(worst, Math.abs(x - q[0]), Math.abs(y - q[1])); });
    if (worst > 1e-3 * Math.max(1, width, height)) note('ug9WarpNotRegular', { warp: warpIds[i], off: +worst.toFixed(3) }, `warp grid ${warpIds[i]}: its rest points are not a regular grid (up to ${worst.toFixed(3)} px off): it comes back as the rectangle of its corners`);
  });
  if (t.warps.length) {
    json.warps = t.warps.map((w, i) => {
      const out = { id: warpIds[i], cols: w.cols, rows: w.rows, rect: grids[i].rect };
      if (angles[i]) out.angle = angles[i] * DEG;
      if (w.parent !== NONE) out.parent = warpIds[w.parent]; else out.bone = boneIds[w.bone];
      return out;
    });
  }

  if (t.chains.length) {
    json.chains = t.chains.map((c) => {
      const id = S(c.name), out = id ? { id } : {};
      return Object.assign(out, { bones: t.chainBones.slice(c.firstBone, c.firstBone + c.boneCount).map((b) => boneIds[b]),
        stiffness: c.stiffness, damping: c.damping, gravity: [c.gx, c.gy], inertia: c.inertia, mix: c.mix });
    });
  }

  // parts
  json.parts = t.parts.map((p, pi) => {
    const out = { id: partIds[pi], texture: p.texture, opacity: p.opacity };
    const vs = [], uvs = [];
    const inGrid = p.warp !== NONE;
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) {
      const [x, y] = t.pos[v];
      if (inGrid) vs.push(...cellToModel(p.warp, x, y)); else vs.push(x, y);
      uvs.push(...t.uv[v]);
    }
    out.vertices = vs;
    out.uvs = uvs;
    out.triangles = t.indices.slice(p.firstIndex, p.firstIndex + p.indexCount).map((k) => k - p.firstVert);
    if (p.warp !== NONE) out.warp = warpIds[p.warp];
    else {
      const infl = [];
      for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) {
        const list = [];
        for (let j = 0; j < 4; j++) if (t.weights[v][j] > 0) list.push([boneIds[t.joints[v][j]], t.weights[v][j]]);
        for (let k = t.extraStart[v]; k < t.extraStart[v + 1]; k++) if (t.extraWeights[k][1] > 0) list.push([boneIds[t.extraWeights[k][0]], t.extraWeights[k][1]]);
        infl.push(evenWeights(list));
      }
      const one = infl.length && infl.every((l) => l.length === 1 && l[0][0] === infl[0][0][0] && l[0][1] === 1);
      if (!infl.length) out.bone = boneIds[0];
      else if (one) out.bone = infl[0][0][0];
      else out.weights = infl;
    }
    if (p.mask !== NONE) {
      const m = t.masks[p.mask];
      out.mask = t.maskParts.slice(m.firstPart, m.firstPart + m.count).map((k) => partIds[k]);
    }
    if (p.flags & 1) out.maskInvert = true;
    if (p.flags & 2) out.maskOnly = true;
    if (p.flags & 4) out.solid = true;
    if (p.blend) out.blend = BLEND[p.blend];
    if (p.color !== NONE) out.color = colorIds[p.color];
    if (t.orders.length && t.orders[pi] !== 500) out.order = t.orders[pi];
    return out;
  });

  // deformers: one per morph (with the morph's region), and the bone / opacity / colour / warp
  // motions with the first deformer of their region (a region with none of the morphs gets its own)
  const regionSpec = (ri) => Object.fromEntries(t.regions[ri].map(([p, s, k, e]) => [paramIds[p], [s, k, e]]));
  const morphDeltas = t.morphs.map(() => new Map()); // part -> { vertices, deltas }
  for (let v = 0; v < t.counts.vertices; v++) {
    const pi = t.vparts[v], p = t.parts[pi], inGrid = p.warp !== NONE;
    for (let k = t.deltaStart[v]; k < t.deltaStart[v + 1]; k++) {
      const d = t.deltas[k];
      let e = morphDeltas[d.morph].get(pi);
      if (!e) morphDeltas[d.morph].set(pi, e = { vertices: [], deltas: [] });
      e.vertices.push(v - p.firstVert);
      e.deltas.push(...(inGrid ? cellDeltaToPx(p.warp, d.dx, d.dy) : [d.dx, d.dy]));
    }
  }
  const deformers = [], firstOfRegion = new Map();
  const order = t.morphs.map((r, m) => m).sort((a, b) => {
    const ra = t.morphs[a] === NONE ? Infinity : t.morphs[a], rb = t.morphs[b] === NONE ? Infinity : t.morphs[b];
    return ra - rb || a - b;
  });
  const forRegion = (ri) => {
    if (!firstOfRegion.has(ri)) { const d = { region: regionSpec(ri) }; deformers.push(d); firstOfRegion.set(ri, d); }
    return firstOfRegion.get(ri);
  };
  // regions in their order, so they are numbered the same when compiled again
  for (let ri = 0; ri < t.regions.length; ri++) {
    for (const m of order) {
      if (t.morphs[m] !== ri) continue;
      const d = firstOfRegion.has(ri) && !firstOfRegion.get(ri).morphs ? firstOfRegion.get(ri) : { region: regionSpec(ri) };
      if (!firstOfRegion.has(ri)) { firstOfRegion.set(ri, d); }
      if (!deformers.includes(d)) deformers.push(d);
      d.id = morphIds[m];
      d.morphs = Object.fromEntries([...morphDeltas[m].entries()].map(([pi, e]) => [partIds[pi], e]));
    }
    const used = t.boneDrivers.some((x) => x.region === ri) || t.opacityDrivers.some((x) => x.region === ri) || t.colorDrivers.some((x) => x.region === ri) || t.warpDrivers.some((x) => x.region === ri) || t.orderDrivers.some((x) => x.region === ri);
    if (used) forRegion(ri);
  }
  for (const m of order) {
    if (t.morphs[m] !== NONE) continue;
    deformers.push({ id: morphIds[m], morphs: Object.fromEntries([...morphDeltas[m].entries()].map(([pi, e]) => [partIds[pi], e])) });
  }
  for (const d of t.boneDrivers) {
    const f = forRegion(d.region);
    (f.bones ||= {})[boneIds[d.bone]] = { rotation: deg(d.drot), x: d.dx, y: d.dy, scaleX: d.dsx, scaleY: d.dsy };
  }
  for (const d of t.opacityDrivers) { const f = forRegion(d.region); (f.opacity ||= {})[partIds[d.part]] = d.dop; }
  for (const d of t.colorDrivers) {
    const f = forRegion(d.region), [an, bn] = COLOR_MODES[t.colors[d.slot].mode];
    (f.colors ||= {})[colorIds[d.slot]] = { [an]: d.da, [bn]: d.db };
  }
  for (const d of t.warpDrivers) {
    const f = forRegion(d.region), w = t.warps[d.warp], np = (w.cols + 1) * (w.rows + 1);
    const pts = t.warpDeltas.slice(d.firstDelta, d.firstDelta + np);
    (f.warps ||= {})[warpIds[d.warp]] = { dense: pts.flatMap(([x, y]) => (w.parent !== NONE ? cellDeltaToPx(w.parent, x, y) : [x, y])) };
  }
  for (const d of t.orderDrivers) { const f = forRegion(d.region); (f.order ||= {})[partIds[d.part]] = Math.fround(t.orders[d.part] + d.d); }
  if (deformers.length) json.deformers = deformers;
  if (t.morphs.length) note('ug9DeformerIds', { count: t.morphs.length }, 'deformers have no names in a .ug9: those with morphs are called morph0.. (deformers that shared a region may come back joined)', 'info');

  if (t.physics.length) {
    json.physics = t.physics.map((p) => ({
      output: paramIds[p.output],
      inputs: Object.fromEntries(t.physicsInputs.slice(p.firstInput, p.firstInput + p.inputCount).map(([q, w]) => [paramIds[q], w])),
      stiffness: p.stiffness, damping: p.damping, gain: p.gain, min: p.outMin, max: p.outMax,
    }));
  }

  // animations: keys back from 16-bit times and values; a track marked smooth eases between its keys
  let smoothBaked = 0, colorJoined = 0, unknownTracks = 0, curvesBaked = 0;
  json.animations = t.animations.map((a, ai) => {
    const out = { id: animIds[ai], duration: a.duration, loop: !!a.loop };
    const colorKeys = new Map(); // colour -> channel (0..5) -> keys
    // the compiler adds keys in the JSON's order and then sorts the tracks: going through the
    // tracks in the order of their keys gives the JSON's order back (so the keys land where they were)
    // (single-key tracks have no keys, so their place does not matter)
    const firstKeyOf = new Map(); // JSON object -> the first key of its tracks, to sort its entries by
    const seen = (obj, key, ti) => {
      const tr = t.tracks[ti], k = tr.keyCount > 1 ? tr.firstKey : Infinity;
      let m = firstKeyOf.get(obj);
      if (!m) firstKeyOf.set(obj, m = new Map());
      m.set(key, Math.min(m.get(key) ?? Infinity, k));
    };
    for (let ti = a.firstTrack; ti < a.firstTrack + a.trackCount; ti++) {
      const tr = t.tracks[ti], eased = tr.target >>> 31 === 1, kind = (tr.target >>> 24) & 0x7f, index = tr.target & 0xffffff;
      const val = (v) => Math.fround(tr.base + v * Math.fround(tr.step));
      const kindOf = (tr.target >>> 24) & 0x7f;
      let ks;
      if (tr.keyCount === 1) ks = [[0, tr.base]];
      else {
        ks = [];
        for (let j = tr.firstKey; j < tr.firstKey + tr.keyCount; j++) {
          const [tq, v] = t.keys[j], c = t.curves.get(j), k = [tq * a.tick, val(v)];
          const smoothCurve = c && c.cx1 === 21845 && c.cx2 === 43690 && c.cy1 === t.keys[j][1] && c.cy2 === t.keys[j + 1][1];
          if (c && kindOf === 11 && smoothCurve) { ks.push([...k, 'smooth']); continue; } // a colour's channels share their keys' modes: smooth goes
          if (c && kindOf === 11) { // ... but a curve does not (one curve per channel): it comes back as the core's pieces
            ks.push(k);
            for (const [pt, pv] of curvePoints(t.keys[j], t.keys[j + 1], c)) ks.push([pt * a.tick, val(pv)]);
            curvesBaked++;
            continue;
          }
          if (c) {
            // smoothstep as the compiler writes it: (1/3, v0), (2/3, v1)
            if (smoothCurve) k.push('smooth');
            else k.push('bezier', c.cx1 / 65535, val(c.cy1), c.cx2 / 65535, val(c.cy2));
          }
          ks.push(k);
        }
      }
      if (eased) for (const k of ks) k.push('smooth');
      if (!eased && tr.keyCount > 8 && looksBaked(ks)) smoothBaked++;
      const scaled = (f) => ks.map((k) => (k[2] === 'bezier' ? [k[0], k[1] * f, 'bezier', k[3], k[4] * f, k[5], k[6] * f] : [k[0], k[1] * f, ...k.slice(2)]));
      if (kind === 0) { checkIndex(index, t.params.length, 'track parameter'); (out.tracks ||= {})[paramIds[index]] = ks; seen(out.tracks, paramIds[index], ti); }
      else if (BONE_TRACK[kind]) {
        checkIndex(index, t.bones.length, 'track bone');
        const prop = BONE_TRACK[kind];
        const bo = ((out.bones ||= {})[boneIds[index]] ||= {});
        bo[prop] = prop === 'rotate' || prop.startsWith('shear') ? scaled(DEG) : ks;
        seen(out.bones, boneIds[index], ti); seen(bo, prop, ti);
      } else if (kind === 6) { checkIndex(index, t.parts.length, 'track part'); (out.opacity ||= {})[partIds[index]] = ks; seen(out.opacity, partIds[index], ti); }
      else if (kind === 12) { checkIndex(index, t.parts.length, 'track part'); (out.order ||= {})[partIds[index]] = ks; seen(out.order, partIds[index], ti); }
      else if (kind === 7) { checkIndex(index, t.morphs.length, 'track morph'); (out.morphs ||= {})[morphIds[index]] = ks; seen(out.morphs, morphIds[index], ti); }
      else if (kind === 10) {
        const rec = Math.floor(index / 8), ch = index % 8;
        checkIndex(rec, t.constraints.length, 'track constraint');
        const prop = t.constraints[rec].type === 0 ? IK_CHANNEL[ch] : TRANSFORM_CHANNEL[ch];
        if (!prop) throw bad(`a constraint track with channel ${ch}`, 'ug9Broken', { what: 'track' });
        const co = ((out.constraints ||= {})[consIds[rec]] ||= {});
        co[prop] = ks;
        seen(out.constraints, consIds[rec], ti); seen(co, prop, ti);
      } else if (kind === 11) {
        const slot = Math.floor(index / 8), ch = index % 8;
        checkIndex(slot, t.colors.length, 'track color');
        if (ch > 5) throw bad(`a colour track with channel ${ch}`, 'ug9Broken', { what: 'track' });
        if (!colorKeys.has(slot)) colorKeys.set(slot, []);
        colorKeys.get(slot)[ch] = { ks, eased };
        seen(colorKeys, slot, ti); seen(colorKeys.get(slot), ch < 3 ? 0 : 1, ti);
      } else if (t.major >= 1) { unknownTracks++; } // a newer 1.x's kind: skipped, as the core does
      else throw bad(`a track of unknown kind ${kind}`, 'ug9Broken', { what: 'track' });
    }
    // colours: the JSON keys [time, [r, g, b]] for the three channels together
    const byKey = (obj) => (x, y) => (firstKeyOf.get(obj)?.get(x) ?? Infinity) - (firstKeyOf.get(obj)?.get(y) ?? Infinity);
    for (const [slot, chans] of [...colorKeys].sort((x, y) => byKey(colorKeys)(x[0], y[0]))) {
      const mode = COLOR_MODES[t.colors[slot].mode];
      for (const [half, name] of [[0, mode[0]], [3, mode[1]]].sort((x, y) => byKey(chans)(x[0] / 3, y[0] / 3))) {
        const three = [0, 1, 2].map((c) => chans[half + c]);
        if (three.every((x) => !x)) continue;
        const rest = half === 0 ? t.colors[slot].a : t.colors[slot].b;
        const times = [...new Set(three.flatMap((x) => (x ? x.ks.map((k) => k[0]) : [])))].sort((p, q) => p - q);
        const anyEased = three.some((x) => x?.eased), allSame = three.every((x) => !x || x.ks.length === 1 || x.ks.map((k) => k[0]).join() === times.join());
        if (anyEased && !allSame) colorJoined++;
        // a time can be there twice (a jump): keep both keys, before and after
        const at = (x, c, time, which) => (x ? valueAt(x.ks, time, x.eased, which) : rest[c]);
        const keysOut = [];
        times.forEach((time) => {
          const jump = three.some((x) => x && x.ks.filter((k) => k[0] === time).length > 1);
          for (const which of jump ? ['first', 'last'] : ['last']) {
            const k = [time, [0, 1, 2].map((c) => at(three[c], c, time, which))];
            // smooth when every moving channel's piece from here is smooth (an eased track: all of them)
            const pieceSmooth = (x) => !x || x.ks.length === 1 || x.eased || x.ks.some((q) => q[0] === time && q[2] === 'smooth') || !x.ks.some((q) => q[0] === time);
            if (anyEased || (three.some((x) => x && x.ks.some((q) => q[0] === time && q[2] === 'smooth')) && three.every(pieceSmooth))) k.push('smooth');
            keysOut.push(k);
          }
        });
        (((out.colors ||= {})[colorIds[slot]] ||= {}))[name] = keysOut;
      }
    }
    // entries in the order the compiler first met them (by the first key of their tracks)
    const sortObj = (obj) => {
      const m = firstKeyOf.get(obj);
      if (!obj || !m) return obj;
      const sorted = Object.fromEntries(Object.entries(obj).sort((x, y) => (m.get(x[0]) ?? Infinity) - (m.get(y[0]) ?? Infinity)));
      firstKeyOf.set(sorted, m);
      return sorted;
    };
    for (const k of ['tracks', 'opacity', 'morphs', 'order']) if (out[k]) out[k] = sortObj(out[k]);
    for (const k of ['bones', 'constraints']) if (out[k]) out[k] = Object.fromEntries(Object.entries(sortObj(out[k])).map(([id, props]) => [id, sortObj(props)]));
    return out;
  });
  if (curvesBaked) note('ug9ColorCurves', { curves: curvesBaked }, `${curvesBaked} curve(s) on colour tracks come back as the player's straight pieces (a colour's keys are written for its three channels together)`, 'info');
  if (unknownTracks) note('ug9SkippedTracks', { tracks: unknownTracks }, `made by a newer version: ${unknownTracks} track(s) of kinds not known here were left out`);
  if (smoothBaked) note('ug9SmoothBaked', { tracks: smoothBaked }, `${smoothBaked} track(s) look like curves baked into short straight pieces: they come back as those pieces`, 'info');
  if (colorJoined) note('ug9ColorJoined', { tracks: colorJoined }, `${colorJoined} colour track(s) had channels with different key times and easing: joined, they may ease slightly differently`);

  if (t.expressions.length) {
    json.expressions = t.expressions.map((e) => ({ id: S(e.name), fadeIn: e.fadeIn, fadeOut: e.fadeOut,
      params: Object.fromEntries(t.expressionItems.slice(e.firstItem, e.firstItem + e.itemCount).map((it) => [paramIds[it.param], [EXPR_OPS[it.op], it.value]])) }));
  }
  if (t.skipped.length) {
    const drawn = t.skipped.filter((x) => x.flag === 1).map((x) => x.kind);
    note('ug9SkippedTable', { kinds: t.skipped.map((x) => x.kind), changesPicture: drawn }, `made by a newer version: table kind(s) ${t.skipped.map((x) => x.kind).join(', ')} are not known here and were left out${drawn.length ? ' (the picture may differ)' : ''}`, drawn.length ? 'warn' : 'info');
  }
  json.editor = { restoredFrom: { file: opts.file || '', format: `${t.major}.${t.minor}`, bytes: (bytes.byteLength ?? bytes.length) } };
  note('ug9Lost', {}, 'not in a .ug9, so not restored: the source PSD / Spine links, glue (it is baked into the weights and morphs), curve shapes and key interpolation names, and the editor\'s own data (guides, selection sets, folders, scripts)', 'info');
  return { json, notes, warnings };
}

// weights the compiler normalises (divides by their sum) back into the same f32s: the f32s as
// they are when that gives them, else with the largest taking up what the f32s lost
function evenWeights(list) {
  if (list.length < 2) return list;
  const target = list.map(([, w]) => w);
  const x = [...target];
  const result = () => { // as the compiler does it: sorted strongest first, divided by the sum
    const order = x.map((w, i) => i).sort((p, q) => x[q] - x[p]);
    const sum = order.reduce((s, i) => s + x[i], 0);
    return x.map((w) => Math.fround(w / sum));
  };
  for (let round = 0; round < 16; round++) {
    const r = result();
    let off = false;
    r.forEach((v, i) => {
      if (v === target[i]) return;
      off = true;
      const ulp = Math.abs(target[i]) * 2 ** -24 || 2 ** -149;
      x[i] += (target[i] > v ? 1 : -1) * ulp * 0.5;
    });
    if (!off) return list.map(([bone], i) => [bone, x[i]]);
  }
  return list;
}

// radians (an f32) as degrees that the compiler turns back into the same f32
function deg(r) {
  const d = r * DEG;
  if (Math.fround(d * (Math.PI / 180)) === r) return d;
  for (let k = 1; k <= 64; k++) for (const s of [1, -1]) {
    const c = d + s * k * Math.abs(d) * Number.EPSILON;
    if (Math.fround(c * (Math.PI / 180)) === r) return c;
  }
  return d;
}

function checkIndex(v, max, what) { if (!(v >= 0 && v < max)) throw bad(`${what} ${v} is out of range (0..${max - 1})`, 'ug9Broken', { what }); }

// a track's value at a time (straight lines, or smoothstep for an eased track); at a jump, the
// value before it ('first') or after it ('last')
function valueAt(ks, time, eased, which) {
  if (ks.length === 1 || time <= ks[0][0]) return ks[0][1];
  if (time >= ks[ks.length - 1][0]) return ks[ks.length - 1][1];
  const same = ks.filter((k) => k[0] === time);
  if (same.length) return which === 'first' ? same[0][1] : same[same.length - 1][1];
  let i = 0;
  while (ks[i + 1][0] < time) i++;
  const [t0, v0] = ks[i], [t1, v1] = ks[i + 1];
  let f = (time - t0) / (t1 - t0);
  if (eased || ks[i][2] === 'smooth') f = f * f * (3 - 2 * f);
  return v0 + (v1 - v0) * f;
}

// many keys close together that follow a smooth line: a curve the compiler cut into straight pieces
function looksBaked(ks) {
  let short = 0;
  for (let i = 1; i < ks.length; i++) if (ks[i][0] - ks[i - 1][0] < 0.05) short++;
  return short > ks.length * 0.6;
}

// ---- CLI ---------------------------------------------------------------
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const [, , input, outDir] = process.argv;
  if (!input) {
    console.error('usage: node tools/import_ug9.mjs model.ug9 [out_dir]   (out_dir/model.json and the textures beside it)');
    process.exit(2);
  }
  let res;
  try { res = importUg9(fs.readFileSync(input), { file: path.basename(input) }); } catch (e) { console.error(e.message); process.exit(e.code === 'ug9Version' || e.code === 'ug9NotUg9' ? 2 : 1); }
  const dir = outDir || path.join(path.dirname(input), `${path.basename(input).replace(/\.(ug9|ugo)$/i, '')}_restored`);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(input).replace(/\.(ug9|ugo)$/i, '') || 'model';
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(res.json, null, 1));
  for (const tex of res.json.textures) {
    const from = path.join(path.dirname(input), tex), to = path.join(dir, tex);
    if (fs.existsSync(from) && path.resolve(from) !== path.resolve(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    else if (!fs.existsSync(from)) console.warn(`texture ${tex} is not next to ${input}: put it beside the JSON`);
  }
  for (const w of res.warnings) console.warn(`note: ${w}`);
  console.log(`${path.join(dir, `${name}.json`)}: ${res.json.parts.length} parts, ${res.json.bones.length} bones, ${res.json.animations.length} animations`);
}
