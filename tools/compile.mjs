// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 compiler: authoring JSON (docs/形式.md) -> .ug9 binary.
// Works in Node and in the browser (no Node APIs outside the CLI block).
//
//   node tools/compile.mjs model.json [model.ug9]

import { poseWorld } from './skeleton_pose.mjs';
import { readExpressions } from './expressions.mjs';
import { packTracks, curvePoints, curveAt, expandTracks } from './curve_keys.mjs';

// header (1.0): magic, major, minor, file size, header size, canvas (16), contents count, flags; then the table
// of contents (16 bytes a table: kind, offset, count, record size | flags << 16). See docs/形式.md.
const HEADER_SIZE = 40;
const TOC_ENTRY = 16, TOC_MAX = 256;
// what an older core does with a table it does not know (as TOC_SKIP .. in core/src/ugo_internal.h)
const TOC_SKIP = 0, TOC_WARN = 1, TOC_NEED = 2;
// table kinds (as TB_* in core/src/ugo_internal.h; the numbers never change)
export const TABLE_KIND = {
  params: 1, bones: 2, constraints: 3, parts: 4, textures: 5, positions: 6, uvs: 7, joints: 8, weights: 9, vertexParts: 10,
  entryStarts: 11, entries: 12, indices: 13, regions: 14, morphs: 15, boneDrivers: 16, opacityDrivers: 17, physics: 18,
  physicsInputs: 19, animations: 20, tracks: 21, keys: 22, strings: 23, masks: 24, maskParts: 25, colors: 26, colorDrivers: 27,
  extraStarts: 28, extraWeights: 29, warps: 30, warpPoints: 31, warpDrivers: 32, warpDeltas: 33, boneWarps: 34, chains: 35,
  chainBones: 36, orders: 37, orderDrivers: 38, expressions: 39, expressionItems: 40,
  tracks11: 41, keys11: 42, keyCurves: 43, // 1.1 curve keys, in place of tracks and keys (tools/curve_keys.mjs)
};
const VERSION_MAJOR = 1;
const VERSION_MINOR = 1; // 1.1: curve keys (tables 41-43 in place of 21-22)
// the format version as the authoring JSON's "version" (and the editor's savedBy.formatVersion) writes it
export const FORMAT_VERSION = `${VERSION_MAJOR}.${VERSION_MINOR}`;
const NO_REGION = 0xffffffff; // a morph that only animation tracks drive
// animation track targets: kind << 24 | index (see core/src/ugo_internal.h)
const TRACK_KIND = { param: 0, rotate: 1, x: 2, y: 3, scaleX: 4, scaleY: 5, opacity: 6, morph: 7, shearX: 8, shearY: 9, constraint: 10, color: 11, order: 12 };
const BLEND = { normal: 0, add: 1, multiply: 2, screen: 3 };
const PART_MASK_INVERT = 1, PART_HIDDEN = 2, PART_SOLID = 4;
const MASK_CHANNELS = 16;
// colour slots: [mode, name of a, name of b, default a, default b]
const COLOR_MODES = [['multiply', 'screen', 1, 0], ['tint', 'dark', 1, 0]];
// animatable constraint values -> channel (index = record * 8 + channel)
const CONS_CHANNEL = { mix: 0, mixRotate: 0, mixX: 1, mixY: 2, mixScaleX: 3, mixScaleY: 4, mixShearY: 5, bend: 6 };
const INHERIT_NAMES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const DEG = Math.PI / 180;
const INTERP = { step: 0, linear: 1, smooth: 2, bezier: 3 }; // in the authoring JSON (bezier: 1.1, [t, v, 'bezier', cx1, cy1, cx2, cy2])
const KEY_TICKS = 65535; // a key's time: 16 bits of the animation's last key time (0.7)
const ORDER_DEFAULT = 500, ORDER_MAX = 1e6; // a part's draw order value (0.8; as UGO_ORDER_MAX)

// where in the authoring JSON the compiler is reading (e.g. "deformers[3].morphs.face"),
// so an editor can point at the field: errors carry it in .path and at the start of the message
let at = '';
// errors also carry .code and .vars (as the warnings do: the list is in docs/形式.md),
// so an editor can show them in its own language; .message stays the English text
function fail(msg, code = 'invalid', vars = {}) {
  const e = new Error(`ugo compile: ${at ? `[${at}] ` : ''}${msg}`);
  e.path = at;
  e.code = code;
  e.vars = vars;
  throw e;
}

function num(v, fallback, what) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a finite number`, 'notFinite', { field: what });
  return v;
}

// ---- hot loops ----------------------------------------------------------
// The loops that run once per vertex, index, delta or key live in these small functions: V8 does not
// optimize a function as large as compile(), so a loop written in its body runs in the interpreter
// (a 160-part model took 40-55 ms to compile; most of it was those loops).

// count numbers from src into dst at o (finite numbers inline; anything else through num, for its default or error)
function readNumbers(src, dst, o, count, what) {
  for (let i = 0; i < count; i++) {
    const x = src[i];
    dst[o + i] = typeof x === 'number' && x - x === 0 ? x : num(x, 0, what);
  }
}

// a part's triangles into out from at, as global vertex numbers; returns the new end (or the first bad index)
function readTriangles(tri, n, firstVert, out, at) {
  if (!Array.isArray(tri)) { // anything else as before (iterated; not iterable throws, which compileUgo reports as malformed)
    for (const k of tri) {
      if (!Number.isInteger(k) || k < 0 || k >= n) return { bad: k };
      out[at++] = firstVert + k;
    }
    return { end: at };
  }
  for (let j = 0; j < tri.length; j++) {
    const k = tri[j];
    if (!(typeof k === 'number' && k >= 0 && k < n && Math.floor(k) === k)) return { bad: k };
    out[at++] = firstVert + k;
  }
  return { end: at };
}

// one vertex's influences: the positive weights, strongest first (ties: lower bone first), divided by their sum
function readInfluences(list, bone, where) {
  if (!Array.isArray(list)) return readInfluencesAsBefore(list, bone, where);
  const infl = [];
  for (let j = 0; j < list.length; j++) {
    if (!Array.isArray(list[j])) return readInfluencesAsBefore(list, bone, where);
    const b = bone(list[j][0], where), x = num(list[j][1], 0, 'weight');
    if (!(x > 0)) continue;
    let k = infl.length; // insertion: lists are short
    while (k > 0 && (infl[k - 1][1] < x || (infl[k - 1][1] === x && infl[k - 1][0] > b))) k--;
    infl.splice(k, 0, [b, x]);
  }
  if (!infl.length) return [[0, 1]];
  let sum = 0;
  for (let j = 0; j < infl.length; j++) sum += infl[j][1];
  for (let j = 0; j < infl.length; j++) infl[j][1] /= sum;
  return infl;
}

// a part's influences, one list per vertex (oneBone: the same list for all)
function readPartInfluences(vInfl, n, oneBone, weights, bone, where) {
  if (oneBone) for (let i = 0; i < n; i++) vInfl.push(oneBone);
  else for (let i = 0; i < n; i++) vInfl.push(readInfluences(weights[i] || [], bone, where));
}

// how many of n points (cell coordinates from 2 * first) lie outside a cols x rows grid
function countOutside(pos, first, n, cols, rows) {
  let out = 0;
  for (let i = first; i < first + n; i++) {
    const u = pos[2 * i], v = pos[2 * i + 1];
    if (u < -0.01 || v < -0.01 || u > cols + 0.01 || v > rows + 0.01) out++;
  }
  return out;
}

// lists that are not lists of [bone, weight] arrays: as the compiler did before (the same results and errors)
function readInfluencesAsBefore(list, bone, where) {
  let infl = list.map(([id, w]) => [bone(id, where), num(w, 0, 'weight')]);
  infl = infl.filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!infl.length) infl = [[0, 1]];
  const sum = infl.reduce((s, [, w]) => s + w, 0);
  return infl.map(([b, w]) => [b, w / sum]);
}

// a dense morph: one delta pair per vertex
function addDense(dense, count, add) {
  for (let i = 0; i < count; i++) {
    const x = dense[2 * i], y = dense[2 * i + 1];
    add(i, typeof x === 'number' && x - x === 0 ? x : num(x, 0, 'delta'), typeof y === 'number' && y - y === 0 ? y : num(y, 0, 'delta'));
  }
}

// influences -> the strongest four per vertex, and the rest in their own table
function splitInfluences(vInfl, joints, weights, xweights, xstart) {
  for (let v = 0; v < vInfl.length; v++) {
    const infl = vInfl[v];
    for (let j = 0; j < 4 && j < infl.length; j++) { joints[4 * v + j] = infl[j][0]; weights[4 * v + j] = infl[j][1]; }
    for (let j = 4; j < infl.length; j++) xweights.push([infl[j][0], infl[j][1]]);
    xstart.push(xweights.length);
  }
}

// per-vertex morph deltas -> CSR starts and the flat entries (morph, dx, dy)
function packEntries(perVertex, nv) {
  const csr = new Uint32Array(nv + 1);
  let n = 0;
  for (let v = 0; v < nv; v++) { n += perVertex[v].length / 3; csr[v + 1] = n; }
  const entries = new Float64Array(3 * n);
  for (let v = 0; v < nv; v++) { const d = perVertex[v]; if (d.length) entries.set(d, 3 * csr[v]); }
  return { csr, nEntries: n, entries };
}

// entries interleaved: morph (u32), dx, dy (f32), at byte o of buf (little-endian, o % 4 === 0)
function writeEntries(buf, o, entries) {
  const eu = new Uint32Array(buf, o, entries.length), ef = new Float32Array(buf, o, entries.length);
  for (let k = 0; k < entries.length; k += 3) { eu[k] = entries[k]; ef[k + 1] = entries[k + 1]; ef[k + 2] = entries[k + 2]; }
}

// keys: 16-bit time in the animation's ticks, 16-bit value in the track's range (encoded at each key's own
// index: the tracks were sorted, the keys stay where they were added)
function encodeKeys(anims, tracks, keys) {
  const enc = new Uint16Array(2 * keys.length);
  for (const a of anims) {
    for (let ti = a.firstTrack; ti < a.firstTrack + a.trackCount; ti++) {
      const [, k0, n, base, step] = tracks[ti];
      if (n < 2) continue;
      const b = Math.fround(base), st = Math.fround(step);
      let prev = 0;
      for (let k = k0; k < k0 + n; k++) {
        const [t, v] = keys[k];
        // a jump (two keys at one time, e.g. a step) is rounded down, so it is never late
        const jump = (k > k0 && keys[k - 1][0] === t) || (k + 1 < k0 + n && keys[k + 1][0] === t);
        const tq = Math.max(prev, Math.min(KEY_TICKS, Math.max(0, (jump ? Math.floor : Math.round)(t / a.tick))));
        prev = tq;
        enc[2 * k] = tq;
        enc[2 * k + 1] = st > 0 ? Math.min(65535, Math.max(0, Math.round((v - b) / st))) : 0;
      }
    }
  }
  return enc;
}

// Whether the core's pieces of a curve (curve_keys.mjs curvePoints) stay within `tolerance` value units
// of the exact curve (as curve_keys.mjs curveError, sampled 16 times a piece and walked once; it stops at
// the first sample too far); and the fewest pieces (2..256) that do: doubling, then halving the gap (as
// curvePieces, faster). The same curve (keys, handles, tolerance) gives the same answer: kept for the next
// one (a character's animations repeat their curves), the answer itself is the same as working it out again
// curve_keys.mjs curvePoints in plain numbers, where every product stays a whole number below 2^53 (n up
// to 64, any keys and handles of 16 bits), the same points; above that, curvePoints itself (BigInt)
export function curvePointsFast(a, b, c) {
  const n = c.n;
  if (!(n <= 64)) return curvePoints(a, b, c);
  const n3 = n * n * n, span = b[0] - a[0], { cx1, cy1, cx2, cy2 } = c, v0 = a[1], v1 = b[1];
  // x / d rounded half up, x and d whole and 0 <= 2x + d < 2^53: the floor of (2x + d) / 2d, put right
  const div = (x, d) => { const p = 2 * x + d, q2 = 2 * d; let q = Math.floor(p / q2); const r = p - q * q2; if (r < 0) q--; else if (r >= q2) q++; return q; };
  const out = [];
  let last = a[0];
  for (let s = 1; s < n; s++) {
    const u = n - s;
    const x = 3 * u * u * s * cx1 + 3 * u * s * s * cx2 + s * s * s * 65535;
    const y = u * u * u * v0 + 3 * u * u * s * cy1 + 3 * u * s * s * cy2 + s * s * s * v1;
    const t = a[0] + div(x * span, 65535 * n3);
    if (t <= last || t >= b[0]) continue;
    out.push([t, div(y, n3)]);
    last = t;
  }
  return out;
}
function piecesWithin(A, B, h, n, tolerance) {
  const pts = [A, ...curvePointsFast(A, B, { ...h, n }), B], N = 16 * n;
  const a0 = A[0], a1 = A[1], b1 = B[1], span = B[0] - A[0], { cx1, cy1, cx2, cy2 } = h;
  let i = 0;
  for (let k = 0; k <= N; k++) {
    // curve_keys.mjs curveAt(A, B, h, k / N), written out (the same sums in the same order: the same numbers)
    const s = k / N, u = 1 - s, w0 = u * u * u, w1 = 3 * u * u * s, w2 = 3 * u * s * s, w3 = s * s * s;
    const t = a0 + (w1 * cx1 / 65535 + w2 * cx2 / 65535 + w3) * span, v = w0 * a1 + w1 * cy1 + w2 * cy2 + w3 * b1;
    while (i < pts.length - 2 && pts[i + 1][0] <= t) i++;
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    const lin = t1 > t0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : v1;
    if (Math.abs(lin - v) > tolerance) return false;
  }
  return true;
}
const fitted = new Map(); // "A B handles tolerance" -> { n, ok }
export function fewestPieces(A, B, h, tolerance) {
  const key = `${A[0]},${A[1]},${B[0]},${B[1]},${h.cx1},${h.cy1},${h.cx2},${h.cy2},${tolerance}`;
  const known = fitted.get(key);
  if (known) return known;
  let lo = 1, hi = 2, fit;
  while (hi < 256 && !piecesWithin(A, B, h, hi, tolerance)) { lo = hi; hi = Math.min(256, hi * 2); }
  if (hi === 256 && !piecesWithin(A, B, h, 256, tolerance)) fit = { n: 256, ok: false };
  else {
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (piecesWithin(A, B, h, m, tolerance)) hi = m; else lo = m; }
    fit = { n: Math.max(2, hi), ok: true };
  }
  if (fitted.size > 100000) fitted.clear(); // a bound for a long-lived page (the editor compiles again and again)
  fitted.set(key, fit);
  return fit;
}

// a draw order value (0.8): finite, at most ORDER_MAX either way
function orderValue(v, fallback, what) {
  const x = num(v, fallback, what);
  if (Math.abs(x) > ORDER_MAX) fail(`${what}: a draw order value must be within -${ORDER_MAX}..${ORDER_MAX}`, 'orderRange', { field: what, max: ORDER_MAX });
  return x;
}

function matInv(M) {
  const det = M[0] * M[3] - M[1] * M[2];
  if (Math.abs(det) < 1e-12) fail('a bone has zero scale in its rest pose', 'boneZeroScale', {});
  const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
}


/** Compiles an authoring object into an ArrayBuffer (.ug9). */
export function compileUgo(src, options = {}) {
  try {
    return compile(src, options);
  } catch (e) {
    if (e.code) throw e;
    // data of the wrong shape somewhere a check does not look (e.g. a number where a list goes)
    const f = new Error(`ugo compile: ${at ? `[${at}] ` : ''}malformed data (${e.message})`);
    f.path = at;
    f.code = 'malformed';
    f.vars = { detail: e.message };
    throw f;
  }
}

function compile(src, options) {
  at = '';
  // options.warnings: an array that gets { path, code, vars, level, message } for things that compile
  // but look wrong (codes and vars: docs/形式.md; level 'info' for the ones that are often fine)
  const warn = (code, vars, message, path = at, level = 'warning') => { if (options.warnings) options.warnings.push({ path, code, vars, level, message }); };
  // options.timings: an object that gets milliseconds per section (for measuring the editor's rebuild)
  // options.checkOnly: run the checks (errors, warnings) without writing the .ug9; returns null
  let lapT = options.timings ? performance.now() : 0;
  const lap = options.timings ? (name) => { const t = performance.now(); options.timings[name] = (options.timings[name] || 0) + t - lapT; lapT = t; } : () => {};
  const usedParams = new Set();
  if (!src || src.format !== 'ugo9') fail('"format" must be "ugo9"', 'notUgo9', {});
  for (const k of ['textures', 'parameters', 'bones', 'constraints', 'colors', 'warps', 'chains', 'parts', 'deformers', 'glue', 'physics', 'animations']) {
    at = k;
    if (src[k] && !Array.isArray(src[k])) fail(`"${k}" must be a list`, 'notList', { field: k });
  }
  at = '';
  const canvas = src.canvas || {};

  // strings: offset 0 is the empty string
  const strings = [''];
  const stringOffset = new Map([['', 0]]);
  let stringBytes = 1;
  const enc = new TextEncoder();
  const str = (s) => {
    s = String(s ?? '');
    if (stringOffset.has(s)) return stringOffset.get(s);
    const off = stringBytes;
    stringOffset.set(s, off);
    strings.push(s);
    stringBytes += enc.encode(s).length + 1;
    return off;
  };

  // parameters
  const params = (src.parameters || []).map((p, i) => {
    at = `parameters[${i}]`;
    if (!p.id) fail(`parameter #${i} has no id`, 'missingId', { kind: 'param', index: i });
    const min = num(p.min, 0, `${p.id}.min`), max = num(p.max, 1, `${p.id}.max`);
    const def = num(p.default, Math.min(Math.max(0, min), max), `${p.id}.default`);
    if (!(min <= def && def <= max)) fail(`parameter ${p.id}: need min <= default <= max`, 'paramRange', { param: p.id });
    return { id: p.id, min, max, def };
  });
  const paramIndex = new Map(params.map((p, i) => [p.id, i]));
  if (paramIndex.size !== params.length) fail('duplicate parameter id', 'duplicateId', { kind: 'param' });
  const P = (id, where) => {
    if (!paramIndex.has(id)) fail(`${where}: unknown parameter "${id}"`, 'unknownParam', { id });
    usedParams.add(id);
    return paramIndex.get(id);
  };

  lap('params');
  // bones: reorder so parents come first, compute bind inverses
  const srcBones = src.bones && src.bones.length ? src.bones : [{ id: 'root' }];
  const byId = new Map();
  for (const b of srcBones) {
    if (!b.id) fail('a bone has no id', 'missingId', { kind: 'bone' });
    if (byId.has(b.id)) fail(`duplicate bone id "${b.id}"`, 'duplicateId', { kind: 'bone', id: b.id });
    byId.set(b.id, b);
  }
  const order = [];
  const state = new Map();
  const srcBoneAt = new Map(srcBones.map((b, i) => [b, i]));
  const visit = (b) => {
    if (state.get(b.id) === 2) return;
    at = `bones[${srcBoneAt.get(b)}]`;
    if (state.get(b.id) === 1) fail(`bone hierarchy has a cycle at "${b.id}"`, 'boneCycle', { bone: b.id });
    state.set(b.id, 1);
    if (b.parent != null) {
      if (!byId.has(b.parent)) fail(`bone "${b.id}": unknown parent "${b.parent}"`, 'unknownBone', { id: b.parent });
      visit(byId.get(b.parent));
    }
    state.set(b.id, 2);
    at = `bones[${srcBoneAt.get(b)}]`;
    order.push(b);
  };
  srcBones.forEach(visit);
  if (order.length > 8192) fail('at most 8192 bones', 'tooMany', { kind: 'bone', max: 8192 });
  const boneIndex = new Map(order.map((b, i) => [b.id, i]));
  const bones = order.map((b) => {
    at = `bones[${srcBoneAt.get(b)}]`;
    const inherit = typeof b.inherit === 'number' ? b.inherit : INHERIT_NAMES.indexOf(b.inherit ?? 'normal');
    if (!(inherit >= 0 && inherit < INHERIT_NAMES.length)) fail(`bone "${b.id}": unknown inherit mode "${b.inherit}"`, 'unknownInherit', { bone: b.id, value: String(b.inherit) });
    return {
      id: b.id,
      parent: b.parent == null ? -1 : boneIndex.get(b.parent),
      x: num(b.x, 0, `${b.id}.x`), y: num(b.y, 0, `${b.id}.y`),
      rot: num(b.rotation, 0, `${b.id}.rotation`) * DEG,
      sx: num(b.scaleX, 1, `${b.id}.scaleX`), sy: num(b.scaleY, 1, `${b.id}.scaleY`),
      shx: num(b.shearX, 0, `${b.id}.shearX`) * DEG, shy: num(b.shearY, 0, `${b.id}.shearY`) * DEG,
      length: num(b.length, 0, `${b.id}.length`), inherit,
    };
  });
  const B = (id, where) => {
    if (!boneIndex.has(id)) fail(`${where}: unknown bone "${id}"`, 'unknownBone', { id });
    return boneIndex.get(id);
  };

  // constraints, in the order they apply (a transform constraint on several bones
  // becomes one record per bone)
  const cons = [];
  const consRecords = new Map(); // constraint id -> record indices
  for (const [ci, c] of (src.constraints || []).entries()) {
    const where = `constraint ${c.id ?? '#' + ci}`;
    at = `constraints[${ci}]`;
    const first = cons.length;
    const list = (c.bones || []).map((id) => B(id, where));
    const target = B(c.target, where);
    if (c.type === 'ik') {
      if (list.length < 1 || list.length > 2) fail(`${where}: IK needs 1 or 2 bones`, 'ikBoneCount', { constraint: c.id ?? '' });
      cons.push({
        type: 0, flags: (c.compress ? 1 : 0) | (c.stretch ? 2 : 0) | (c.uniform ? 4 : 0),
        bone: list[0], bone2: list.length > 1 ? list[1] : -1, target,
        mix: [num(c.mix, 1, `${where}.mix`), 0, 0, 0, 0, 0], off: [num(c.bend, 1, `${where}.bend`) < 0 ? -1 : 1, 0, 0, 0, 0, 0],
      });
    } else if (c.type === 'transform') {
      if (!list.length) fail(`${where}: no bones`, 'noBones', { constraint: c.id ?? '' });
      const mix = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'].map((k) => num(c[k], 1, `${where}.${k}`));
      const off = [num(c.rotation, 0, `${where}.rotation`) * DEG, num(c.x, 0, `${where}.x`), num(c.y, 0, `${where}.y`),
        num(c.scaleX, 0, `${where}.scaleX`), num(c.scaleY, 0, `${where}.scaleY`), num(c.shearY, 0, `${where}.shearY`) * DEG];
      for (const bone of list) cons.push({ type: 1, flags: (c.local ? 1 : 0) | (c.relative ? 2 : 0), bone, bone2: -1, target, mix, off });
    } else fail(`${where}: unknown type "${c.type}"`, 'unknownConstraintType', { constraint: c.id ?? '', value: String(c.type) });
    if (c.id !== undefined) {
      if (consRecords.has(c.id)) fail(`duplicate constraint id "${c.id}"`, 'duplicateId', { kind: 'constraint', id: c.id });
      consRecords.set(c.id, { type: c.type, records: Array.from({ length: cons.length - first }, (_, k) => first + k) });
    }
  }

  at = '';
  // bind pose: the rest pose with inheritance and constraints applied
  const world = poseWorld(
    bones.map((b) => ({ parent: b.parent, inherit: b.inherit, length: b.length })),
    bones.map((b) => [b.x, b.y, b.rot, b.sx, b.sy, b.shx, b.shy]),
    cons.map(consForPose),
  );
  bones.forEach((b, i) => { b.bindInv = matInv(world[i]); });

  lap('bones');
  // textures
  const textures = (src.textures || []).map((t) => (typeof t === 'string' ? t : t.path));

  // colour slots: Live2D style multiply / screen, or Spine style tint / dark (two-colour tint)
  const rgb = (v, fallback, what) => {
    if (v === undefined) return [fallback, fallback, fallback];
    if (!Array.isArray(v) || v.length !== 3) fail(`${what} must be [r, g, b] (0..1)`, 'notColor', { field: what });
    return v.map((x) => num(x, 0, what));
  };
  const colorMode = (c, where) => {
    const ls = 'multiply' in c || 'screen' in c, sp = 'tint' in c || 'dark' in c;
    if (ls && sp) fail(`${where}: use either multiply/screen or tint/dark`, 'colorModeMix', { color: c.id ?? '' });
    return sp ? 1 : 0;
  };
  const colors = (src.colors || []).map((c, i) => {
    const where = `color ${c.id ?? '#' + i}`;
    at = `colors[${i}]`;
    if (!c.id) fail(`${where} has no id`, 'missingId', { kind: 'color', index: i });
    const mode = colorMode(c, where), [an, bn, ad, bd] = COLOR_MODES[mode];
    return { id: c.id, mode, a: rgb(c[an], ad, `${where}.${an}`), b: rgb(c[bn], bd, `${where}.${bn}`) };
  });
  const colorIndex = new Map(colors.map((c, i) => [c.id, i]));
  if (colorIndex.size !== colors.length) fail('duplicate color id', 'duplicateId', { kind: 'color' });
  const CL = (id, where) => {
    if (!colorIndex.has(id)) fail(`${where}: unknown color "${id}"`, 'unknownColor', { id });
    return colorIndex.get(id);
  };

  // warp grids (0.5): parents first; a regular grid over "rect" in the rest pose
  const warpById = new Map();
  for (const [wi, w] of (src.warps || []).entries()) {
    if (!w.id) fail(`warp #${wi} has no id`, 'missingId', { kind: 'warp', index: wi });
    if (warpById.has(w.id)) fail(`duplicate warp id "${w.id}"`, 'duplicateId', { kind: 'warp', id: w.id });
    warpById.set(w.id, w);
  }
  const warps = [], warpState = new Map(), srcWarpAt = new Map((src.warps || []).map((w, i) => [w, i]));
  const visitWarp = (w) => {
    if (warpState.get(w.id) === 2) return;
    at = `warps[${srcWarpAt.get(w)}]`;
    if (warpState.get(w.id) === 1) fail(`warp "${w.id}": parents form a cycle`, 'warpCycle', { warp: w.id });
    warpState.set(w.id, 1);
    if (w.parent != null) {
      if (!warpById.has(w.parent)) fail(`warp "${w.id}": unknown parent warp "${w.parent}"`, 'unknownWarp', { id: w.parent });
      visitWarp(warpById.get(w.parent));
    }
    warpState.set(w.id, 2);
    at = `warps[${srcWarpAt.get(w)}]`;
    const where = `warp ${w.id}`;
    const cols = num(w.cols, 0, `${where}.cols`), rows = num(w.rows, 0, `${where}.rows`);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 64 || rows > 64) fail(`${where}: cols and rows must be 1..64`, 'warpSize', { warp: w.id, max: 64 });
    if (!Array.isArray(w.rect) || w.rect.length !== 4) fail(`${where}: "rect" must be [x, y, width, height]`, 'warpRect', { warp: w.id });
    const rect = w.rect.map((x) => num(x, 0, `${where}.rect`));
    if (!(rect[2] > 0 && rect[3] > 0)) fail(`${where}: rect needs a positive width and height`, 'warpRect', { warp: w.id });
    if (w.parent != null && w.bone != null) fail(`${where}: a warp inside another follows it, not a bone`, 'warpParentAndBone', { warp: w.id });
    // turned (0.8): rect is the grid seen along its own axes, turned by angle (degrees) about its centre
    const angle = num(w.angle, 0, `${where}.angle`) * DEG;
    const turn = angle === 0 ? null : { cos: Math.cos(angle), sin: Math.sin(angle), cx: rect[0] + rect[2] / 2, cy: rect[1] + rect[3] / 2 };
    warps.push({ id: w.id, cols, rows, rect, turn, parent: w.parent == null ? null : w.parent, bone: B(w.bone ?? bones[0].id, where) });
  };
  (src.warps || []).forEach(visitWarp);
  const warpIndex = new Map(warps.map((w, i) => [w.id, i]));
  warps.forEach((w) => { w.parentIndex = w.parent == null ? NO_REGION : warpIndex.get(w.parent); });
  // model space (rest pose) -> a warp's cell coordinates, and a model-space delta -> cells
  // (a turned grid: first turned back into the grid's own axes)
  const unturn = (w, x, y) => {
    const t = w.turn, dx = x - t.cx, dy = y - t.cy;
    return [t.cx + t.cos * dx + t.sin * dy, t.cy - t.sin * dx + t.cos * dy];
  };
  const toCell = (w, x, y) => {
    if (w.turn) [x, y] = unturn(w, x, y);
    return [(x - w.rect[0]) / w.rect[2] * w.cols, (y - w.rect[1]) / w.rect[3] * w.rows];
  };
  const deltaToCell = (w, dx, dy) => {
    if (w.turn) [dx, dy] = [w.turn.cos * dx + w.turn.sin * dy, -w.turn.sin * dx + w.turn.cos * dy];
    return [dx / w.rect[2] * w.cols, dy / w.rect[3] * w.rows];
  };
  // n points in place (model space -> cells), as toCell does point by point
  const toCells = (w, a, o, n) => {
    const sx = w.cols, sy = w.rows, [x0, y0, ww, hh] = w.rect, t = w.turn;
    for (let k = o; k < o + 2 * n; k += 2) {
      let x = a[k], y = a[k + 1];
      if (t) { const dx = x - t.cx, dy = y - t.cy; x = t.cx + t.cos * dx + t.sin * dy; y = t.cy - t.sin * dx + t.cos * dy; }
      a[k] = (x - x0) / ww * sx; a[k + 1] = (y - y0) / hh * sy;
    }
  };
  // a point of the grid's own axes -> model space
  const turnPoint = (w, x, y) => {
    const t = w.turn;
    if (!t) return [x, y];
    const dx = x - t.cx, dy = y - t.cy;
    return [t.cx + t.cos * dx - t.sin * dy, t.cy + t.sin * dx + t.cos * dy];
  };
  // rest points: in model space, or in the parent's cells
  const wpoints = [];
  for (const w of warps) {
    w.firstPoint = wpoints.length / 2;
    for (let j = 0; j <= w.rows; j++) for (let i = 0; i <= w.cols; i++) {
      const [x, y] = turnPoint(w, w.rect[0] + w.rect[2] * i / w.cols, w.rect[1] + w.rect[3] * j / w.rows);
      wpoints.push(...(w.parent == null ? [x, y] : toCell(warps[w.parentIndex], x, y)));
    }
  }
  const WP = (id, where) => {
    if (!warpIndex.has(id)) fail(`${where}: unknown warp "${id}"`, 'unknownWarp', { id });
    return warpIndex.get(id);
  };

  // bones in warp grids (rotation deformers): roots only; nothing of theirs drives a constraint or a grid
  const boneWarps = [];
  const inGrid = new Set();
  order.forEach((b, i) => {
    at = `bones[${srcBoneAt.get(b)}]`;
    if (b.warp != null) {
      if (b.parent != null) fail(`bone "${b.id}": a bone in a warp grid has no parent bone`, 'warpBoneParent', { bone: b.id });
      const w = warps[WP(b.warp, `bone ${b.id}`)];
      // model space -> cells: (p - o) times a 2x2 (just the scale for a grid that is not turned)
      const sx = w.cols / w.rect[2], sy = w.rows / w.rect[3], t = w.turn;
      const [ox, oy] = turnPoint(w, w.rect[0], w.rect[1]);
      boneWarps.push(t ? { bone: i, warp: warpIndex.get(w.id), ox, oy, a: sx * t.cos, b: -sy * t.sin, c: sx * t.sin, d: sy * t.cos, rc: t.cos, rs: t.sin }
        : { bone: i, warp: warpIndex.get(w.id), ox, oy, a: sx, b: 0, c: 0, d: sy, rc: 1, rs: 0 });
      inGrid.add(i);
    } else if (b.parent != null && inGrid.has(boneIndex.get(b.parent))) inGrid.add(i);
  });
  at = 'constraints';
  for (const c of cons) {
    for (const k of [c.bone, c.bone2, c.target]) if (k >= 0 && inGrid.has(k)) fail(`bone "${bones[k].id}" is in a warp grid: constraints can't use it`, 'warpBoneConstraint', { bone: bones[k].id });
  }
  // swaying bone chains (0.6): root to tip, each bone the child of the one before
  const chains = [], chainBones = [];
  const inChain = new Set();
  for (const [ci, c] of (src.chains || []).entries()) {
    at = `chains[${ci}]`;
    const where = `chain ${c.id ?? '#' + ci}`;
    const list = (c.bones || []).map((id) => B(id, where));
    if (!list.length || list.length > 64) fail(`${where}: 1 to 64 bones`, 'chainBoneCount', { chain: c.id ?? '', max: 64 });
    list.forEach((b, k) => {
      if (k > 0 && bones[b].parent !== list[k - 1]) fail(`${where}: "${bones[b].id}" is not the child of "${bones[list[k - 1]].id}"`, 'chainNotChild', { bone: bones[b].id, parent: bones[list[k - 1]].id });
      if (inGrid.has(b)) fail(`${where}: "${bones[b].id}" is in a warp grid`, 'chainBoneInWarp', { bone: bones[b].id });
      if (inChain.has(b)) fail(`${where}: "${bones[b].id}" is already in a chain`, 'chainBoneTwice', { bone: bones[b].id });
      inChain.add(b);
    });
    const g = c.gravity ?? [0, 0];
    if (!Array.isArray(g) || g.length !== 2) fail(`${where}: "gravity" must be [x, y]`, 'chainGravity', { chain: c.id ?? '' });
    const stiffness = num(c.stiffness, 40, `${where}.stiffness`), damping = num(c.damping, 4, `${where}.damping`);
    if (stiffness < 0 || stiffness > 1e5 || damping < 0 || damping > 1e4) fail(`${where}: stiffness 0..100000, damping 0..10000`, 'chainParams', { chain: c.id ?? '' });
    chains.push({ id: c.id == null ? '' : String(c.id), firstBone: chainBones.length, boneCount: list.length, stiffness, damping,
      gx: num(g[0], 0, `${where}.gravity`), gy: num(g[1], 0, `${where}.gravity`),
      inertia: num(c.inertia, 1, `${where}.inertia`), mix: num(c.mix, 1, `${where}.mix`) });
    chainBones.push(...list);
    const tip = bones[list[list.length - 1]];
    if (!tip.length) warn('chainTipNoLength', { chain: c.id ?? `#${ci}`, bone: tip.id }, `the last bone "${tip.id}" has no length: it has no tip to swing`);
  }
  at = 'constraints';
  for (const c of cons) {
    for (const k of [c.bone, c.bone2]) if (k >= 0 && inChain.has(k)) fail(`bone "${bones[k].id}" sways in a chain: constraints can't move it`, 'chainBoneConstraint', { bone: bones[k].id });
  }
  at = 'warps';
  for (const w of warps) if (w.parent == null && inGrid.has(w.bone)) fail(`warp "${w.id}": its bone "${bones[w.bone].id}" is in a warp grid`, 'warpOnWarpBone', { warp: w.id, bone: bones[w.bone].id });

  lap('colors+warps+chains');
  // parts -> one vertex/index stream in draw order
  const parts = [];
  const partIndex = new Map();
  // sized up front (typed arrays: no growing, no garbage); a part that does not fit fails below anyway
  at = 'parts';
  if (src.parts && !Array.isArray(src.parts)) fail('"parts" must be a list', 'notList', { field: 'parts' });
  let maxVerts = 0, maxIndices = 0;
  for (const part of src.parts || []) {
    maxVerts += Math.max(0, ((part?.vertices || []).length >> 1) || 0);
    maxIndices += Math.max(0, (part?.triangles || []).length || 0);
  }
  const posAll = new Float64Array(2 * maxVerts), uvAll = new Float64Array(2 * maxVerts);
  const vpartsAll = new Uint32Array(maxVerts), indicesAll = new Uint32Array(maxIndices);
  let nVerts = 0, nIndices = 0;
  const xstart = [0], xweights = []; // influences beyond the strongest four
  const vInfl = [];                   // per vertex: [[bone, weight], ...], weights summing to 1
  for (const [pi, part] of (src.parts || []).entries()) {
    at = `parts[${pi}]`;
    if (!part.id) fail(`part #${pi} has no id`, 'missingId', { kind: 'part', index: pi });
    if (partIndex.has(part.id)) fail(`duplicate part id "${part.id}"`, 'duplicateId', { kind: 'part', id: part.id });
    const v = part.vertices || [], t = part.uvs || [], tri = part.triangles || [];
    const n = v.length / 2;
    if (!Number.isInteger(n) || t.length !== v.length) fail(`part ${part.id}: vertices/uvs length mismatch`, 'uvLengthMismatch', { part: part.id });
    if (tri.length % 3) fail(`part ${part.id}: triangles length must be a multiple of 3`, 'trianglesLength', { part: part.id });
    const firstVert = nVerts, firstIndex = nIndices;
    const warp = part.warp === undefined ? null : warps[WP(part.warp, `part ${part.id}`)];
    if (warp && (part.bone !== undefined || part.weights)) fail(`part ${part.id}: a part in a warp grid has no bone or weights`, 'warpPartBone', { part: part.id });
    const vWhat = `${part.id}.vertices`, uWhat = `${part.id}.uvs`, where = `part ${part.id}`;
    if (firstVert + n > maxVerts || firstIndex + tri.length > maxIndices) fail(`part ${part.id}: bad vertices or triangles`, 'partMesh', { part: part.id });
    const o0 = 2 * firstVert;
    readNumbers(v, posAll, o0, 2 * n, vWhat);
    readNumbers(t, uvAll, o0, 2 * n, uWhat);
    // in a warp: its cell coordinates; its box in the model (the rest pose) kept for sharing mask channels
    let restBox = null;
    if (warp) {
      restBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = o0; k < o0 + 2 * n; k += 2) {
        restBox[0] = Math.min(restBox[0], posAll[k]); restBox[1] = Math.min(restBox[1], posAll[k + 1]);
        restBox[2] = Math.max(restBox[2], posAll[k]); restBox[3] = Math.max(restBox[3], posAll[k + 1]);
      }
      toCells(warp, posAll, o0, n);
    }
    nVerts += n;
    vpartsAll.fill(pi, firstVert, nVerts);
    const oneBone = part.weights ? null : [[B(part.bone ?? bones[0].id, where), 1]]; // shared: never changed in place
    readPartInfluences(vInfl, n, oneBone, part.weights, B, where); // written out after glue (below)
    const tr = readTriangles(tri, n, firstVert, indicesAll, nIndices);
    if (tr.end === undefined) fail(`part ${part.id}: triangle index ${tr.bad} out of range`, 'triangleOutOfRange', { part: part.id, index: tr.bad });
    nIndices = tr.end;
    const texture = part.texture ?? 0;
    if (textures.length && !(texture >= 0 && texture < textures.length)) fail(`part ${part.id}: bad texture`, 'badTexture', { part: part.id });
    const blend = BLEND[part.blend ?? 'normal'];
    if (blend === undefined) fail(`part ${part.id}: unknown blend "${part.blend}"`, 'unknownBlend', { part: part.id, value: String(part.blend) });
    if (part.mask !== undefined && (!Array.isArray(part.mask) || !part.mask.length)) fail(`part ${part.id}: "mask" must be a list of part ids`, 'maskList', { part: part.id });
    if (!tri.length) warn('partNoTriangles', { part: part.id }, 'this part has no triangles: nothing of it is drawn');
    if (warp) { // vertices far outside their grid only follow the edge's slope
      const out = countOutside(posAll, firstVert, n, warp.cols, warp.rows);
      if (n && out > n / 4) warn('partOutsideWarp', { part: part.id, warp: warp.id, outside: out, total: n }, `${out} of ${n} vertices lie outside warp grid "${warp.id}" (they only continue along the edge)`);
    }
    parts.push({
      id: part.id, firstVert, vertCount: n, firstIndex, indexCount: nIndices - firstIndex,
      opacity: num(part.opacity, 1, `${part.id}.opacity`), blend, texture,
      maskIds: part.mask, mask: NO_REGION,
      flags: (part.maskInvert ? PART_MASK_INVERT : 0) | (part.maskOnly ? PART_HIDDEN : 0) | (part.solid ? PART_SOLID : 0),
      color: part.color === undefined ? NO_REGION : CL(part.color, `part ${part.id}`),
      warp: warp ? warpIndex.get(warp.id) : NO_REGION,
      order: orderValue(part.order, ORDER_DEFAULT, `${part.id}.order`),
      restBox, // (not written: assignMaskChannels)
    });
    partIndex.set(part.id, pi);
  }
  const nv = nVerts;
  const pos = posAll.subarray(0, 2 * nv), uv = uvAll.subarray(0, 2 * nv), vparts = vpartsAll.subarray(0, nv), indices = indicesAll.subarray(0, nIndices);
  const PT = (id, where) => {
    if (!partIndex.has(id)) fail(`${where}: unknown part "${id}"`, 'unknownPart', { id });
    return partIndex.get(id);
  };

  lap('parts');
  // masks: one record per distinct set of mask parts, then a channel for each
  const masks = [], maskRefs = [], maskKey = new Map(), inSomeMask = new Set();
  for (const [pi, part] of parts.entries()) {
    if (!part.maskIds) continue;
    at = `parts[${pi}].mask`;
    const list = [...new Set(part.maskIds.map((id) => PT(id, `part ${part.id} mask`)))].sort((a, b) => a - b);
    if (list.includes(pi)) warn('partInOwnMask', { part: part.id }, `part ${part.id} is in its own mask`);
    for (const k of list) inSomeMask.add(k);
    const key = list.join(',');
    if (!maskKey.has(key)) {
      maskKey.set(key, masks.length);
      masks.push({ firstRef: maskRefs.length, refCount: list.length, channel: 0, parts: list, users: [] });
      maskRefs.push(...list);
    }
    part.mask = maskKey.get(key);
    masks[part.mask].users.push(parts.indexOf(part));
  }
  parts.forEach((p, pi) => {
    if (p.flags & PART_HIDDEN && !inSomeMask.has(pi)) warn('maskPartHiddenOnly', { part: p.id }, `part ${p.id} is only drawn into masks (maskOnly), but no part uses it as a mask`, `parts[${pi}]`);
  });
  at = 'parts';
  assignMaskChannels(masks, parts, pos);

  lap('masks');
  // deformers -> regions, morphs (one per deformer with morphs), drivers
  const regions = [];
  const regionKey = new Map();
  const region = (spec, where) => {
    const axes = Object.entries(spec || {});
    if (axes.length > 4) fail(`${where}: a region can use at most 4 parameters`, 'regionTooManyAxes', { max: 4 });
    const list = axes.map(([id, r]) => {
      if (!Array.isArray(r) || r.length !== 3) fail(`${where}: region "${id}" must be [start, peak, end]`, 'regionShape', { param: id });
      const [s, p, e] = r.map((x) => num(x, 0, `${where}.region`));
      if (!(s <= p && p <= e)) fail(`${where}: region "${id}" needs start <= peak <= end`, 'regionBadOrder', { param: id });
      const pr = params[P(id, where)];
      if ((e <= pr.min && p < pr.min) || (s >= pr.max && p > pr.max)) warn('regionOutOfRange', { param: id, start: s, peak: p, end: e, min: pr.min, max: pr.max }, `region "${id}" [${s}, ${p}, ${e}] is outside the parameter's range ${pr.min}..${pr.max}: it never takes effect`);
      return [P(id, where), s, p, e];
    });
    const key = JSON.stringify(list);
    if (!regionKey.has(key)) { regionKey.set(key, regions.length); regions.push(list); }
    return regionKey.get(key);
  };
  const morphs = [];                         // region index per morph
  const morphIndex = new Map();              // deformer id -> morph
  // per vertex, flat: morph, dx, dy, ... in morph order (morphs are numbered as they are read)
  const NO_DELTAS = []; // shared by the vertices no morph moves (most of them); never filled
  const perVertex = new Array(nv).fill(NO_DELTAS);
  const boneDrivers = [], opDrivers = [], colorDrivers = [], warpDrivers = [], wdeltas = [], orderDrivers = [];
  for (const [di, d] of (src.deformers || []).entries()) {
    const where = `deformer ${d.id ?? '#' + di}`;
    at = `deformers[${di}].region`;
    // without a region the deformer only moves when an animation keys it by id
    const r = d.region ? region(d.region, where) : NO_REGION;
    if (r === NO_REGION && (Object.keys(d.bones || {}).length || Object.keys(d.opacity || {}).length)) {
      fail(`${where}: bone and opacity changes need a region`, 'needsRegion', { deformer: d.id ?? '', kind: 'bone' });
    }
    if (r === NO_REGION && Object.keys(d.order || {}).length) fail(`${where}: draw order changes need a region`, 'needsRegion', { deformer: d.id ?? '', kind: 'order' });
    // constraints are not something a deformer moves: written there (meaning a parameter to move a constraint's mix),
    // they were read by nothing; their mix moves with an animation's constraint tracks
    const consHere = d.constraints && typeof d.constraints === 'object' ? (Array.isArray(d.constraints) ? d.constraints.map((c) => c?.id ?? c) : Object.keys(d.constraints)) : [];
    if (d.constraints !== undefined) {
      warn('deformerConstraints', { deformer: d.id ?? '', constraints: consHere.map(String).join(', ') },
        `constraints in a deformer are not read (${consHere.join(', ') || 'none'}): a constraint's mix moves with an animation's constraint tracks (animations[].constraints.<id>.mix, mixRotate, mixX ...), not with a parameter`,
        `deformers[${di}].constraints`);
    }
    if (!['morphs', 'bones', 'opacity', 'warps', 'colors', 'order'].some((k) => Object.keys(d[k] || {}).length) && d.constraints === undefined) warn('deformerEmpty', {}, 'this deformer changes nothing', `deformers[${di}]`);
    if (d.morphs && Object.keys(d.morphs).length) {
      const m = morphs.length;
      morphs.push(r);
      if (d.id !== undefined) {
        if (morphIndex.has(d.id)) fail(`duplicate deformer id "${d.id}"`, 'duplicateId', { kind: 'deformer', id: d.id });
        morphIndex.set(d.id, m);
      }
      for (const [pid, md] of Object.entries(d.morphs)) {
        at = `deformers[${di}].morphs.${pid}`;
        const part = parts[PT(pid, where)];
        const grid = part.warp !== NO_REGION ? warps[part.warp] : null;
        let moved = false;
        // px -> the grid's cells (as deltaToCell, without an array per delta)
        const gt = grid && grid.turn, gw = grid ? grid.rect[2] : 1, gh = grid ? grid.rect[3] : 1, gc = grid ? grid.cols : 1, gr = grid ? grid.rows : 1;
        const add = (local, dx, dy) => {
          if (!Number.isInteger(local) || local < 0 || local >= part.vertCount) fail(`${where}: vertex ${local} out of range in ${pid}`, 'vertexOutOfRange', { part: pid, vertex: local });
          if (dx === 0 && dy === 0) return;
          moved = true;
          if (grid) {
            if (gt) { const x = gt.cos * dx + gt.sin * dy, y = -gt.sin * dx + gt.cos * dy; dx = x; dy = y; }
            dx = dx / gw * gc; dy = dy / gh * gr;
          }
          let d = perVertex[part.firstVert + local];
          if (d === NO_DELTAS) perVertex[part.firstVert + local] = d = [];
          const k = d.length - 3;
          if (k >= 0 && d[k] === m) { d[k + 1] += dx; d[k + 2] += dy; } else d.push(m, 0 + dx, 0 + dy);
        };
        if (md.dense) {
          if (md.dense.length !== 2 * part.vertCount) fail(`${where}: dense deltas for ${pid} need 2 numbers per vertex`, 'deltaCount', { part: pid });
          addDense(md.dense, part.vertCount, add);
        } else {
          const vs = md.vertices || [], ds = md.deltas || [];
          if (ds.length !== 2 * vs.length) fail(`${where}: deltas for ${pid} need 2 numbers per listed vertex`, 'deltaCount', { part: pid });
          vs.forEach((vi, i) => add(vi, num(ds[2 * i], 0, 'delta'), num(ds[2 * i + 1], 0, 'delta')));
        }
        if (!moved) warn('morphZero', { part: pid }, `every delta for ${pid} is 0: this morph does not move it`);
      }
    }
    for (const [bid, bd] of Object.entries(d.bones || {})) {
      at = `deformers[${di}].bones.${bid}`;
      boneDrivers.push({
        region: r, bone: B(bid, where),
        drot: num(bd.rotation, 0, 'rotation') * DEG, dx: num(bd.x, 0, 'x'), dy: num(bd.y, 0, 'y'),
        dsx: num(bd.scaleX, 0, 'scaleX'), dsy: num(bd.scaleY, 0, 'scaleY'),
      });
    }
    for (const [pid, dop] of Object.entries(d.opacity || {})) {
      at = `deformers[${di}].opacity.${pid}`;
      opDrivers.push({ region: r, part: PT(pid, where), dop: num(dop, 0, 'opacity') });
    }
    // draw order: the value at the region's peak; the change from the part's own value is stored (0.8)
    for (const [pid, v] of Object.entries(d.order || {})) {
      at = `deformers[${di}].order.${pid}`;
      const k = PT(pid, where);
      orderDrivers.push({ region: r, part: k, d: orderValue(v, parts[k].order, 'order') - parts[k].order });
    }
    for (const [wid, wd] of Object.entries(d.warps || {})) {
      at = `deformers[${di}].warps.${wid}`;
      if (r === NO_REGION) fail(`${where}: warp changes need a region`, 'needsRegion', { deformer: d.id ?? '', kind: 'warp' });
      const w = warps[WP(wid, where)], np = (w.cols + 1) * (w.rows + 1), delta = new Array(2 * np).fill(0);
      if (wd.dense) {
        if (wd.dense.length !== 2 * np) fail(`${where}: dense deltas for warp ${wid} need 2 numbers per point (${np} points)`, 'warpDeltaCount', { warp: wid, points: np });
        for (let k = 0; k < 2 * np; k++) delta[k] = num(wd.dense[k], 0, 'delta');
      } else {
        const ps = wd.points || [], ds = wd.deltas || [];
        if (ds.length !== 2 * ps.length) fail(`${where}: deltas for warp ${wid} need 2 numbers per listed point`, 'warpDeltaCount', { warp: wid });
        ps.forEach((k, i) => {
          if (!Number.isInteger(k) || k < 0 || k >= np) fail(`${where}: point ${k} out of range in warp ${wid}`, 'warpPointOutOfRange', { warp: wid, point: k });
          delta[2 * k] += num(ds[2 * i], 0, 'delta'); delta[2 * k + 1] += num(ds[2 * i + 1], 0, 'delta');
        });
      }
      // a warp inside another moves in the parent's cells
      if (w.parent != null) for (let k = 0; k < np; k++) [delta[2 * k], delta[2 * k + 1]] = deltaToCell(warps[w.parentIndex], delta[2 * k], delta[2 * k + 1]);
      warpDrivers.push({ region: r, warp: warpIndex.get(w.id), firstDelta: wdeltas.length / 2 });
      wdeltas.push(...delta);
    }
    for (const [cid, cd] of Object.entries(d.colors || {})) {
      at = `deformers[${di}].colors.${cid}`;
      if (r === NO_REGION) fail(`${where}: color changes need a region`, 'needsRegion', { deformer: d.id ?? '', kind: 'color' });
      const slot = CL(cid, where), [an, bn] = COLOR_MODES[colors[slot].mode];
      for (const k of Object.keys(cd)) if (k !== an && k !== bn) fail(`${where}: color ${cid} has no "${k}" (it uses ${an} / ${bn})`, 'colorChannel', { color: cid, channel: k, a: an, b: bn });
      colorDrivers.push({ region: r, slot, da: rgb(cd[an], 0, `${where}.${an}`), db: rgb(cd[bn], 0, `${where}.${bn}`) });
    }
  }
  lap('deformers');
  // glue (no run-time cost): glued vertex pairs get the same morph deltas and bone weights,
  // each pulled toward a blend of the two by the glue's strength
  for (const [gi, g] of (src.glue || []).entries()) {
    at = `glue[${gi}]`;
    if (!Array.isArray(g.parts) || g.parts.length !== 2) fail('"parts" must name two parts', 'glueParts', {});
    const [pa, pb] = g.parts.map((id) => parts[PT(id, 'glue')]);
    if (pa.warp !== pb.warp) fail(`parts ${pa.id} and ${pb.id} must both be on bones or both in the same warp grid`, 'glueMixed', { partA: pa.id, partB: pb.id });
    const strength = num(g.strength, 1, 'strength'), bias = num(g.bias, 0.5, 'bias');
    if (!(strength >= 0 && strength <= 1 && bias >= 0 && bias <= 1)) fail('strength and bias must be 0..1', 'glueRange', {});
    for (const [k, pair] of (g.pairs || []).entries()) {
      if (!Array.isArray(pair) || pair.length !== 2) fail(`pairs[${k}] must be [vertex of ${pa.id}, vertex of ${pb.id}]`, 'gluePair', { partA: pa.id, partB: pb.id });
      const [ia, ib] = pair;
      if (!Number.isInteger(ia) || ia < 0 || ia >= pa.vertCount) fail(`pairs[${k}]: vertex ${ia} out of range in ${pa.id}`, 'vertexOutOfRange', { part: pa.id, vertex: ia });
      if (!Number.isInteger(ib) || ib < 0 || ib >= pb.vertCount) fail(`pairs[${k}]: vertex ${ib} out of range in ${pb.id}`, 'vertexOutOfRange', { part: pb.id, vertex: ib });
      const va = pa.firstVert + ia, vb = pb.firstVert + ib;
      { // glued points should sit together in the rest pose
        const sa = src.parts.find((q) => q.id === pa.id).vertices, sb = src.parts.find((q) => q.id === pb.id).vertices;
        const d = Math.hypot(sa[2 * ia] - sb[2 * ib], sa[2 * ia + 1] - sb[2 * ib + 1]);
        if (d > 1) warn('glueApart', { partA: pa.id, vertexA: ia, partB: pb.id, vertexB: ib, distance: +d.toFixed(1) }, `vertex ${ia} of ${pa.id} and vertex ${ib} of ${pb.id} are ${d.toFixed(1)} px apart in the rest pose`, `glue[${gi}].pairs[${k}]`);
      }
      // the shared motion: (1 - bias) of a's + bias of b's; each vertex moves strength of the way to it
      const mixMaps = (A, Bm, toward) => {
        const out = new Map();
        for (const m of new Set([...A.keys(), ...Bm.keys()])) {
          const a = A.get(m) || [0, 0], b = Bm.get(m) || [0, 0];
          const t = [(1 - bias) * a[0] + bias * b[0], (1 - bias) * a[1] + bias * b[1]], own = toward ? a : b;
          out.set(m, [own[0] + strength * (t[0] - own[0]), own[1] + strength * (t[1] - own[1])]);
        }
        return out;
      };
      const mixInfl = (A, Bl, toward) => {
        const w = new Map(), own = toward ? A : Bl, add = (list, f) => { for (const [b, x] of list) w.set(b, (w.get(b) || 0) + x * f); };
        add(own, 1 - strength);
        add(A, strength * (1 - bias)); add(Bl, strength * bias);
        return [...w.entries()].filter(([, x]) => x > 0).sort((x, y) => y[1] - x[1] || x[0] - y[0]);
      };
      const toMap = (d) => { const map = new Map(); for (let k = 0; k < d.length; k += 3) map.set(d[k], [d[k + 1], d[k + 2]]); return map; };
      const toFlat = (map) => [...map.entries()].sort((x, y) => x[0] - y[0]).flatMap(([m, [dx, dy]]) => [m, dx, dy]);
      const [A, Bm] = [toMap(perVertex[va]), toMap(perVertex[vb])];
      const [ma, mb] = [toFlat(mixMaps(A, Bm, true)), toFlat(mixMaps(A, Bm, false))];
      const [wa, wb] = [mixInfl(vInfl[va], vInfl[vb], true), mixInfl(vInfl[va], vInfl[vb], false)];
      perVertex[va] = ma; perVertex[vb] = mb; vInfl[va] = wa; vInfl[vb] = wb;
    }
  }
  const joints = new Uint16Array(4 * nv), weights = new Float64Array(4 * nv);
  splitInfluences(vInfl, joints, weights, xweights, xstart);
  at = '';
  const { csr, nEntries, entries } = packEntries(perVertex, nv); // entries flat: morph, dx, dy

  lap('glue');
  // physics
  const physics = [], physIn = [];
  for (const [i, ph] of (src.physics || []).entries()) {
    const where = `physics #${i}`;
    at = `physics[${i}]`;
    const firstInput = physIn.length;
    for (const [id, w] of Object.entries(ph.inputs || {})) physIn.push([P(id, where), num(w, 1, 'input weight')]);
    const out = P(ph.output, where);
    physics.push({
      firstInput, inputCount: physIn.length - firstInput, output: out,
      stiffness: num(ph.stiffness, 40, 'stiffness'), damping: num(ph.damping, 5, 'damping'),
      gain: num(ph.gain, 0.1, 'gain'),
      outMin: num(ph.min, params[out].min, 'min'), outMax: num(ph.max, params[out].max, 'max'),
    });
  }

  // expressions (0.8): parameter changes by name, the host fades them in and out
  at = 'expressions';
  let exprList;
  try { exprList = readExpressions(src.expressions); } catch (e) { at = e.path; fail(e.message.replace(/^ugo expressions: (\[[^\]]*\] )?/, ''), e.code, e.vars); }
  const expressions = [], exprItems = [];
  exprList.forEach((e, i) => {
    expressions.push({ id: e.id, firstItem: exprItems.length, itemCount: e.items.length, fadeIn: e.fadeIn, fadeOut: e.fadeOut });
    for (const [name, op, value] of e.items) {
      at = `expressions[${i}].params.${name}`;
      const k = P(name, `expression ${e.id}`);
      usedParams.add(name);
      exprItems.push([k, op, value]);
    }
  });
  at = '';

  lap('physics');
  // animations
  const anims = [], tracks = [], keys = [];
  const curveOf = new Map(); // key index -> its segment's curve { cx1, cy1, cx2, cy2 } (1.1)
  for (const [i, a] of (src.animations || []).entries()) {
    const where = `animation ${a.id ?? '#' + i}`;
    at = `animations[${i}]`;
    const firstTrack = tracks.length, firstKeyOfAnim = keys.length;
    let maxT = 0;
    const addTrack = (target, label, ks, scale = 1) => {
      if (!Array.isArray(ks) || !ks.length) fail(`${where}: track ${label} has no keys`, 'trackNoKeys', { anim: a.id ?? '', track: label });
      const firstKey = keys.length;
      let last = -Infinity;
      const raw = [];
      for (const k of ks) {
        const [t, v, mode = 'linear'] = k;
        if (!(mode in INTERP)) fail(`${where}: unknown interpolation "${mode}"`, 'unknownInterp', { anim: a.id ?? '', value: String(mode) });
        const time = num(t, 0, 'time');
        if (time < last) fail(`${where}: keys of ${label} must be sorted by time`, 'keysNotSorted', { anim: a.id ?? '', track: label });
        last = time;
        maxT = Math.max(maxT, time);
        const key = [time, num(v, 0, 'value') * scale, INTERP[mode]];
        if (mode === 'bezier') { // 1.1: the segment to the next key is a cubic Bezier (cx: its time fraction 0..1, cy: values)
          const h = [3, 4, 5, 6].map((j) => num(k[j], NaN, 'curve handle'));
          if (h.some((x) => Number.isNaN(x))) fail(`${where}: a bezier key of ${label} needs cx1, cy1, cx2, cy2`, 'curveHandles', { anim: a.id ?? '', track: label });
          let [cx1, cy1, cx2, cy2] = h;
          if (cx1 < 0 || cx1 > 1 || cx2 < 0 || cx2 > 1) {
            warn('curveHandleClamped', { anim: a.id ?? `#${i}`, track: label, time }, `a curve of ${label} at ${time} s has a time handle outside its segment: kept inside (0..1)`);
            cx1 = Math.min(1, Math.max(0, cx1)); cx2 = Math.min(1, Math.max(0, cx2));
          }
          key.push({ cx1, cy1: cy1 * scale, cx2, cy2: cy2 * scale });
        }
        raw.push(key);
      }
      // 1.1: straight lines between keys, or a curve (tables 41-43) the core cuts into pieces at load;
      // a step holds its value up to the next key (a second key there); a smooth piece among straight
      // ones becomes short straight ones within about one 16-bit value step of its curve (as in 0.7: a
      // curve would follow the keys' times as rounded to ticks, a step or two away from the editor's)
      // a track whose moving pieces are all smooth is marked eased instead (no curves)
      let lo0 = Infinity, hi0 = -Infinity;
      for (const [, v] of raw) { lo0 = Math.min(lo0, v); hi0 = Math.max(hi0, v); }
      const tol = Math.max((hi0 - lo0) / 65535, 1e-9);
      const moving = raw.slice(0, -1).filter((k, j) => k[2] !== INTERP.step && raw[j + 1][1] !== k[1]);
      const eased = moving.length > 0 && moving.every((k) => k[2] === INTERP.smooth);
      for (let k = 0; k < raw.length; k++) {
        const [t0, v0, interp, bez] = raw[k], next = raw[k + 1];
        keys.push([t0, v0]);
        if (!next) break;
        if (interp === INTERP.step) { if (next[1] !== v0) keys.push([next[0], v0]); continue; }
        if (!(next[0] > t0)) continue;
        if (interp === INTERP.smooth && !eased && next[1] !== v0) {
          // smoothstep's bend is at most 6 * |dv|: n pieces stay within 0.75 * |dv| / n^2
          const n = Math.min(256, Math.max(2, Math.ceil(Math.sqrt(0.75 * Math.abs(next[1] - v0) / tol))));
          for (let s = 1; s < n; s++) { const f = s / n; keys.push([t0 + (next[0] - t0) * f, v0 + (next[1] - v0) * f * f * (3 - 2 * f)]); }
        } else if (interp === INTERP.bezier) curveOf.set(keys.length - 1, bez);
      }
      const curved = (j) => curveOf.has(j) && (curveOf.get(j).cy1 !== keys[j][1] || curveOf.get(j).cy2 !== keys[j + 1][1]);
      // a track whose keys all hold the same value (and no curve leaves it) has no keys: its value is kept in the track (0.7)
      let flat = true;
      for (let j = firstKey; j < keys.length && flat; j++) flat = keys[j][1] === keys[firstKey][1] && !curved(j);
      if (flat) {
        const v = keys[firstKey][1];
        for (let j = firstKey; j < keys.length; j++) curveOf.delete(j);
        keys.length = firstKey;
        tracks.push([target, 0, 1, v, 0]);
        return;
      }
      // the others keep 16-bit values between their smallest and largest, curve handles included (0.7, 1.1)
      let lo = Infinity, hi = -Infinity;
      for (let j = firstKey; j < keys.length; j++) {
        lo = Math.min(lo, keys[j][1]); hi = Math.max(hi, keys[j][1]);
        const c = curveOf.get(j);
        if (c) { lo = Math.min(lo, c.cy1, c.cy2); hi = Math.max(hi, c.cy1, c.cy2); }
      }
      tracks.push([(eased ? target | 0x80000000 : target) >>> 0, firstKey, keys.length - firstKey, lo, (hi - lo) / 65535]);
    };
    const target = (kind, index) => (TRACK_KIND[kind] * 0x1000000 + index) >>> 0;
    for (const [id, ks] of Object.entries(a.tracks || {})) {
      at = `animations[${i}].tracks.${id}`;
      const pr = params[P(id, where)];
      addTrack(target('param', P(id, where)), id, ks);
      const k = ks.find((k) => k[1] < pr.min || k[1] > pr.max); // the run time clamps it to the range
      if (k) warn('keyOutOfRange', { anim: a.id ?? `#${i}`, param: id, time: k[0], value: k[1], min: pr.min, max: pr.max },
        `a key of ${id} at ${k[0]} s is ${k[1]}, outside the parameter's range ${pr.min}..${pr.max}`);
    }
    // bone tracks are offsets from the rest pose (rotate in degrees, scale added to the rest scale)
    for (const [bid, props] of Object.entries(a.bones || {})) {
      for (const [prop, ks] of Object.entries(props)) {
        at = `animations[${i}].bones.${bid}.${prop}`;
        if (!['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY'].includes(prop)) fail(`${where}: unknown bone track "${prop}"`, 'unknownTrack', { anim: a.id ?? '', value: prop });
        addTrack(target(prop, B(bid, where)), `${bid}.${prop}`, ks, prop === 'rotate' || prop.startsWith('shear') ? DEG : 1);
      }
    }
    for (const [pid, ks] of Object.entries(a.opacity || {})) { at = `animations[${i}].opacity.${pid}`; addTrack(target('opacity', PT(pid, where)), `${pid}.opacity`, ks); }
    // draw order values over time (0.8; they replace the part's own, as opacity does)
    for (const [pid, ks] of Object.entries(a.order || {})) {
      at = `animations[${i}].order.${pid}`;
      if (Array.isArray(ks)) ks.forEach((k, j) => { if (Array.isArray(k)) orderValue(k[1], 0, `${pid}.order key ${j}`); });
      addTrack(target('order', PT(pid, where)), `${pid}.order`, ks);
    }
    // constraint mixes (and IK bend direction, +1 / -1) over time
    for (const [cid, props] of Object.entries(a.constraints || {})) {
      at = `animations[${i}].constraints.${cid}`;
      const info = consRecords.get(cid);
      if (!info) fail(`${where}: unknown constraint "${cid}"`, 'unknownConstraint', { anim: a.id ?? '', id: cid });
      for (const [prop, ks] of Object.entries(props)) {
        at = `animations[${i}].constraints.${cid}.${prop}`;
        const ok = info.type === 'ik' ? ['mix', 'bend'].includes(prop) : prop.startsWith('mix') && prop !== 'mix';
        if (!ok || !(prop in CONS_CHANNEL)) fail(`${where}: constraint ${cid} has no "${prop}" track`, 'unknownTrack', { anim: a.id ?? '', value: prop });
        for (const r of info.records) addTrack(target('constraint', r * 8 + CONS_CHANNEL[prop]), `${cid}.${prop}`, ks);
      }
    }
    // colours: [[time, [r, g, b], interp], ...] -> one track per channel
    for (const [cid, props] of Object.entries(a.colors || {})) {
      at = `animations[${i}].colors.${cid}`;
      const slot = CL(cid, where), [an, bn] = COLOR_MODES[colors[slot].mode];
      for (const [prop, ks] of Object.entries(props)) {
        at = `animations[${i}].colors.${cid}.${prop}`;
        if (prop !== an && prop !== bn) fail(`${where}: color ${cid} has no "${prop}" track (it uses ${an} / ${bn})`, 'colorChannel', { color: cid, channel: prop, a: an, b: bn });
        if (!Array.isArray(ks)) fail(`${where}: track ${cid}.${prop} has no keys`, 'trackNoKeys', { anim: a.id ?? '', track: `${cid}.${prop}` });
        for (let ch = 0; ch < 3; ch++) {
          const keysCh = ks.map((k) => {
            if (!Array.isArray(k) || !Array.isArray(k[1]) || k[1].length !== 3) fail(`${where}: ${cid}.${prop} keys are [time, [r, g, b], interp]`, 'colorKeys', { anim: a.id ?? '', track: `${cid}.${prop}` });
            return [k[0], k[1][ch], ...k.slice(2)];
          });
          addTrack(target('color', slot * 8 + (prop === an ? 0 : 3) + ch), `${cid}.${prop}`, keysCh);
        }
      }
    }
    for (const [mid, ks] of Object.entries(a.morphs || {})) {
      at = `animations[${i}].morphs.${mid}`;
      if (!morphIndex.has(mid)) fail(`${where}: no deformer with morphs has id "${mid}"`, 'unknownMorph', { anim: a.id ?? '', id: mid });
      addTrack(target('morph', morphIndex.get(mid)), mid, ks);
    }
    at = `animations[${i}].duration`;
    const duration = num(a.duration, maxT, 'duration');
    // tracks target different things, so their order is free: group them by kind, single keys
    // first, so the runtime's branches are predictable
    const mine = tracks.splice(firstTrack).sort((x, y) => ((x[0] >>> 24) & 0x7f) - ((y[0] >>> 24) & 0x7f) || (x[2] > 1) - (y[2] > 1) || x[0] - y[0]);
    tracks.push(...mine);
    // key times are kept in 16-bit ticks of the animation's last key time (0.7)
    const tick = Math.fround(maxT > 0 ? maxT / KEY_TICKS : 1);
    anims.push({ id: a.id || `anim${i}`, duration, loop: a.loop === false ? 0 : 1, firstTrack, trackCount: tracks.length - firstTrack, tick, firstKey: firstKeyOfAnim, keyEnd: keys.length });
  }

  params.forEach((p, i) => { if (!usedParams.has(p.id)) warn('paramUnused', { param: p.id }, `parameter ${p.id} is not used by any region, physics or animation`, `parameters[${i}]`); });
  if (options.warnings) {
    const usedTex = new Set(parts.map((p) => p.texture));
    textures.forEach((t, i) => { if (!usedTex.has(i)) warn('textureUnused', { texture: String(t) }, `texture ${t} is not used by any part`, `textures[${i}]`); });
    const warpUsed = new Set();
    for (const p of parts) if (p.warp !== NO_REGION) warpUsed.add(p.warp);
    for (const w of warps) if (w.parentIndex !== NO_REGION) warpUsed.add(w.parentIndex);
    for (const q of boneWarps) warpUsed.add(q.warp);
    (src.warps || []).forEach((w, i) => { if (!warpUsed.has(warpIndex.get(w.id))) warn('warpEmpty', { warp: w.id }, `warp grid ${w.id} has no parts, grids or bones in it`, `warps[${i}]`); });
    // bones nothing hangs on: no part, child, constraint, grid or chain (tips and helpers are often fine)
    const boneUsed = new Set();
    for (const infl of vInfl) for (const [b] of infl) boneUsed.add(b);
    for (const b of bones) if (b.parent >= 0) boneUsed.add(b.parent);
    for (const c of cons) for (const k of [c.bone, c.bone2, c.target]) if (k >= 0) boneUsed.add(k);
    for (const w of warps) if (w.parentIndex === NO_REGION && w.bone >= 0) boneUsed.add(w.bone);
    for (const b of chainBones) boneUsed.add(b);
    for (const q of boneWarps) boneUsed.add(q.bone);
    bones.forEach((b, k) => {
      if (!boneUsed.has(k)) warn('boneUnused', { bone: b.id }, `bone ${b.id} moves nothing (no part, child bone, constraint, grid or chain uses it)`,
        `bones[${(src.bones || []).findIndex((x) => x.id === b.id)}]`, 'info');
    });
  }
  at = '';
  lap('animations');
  if (options.checkOnly) return null; // every check has run: errors thrown, warnings filled
  // names into the string table (in a fixed order so output is stable)
  params.forEach((p) => { p.name = str(p.id); });
  bones.forEach((b) => { b.name = str(b.id); });
  parts.forEach((p) => { p.name = str(p.id); });
  const textureNames = textures.map((t) => str(t));
  anims.forEach((a) => { a.name = str(a.id); });
  warps.forEach((w) => { w.name = str(w.id); });
  chains.forEach((c) => { c.name = str(c.id); });
  expressions.forEach((e) => { e.name = str(e.id); });

  // ---- write ------------------------------------------------------------
  // draw order values (0.8): only when a part has its own, or something changes them
  const orderTracks = tracks.some((t) => ((t[0] >>> 24) & 0x7f) === TRACK_KIND.order);
  const orders = parts.some((p) => p.order !== ORDER_DEFAULT) || orderDrivers.length || orderTracks ? parts.map((p) => p.order) : [];
  // tests only: what a later 1.x might add (a newer minor, header fields, tables and track kinds this
  // version does not know), to check that a core reads files newer than itself
  const future = options.future || {};
  for (const t of future.tracks || []) { // appended to the last animation: [kind, index, value]
    if (!anims.length) fail('internal: future tracks need an animation', 'internal', {});
    tracks.push([((t.kind * 0x1000000) + (t.index || 0)) >>> 0, 0, 1, t.value ?? 0, 0]);
    anims[anims.length - 1].trackCount++;
  }
  // 1.1: tracks and keys as tables 41-43 (curve keys). The keys in 16 bits, each curve's handles in the
  // same units; the pieces the core cuts a curve into: the fewest within about the import's tolerance
  const keyWords = encodeKeys(anims, tracks, keys);
  const qkeys = keys.map((_, j) => [keyWords[2 * j], keyWords[2 * j + 1]]);
  // a curve the core's pieces cannot follow within the tolerance (a swing of hundreds of degrees in a
  // few hundredths of a second) is cut into straight keys here instead, as many as the tolerance needs
  const curveList = [], tracks2 = [], keys2 = [];
  let bakedCurves = 0;
  tracks.forEach(([target, k0, n, base, step], ti) => {
    if (n < 2) { tracks2.push([target, 0, n, base, step]); return; }
    const b = Math.fround(base), st = Math.fround(step), q = (v) => (st > 0 ? Math.min(65535, Math.max(0, Math.round((v - b) / st))) : 0);
    const kind = (target >>> 24) & 0x7f;
    // the tolerance: 0.05° for angles and 0.05 px for moves (as the Spine import's, P1), half a draw
    // order step, a thousandth of a parameter's range, a thousandth for the rest (opacity, morphs,
    // mixes). It sets only how many pieces the core makes at load, not the file's size
    const tol = kind === TRACK_KIND.rotate || kind === TRACK_KIND.shearX || kind === TRACK_KIND.shearY ? 0.05 * DEG
      : kind === TRACK_KIND.x || kind === TRACK_KIND.y ? 0.05
        : kind === TRACK_KIND.order ? 0.5
          : kind === TRACK_KIND.param ? 1e-3 * Math.max(1e-9, params[target & 0xffffff].max - params[target & 0xffffff].min) : 1e-3;
    const units = Math.max(1, st > 0 ? tol / st : 1);
    const first = keys2.length;
    for (let k = 0; k < n; k++) {
      const A = qkeys[k0 + k];
      keys2.push(A);
      const c = curveOf.get(k0 + k);
      if (!c || k === n - 1) continue;
      const B = qkeys[k0 + k + 1];
      if (!(B[0] > A[0])) continue; // no time between them: nothing to bend
      const h = { cx1: Math.round(c.cx1 * 65535), cy1: q(c.cy1), cx2: Math.round(c.cx2 * 65535), cy2: q(c.cy2) };
      const fit = fewestPieces(A, B, h, units);
      if (fit.ok) { curveList.push({ track: tracks2.length, key: keys2.length - 1 - first, n: fit.n, ...h }); continue; }
      bakedCurves++;
      // the exact curve at a time (in ticks), then halves of the segment until straight pieces are within the tolerance
      const at = (tq) => { let lo = 0, hi = 1; for (let it = 0; it < 48; it++) { const m = (lo + hi) / 2; if (curveAt(A, B, h, m)[0] < tq) lo = m; else hi = m; } return curveAt(A, B, h, (lo + hi) / 2)[1]; };
      const cut = (t0, v0, t1, v1, depth) => {
        if (t1 - t0 < 2 || depth > 16) return;
        const tm = Math.round((t0 + t1) / 2), vm = at(tm);
        if (Math.abs(vm - (v0 + ((v1 - v0) * (tm - t0)) / (t1 - t0))) <= units) {
          // also a quarter of the way on each side (an S-shaped piece can cross the line at its middle)
          const q1 = Math.round((t0 + tm) / 2), q3 = Math.round((tm + t1) / 2);
          if (Math.abs(at(q1) - (v0 + ((v1 - v0) * (q1 - t0)) / (t1 - t0))) <= units && Math.abs(at(q3) - (v0 + ((v1 - v0) * (q3 - t0)) / (t1 - t0))) <= units) return;
        }
        cut(t0, v0, tm, vm, depth + 1);
        keys2.push([tm, Math.min(65535, Math.max(0, Math.round(vm)))]);
        cut(tm, vm, t1, v1, depth + 1);
      };
      cut(A[0], A[1], B[0], B[1], 0);
    }
    tracks2.push([target, first, keys2.length - first, base, step]);
  });
  if (bakedCurves) warn('curveBaked', { curves: bakedCurves }, `${bakedCurves} curve(s) too steep for the player's pieces: written as straight keys`, '', 'info');
  const packed = packTracks(tracks2, keys2, curveList);
  // a model without curves stays 1.0 (tables 21-22: a 1.0 core reads it); options.curveKeys false writes
  // 1.0 always, each curve cut into the pieces a 1.1 core makes of it at load (the same keys, bit for
  // bit), for players of 1.0 and for comparing the two
  const as10 = options.curveKeys === false || !packed.curves.length ? expandTracks(packed.tracks11, packed.words, packed.curves) : null;
  // the tables in the order they are written: [kind, record count, record size]
  const layout = [
    [TABLE_KIND.params, params.length, 16], [TABLE_KIND.bones, bones.length, 68], [TABLE_KIND.constraints, cons.length, 68],
    [TABLE_KIND.parts, parts.length, 48], [TABLE_KIND.textures, textures.length, 4],
    [TABLE_KIND.positions, nv, 8], [TABLE_KIND.uvs, nv, 8], [TABLE_KIND.joints, nv, 8], [TABLE_KIND.weights, nv, 16],
    [TABLE_KIND.vertexParts, nv, 4], [TABLE_KIND.entryStarts, nv + 1, 4], [TABLE_KIND.entries, nEntries, 12],
    [TABLE_KIND.indices, indices.length, 4], [TABLE_KIND.regions, regions.length, 68], [TABLE_KIND.morphs, morphs.length, 4],
    [TABLE_KIND.boneDrivers, boneDrivers.length, 28], [TABLE_KIND.opacityDrivers, opDrivers.length, 12],
    [TABLE_KIND.physics, physics.length, 32], [TABLE_KIND.physicsInputs, physIn.length, 8], [TABLE_KIND.animations, anims.length, 24],
    ...(as10 ? [[TABLE_KIND.tracks, as10.tracks.length, 20], [TABLE_KIND.keys, as10.keys.length, 4]]
      : [[TABLE_KIND.tracks11, packed.tracks11.length, 12], [TABLE_KIND.keys11, packed.words.length, 4], [TABLE_KIND.keyCurves, packed.curves.length, 16]]),
    [TABLE_KIND.masks, masks.length, 12], [TABLE_KIND.maskParts, maskRefs.length, 4], [TABLE_KIND.colors, colors.length, 32],
    [TABLE_KIND.colorDrivers, colorDrivers.length, 32], [TABLE_KIND.extraStarts, nv + 1, 4], [TABLE_KIND.extraWeights, xweights.length, 8],
    [TABLE_KIND.warps, warps.length, 24], [TABLE_KIND.warpPoints, wpoints.length / 2, 8], [TABLE_KIND.warpDrivers, warpDrivers.length, 12],
    [TABLE_KIND.warpDeltas, wdeltas.length / 2, 8], [TABLE_KIND.boneWarps, boneWarps.length, 40], [TABLE_KIND.chains, chains.length, 36],
    [TABLE_KIND.chainBones, chainBones.length, 4], [TABLE_KIND.orders, orders.length, 4], [TABLE_KIND.orderDrivers, orderDrivers.length, 12],
    [TABLE_KIND.expressions, expressions.length, 20], [TABLE_KIND.expressionItems, exprItems.length, 12],
    [TABLE_KIND.strings, stringBytes, 1],
  ];
  const extra = (future.tables || []).map((t) => ({ ...t, bytes: t.bytes || new Uint8Array((t.count || 0) * (t.recSize || 4)) }));
  const headerSize = HEADER_SIZE + (future.headerExtra || 0);
  const toc = layout.filter(([, n]) => n > 0); // (absent tables have no records)
  const start = headerSize + TOC_ENTRY * (toc.length + extra.length);
  const body = layout.reduce((a, [, n, size]) => a + n * size, 0);
  const extraAt = (start + body + 3) & ~3;
  const total = (extraAt + extra.reduce((a, t) => a + ((t.bytes.length + 3) & ~3), 0) + 3) & ~3;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 0;
  const U32 = (v) => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const I32 = (v) => { dv.setInt32(o, v, true); o += 4; };
  const F32 = (v) => { dv.setFloat32(o, v, true); o += 4; };
  // whole arrays at once through typed views (the same bytes as U32 / F32 one by one)
  const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const bulk = (Type, put, size) => (arr) => {
    if (LE && o % size === 0) { new Type(buf, o, arr.length).set(arr); o += size * arr.length; } else arr.forEach(put);
  };
  const U32s = bulk(Uint32Array, U32, 4), F32s = bulk(Float32Array, F32, 4);
  const U16s = bulk(Uint16Array, (v) => { dv.setUint16(o, v, true); o += 2; }, 2);

  // header (1.0): magic, version, file size, header size, canvas, contents count, flags
  u8.set([0x55, 0x47, 0x4f, 0x39], 0); // "UGO9"
  dv.setUint16(4, VERSION_MAJOR, true);
  dv.setUint16(6, future.minor ?? (as10 ? 0 : VERSION_MINOR), true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, headerSize, true);
  o = 16;
  F32(num(canvas.width, 512, 'canvas.width'));
  F32(num(canvas.height, 512, 'canvas.height'));
  F32(num(canvas.originX, 0, 'canvas.originX'));
  F32(num(canvas.originY, 0, 'canvas.originY'));
  U32(toc.length + extra.length);
  U32(0); // flags (reserved)
  // table of contents: kind, offset, count, record size | flags << 16, in the order written
  o = headerSize;
  if (toc.length + extra.length > TOC_MAX) fail('internal: too many tables', 'internal', {});
  let tableAt = start;
  for (const [kind, n, size] of layout) {
    if (n > 0) { U32(kind); U32(tableAt); U32(n); U32(size | (TOC_NEED << 16)); }
    tableAt += n * size;
  }
  let xat = extraAt;
  for (const t of extra) { U32(t.kind); U32(t.count ? xat : 0); U32(t.count || 0); U32((t.recSize || 4) | ((t.flag || 0) << 16)); xat += (t.bytes.length + 3) & ~3; }
  o = start;

  for (const p of params) { F32(p.min); F32(p.def); F32(p.max); U32(p.name); }
  for (const b of bones) {
    I32(b.parent); F32(b.x); F32(b.y); F32(b.rot); F32(b.sx); F32(b.sy); U32(b.name); b.bindInv.forEach(F32);
    F32(b.shx); F32(b.shy); F32(b.length); U32(b.inherit);
  }
  for (const c of cons) { U32(c.type); U32(c.flags); I32(c.bone); I32(c.bone2); I32(c.target); c.mix.forEach(F32); c.off.forEach(F32); }
  for (const p of parts) {
    U32(p.firstVert); U32(p.vertCount); U32(p.firstIndex); U32(p.indexCount); F32(p.opacity); U32(p.blend); U32(p.texture); U32(p.name);
    U32(p.mask); U32(p.flags); U32(p.color); U32(p.warp);
  }
  textureNames.forEach(U32);
  F32s(pos);
  F32s(uv);
  U16s(joints);
  F32s(weights);
  U32s(vparts);
  U32s(csr);
  if (LE && o % 4 === 0) { // interleaved: morph (u32), dx, dy (f32)
    writeEntries(buf, o, entries);
    o += 4 * entries.length;
  } else for (let k = 0; k < entries.length; k += 3) { U32(entries[k]); F32(entries[k + 1]); F32(entries[k + 2]); }
  U32s(indices);
  for (const axes of regions) {
    U32(axes.length);
    for (let i = 0; i < 4; i++) {
      const a = axes[i] || [0, 0, 0, 0];
      U32(a[0]); F32(a[1]); F32(a[2]); F32(a[3]);
    }
  }
  morphs.forEach(U32);
  for (const d of boneDrivers) { U32(d.region); U32(d.bone); F32(d.drot); F32(d.dx); F32(d.dy); F32(d.dsx); F32(d.dsy); }
  for (const d of opDrivers) { U32(d.region); U32(d.part); F32(d.dop); }
  for (const p of physics) { U32(p.firstInput); U32(p.inputCount); U32(p.output); F32(p.stiffness); F32(p.damping); F32(p.gain); F32(p.outMin); F32(p.outMax); }
  for (const [p, w] of physIn) { U32(p); F32(w); }
  for (const a of anims) { U32(a.name); F32(a.duration); U32(a.loop); U32(a.firstTrack); U32(a.trackCount); F32(a.tick); }
  if (as10) {
    for (const [p, k, n, base, step] of as10.tracks) { U32(p); U32(k); U32(n); F32(base); F32(step); }
    for (const [t, v] of as10.keys) { dv.setUint16(o, t, true); dv.setUint16(o + 2, v, true); o += 4; }
  } else {
    for (const t of packed.tracks11) { U32(t.target); F32(t.base); F32(t.step); }
    U32s(packed.words);
    for (const c of packed.curves) { U32(c.key); [c.n, c.cx1, c.cy1, c.cx2, c.cy2, 0].forEach((v) => { dv.setUint16(o, v, true); o += 2; }); }
  }
  for (const k of masks) { U32(k.firstRef); U32(k.refCount); U32(k.channel); }
  maskRefs.forEach(U32);
  for (const c of colors) { U32(c.mode); c.a.forEach(F32); c.b.forEach(F32); U32(0); }
  for (const d of colorDrivers) { U32(d.region); U32(d.slot); d.da.forEach(F32); d.db.forEach(F32); }
  xstart.forEach(U32);
  for (const [b, w] of xweights) { U32(b); F32(w); }
  for (const w of warps) { U32(w.cols); U32(w.rows); U32(w.parentIndex); U32(w.bone); U32(w.firstPoint); U32(w.name); }
  wpoints.forEach(F32);
  for (const d of warpDrivers) { U32(d.region); U32(d.warp); U32(d.firstDelta); }
  wdeltas.forEach(F32);
  for (const q of boneWarps) { U32(q.bone); U32(q.warp); F32(q.ox); F32(q.oy); F32(q.a); F32(q.b); F32(q.c); F32(q.d); F32(q.rc); F32(q.rs); }
  for (const c of chains) { U32(c.firstBone); U32(c.boneCount); F32(c.stiffness); F32(c.damping); F32(c.gx); F32(c.gy); F32(c.inertia); F32(c.mix); U32(c.name); }
  chainBones.forEach(U32);
  orders.forEach(F32);
  for (const d of orderDrivers) { U32(d.region); U32(d.part); F32(d.d); }
  for (const e of expressions) { U32(e.name); U32(e.firstItem); U32(e.itemCount); F32(e.fadeIn); F32(e.fadeOut); }
  for (const [k, op, v] of exprItems) { U32(k); U32(op); F32(v); }
  for (const s of strings) { const b = enc.encode(s); u8.set(b, o); o += b.length + 1; }
  lap('write');
  if (o !== start + body) fail(`internal size mismatch (${o} vs ${start + body})`, 'internal', {});
  for (const t of extra) { o = (o + 3) & ~3; u8.set(t.bytes, o); o += t.bytes.length; }
  return buf;
}

// Gives each mask a channel (< 16). With up to 16 masks each gets its own; with
// more, masks whose areas (mask and masked parts in the rest pose, in model
// coordinates, grown by a margin) don't overlap share a channel. (pos holds a
// part in a warp grid in the grid's cell coordinates: its restBox is used.)
function assignMaskChannels(masks, parts, pos) {
  if (masks.length <= MASK_CHANNELS) { masks.forEach((k, i) => { k.channel = i; }); return; }
  const box = (list) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const pi of list) {
      const p = parts[pi];
      if (p.restBox) {
        b[0] = Math.min(b[0], p.restBox[0]); b[1] = Math.min(b[1], p.restBox[1]);
        b[2] = Math.max(b[2], p.restBox[2]); b[3] = Math.max(b[3], p.restBox[3]);
        continue;
      }
      for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) {
        b[0] = Math.min(b[0], pos[2 * v]); b[1] = Math.min(b[1], pos[2 * v + 1]);
        b[2] = Math.max(b[2], pos[2 * v]); b[3] = Math.max(b[3], pos[2 * v + 1]);
      }
    }
    const m = 0.25 * Math.max(b[2] - b[0], b[3] - b[1], 1);
    return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  };
  const boxes = masks.map((k) => box([...k.parts, ...k.users]));
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const used = Array.from({ length: MASK_CHANNELS }, () => []);
  masks.forEach((k, i) => {
    const ch = used.findIndex((list) => list.every((j) => !hit(boxes[i], boxes[j])));
    if (ch < 0) fail(`too many overlapping masks (at most ${MASK_CHANNELS} can overlap)`, 'tooManyMasks', { max: MASK_CHANNELS });
    used[ch].push(i);
    k.channel = ch;
  });
}

// a constraint record as tools/skeleton_pose.mjs takes it
export function consForPose(c) {
  if (c.type === 0) {
    return { type: 'ik', bones: c.bone2 >= 0 ? [c.bone, c.bone2] : [c.bone], target: c.target, mix: c.mix[0], bend: c.off[0],
      compress: !!(c.flags & 1), stretch: !!(c.flags & 2), uniform: !!(c.flags & 4) };
  }
  const [mixRot, mixX, mixY, mixSx, mixSy, mixShear] = c.mix, [offRot, offX, offY, offSx, offSy, offShy] = c.off;
  return { type: 'transform', bones: [c.bone], target: c.target, local: !!(c.flags & 1), relative: !!(c.flags & 2),
    offRot, offX, offY, offSx, offSy, offShy, mixRot, mixX, mixY, mixSx, mixSy, mixShear };
}

// ---- CLI ---------------------------------------------------------------
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const fs = await import('node:fs');
  const [, , input, output] = process.argv;
  if (!input) {
    console.error('usage: node tools/compile.mjs model.json [model.ug9]');
    process.exit(2);
  }
  const out = output || input.replace(/\.json$/i, '') + '.ug9';
  const buf = compileUgo(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(out, new Uint8Array(buf));
  console.log(`${out}: ${buf.byteLength} bytes`);
}
