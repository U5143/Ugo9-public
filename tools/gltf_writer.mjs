// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Small helpers to write glTF 2.0 binary (.glb): buffer views, accessors
// (dense and sparse) and the GLB container. Used by export_gltf.mjs and
// export_vrm.mjs.

export const FLOAT = 5126, UINT = 5125, USHORT = 5123, UBYTE = 5121;
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export class GltfBuilder {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  /** Appends bytes (4-byte aligned) and returns a bufferView index. */
  view(typed, target) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    this.chunks.push(bytes.slice());
    const v = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) v.target = target;
    this.length += bytes.byteLength;
    this.bufferViews.push(v);
    return this.bufferViews.length - 1;
  }

  static minmax(arr, comps) {
    const min = new Array(comps).fill(Infinity), max = new Array(comps).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { const c = i % comps; if (arr[i] < min[c]) min[c] = arr[i]; if (arr[i] > max[c]) max[c] = arr[i]; }
    return { min: min.map(Math.fround), max: max.map(Math.fround) };
  }

  /** Between beginPack() and endPack(), accessors share one bufferView (with byte offsets):
   * thousands of animation tracks then do not each add a bufferView to the JSON. */
  beginPack() {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: 0 });
    this.pack = { view: this.bufferViews.length - 1, start: this.length };
  }

  endPack() {
    this.bufferViews[this.pack.view].byteLength = this.length - this.pack.start;
    this.pack = null;
  }

  accessor(typed, type, componentType, { target, bounds = false, normalized } = {}) {
    let where;
    if (this.pack && !target && typed.BYTES_PER_ELEMENT === 4) {
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      where = { bufferView: this.pack.view, byteOffset: this.length - this.pack.start };
      this.chunks.push(bytes.slice()); this.length += bytes.byteLength;
      if (!where.byteOffset) delete where.byteOffset;
    } else where = { bufferView: this.view(typed, target) };
    const acc = { ...where, componentType, count: typed.length / COMPS[type], type };
    if (normalized) acc.normalized = true;
    if (bounds) Object.assign(acc, GltfBuilder.minmax(typed, COMPS[type]));
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  /** A VEC3 accessor of `count` elements where only the listed ones are non-zero
   * (map: index -> [x, y, z]). Used for morph target positions. */
  sparseVec3(map, count) {
    const keys = [...map.keys()].sort((a, b) => a - b);
    const idx = new Uint32Array(keys), vals = new Float32Array(3 * keys.length);
    keys.forEach((k, i) => { const v = map.get(k); vals[3 * i] = v[0]; vals[3 * i + 1] = v[1]; vals[3 * i + 2] = v[2] || 0; });
    const mm = GltfBuilder.minmax(vals, 3);
    if (keys.length < count) for (let c = 0; c < 3; c++) { mm.min[c] = Math.min(mm.min[c], 0); mm.max[c] = Math.max(mm.max[c], 0); }
    if (!keys.length) { mm.min = [0, 0, 0]; mm.max = [0, 0, 0]; }
    const acc = { componentType: FLOAT, count, type: 'VEC3', ...mm };
    if (keys.length) acc.sparse = { count: keys.length, indices: { bufferView: this.view(idx), componentType: UINT }, values: { bufferView: this.view(vals) } };
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  /** Packs the JSON (bufferViews, accessors and buffers are filled in) into a .glb. */
  glb(json) {
    json.buffers = [{ byteLength: this.length }];
    json.bufferViews = this.bufferViews;
    json.accessors = this.accessors;
    const pad4 = (n) => (4 - (n % 4)) % 4;
    // plain Uint8Arrays (no Node Buffer), so it runs in the browser too
    const json8 = new TextEncoder().encode(JSON.stringify(json)), textLen = json8.length + pad4(json8.length);
    const binLen = this.length + pad4(this.length), total = 12 + 8 + textLen + 8 + binLen;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    const tag = (at, s) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
    tag(0, 'glTF'); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, textLen, true); tag(16, 'JSON');
    out.set(json8, 20); out.fill(0x20, 20 + json8.length, 20 + textLen);
    const b0 = 20 + textLen;
    dv.setUint32(b0, binLen, true); tag(b0 + 4, 'BIN\0');
    let o = b0 + 8;
    for (const c of this.chunks) { const u = c instanceof Uint8Array ? c : new Uint8Array(c.buffer, c.byteOffset, c.byteLength); out.set(u, o); o += u.length; }
    return out;
  }
}

// 2D affine (a, b, c, d, tx, ty) helpers for bind matrices
export const mul2d = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
export const inv2d = (M) => {
  const det = M[0] * M[3] - M[1] * M[2];
  const a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det;
  return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])];
};
export const mat4of2d = (M) => [M[0], M[1], 0, 0, M[2], M[3], 0, 0, 0, 0, 1, 0, M[4], M[5], 0, 1]; // column major

const PART_HIDDEN = 2; // as UGO_PART_HIDDEN (core/include/ugo.h): drawn only into masks (maskOnly)
/**
 * The triangles of a model (web/ugo.js UgoModel) split into glTF primitives: runs of parts that
 * follow each other in `order` (part numbers, default the stored order) on the same texture, so
 * the parts stay in draw order and each run takes its own page's material. Parts only drawn into
 * masks (maskOnly) are left out. -> [{ texture, indices: Uint32Array }]
 */
export function primitiveRuns(model, mesh, order = null) {
  const parts = model.partData().parts, runs = [];
  for (const k of order || parts.map((_, i) => i)) {
    const p = parts[k];
    if (!p.indexCount || p.flags & PART_HIDDEN) continue;
    const last = runs[runs.length - 1], tris = mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount);
    if (last && last.texture === p.texture) last.list.push(tris); else runs.push({ texture: p.texture, list: [tris] });
  }
  return runs.map(({ texture, list }) => {
    const indices = new Uint32Array(list.reduce((n, t) => n + t.length, 0));
    let o = 0;
    for (const t of list) { indices.set(t, o); o += t.length; }
    return { texture, indices };
  });
}
