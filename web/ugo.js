// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 Web runtime: loads ugo.wasm (the C core), wraps models and instances,
// and draws with WebGL2. Each frame the CPU hands the GPU a few hundred
// bytes per character; every vertex is deformed in the vertex shader and all
// characters are drawn with one call.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class UgoRuntime {
  /**
   * Loads the core. source: the URL of ugo.wasm (default: next to this file), or its bytes (an ArrayBuffer or a
   * typed array: in Node or server-side rendering, where fetch cannot read file: URLs, or when a bundler gives them).
   * Importing this file touches no window or document; only drawing (UgoRenderer, loadImage) needs a browser.
   *
   * Where the browser has WebAssembly SIMD, a URL ending in ugo.wasm loads ugo_simd.wasm next to it instead (the
   * same results bit for bit, faster); if that file is missing, ugo.wasm. options.simd: false always loads the
   * given file (true: SIMD wherever it can). Bytes are loaded as given (UgoRuntime.simdSupported() says which to
   * give). runtime.simd says whether the SIMD build runs.
   */
  static async load(source = new URL('./ugo.wasm', import.meta.url)) {
    // (options as a second argument: engines/web_bundle.mjs rewrites this line as it is)
    const options = arguments[1] || {};
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return UgoRuntime.fromBytes(source);
    const url = source instanceof URL ? source : new URL(String(source), typeof location !== 'undefined' ? location.href : undefined);
    if (options.simd !== false && /(^|\/)ugo\.wasm$/.test(url.pathname) && UgoRuntime.simdSupported()) {
      try {
        const r = await fetch(new URL(url.pathname.replace(/ugo\.wasm$/, 'ugo_simd.wasm') + url.search, url));
        if (r.ok) return await UgoRuntime.fromBytes(await r.arrayBuffer());
      } catch { /* not there, or not readable: the plain build */ }
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Ugo9: cannot load ${url} (${r.status})`);
    return UgoRuntime.fromBytes(await r.arrayBuffer());
  }

  /** Whether this browser (or Node) runs WebAssembly SIMD (it validates a tiny module with one SIMD instruction). */
  static simdSupported() {
    if (UgoRuntime.simdCache === undefined) {
      try {
        // (module (func (result v128) i32.const 0 i8x16.splat))
        UgoRuntime.simdCache = typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11]));
      } catch { UgoRuntime.simdCache = false; }
    }
    return UgoRuntime.simdCache;
  }

  static async fromBytes(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new UgoRuntime(instance.exports);
  }

  constructor(exports) {
    this.ex = exports;
    // the SIMD build exports a marker (web/src/ugo_wasm.c)
    this.simd = typeof exports.ugo_wasm_simd === 'function' && exports.ugo_wasm_simd() === 1;
  }

  f32(ptr, n) { return new Float32Array(this.ex.memory.buffer, ptr, n); }
  u32(ptr, n) { return new Uint32Array(this.ex.memory.buffer, ptr, n); }
  u8(ptr, n) { return new Uint8Array(this.ex.memory.buffer, ptr, n); }
  u16(ptr, n) { return new Uint16Array(this.ex.memory.buffer, ptr, n); }

  str(ptr) {
    const u8 = new Uint8Array(this.ex.memory.buffer);
    let end = ptr;
    while (u8[end]) end++;
    return decoder.decode(u8.subarray(ptr, end));
  }

  alloc(size) {
    const p = this.ex.ugo_wasm_alloc(size);
    if (!p) throw new Error('Ugo9: out of WebAssembly memory');
    return p;
  }

  /** bytes: ArrayBuffer of a .ug9 file */
  loadModel(bytes) {
    return new UgoModel(this, bytes);
  }
}

export class UgoModel {
  constructor(rt, bytes) {
    const ex = rt.ex;
    const data = rt.alloc(bytes.byteLength);
    rt.u8(data, bytes.byteLength).set(new Uint8Array(bytes));
    // a 1.1 file's curve keys are expanded into the model's memory: ask the core how much it needs
    const need = ex.ugo_model_mem_size_for(data, bytes.byteLength);
    const ptr = need ? ex.ugo_model_init_sized(rt.alloc(need), need, data, bytes.byteLength) : 0;
    this.fileBytes = bytes.byteLength; this.memBytes = need;
    if (!ptr) {
      const err = ex.ugo_last_error(), b = new Uint8Array(bytes);
      if (err === 3 && b.length >= 8) { // UGO_ERR_VERSION: say which version it is, and what to do
        const major = b[4] | (b[5] << 8), minor = b[6] | (b[7] << 8), reads = ex.ugo_version() >>> 16;
        const e = new Error(major === reads
          ? `Ugo9: this .ug9 (format ${major}.${minor}) uses something this player does not know: update the player`
          : major < reads
            ? `Ugo9: this .ug9 is format ${major}.${minor}, but this player reads ${reads}.x: compile it again from its authoring JSON`
            : `Ugo9: this .ug9 is format ${major}.${minor}, but this player reads ${reads}.x: update the player`);
        e.code = major === reads ? 'ugoNewer' : 'ugoVersion'; e.vars = { major, minor, reads };
        throw e;
      }
      throw new Error(`Ugo9: not a valid .ug9 file (error ${err})`);
    }
    this.rt = rt;
    this.ptr = ptr;
    // a file of a later 1.x: what this player skipped (UGO_WARN_* bits; 0 when nothing) and the file's version
    this.warnings = ex.ugo_model_warnings(ptr);
    this.format = { major: ex.ugo_model_format(ptr) >>> 16, minor: ex.ugo_model_format(ptr) & 0xffff };
    if (this.warnings) console.warn(`Ugo9: this .ug9 is format ${this.format.major}.${this.format.minor}, newer than this player (${ex.ugo_version() >>> 16}.${ex.ugo_version() & 0xffff}): it skipped ${this.warnings & 1 ? 'tables' : ''}${this.warnings === 3 ? ' and ' : ''}${this.warnings & 2 ? 'animation tracks' : ''} it does not know, so the picture may differ`);
    this.vertexCount = ex.ugo_vertex_count(ptr);
    this.indexCount = ex.ugo_index_count(ptr);
    this.boneCount = ex.ugo_bone_count(ptr);
    this.partCount = ex.ugo_part_count(ptr);
    this.morphCount = ex.ugo_morph_count(ptr);
    this.entryCount = ex.ugo_entry_count(ptr);
    this.frameFloats = ex.ugo_frame_float_count(ptr);
    this.skinOffset = ex.ugo_frame_skin_offset(ptr);
    this.opacityOffset = ex.ugo_frame_opacity_offset(ptr);
    this.morphOffset = ex.ugo_frame_morph_offset(ptr);
    this.colorOffset = ex.ugo_frame_color_offset(ptr);
    this.maskChannels = ex.ugo_mask_channel_count(ptr);
    this.canvas = Array.from(rt.f32(ex.ugo_canvas(ptr), 4));
    this.params = Array.from({ length: ex.ugo_param_count(ptr) }, (_, i) => ({
      name: rt.str(ex.ugo_param_name(ptr, i)),
      min: ex.ugo_param_min(ptr, i), max: ex.ugo_param_max(ptr, i), def: ex.ugo_param_default(ptr, i),
    }));
    this.animations = Array.from({ length: ex.ugo_animation_count(ptr) }, (_, i) => ({
      name: rt.str(ex.ugo_animation_name(ptr, i)), duration: ex.ugo_animation_duration(ptr, i), loop: !!ex.ugo_animation_loop(ptr, i),
    }));
    this.textures = Array.from({ length: ex.ugo_texture_count(ptr) }, (_, i) => rt.str(ex.ugo_texture_name(ptr, i)));
    // warp grids: rect is the rest-pose rectangle along the grid's own axes, turned by angle (degrees,
    // 0.8) about its centre, in model space; parent is a warp index, bone a bone index (-1: none).
    // axes: the rest pose's cell (0, 0) corner o and the whole width u and height v, in model space.
    this.warps = Array.from({ length: ex.ugo_warp_count(ptr) }, (_, i) => {
      const info = rt.u32(rt.alloc(12), 3);
      ex.ugo_warp_info(ptr, i, info.byteOffset);
      const [cols, rows] = info, n = (cols + 1) * (rows + 1), rest = rt.f32(ex.ugo_warp_rest_points(ptr, i), 2 * n);
      const at = (c, r) => [rest[2 * (r * (cols + 1) + c)], rest[2 * (r * (cols + 1) + c) + 1]];
      return { name: rt.str(ex.ugo_warp_name(ptr, i)), cols, rows, parent: ex.ugo_warp_parent(ptr, i), bone: ex.ugo_warp_bone(ptr, i),
        restLocal: [at(0, 0), at(cols, 0), at(0, rows)] };
    });
    for (const w of this.warps) { // corners in model space; a nested grid's rest points are in its parent's cells
      let [o, ou, ov] = w.restLocal;
      if (w.parent >= 0) [o, ou, ov] = [o, ou, ov].map(([x, y]) => this.warpCellToModel(w.parent, x, y)); // (parents come first)
      const u = [ou[0] - o[0], ou[1] - o[1]], v = [ov[0] - o[0], ov[1] - o[1]];
      w.axes = { o, u, v };
      if (u[1] === 0 && v[0] === 0) { w.rect = [o[0], o[1], u[0], v[1]]; w.angle = 0; } // not turned
      else {
        const wd = Math.hypot(u[0], u[1]), ht = Math.hypot(v[0], v[1]), cx = o[0] + (u[0] + v[0]) / 2, cy = o[1] + (u[1] + v[1]) / 2;
        w.rect = [cx - wd / 2, cy - ht / 2, wd, ht];
        w.angle = Math.atan2(u[1], u[0]) * 180 / Math.PI;
      }
      delete w.restLocal;
    }
    this.warpIndex = new Map(this.warps.map((w, i) => [w.name, i]));
    // swaying bone chains: their id (0.7; "" if none), bones root to tip (indices), and their settings
    this.chains = Array.from({ length: ex.ugo_chain_count(ptr) }, (_, i) => {
      const buf = rt.alloc(28), p = rt.f32(buf, 6), n = rt.u32(buf + 24, 1);
      ex.ugo_chain_info(ptr, i, buf, buf + 24);
      const [stiffness, damping, gx, gy, inertia, mix] = p;
      return { name: rt.str(ex.ugo_chain_name(ptr, i)), bones: Array.from(rt.u32(ex.ugo_chain_bones(ptr, i), n[0])), stiffness, damping, gravity: [gx, gy], inertia, mix };
    });
    // draw order (0.8): whether it can change, and each part's own value
    this.hasDrawOrder = !!ex.ugo_has_draw_order(ptr);
    // expressions (0.8): { name, fadeIn, fadeOut, items: [[parameter name, op (0 set, 1 add, 2 multiply), value]] }
    this.expressions = Array.from({ length: ex.ugo_expression_count(ptr) }, (_, i) => {
      const buf = rt.alloc(8), fade = rt.f32(buf, 2);
      ex.ugo_expression_fade(ptr, i, buf);
      const [fadeIn, fadeOut] = fade;
      const at = ex.ugo_expression_items(ptr, i, buf), n = rt.u32(buf, 1)[0], w = rt.u32(at, 3 * n), f = rt.f32(at, 3 * n);
      const items = Array.from({ length: n }, (_, k) => [this.params[w[3 * k]].name, w[3 * k + 1], f[3 * k + 2]]);
      return { name: rt.str(ex.ugo_expression_name(ptr, i)), fadeIn, fadeOut, items };
    });
    this.expressionIndex = new Map(this.expressions.map((e, i) => [e.name, i]));
    this.paramIndex = new Map(this.params.map((p, i) => [p.name, i]));
    this.animationIndex = new Map(this.animations.map((a, i) => [a.name, i]));
    // bones: { name, parent (-1: none), length, rest: { x, y, rotate (degrees), scaleX, scaleY } relative to the parent }
    {
      const buf = rt.alloc(20);
      this.bones = Array.from({ length: this.boneCount }, (_, i) => {
        ex.ugo_bone_rest(ptr, i, buf);
        const [x, y, r, scaleX, scaleY] = rt.f32(buf, 5);
        return { name: rt.str(ex.ugo_bone_name(ptr, i)), parent: ex.ugo_bone_parent(ptr, i), length: ex.ugo_bone_length(ptr, i), rest: { x, y, rotate: r * 180 / Math.PI, scaleX, scaleY } };
      });
    }
    // hit areas (a convention, not in the format): parts named "hit:<name>" or "当たり:<name>" (or "当たり：")
    this.hitAreas = [];
    for (let i = 0; i < this.partCount; i++) {
      const m = /^(?:hit|当たり)[:：](.+)$/.exec(rt.str(ex.ugo_part_name(ptr, i)));
      if (m) this.hitAreas.push({ name: m[1], part: i });
    }
    this.skeletonIsSimple = !!ex.ugo_skeleton_is_simple(ptr); // no constraints, shear, special inheritance, chains or bones in grids
    this.warpOffset = ex.ugo_frame_warp_offset(ptr);
  }

  /**
   * A mask for inst.play(.., { mask }): { bones, parts, params, morphs, constraints, colors }, each a
   * list of names or numbers (bones, parts and parameters by name; the others by number). A kind left
   * out is applied whole; an empty list applies none of it. Made once, kept with the model.
   */
  animationMask(spec = {}) {
    const rt = this.rt, ex = rt.ex, ptr = this.ptr;
    const kinds = [['bones', this.boneCount, (n) => this.boneIndex(n)], ['parts', this.partCount, (n) => this.partIndex(n)],
      ['params', this.params.length, (n) => this.paramIndex.get(n)], ['morphs', this.morphCount], ['constraints', ex.ugo_constraint_count(ptr)],
      ['colors', ex.ugo_color_count(ptr)]];
    const at = rt.alloc(4 * kinds.length);
    const lists = kinds.map(([key, count, find]) => {
      if (spec[key] == null) return 0;
      const list = rt.alloc(Math.max(count, 1)), bytes = rt.u8(list, Math.max(count, 1));
      bytes.fill(0);
      for (const n of spec[key]) {
        const i = typeof n === 'number' ? n : find ? find(n) : undefined;
        if (i === undefined || i < 0 || i >= count) throw new Error(`Ugo9: the mask names ${key} "${n}", which the model does not have`);
        bytes[i] = 1;
      }
      return list;
    });
    rt.u32(at, kinds.length).set(lists); // (after every alloc: memory may have grown)
    return { ptr: at };
  }
  /**
   * An animation's tracks as the file has them (a 1.1 curve as its straight pieces):
   * [{ kind ('param', 'rotate', 'x', 'y', 'scaleX', 'scaleY', 'opacity', 'morph', 'shearX', 'shearY',
   * 'constraint', 'color', 'order'), index, target (the parameter's, bone's or part's name, if it has one),
   * smooth, keys: [[seconds, value], ...] (empty: one value), value(t) }]. Values as in the authoring
   * JSON: angles in degrees, bones as offsets from the rest pose.
   */
  animationTracks(nameOrIndex) {
    const rt = this.rt, ex = rt.ex, ptr = this.ptr;
    const a = typeof nameOrIndex === 'number' ? nameOrIndex : this.animationIndex.get(nameOrIndex);
    if (a === undefined) return null;
    const KINDS = ['param', 'rotate', 'x', 'y', 'scaleX', 'scaleY', 'opacity', 'morph', 'shearX', 'shearY', 'constraint', 'color', 'order'];
    const buf = rt.alloc(16), out = [];
    const n = ex.ugo_animation_track_count(ptr, a);
    for (let k = 0; k < n; k++) {
      ex.ugo_animation_track(ptr, a, k, buf);
      const [kind, index, count, smooth] = rt.u32(buf, 4);
      const name = KINDS[kind] ?? `kind${kind}`, scale = name === 'rotate' || name.startsWith('shear') ? 180 / Math.PI : 1;
      const keys = [];
      for (let j = 0; j < count; j++) { ex.ugo_animation_track_key(ptr, a, k, j, buf); const [t, v] = rt.f32(buf, 2); keys.push([t, v * scale]); }
      const target = kind === 0 ? this.params[index]?.name : kind <= 5 || kind === 8 || kind === 9 ? rt.str(ex.ugo_bone_name(ptr, index))
        : kind === 6 || kind === 12 ? rt.str(ex.ugo_part_name(ptr, index)) : undefined;
      out.push({ kind: name, index, target, smooth: !!smooth, keys, value: (t) => ex.ugo_animation_track_value(ptr, a, k, t) * scale });
    }
    return out;
  }
  /**
   * Numbers for an editor's statistics: counts of what the model has, its animations' tracks and keys
   * (after loading: 1.1 curves as their pieces) and the bytes it takes (file, model memory, per instance,
   * frame block sent to the GPU per character per frame).
   */
  stats() {
    const rt = this.rt, ex = rt.ex, ptr = this.ptr, info = rt.alloc(16);
    let tracks = 0, keys = 0;
    for (let a = 0; a < this.animations.length; a++) {
      const n = ex.ugo_animation_track_count(ptr, a);
      tracks += n;
      for (let k = 0; k < n; k++) { ex.ugo_animation_track(ptr, a, k, info); keys += rt.u32(info, 4)[2]; }
    }
    return {
      parameters: this.params.length, bones: this.boneCount, parts: this.partCount, vertices: this.vertexCount, triangles: this.indexCount / 3,
      morphs: this.morphCount, morphEntries: this.entryCount, extraWeights: ex.ugo_extra_weight_count(ptr), warps: this.warps.length,
      masks: ex.ugo_mask_count(ptr), colors: ex.ugo_color_count(ptr), constraints: ex.ugo_constraint_count(ptr), chains: ex.ugo_chain_count(ptr),
      physics: ex.ugo_physics_count(ptr), expressions: this.expressions.length, animations: this.animations.length, tracks, keys,
      textures: this.textures.length,
      bytes: { file: this.fileBytes, model: this.memBytes, instance: ex.ugo_instance_mem_size(ptr), frame: 4 * this.frameFloats },
    };
  }
  /**
   * Where a bone goes in an animation, as the core plays it (constraints and physics included):
   * [[seconds, x, y], ...] in model space, the bone's tip (its end, or its origin without a length;
   * { tip: false } for the origin). Played from 0 at fps (physics needs the time before `from`), recorded
   * from `from` to `to` (a looping animation's end time is its start again, as it plays). Uses an
   * instance of its own, so the caller's characters are not touched.
   */
  trajectory(animation, bone, { fps = 30, from = 0, to, tip = true, params = {} } = {}) {
    const a = typeof animation === 'number' ? animation : this.animationIndex.get(animation);
    const b = typeof bone === 'number' ? bone : this.boneIndex(bone);
    if (a === undefined || b === undefined || b < 0 || b >= this.boneCount) return null;
    const end = to ?? this.animations[a].duration, dt = 1 / fps, out = [];
    if (!this.trajInst) this.trajInst = this.createInstance();
    const inst = this.trajInst, len = tip ? this.bones[b].length : 0;
    this.rt.ex.ugo_reset_physics(inst.ptr);
    const steps = Math.round(end * fps);
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * dt, end);
      inst.reset();
      for (const [k, v] of Object.entries(params)) inst.set(k, v);
      inst.play(a, t);
      inst.update(i ? dt : 0);
      if (t + 1e-9 < from) continue;
      const w = inst.boneWorld(b);
      out.push([t, w[4] + w[0] * len, w[5] + w[1] * len]);
    }
    return out;
  }
  boneIndex(name) {
    if (!this.boneMap) this.boneMap = new Map(Array.from({ length: this.boneCount }, (_, i) => [this.rt.str(this.rt.ex.ugo_bone_name(this.ptr, i)), i]));
    return this.boneMap.get(name);
  }
  partIndex(name) {
    if (!this.partMap) this.partMap = new Map(Array.from({ length: this.partCount }, (_, i) => [this.rt.str(this.rt.ex.ugo_part_name(this.ptr, i)), i]));
    return this.partMap.get(name);
  }
  createInstance() {
    return new UgoInstance(this);
  }

  /**
   * Expressions from a preset (made for this model or another one: parameters by name), ready for
   * UgoInstance.expression() and UgoExpressionMixer. preset: the preset file's object, or a list of
   * expressions as written ({ id, fadeIn, fadeOut, params: { name: [op, value] } }).
   * -> { expressions: [{ name, fadeIn, fadeOut, missing: [names] }, ...], missing: [names, each once] }
   *   Parameters this model lacks are skipped (the core resolves the names once, here).
   */
  loadExpressions(preset) {
    const list = Array.isArray(preset) ? preset : readPresetList(preset);
    const { rt } = this, ex = rt.ex, missingAll = new Set();
    const expressions = list.map((e, i) => {
      const where = `expressions[${i}]`;
      if (!e || typeof e.id !== 'string' || !e.id) throw new Error(`Ugo9: ${where} has no id`);
      const items = Object.entries(e.params || {}).map(([name, item]) => {
        const op = Array.isArray(item) ? EXPR_OPS.indexOf(item[0]) : -1;
        if (op < 0 || !Number.isFinite(item[1])) throw new Error(`Ugo9: ${where}.params.${name} must be [${EXPR_OPS.join(' | ')}, value]`);
        return [name, op, item[1]];
      });
      const n = items.length, index = rt.alloc(4 * n + 4), ops = rt.alloc(4 * n + 4), values = rt.alloc(4 * n + 4);
      rt.u32(ops, n).set(items.map(([, op]) => op));
      rt.f32(values, n).set(items.map(([, , v]) => v));
      const mark = ex.ugo_wasm_mark();
      try { // the names as C strings, only while they are resolved
        const names = rt.alloc(4 * n + 4), ptrs = items.map(([name]) => {
          const b = encoder.encode(name), p = rt.alloc(b.length + 1);
          rt.u8(p, b.length + 1).set([...b, 0]);
          return p;
        });
        rt.u32(names, n).set(ptrs);
        ex.ugo_resolve_params(this.ptr, names, n, index);
      } finally { ex.ugo_wasm_release(mark); }
      const idx = new Int32Array(ex.memory.buffer, index, n), missing = items.filter((_, k) => idx[k] < 0).map(([name]) => name);
      missing.forEach((m) => missingAll.add(m));
      const fade = (v) => (v == null ? 0.5 : v);
      return { name: e.id, fadeIn: fade(e.fadeIn), fadeOut: fade(e.fadeOut), missing, items, n, index, ops, values, model: this };
    });
    return { expressions, missing: [...missingAll] };
  }

  /** This model's expressions as a preset file's object (to save, or to use with another model). */
  exportExpressions() {
    return { format: 'ugo9-expressions', version: 1, expressions: this.expressions.map((e) => ({
      id: e.name, fadeIn: e.fadeIn, fadeOut: e.fadeOut, params: Object.fromEntries(e.items.map(([n, op, v]) => [n, [EXPR_OPS[op], v]])),
    })) };
  }

  /** Rest-pose cell coordinates of warp grid i -> model space. */
  warpCellToModel(i, x, y) {
    const w = this.warps[i], { o, u, v } = w.axes, s = x / w.cols, t = y / w.rows;
    return [o[0] + s * u[0] + t * v[0], o[1] + s * u[1] + t * v[1]];
  }
  /** Rest-pose model space -> cell coordinates of warp grid i. */
  warpModelToCell(i, x, y) {
    const w = this.warps[i];
    if (!w.angle) return [(x - w.rect[0]) / w.rect[2] * w.cols, (y - w.rect[1]) / w.rect[3] * w.rows];
    const { o, u, v } = w.axes, dx = x - o[0], dy = y - o[1], det = u[0] * v[1] - u[1] * v[0];
    return [(dx * v[1] - dy * v[0]) / det * w.cols, (dy * u[0] - dx * u[1]) / det * w.rows];
  }

  /** Static mesh arrays (copied out of wasm memory, built once into GPU buffers). */
  meshData() {
    const { rt, ptr } = this, ex = rt.ex, nv = this.vertexCount;
    const csr = rt.u32(ex.ugo_csr_starts(ptr), nv + 1);
    const csrPairs = new Uint32Array(2 * nv);
    for (let i = 0; i < nv; i++) { csrPairs[2 * i] = csr[i]; csrPairs[2 * i + 1] = csr[i + 1] - csr[i]; }
    const rawEntries = ex.ugo_entries(ptr);
    const em = rt.u32(rawEntries, 3 * this.entryCount), ed = rt.f32(rawEntries, 3 * this.entryCount);
    const entries = new Float32Array(4 * this.entryCount);
    for (let i = 0; i < this.entryCount; i++) {
      entries[4 * i] = em[3 * i]; entries[4 * i + 1] = ed[3 * i + 1]; entries[4 * i + 2] = ed[3 * i + 2];
    }
    // influences beyond four: (start, count) per vertex and (bone, weight, 0, 0) per entry
    const nx = ex.ugo_extra_weight_count(ptr), xs = rt.u32(ex.ugo_extra_weight_starts(ptr), nv + 1);
    const xcsr = new Uint32Array(2 * nv);
    for (let i = 0; i < nv; i++) { xcsr[2 * i] = xs[i]; xcsr[2 * i + 1] = xs[i + 1] - xs[i]; }
    const rawX = ex.ugo_extra_weights(ptr), xb = rt.u32(rawX, 2 * nx), xw = rt.f32(rawX, 2 * nx);
    const extraWeights = new Float32Array(4 * nx);
    for (let i = 0; i < nx; i++) { extraWeights[4 * i] = xb[2 * i]; extraWeights[4 * i + 1] = xw[2 * i + 1]; }
    return {
      xcsr, extraWeights,
      positions: rt.f32(ex.ugo_positions(ptr), 2 * nv).slice(),
      uvs: rt.f32(ex.ugo_uvs(ptr), 2 * nv).slice(),
      joints: rt.u16(ex.ugo_joints(ptr), 4 * nv).slice(),
      weights: rt.f32(ex.ugo_weights(ptr), 4 * nv).slice(),
      parts: rt.u32(ex.ugo_vertex_parts(ptr), nv).slice(),
      csr: csrPairs,
      entries,
      indices: rt.u32(ex.ugo_indices(ptr), this.indexCount).slice(),
    };
  }

  /** Per part: draw range, blend mode, flags, mask, colour slot; per mask: channel and parts. */
  partData() {
    const { rt, ptr } = this, ex = rt.ex;
    const tmp = rt.alloc(16), range = rt.u32(tmp, 4);
    const parts = Array.from({ length: this.partCount }, (_, i) => {
      ex.ugo_part_range(ptr, i, tmp);
      return {
        name: rt.str(ex.ugo_part_name(ptr, i)), firstVertex: range[0], vertexCount: range[1], firstIndex: range[2], indexCount: range[3],
        order: ex.ugo_part_draw_order(ptr, i), // its own draw order value (0 without draw order)
        blend: ex.ugo_part_blend(ptr, i), flags: ex.ugo_part_flags(ptr, i), texture: ex.ugo_part_texture(ptr, i),
        mask: ex.ugo_part_mask(ptr, i), color: ex.ugo_part_color(ptr, i), warp: ex.ugo_part_warp(ptr, i),
      };
    });
    const masks = Array.from({ length: ex.ugo_mask_count(ptr) }, (_, k) => {
      const list = ex.ugo_mask_parts(ptr, k, tmp), n = range[0];
      return { channel: ex.ugo_mask_channel(ptr, k), parts: Array.from(rt.u32(list, n)) };
    });
    const warps = Array.from({ length: ex.ugo_warp_count(ptr) }, (_, k) => {
      ex.ugo_warp_info(ptr, k, tmp);
      return { name: rt.str(ex.ugo_warp_name(ptr, k)), cols: range[0], rows: range[1], offset: range[2] };
    });
    return { parts, masks, warps };
  }
}

// a chain is known by its bones' names
const chainKey = (model, c) => c.bones.map((b) => model.rt.str(model.rt.ex.ugo_bone_name(model.ptr, b))).join('/');

export class UgoInstance {
  constructor(model) {
    const ex = model.rt.ex;
    this.model = model;
    this.ex = ex;
    this.ptr = ex.ugo_instance_init(model.rt.alloc(ex.ugo_instance_mem_size(model.ptr)), model.ptr);
    this.framePtr = ex.ugo_frame(this.ptr);
  }

  reset() { this.ex.ugo_reset_params(this.ptr); }
  resetPhysics() { this.ex.ugo_reset_physics(this.ptr); }
  set(nameOrIndex, value) {
    const i = typeof nameOrIndex === 'number' ? nameOrIndex : this.model.paramIndex.get(nameOrIndex);
    if (i !== undefined) this.ex.ugo_set_param(this.ptr, i, value);
  }
  get(nameOrIndex) {
    const i = typeof nameOrIndex === 'number' ? nameOrIndex : this.model.paramIndex.get(nameOrIndex);
    return i === undefined ? 0 : this.ex.ugo_get_param(this.ptr, i);
  }
  /**
   * Applies an animation at time t and weight w. opts (for layers): { add: true } adds its change
   * from the rest pose on top instead of mixing towards it; { mask } (from model.animationMask())
   * applies only the bones, parts, ... the mask names.
   */
  play(nameOrIndex, time, weight = 1, opts) {
    const i = typeof nameOrIndex === 'number' ? nameOrIndex : this.model.animationIndex.get(nameOrIndex);
    if (i === undefined) return;
    if (opts && (opts.add || opts.mask)) this.ex.ugo_apply_animation_ex(this.ptr, i, time, weight, opts.add ? 1 : 0, opts.mask ? opts.mask.ptr : 0);
    else this.ex.ugo_apply_animation(this.ptr, i, time, weight);
  }
  update(dt) { this.ex.ugo_update(this.ptr, dt); }
  /**
   * Applies an expression at weight w (0..1): the model's own, by name or number, or one from
   * model.loadExpressions(). Call it after play() and set(), before update(); several stack in order.
   */
  expression(e, w = 1) {
    if (typeof e === 'string') e = this.model.expressionIndex.get(e);
    if (typeof e === 'number') { if (e >= 0) this.ex.ugo_apply_expression(this.ptr, e, w); return; }
    if (e && e.index !== undefined) {
      if (e.model !== this.model) throw new Error('Ugo9: this expression was loaded for another model (use that model\'s loadExpressions)');
      this.ex.ugo_apply_params(this.ptr, e.index, e.ops, e.values, e.n, w);
    }
  }
  setTransform(a, b, c, d, tx, ty) { this.ex.ugo_set_transform(this.ptr, a, b, c, d, tx, ty); }
  /**
   * The instance's state as plain values, to carry into an instance of an
   * edited model with loadState() (also after the old model's wasm memory is
   * gone): parameter values (by name), the parameter physics (by output
   * parameter), swaying chains (by their bones' names), the placement and where
   * the character was at the last update.
   */
  saveState() {
    const ex = this.ex, m = this.model, rt = m.rt, mark = ex.ugo_wasm_mark();
    const state = { params: new Map(), physics: new Map(), chains: new Map(), transform: Array.from(this.frame().subarray(0, 6)) };
    try {
      const buf = rt.alloc(4 * (4 * 65 + 1)); // a chain has at most 64 bones
      m.params.forEach((p, i) => state.params.set(p.name, this.get(i)));
      for (let i = 0; i < ex.ugo_physics_count(m.ptr); i++) {
        ex.ugo_get_physics_state(this.ptr, i, buf);
        state.physics.set(m.params[ex.ugo_physics_output(m.ptr, i)].name, Array.from(rt.f32(buf, 3)));
      }
      m.chains.forEach((c, i) => {
        ex.ugo_get_chain_state(this.ptr, i, buf);
        state.chains.set(chainKey(m, c), Array.from(rt.f32(buf, ex.ugo_chain_state_floats(m.ptr, i))));
      });
      ex.ugo_get_last_placement(this.ptr, buf);
      state.lastPlacement = Array.from(rt.f32(buf, 3));
      ex.ugo_get_wind(this.ptr, buf);
      state.wind = [...Array.from(rt.f32(buf, 3)), ex.ugo_wind_time(this.ptr)]; // x, y, gust, its clock
    } finally { ex.ugo_wasm_release(mark); }
    return state;
  }

  /** Puts back what saveState() took (from this model or an earlier version of it); whatever doesn't match starts at rest. Call update() afterwards. */
  loadState(state) {
    const ex = this.ex, m = this.model, rt = m.rt, mark = ex.ugo_wasm_mark();
    try {
      const buf = rt.alloc(4 * (4 * 65 + 1));
      m.params.forEach((p, i) => { if (state.params.has(p.name)) this.set(i, state.params.get(p.name)); });
      for (let i = 0; i < ex.ugo_physics_count(m.ptr); i++) {
        const s = state.physics.get(m.params[ex.ugo_physics_output(m.ptr, i)].name);
        if (s) { rt.f32(buf, 3).set(s); ex.ugo_set_physics_state(this.ptr, i, buf); }
      }
      m.chains.forEach((c, i) => {
        const s = state.chains.get(chainKey(m, c));
        if (s && s.length === ex.ugo_chain_state_floats(m.ptr, i)) { rt.f32(buf, s.length).set(s); ex.ugo_set_chain_state(this.ptr, i, buf); }
      });
      if (state.lastPlacement) { rt.f32(buf, 3).set(state.lastPlacement); ex.ugo_set_last_placement(this.ptr, buf); }
      if (state.wind) { ex.ugo_set_wind(this.ptr, state.wind[0], state.wind[1], state.wind[2]); ex.ugo_set_wind_time(this.ptr, state.wind[3]); }
    } finally { ex.ugo_wasm_release(mark); }
    const t = state.transform;
    this.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  }

  /** loadState(old.saveState()), for two instances alive at once. */
  copyStateFrom(old) { this.loadState(old.saveState()); }

  /** World matrix of bone i after the last update: [a, b, c, d, tx, ty] (model space). */
  /**
   * Pose (editor pose mode, or a game moving a bone): the bone's offsets from its rest pose
   * { rotate (degrees), x, y, scaleX, scaleY, shearX, shearY (degrees) }, as animation tracks set them.
   * setBoneOffset mixes towards them by weight (fields left out stay); call after play(), before update().
   */
  setBoneOffset(bone, pose, weight = 1) {
    const rt = this.model.rt, i = typeof bone === 'number' ? bone : this.model.boneIndex(bone);
    if (i === undefined) return;
    const cur = this.boneOffset(i), D = Math.PI / 180;
    const v = { ...cur, ...pose };
    if (!this.posePtr) this.posePtr = rt.alloc(28);
    rt.f32(this.posePtr, 7).set([v.rotate * D, v.x, v.y, v.scaleX, v.scaleY, v.shearX * D, v.shearY * D]);
    this.ex.ugo_set_bone_offset(this.ptr, i, this.posePtr, weight);
  }
  boneOffset(bone) {
    const rt = this.model.rt, i = typeof bone === 'number' ? bone : this.model.boneIndex(bone);
    if (!this.posePtr) this.posePtr = rt.alloc(28);
    rt.f32(this.posePtr, 7).fill(0);
    if (i !== undefined) this.ex.ugo_get_bone_offset(this.ptr, i, this.posePtr);
    const [r, x, y, sx, sy, hx, hy] = rt.f32(this.posePtr, 7), D = 180 / Math.PI;
    return { rotate: r * D, x, y, scaleX: sx, scaleY: sy, shearX: hx * D, shearY: hy * D };
  }
  /**
   * Drags the bone's tip (its end, or its origin without a length) towards (x, y) in model space by
   * turning it and up to count - 1 of its parents, from the pose of the last update(); update() again
   * to see it. Returns the distance left.
   */
  /**
   * Puts the bone at a world matrix [a, b, c, d, tx, ty] (as boneWorld() gives) by changing its offsets,
   * under its parent's pose of the last update(); update() again to see it. For an editor: keep a child
   * where it is while its parent moves (read boneWorld before, put it back after), or values in world space.
   */
  setBoneWorld(bone, world) {
    const rt = this.model.rt, i = typeof bone === 'number' ? bone : this.model.boneIndex(bone);
    if (i === undefined) return;
    if (!this.worldInPtr) this.worldInPtr = rt.alloc(24);
    rt.f32(this.worldInPtr, 6).set(world);
    this.ex.ugo_set_bone_world(this.ptr, i, this.worldInPtr);
  }
  /** The bone's resulting pose after the last update() (rest + animation + drivers, after constraints), relative to its parent: { x, y, rotate (degrees), scaleX, scaleY }. */
  boneLocal(bone) {
    const rt = this.model.rt, i = typeof bone === 'number' ? bone : this.model.boneIndex(bone);
    if (i === undefined) return null;
    if (!this.localPtr) this.localPtr = rt.alloc(20);
    this.ex.ugo_bone_pose(this.ptr, i, this.localPtr);
    const [x, y, r, scaleX, scaleY] = rt.f32(this.localPtr, 5);
    return { x, y, rotate: r * 180 / Math.PI, scaleX, scaleY };
  }
  /** The parameter values as a live Float32Array view (index as model.params; re-read it after memory grows). */
  paramValues() { return this.model.rt.f32(this.ex.ugo_params(this.ptr), this.model.params.length); }
  dragBone(bone, x, y, count = 2, iterations = 10) {
    const i = typeof bone === 'number' ? bone : this.model.boneIndex(bone);
    return i === undefined ? -1 : this.ex.ugo_solve_ik_to(this.ptr, i, count, x, y, iterations);
  }
  boneWorld(i) {
    const rt = this.model.rt;
    if (!this.worldPtr) this.worldPtr = rt.alloc(24);
    this.ex.ugo_bone_world(this.ptr, i, this.worldPtr);
    return Array.from(rt.f32(this.worldPtr, 6));
  }
  /** The bone's world matrix with setTransform's placement applied (where it is on screen: to attach things). */
  boneWorldPlaced(i) {
    const rt = this.model.rt;
    if (!this.worldPtr) this.worldPtr = rt.alloc(24);
    this.ex.ugo_bone_world_placed(this.ptr, i, this.worldPtr);
    return Array.from(rt.f32(this.worldPtr, 6));
  }
  /**
   * The part drawn in front at (x, y), model space, after the last update(): its number, or -1.
   * By draw order and masks; hidden parts and parts at minOpacity or below are skipped. Transparent
   * pixels of the texture count as covered.
   */
  pickPart(x, y, minOpacity = 0) {
    return this.ex.ugo_pick_part(this.ptr, 0, x, y, minOpacity); // 0: the core places only the vertices it needs
  }
  /**
   * The hit area at (x, y) after the last update(): the name of the area in front ("head" for a part named
   * "hit:head" or "当たり:head" / "当たり：head", usually a part that is not drawn), or null. model.hitAreas lists them.
   */
  hitTest(x, y) {
    const model = this.model, areas = model.hitAreas;
    if (!areas.length) return null;
    if (!model.hitMaskPtr) {
      const n = Math.max(model.partCount, 1), p = model.rt.alloc(n), bytes = model.rt.u8(p, n);
      bytes.fill(0);
      for (const a of areas) bytes[a.part] = 1;
      model.hitMaskPtr = p;
    }
    const part = this.ex.ugo_pick_area(this.ptr, 0, x, y, model.hitMaskPtr);
    return part < 0 ? null : areas.find((a) => a.part === part).name;
  }
  /** The box [x0, y0, x1, y1] (model space) around a part (number or name) after the last update(), or around everything drawn; null if empty. */
  bounds(part = -1) {
    const rt = this.model.rt, i = typeof part === 'number' ? part : this.model.partIndex(part);
    if (i === undefined) return null;
    if (!this.boxPtr) this.boxPtr = rt.alloc(16);
    return this.ex.ugo_bounds(this.ptr, 0, i, this.boxPtr) ? Array.from(rt.f32(this.boxPtr, 4)) : null;
  }
  /**
   * A box [x0, y0, x1, y1] (model space) sure to hold every vertex after the last update(), without placing them:
   * larger than bounds() but cheap (a few points per bone), for culling. null if the model has no vertices.
   */
  boundsEstimate() {
    const rt = this.model.rt;
    if (!this.boxPtr) this.boxPtr = rt.alloc(16);
    return this.ex.ugo_bounds_estimate(this.ptr, this.boxPtr) ? Array.from(rt.f32(this.boxPtr, 4)) : null;
  }
  /** One part's vertices after the last update (model space): 2 floats per vertex of the part (a new array). */
  deformedPart(part) {
    const rt = this.model.rt, i = typeof part === 'number' ? part : this.model.partIndex(part);
    if (i === undefined || i < 0 || i >= this.model.partCount) return null;
    if (!this.deformBuf) this.deformBuf = rt.alloc(8 * this.model.vertexCount + 8);
    if (!this.rangeBuf) this.rangeBuf = rt.alloc(16);
    this.ex.ugo_part_range(this.model.ptr, i, this.rangeBuf);
    const [first, count] = rt.u32(this.rangeBuf, 2);
    this.ex.ugo_deform_part_cpu(this.ptr, i, this.deformBuf);
    return rt.f32(this.deformBuf + 8 * first, 2 * count).slice();
  }
  /**
   * How long update() takes here: the mean of n calls in milliseconds, with what was set before
   * (parameters, animations) applied again each time ({ update, total }: update alone, and with
   * reset + play of the given animation).
   */
  measure(n = 200, animation) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let t0 = now();
    for (let i = 0; i < n; i++) this.ex.ugo_update(this.ptr, 1 / 60);
    const update = (now() - t0) / n;
    t0 = now();
    for (let i = 0; i < n; i++) { this.ex.ugo_reset_params(this.ptr); if (animation !== undefined) this.play(animation, i / 60); this.ex.ugo_update(this.ptr, 1 / 60); }
    return { update, total: (now() - t0) / n };
  }
  /** Wind on the swaying chains: an acceleration (x, y) in model px/s² added to their gravity, with gusts (0: steady). Stays until set again. */
  setWind(x, y, gust = 0) { this.ex.ugo_set_wind(this.ptr, x, y, gust); }
  /** Lets the physics settle for up to `seconds` (at most 10) under the current parameters and pose (before the first frame). */
  settlePhysics(seconds = 2) { this.ex.ugo_settle_physics(this.ptr, seconds); }
  deformInPlace() {
    const rt = this.model.rt;
    if (!this.deformBuf) this.deformBuf = rt.alloc(8 * this.model.vertexCount + 8);
    this.ex.ugo_deform_cpu(this.ptr, this.deformBuf);
  }
  /** Every vertex's position after the last update (model space, before the instance transform):
   *  2 floats per vertex, the same as the GPU computes (a new array). */
  deformedPositions() {
    const rt = this.model.rt, n = 2 * this.model.vertexCount;
    if (!this.deformBuf) this.deformBuf = rt.alloc(4 * n + 8);
    this.ex.ugo_deform_cpu(this.ptr, this.deformBuf);
    return rt.f32(this.deformBuf, n).slice();
  }
  /** Warp grid i's control points after the last update, model space: 2 floats per point, rows top to bottom (a new array). */
  warpPoints(i) {
    const w = this.model.warps[i], rt = this.model.rt, n = 2 * (w.cols + 1) * (w.rows + 1);
    if (!this.warpBuf || this.warpBufN < n) { this.warpBuf = rt.alloc(4 * n); this.warpBufN = n; }
    this.ex.ugo_warp_points(this.ptr, i, this.warpBuf);
    return rt.f32(this.warpBuf, n).slice();
  }
  /** Where warp grid i puts the rest-pose model-space point (x, y) now: [x, y] in model space. */
  warpEval(i, x, y) {
    const rt = this.model.rt;
    if (!this.worldPtr) this.worldPtr = rt.alloc(24);
    const [cx, cy] = this.model.warpModelToCell(i, x, y);
    this.ex.ugo_warp_eval(this.ptr, i, cx, cy, this.worldPtr);
    return Array.from(rt.f32(this.worldPtr, 2));
  }
  /** All bones' world matrices after the last update: 6 floats per bone (a new array). */
  boneWorlds() {
    const n = this.model.boneCount, out = new Float32Array(6 * n);
    for (let i = 0; i < n; i++) out.set(this.boneWorld(i), 6 * i);
    return out;
  }
  /** The frame block (view into wasm memory; copy it before the next update). */
  frame() { return this.model.rt.f32(this.framePtr, this.model.frameFloats); }
  /** After update: the part numbers in the order to draw them (view into wasm memory; 0.8). */
  drawOrder() { return this.model.rt.u32(this.ex.ugo_draw_order(this.ptr), this.model.partCount); }
  /** After update: 0 while the parts are drawn in their stored order, else a hash of drawOrder() (0.8). */
  drawOrderKey() { return this.ex.ugo_draw_order_key(this.ptr) >>> 0; }
}

// ---- expressions (0.8) ---------------------------------------------------------

const EXPR_OPS = ['set', 'add', 'multiply']; // as UGO_EXPR_SET .. in core/include/ugo.h

function readPresetList(preset) {
  if (!preset || preset.format !== 'ugo9-expressions') throw new Error('Ugo9: not an expression preset (format must be "ugo9-expressions")');
  if (preset.version !== 1) throw new Error(`Ugo9: expression preset version ${preset.version} is not known (this reads 1)`);
  return preset.expressions || [];
}

/**
 * Looking at a point (Live2D's drag-to-look; the same rules as the engines' look helpers): the face, the
 * eyes and a little of the body turn towards a point in model space, smoothly, and back when it stops.
 * Writes the standard parameters (docs/パラメータの名前.md) HeadTurnX/Y, PupilX/Y, BodyTurnX, or the
 * older AngleX/Y, EyeBallX/Y, BodyAngleX a model may use instead; a model without them is left alone.
 * Each frame: look.update(dt), then after the animations: look.apply(inst).
 *
 *   const look = new UgoLook(model);  look.lookAt(x, y);  ...  look.stop();
 */
export class UgoLook {
  constructor(model, { range = 400, smoothing = 0.12, body = 0.3, from } = {}) {
    const [w, h, ox, oy] = model.canvas;
    Object.assign(this, { model, range, smoothing, body, from: from ?? [w / 2 - ox, h / 4 - oy], looking: false, tx: 0, ty: 0, x: 0, y: 0, weight: 0 });
    const pick = (...names) => names.map((n) => model.paramIndex.get(n)).find((i) => i !== undefined);
    this.targets = [[pick('HeadTurnX', 'AngleX'), 1, 1], [pick('HeadTurnY', 'AngleY'), -1, 1], [pick('PupilX', 'EyeBallX'), 1, 1],
      [pick('PupilY', 'EyeBallY'), -1, 1], [pick('BodyTurnX', 'BodyAngleX'), 1, body]].filter(([i]) => i !== undefined);
  }
  /** Look at (x, y), model space (y down). */
  lookAt(x, y) { this.looking = true; this.tx = x - this.from[0]; this.ty = y - this.from[1]; }
  stop() { this.looking = false; }
  update(dt) {
    const follow = (c, t) => (this.smoothing <= 0 ? t : c + (t - c) * (1 - Math.exp(-dt / this.smoothing)));
    const clamp = (v) => Math.min(1, Math.max(-1, v / Math.max(1, this.range)));
    this.weight = follow(this.weight, this.looking ? 1 : 0);
    this.x = follow(this.x, this.looking ? clamp(this.tx) : this.x);
    this.y = follow(this.y, this.looking ? clamp(this.ty) : this.y);
  }
  apply(inst) {
    if (this.weight <= 1e-4) return;
    for (const [i, sign, part] of this.targets) {
      const p = this.model.params[i], amount = sign * (sign > 0 ? this.x : this.y), v = inst.get(i);
      const target = p.def + (amount >= 0 ? p.max - p.def : p.def - p.min) * amount * part;
      inst.set(i, v + (target - v) * this.weight);
    }
  }
}

/**
 * Blinking on its own (the same rules as the engines' helpers): every 2 to 6 seconds (a seeded random, so
 * the same seed blinks the same), closing in 0.07 s and opening in 0.12 s, multiplying EyeOpenL / EyeOpenR
 * (so an expression's or animation's half-closed eyes still blink). Each frame, after the animations:
 * blink.update(dt); blink.apply(inst).
 */
export class UgoBlink {
  constructor(model, { min = 2, max = 6, close = 0.07, open = 0.12, seed = 12345 } = {}) {
    Object.assign(this, { model, min, max, close, open, seed: seed >>> 0, wait: -1, t: -1, openness: 1 });
    this.eyes = ['EyeOpenL', 'EyeOpenR'].map((n) => model.paramIndex.get(n)).filter((i) => i !== undefined);
  }
  random01() {
    let x = this.seed;
    x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
    this.seed = x;
    return (x & 0xffffff) / 16777216;
  }
  update(dt) {
    if (this.wait < 0) this.wait = this.min + (this.max - this.min) * this.random01();
    if (this.t < 0) {
      this.wait -= dt;
      if (this.wait <= 0) this.t = 0;
      this.openness = 1;
    }
    if (this.t >= 0) {
      this.t += dt;
      this.openness = this.t < this.close ? 1 - this.t / this.close : Math.min(1, (this.t - this.close) / this.open);
      if (this.t >= this.close + this.open) { this.t = -1; this.wait = -1; this.openness = 1; }
    }
  }
  apply(inst) { for (const i of this.eyes) inst.set(i, inst.get(i) * this.openness); }
}

/**
 * The mouth following a level (lip-sync from loudness, 0..1; the same rules as the engines' helpers):
 * MouthOpen opens quickly and closes more slowly. level < 0 leaves the mouth to the animation.
 */
export class UgoMouth {
  constructor(model, { smoothing = 0.06 } = {}) {
    Object.assign(this, { model, smoothing, level: -1, value: 0 });
    this.index = model.paramIndex.get('MouthOpen');
  }
  update(dt) {
    if (this.level < 0) return;
    const target = Math.min(1, Math.max(0, this.level)), s = target > this.value ? this.smoothing * 0.5 : this.smoothing;
    this.value = s <= 0 ? target : this.value + (target - this.value) * (1 - Math.exp(-dt / s));
  }
  apply(inst) {
    if (this.level < 0 || this.index === undefined) return;
    const p = this.model.params[this.index];
    inst.set(this.index, p.min + (p.max - p.min) * this.value);
  }
}

/**
 * Linked parameters, set from code (not kept in the model file; a format table for them is a 1.2
 * candidate): moving one parameter moves another, scaled, inverted and following with a delay.
 *
 *   const links = new UgoLinks(model).add({ from: 'HeadTurnX', to: 'HairFrontSway', scale: -0.02, delay: 0.15 });
 *   each frame, after the animations and before expressions: links.update(dt, inst); links.apply(inst);
 *
 * The follower's change from its default is the leader's change from its default times scale (invert
 * flips it), reached smoothly over `delay` seconds (0: at once), added to what the follower already has.
 */
export class UgoLinks {
  constructor(model) { this.model = model; this.links = []; }
  add({ from, to, scale = 1, delay = 0, invert = false }) {
    const index = (n) => (typeof n === 'number' ? n : this.model.paramIndex.get(n));
    const a = index(from), b = index(to);
    if (a === undefined || b === undefined) throw new Error(`Ugo9: no parameter "${a === undefined ? from : to}" to link`);
    this.links.push({ a, b, scale: invert ? -scale : scale, delay: Math.max(0, delay), value: 0, target: 0 });
    return this;
  }
  clear() { this.links.length = 0; return this; }
  /** Reads the leaders (call after the animations and parameters are set) and moves the followers' values on. */
  update(dt, inst) {
    for (const l of this.links) {
      if (inst) l.target = (inst.get(l.a) - this.model.params[l.a].def) * l.scale;
      l.value = l.delay > 0 ? l.value + (l.target - l.value) * (1 - Math.exp(-dt / l.delay)) : l.target;
    }
  }
  apply(inst) { for (const l of this.links) { const p = this.model.params[l.b]; inst.set(l.b, Math.min(p.max, Math.max(p.min, inst.get(l.b) + l.value))); } }
}

/**
 * Plays animations on layers, with crossfades, a queue (a playlist), speed and a time range
 * (Live2D's motion manager, Spine's animation state). Each frame: animator.update(dt), then
 * inst.reset(); animator.apply(inst); (set parameters, expressions); inst.update(dt).
 *
 *   const anim = new UgoAnimator(model);
 *   anim.play('idle');                                        // layer 0, loops as the file says
 *   anim.play('wave', { layer: 1, add: true, fade: 0.2 });    // added on top
 *   anim.play('jump', { fade: 0.15 }); anim.queue('idle');     // jump once, then idle again
 *   anim.on('end', ({ layer, name }) => ...);                  // a non-looping one reached its end
 *
 * Layers apply in order (0 first). Within a layer the new animation mixes over the old one as
 * its fade goes from 0 to 1 (an added layer fades the old one out and the new one in).
 */
export class UgoAnimator {
  constructor(model) { this.model = model; this.layers = []; this.handlers = { end: [] }; }
  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
  entry(name, o = {}) {
    const index = typeof name === 'number' ? name : this.model.animationIndex.get(name);
    if (index === undefined) throw new Error(`Ugo9: no animation "${name}"`);
    const a = this.model.animations[index];
    const from = o.from ?? 0, to = o.to ?? a.duration;
    return { index, name: a.name, time: from, from, to, loop: o.loop ?? a.loop, speed: o.speed ?? 1, weight: o.weight ?? 1,
      add: !!o.add, mask: o.mask ?? null, fade: Math.max(0, o.fade ?? 0.25), done: false };
  }
  layer(i) { return (this.layers[i] ||= { current: null, old: null, mix: 1, queue: [], weight: 1 }); }
  /** Starts an animation on a layer now, mixing in over `fade` seconds. Options: layer, fade, loop, speed, from, to (seconds), weight, add, mask. */
  play(name, o = {}) {
    const L = this.layer(o.layer ?? 0), e = this.entry(name, o);
    L.queue.length = 0;
    this.start(L, e);
    return e;
  }
  /** Plays it after the layer's current animation ends (a non-looping one; a looping one ends after its loop). */
  queue(name, o = {}) {
    const L = this.layer(o.layer ?? 0), e = this.entry(name, o);
    if (!L.current) this.start(L, e); else L.queue.push(e);
    return e;
  }
  /** Fades the layer out (and drops its queue). */
  stop(layer = 0, fade = 0.25) {
    const L = this.layer(layer);
    L.queue.length = 0;
    if (!L.current) return;
    L.old = L.current; L.current = null; L.mix = 0; L.fadeTime = Math.max(0, fade);
    if (!L.fadeTime) { L.old = null; L.mix = 1; }
  }
  start(L, e) {
    if (L.current && e.fade > 0) { L.old = L.current; L.mix = 0; L.fadeTime = e.fade; } else { L.old = null; L.mix = 1; }
    L.current = e;
  }
  /** Moves the clocks by dt seconds (speeds, loops, ranges, fades, the queue). */
  update(dt) {
    this.layers.forEach((L, i) => {
      if (!L) return;
      for (const e of [L.old, L.current]) {
        if (!e || e.done) continue;
        e.time += dt * e.speed;
        const len = e.to - e.from;
        if (e.loop && len > 0) {
          const wraps = Math.floor((e.time - e.from) / len);
          if (wraps > 0 && e === L.current && L.queue.length) { e.time = e.to; e.done = true; }
          else e.time = e.from + (((e.time - e.from) % len) + len) % len;
        } else if (e.time >= e.to || e.time < e.from) {
          e.time = Math.min(e.to, Math.max(e.from, e.time));
          if (!e.done) { e.done = true; if (e === L.current) for (const fn of this.handlers.end) fn({ layer: i, name: e.name }); }
        }
      }
      if (L.old) { L.mix = L.fadeTime > 0 ? Math.min(1, L.mix + dt / L.fadeTime) : 1; if (L.mix >= 1) L.old = null; }
      if (L.current && L.current.done && L.queue.length) this.start(L, L.queue.shift());
    });
  }
  /** Where every layer is (times, fades, queues): a plain object for load() (rewinding, an editor's timeline). Masks are kept by reference. */
  save() {
    const entry = (e) => e && { ...e };
    return { layers: this.layers.map((L) => L && { current: entry(L.current), old: entry(L.old), mix: L.mix, fadeTime: L.fadeTime, queue: L.queue.map(entry) }) };
  }
  /** Puts back what save() gave (the 'end' handlers stay as they are). */
  load(state) {
    const entry = (e) => e && { ...e };
    this.layers = state.layers.map((L) => L && { current: entry(L.current), old: entry(L.old), mix: L.mix, fadeTime: L.fadeTime, queue: L.queue.map(entry), weight: 1 });
  }
  /** Applies every layer to the instance (after inst.reset(), before inst.update()). */
  apply(inst) {
    for (const L of this.layers) {
      if (!L) continue;
      const opts = (e) => (e.add || e.mask ? { add: e.add, mask: e.mask } : undefined);
      if (L.old) { // crossfading: the old one in full and the new one over it; stopping: the old one fading out
        const w = L.old.weight * (L.old.add || !L.current ? 1 - L.mix : 1);
        if (w > 0) inst.play(L.old.index, L.old.time, w, opts(L.old));
      }
      if (L.current) {
        const w = L.current.weight * (L.old ? L.mix : 1);
        if (w > 0) inst.play(L.current.index, L.current.time, w, opts(L.current));
      }
    }
  }
}

/**
 * Fades expressions in and out over time (Live2D-style): show() and hide() set where each is going,
 * update(dt) moves the weights by their fade times, apply(inst) applies them in the order they were
 * first shown. An expression is a name or number of the model's own, or one from loadExpressions().
 */
export class UgoExpressionMixer {
  constructor(model) { this.model = model; this.active = []; }
  fadeOf(e) {
    if (typeof e === 'object') return [e.fadeIn, e.fadeOut];
    const k = typeof e === 'number' ? e : this.model.expressionIndex.get(e), x = this.model.expressions[k];
    return x ? [x.fadeIn, x.fadeOut] : [0, 0];
  }
  show(e, fadeIn = this.fadeOf(e)[0]) {
    let a = this.active.find((x) => x.e === e);
    if (!a) this.active.push(a = { e, w: 0 });
    a.target = 1; a.fade = fadeIn;
    return this;
  }
  hide(e, fadeOut = this.fadeOf(e)[1]) {
    const a = this.active.find((x) => x.e === e);
    if (a) { a.target = 0; a.fade = fadeOut; }
    return this;
  }
  /** Shows only these (the others fade out). */
  only(...list) { for (const a of this.active) if (!list.includes(a.e)) this.hide(a.e); list.forEach((e) => this.show(e)); return this; }
  update(dt) {
    for (const a of this.active) {
      const step = a.fade > 0 ? dt / a.fade : 1;
      a.w = a.target > a.w ? Math.min(a.target, a.w + step) : Math.max(a.target, a.w - step);
    }
    this.active = this.active.filter((a) => a.w > 0 || a.target > 0);
    return this;
  }
  /** Weight of each expression shown or fading: [[expression, weight], ...]. */
  weights() { return this.active.map((a) => [a.e, a.w]); }
  apply(inst) { for (const a of this.active) if (a.w > 0) inst.expression(a.e, a.w); }
}

// ---- WebGL2 renderer -------------------------------------------------------
//
// Masks: every mask of every character is first drawn (one instanced call)
// into channels of screen-sized RGBA8 images, max-blended; then the characters
// are drawn with one call and a masked part multiplies its coverage by its
// channel there (1 - channel when inverted). Characters that overlap could
// see each other's mask in the same channel; `strictMasks` draws character by
// character instead (2 calls each).
//
// Blending: normal and add share one blend function (add = alpha 0). With
// WEBGL_blend_func_extended multiply and screen do too (dual-source blending:
// dst = src0 + dst * src1), so everything is still one call. Without it, the
// parts are drawn in runs of the same blend function.

/**
 * Fixed frames, for video tools (Remotion and the like ask for any frame, in any order, often on several
 * workers at once): frame(n) gives the instance as playing from frame 0 at a steady fps leaves it at frame n,
 * physics included, whichever frames were asked for before. It keeps a saved state every `every` seconds, so
 * going back costs at most that much replaying; going forward continues.
 *
 *   const frames = new UgoFrames(model, { fps: 30, setup: (inst, t) => inst.play('idle', t) });
 *   renderer.draw([frames.frame(n)], w, h);
 *
 * setup(inst, seconds, n) is called for every frame after inst.reset(): play animations, set parameters and
 * the placement there (from t only, so the same frame always gets the same). Frame 0 is updated with dt 0, the
 * others with 1 / fps.
 */
export class UgoFrames {
  constructor(model, { fps = 30, setup = () => {}, every = 1, instance } = {}) {
    Object.assign(this, { model, fps, setup, every: Math.max(1, Math.round(every * fps)), at: -1, marks: new Map() });
    this.inst = instance || model.createInstance();
    this.first = this.inst.saveState();
  }
  step(n) {
    const inst = this.inst;
    inst.reset();
    this.setup(inst, n / this.fps, n);
    inst.update(n === 0 ? 0 : 1 / this.fps);
    this.at = n;
    if (n % this.every === 0 && !this.marks.has(n)) this.marks.set(n, inst.saveState());
  }
  /** The instance at frame n (a whole number from 0), updated: draw it, or read its parameters and bones. */
  frame(n) {
    n = Math.max(0, Math.floor(n));
    if (n === this.at) return this.inst;
    // going on from where it is, or from the last state saved before n (a saved state holds no frame block, so
    // frame n itself is always computed)
    let from = n > this.at ? this.at : -1;
    for (const k of this.marks.keys()) if (k < n && k > from) from = k;
    if (from !== this.at) this.inst.loadState(from >= 0 ? this.marks.get(from) : this.first);
    for (let k = from + 1; k <= n; k++) this.step(k);
    return this.inst;
  }
}

export const BLEND = { normal: 0, add: 1, multiply: 2, screen: 3 };
const PART_MASK_INVERT = 1, PART_HIDDEN = 2, PART_SOLID = 4;

const VERT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in uvec4 aJoints;
layout(location = 3) in vec4 aWeights;
layout(location = 4) in uint aPart;
layout(location = 5) in uvec2 aCsr;
layout(location = 6) in uvec2 aXw;  // influences beyond four: first entry, count
uniform sampler2D uFrame;   // per-instance frame blocks, RGBA32F
uniform sampler2D uEntries; // sparse morph deltas: (morph, dx, dy, 0)
uniform sampler2D uXWeights; // influences beyond four: (bone, weight, 0, 0)
uniform usampler2D uParts;  // 2 texels per part: (mask channels written, mask read, flags | blend << 8 | texture << 16, colour slot + 1),
                            // (warp points' first frame texel + 1 or 0, warp cols, rows, 0)
uniform vec2 uTexScale[64]; // each texture's size over the atlas array's layer size
uniform vec2 uAtlasSize;    // layer size in texels
uniform int uFrameW, uStride, uSkinT, uOpF, uMorphF, uColorF, uEntryW, uInstanceBase;
uniform vec4 uView;         // pixel -> clip: scale.xy, offset.zw
out vec2 vUV;
out float vOpacity;
flat out float vLayer;
flat out vec2 vUVMax;
flat out uvec4 vInfo;
flat out vec3 vX, vY;

vec4 frameTexel(int t) { return texelFetch(uFrame, ivec2(t % uFrameW, t / uFrameW), 0); }
float frameFloat(int base, int f) {
  vec4 v = frameTexel(base + (f >> 2));
  int c = f & 3;
  return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
}

// a warp grid's surface at cell coordinates p: uniform cubic B-spline over
// the (cols+3) x (rows+3) points (2 per texel) from texel t, straight on outside
vec2 warpPoint(int t, int W, int k) { vec4 v = frameTexel(t + (k >> 1)); return (k & 1) == 0 ? v.xy : v.zw; }
vec4 bspline(float t) { float s = 1.0 - t, t2 = t * t, t3 = t2 * t; return vec4(s * s * s, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0; }
vec4 bsplineD(float t) { float s = 1.0 - t, t2 = t * t; return vec4(-0.5 * s * s, -2.0 * t + 1.5 * t2, 0.5 + t - 1.5 * t2, 0.5 * t2); }
vec2 warpAt(int t, uvec4 w, vec2 p) {
  vec2 size = vec2(w.yz), q = clamp(p, vec2(0.0), size), c = min(floor(q), size - 1.0), f = q - c, e = p - q;
  vec4 bu = bspline(f.x), bv = bspline(f.y), du = bsplineD(f.x), dv = bsplineD(f.y);
  int W = int(w.y) + 3, k0 = int(c.y) * W + int(c.x);
  vec2 o = vec2(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 P = warpPoint(t, W, k0 + j * W + i);
    o += (bu[i] * bv[j] + du[i] * bv[j] * e.x + bu[i] * dv[j] * e.y) * P;
  }
  return o;
}

void main() {
  int base = (gl_InstanceID + uInstanceBase) * uStride;
  int part = int(aPart);
  vInfo = texelFetch(uParts, ivec2((2 * part) & 1023, (2 * part) >> 10), 0);
#ifdef GPU_DEFORM
  vec2 p = aPos;
  for (uint e = 0u; e < aCsr.y; e++) {
    int k = int(aCsr.x + e);
    vec4 en = texelFetch(uEntries, ivec2(k % uEntryW, k / uEntryW), 0);
    p += frameFloat(base, uMorphF + int(en.x)) * en.yz;
  }
  vec2 o = vec2(0.0);
  uvec4 warp = texelFetch(uParts, ivec2((2 * part + 1) & 1023, (2 * part + 1) >> 10), 0);
  if (warp.x > 0u) o = warpAt(base + int(warp.x) - 1, warp, p); // in a warp grid: no bones
  else for (int j = 0; j < 4; j++) {
    float w = aWeights[j];
    if (w > 0.0) {
      int t = base + uSkinT + 2 * int(aJoints[j]);
      vec4 m0 = frameTexel(t), m1 = frameTexel(t + 1);
      o += w * vec2(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
    }
  }
  for (uint e = 0u; e < aXw.y && warp.x == 0u; e++) {
    int k = int(aXw.x + e);
    vec4 xw = texelFetch(uXWeights, ivec2(k % uEntryW, k / uEntryW), 0);
    int t = base + uSkinT + 2 * int(xw.x);
    vec4 m0 = frameTexel(t), m1 = frameTexel(t + 1);
    o += xw.y * vec2(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
  }
#else
  vec2 o = aPos; // already deformed on the CPU
#endif
  vec4 x0 = frameTexel(base), x1 = frameTexel(base + 1);
  vec2 world = vec2(x0.x * o.x + x0.z * o.y + x1.x, x0.y * o.x + x0.w * o.y + x1.y);
  uint tex = min(vInfo.z >> 16, 63u);
  vLayer = float(tex);
  vUV = aUV * uTexScale[tex];
  vUVMax = uTexScale[tex] - 0.5 / uAtlasSize; // a smaller page stops at its own last texel (like clamp to edge)
#ifdef MASK_PASS
  vOpacity = 1.0; // masks ignore opacity
#else
  vOpacity = frameFloat(base, uOpF + part);
  if ((vInfo.z & ${PART_HIDDEN}u) != 0u) vOpacity = 0.0;
#endif
  vX = vec3(1.0); vY = vec3(0.0);
  if (vInfo.w > 0u) {
    int c = base + (uColorF >> 2) + 2 * int(vInfo.w - 1u);
    vX = frameTexel(c).xyz; vY = frameTexel(c + 1).xyz;
  }
  gl_Position = vOpacity > 0.0 ? vec4(world * uView.xy + uView.zw, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
precision highp int;
precision mediump sampler2DArray;
uniform sampler2DArray uAtlas; // one layer per texture (atlas page)
uniform sampler2D uMask0, uMask1, uMask2, uMask3;
in vec2 vUV;
in float vOpacity;
flat in float vLayer;
flat in vec2 vUVMax;
flat in uvec4 vInfo;
flat in vec3 vX, vY;
#ifdef MASK_PASS
layout(location = 0) out vec4 outMask0;
layout(location = 1) out vec4 outMask1;
layout(location = 2) out vec4 outMask2;
layout(location = 3) out vec4 outMask3;
vec4 bits(uint w, uint shift) { return vec4(uvec4(w >> shift, w >> (shift + 1u), w >> (shift + 2u), w >> (shift + 3u)) & 1u); }
void main() {
  float a = (vInfo.z & ${PART_SOLID}u) != 0u ? 1.0 : texture(uAtlas, vec3(min(vUV, vUVMax), vLayer)).a;
  outMask0 = bits(vInfo.x, 0u) * a; outMask1 = bits(vInfo.x, 4u) * a;
  outMask2 = bits(vInfo.x, 8u) * a; outMask3 = bits(vInfo.x, 12u) * a;
}
#else
#ifdef DUAL_SOURCE
layout(location = 0, index = 0) out vec4 outColor;
layout(location = 0, index = 1) out vec4 outFactor;
#else
out vec4 outColor;
#endif
float maskAt(uint ch) {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 m = ch < 4u ? texelFetch(uMask0, p, 0) : ch < 8u ? texelFetch(uMask1, p, 0) : ch < 12u ? texelFetch(uMask2, p, 0) : texelFetch(uMask3, p, 0);
  uint c = ch & 3u;
  return c == 0u ? m.x : c == 1u ? m.y : c == 2u ? m.z : m.w;
}
void main() {
  vec4 c = texture(uAtlas, vec3(min(vUV, vUVMax), vLayer)); // premultiplied
  c.rgb = c.rgb * vX + c.a * vY;
  float k = vOpacity;
  if ((vInfo.y & 32u) != 0u) {
    float m = maskAt(vInfo.y & 15u);
    k *= (vInfo.y & 16u) != 0u ? 1.0 - m : m;
  }
  c *= k;
  uint blend = (vInfo.z >> 8) & 255u;
#ifdef DUAL_SOURCE
  // dst = outColor + dst * outFactor
  if (blend == 2u) { outColor = vec4(0.0); outFactor = vec4(c.rgb + (1.0 - c.a), 1.0); }
  else if (blend == 3u) { outColor = c; outFactor = vec4(1.0 - c.rgb, 1.0 - c.a); }
  else { outColor = blend == 1u ? vec4(c.rgb, 0.0) : c; outFactor = vec4(1.0 - outColor.a); }
#else
  if (blend == 1u) c.a = 0.0; // add: rgb = s + d, alpha unchanged
  outColor = c;               // multiply / screen: the blend function of the run does the rest
#endif
}
#endif
`;

function compile(gl, defines, fragmentOnly = '') {
  const make = (type, src) => {
    const s = gl.createShader(type);
    const extra = type === gl.FRAGMENT_SHADER ? `${fragmentOnly}\n${defines}` : defines;
    gl.shaderSource(s, src.replace('#version 300 es', `#version 300 es\n${extra}`));
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (const name of ['uFrame', 'uEntries', 'uXWeights', 'uParts', 'uAtlas', 'uMask0', 'uMask1', 'uMask2', 'uMask3', 'uFrameW', 'uStride', 'uSkinT',
    'uOpF', 'uMorphF', 'uColorF', 'uEntryW', 'uInstanceBase', 'uView', 'uTexScale', 'uAtlasSize']) {
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

const FRAME_W = 1024; // texels per row of the frame texture
const ENTRY_W = 2048;
const PARTS_W = 1024;
const ORDER_SLOTS = 8; // draw orders kept on the GPU at once (0.8); more are written again as needed

export class UgoRenderer {
  /**
   * images: one atlas image per model texture. All are drawn in the same call
   *         (layers of one texture array; smaller images are padded to the largest).
   * options.strictMasks: draw masked characters one by one (exact where characters overlap).
   * options.dualSource: false to never use WEBGL_blend_func_extended (for tests).
   * options.sampling: 'linear' (default) or 'nearest' (each texel as it is: pixel art). See setSampling.
   */
  constructor(gl, model, images, options = {}) {
    this.gl = gl;
    this.strictMasks = !!options.strictMasks;
    this.sampling = options.sampling === 'nearest' ? 'nearest' : 'linear';
    this.dual = options.dualSource === false ? null : gl.getExtension('WEBGL_blend_func_extended');
    const programs = (dual) => {
      // the #extension line has to come right after #version; compile() puts it there
      const frag = dual ? '#extension GL_EXT_blend_func_extended : require\n#define DUAL_SOURCE 1' : '';
      return [compile(gl, '#define GPU_DEFORM 1', frag), compile(gl, '', frag)];
    };
    if (this.dual) {
      try { [this.gpu, this.cpu] = programs(true); } catch { this.dual = null; } // fall back to blend runs
    }
    if (!this.dual) [this.gpu, this.cpu] = programs(false);
    const texture = (w, h, ifmt, fmt, type, data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
      return t;
    };
    this.texture = texture;
    this.floatTex = (w, h, data) => texture(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, data);
    this.frameTex = null;
    this.frameRows = 0;
    this.maskTex = [];
    this.maskSize = [0, 0];
    // ms the last setModel / setImages took on the CPU (the GPU may finish the work later):
    // for an editor's "how long did opening take" display
    this.timings = { setModel: 0, setImages: 0 };
    this.setModel(model, images);
  }

  /**
   * Switches to another model (e.g. the editor's next compile). The shaders are
   * kept, and so is the atlas when `images` are the same objects as before;
   * only the model's own buffers are made again. Instances of the old model
   * must not be drawn with this renderer any more.
   */
  setModel(model, images) {
    const gl = this.gl;
    const t0 = performance.now();
    this.disposeModel();
    this.model = model;
    const mesh = model.meshData();
    const info = model.partData();
    this.mesh = mesh;
    this.masks = model.maskChannels > 0;
    if (this.masks && !this.gpuMask) {
      this.gpuMask = compile(gl, '#define GPU_DEFORM 1\n#define MASK_PASS 1');
      this.cpuMask = compile(gl, '#define MASK_PASS 1');
    }
    if (this.maskChannels !== model.maskChannels) this.maskSize = [0, 0]; // remade on the next draw
    this.maskChannels = model.maskChannels;

    // per-part table for the shaders
    const partTex = new Uint32Array(PARTS_W * Math.max(1, Math.ceil(2 * model.partCount / PARTS_W)) * 4);
    info.masks.forEach((k) => { for (const p of k.parts) partTex[8 * p] |= 1 << k.channel; });
    info.parts.forEach((p, i) => {
      if (p.mask >= 0) partTex[8 * i + 1] = info.masks[p.mask].channel | (p.flags & PART_MASK_INVERT ? 16 : 0) | 32;
      partTex[8 * i + 2] = p.flags | (p.blend << 8) | (Math.min(p.texture, images.length - 1, 63) << 16);
      partTex[8 * i + 3] = p.color + 1;
      if (p.warp >= 0) { // where its grid's points are in the frame block (in texels), and the grid's size
        const w = info.warps[p.warp];
        partTex.set([w.offset / 4 + 1, w.cols, w.rows, 0], 8 * i + 4);
      }
    });

    // index buffer: the drawn parts in order, then the mask parts
    const maskParts = new Set(info.masks.flatMap((k) => k.parts));
    const shown = (p) => !(p.flags & PART_HIDDEN) && p.indexCount;
    let nDrawn = 0, nMask = 0;
    info.parts.forEach((p, i) => { if (shown(p)) nDrawn += p.indexCount; if (maskParts.has(i)) nMask += p.indexCount; });
    // a model whose draw order changes (0.8) gets ORDER_SLOTS more copies of the drawn parts, one per order in use
    const slots = model.hasDrawOrder ? ORDER_SLOTS : 0;
    const allIdx = new Uint32Array(nDrawn * (1 + slots) + nMask);
    // runs of parts that share a blend function (one run when dual-source blending is there)
    const blendClass = (b) => (this.dual || b < 2 ? 0 : b - 1);
    // the drawn parts in the order of `list` into idx from `first`: their runs
    const layOut = (list, idx, first) => {
      const runs = [];
      let drawn = first;
      for (const i of list) {
        const p = info.parts[i];
        if (!shown(p)) continue;
        const part = mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount);
        const cls = blendClass(p.blend), last = runs[runs.length - 1];
        if (last && last.cls === cls) last.count += part.length;
        else runs.push({ cls, first: drawn, count: part.length });
        idx.set(part, drawn); drawn += part.length;
      }
      if (!runs.length) runs.push({ cls: 0, first, count: 0 });
      return runs;
    };
    this.runs = layOut(info.parts.map((_, i) => i), allIdx, 0);
    let masked = nDrawn;
    info.parts.forEach((p, i) => {
      if (!maskParts.has(i)) return;
      allIdx.set(mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount), masked); masked += p.indexCount;
    });
    this.maskFirst = nDrawn;
    this.maskCount = nMask;
    // draw orders in use: key -> { list, runs, slot, used }; a slot's parts are written when an order first needs it
    this.orders = new Map();
    this.orderUse = 0;
    this.orderSlot = (k) => nDrawn + nMask + k * nDrawn;
    this.layOut = (list, k) => {
      const part = new Uint32Array(nDrawn), runs = layOut(list, part, 0);
      for (const r of runs) r.first += this.orderSlot(k);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      this.gl.bufferSubData(this.gl.ELEMENT_ARRAY_BUFFER, 4 * this.orderSlot(k), part);
      return runs;
    };

    const buffer = (target, data, usage = gl.STATIC_DRAW) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, usage);
      return b;
    };
    const vbo = {
      pos: buffer(gl.ARRAY_BUFFER, mesh.positions), uv: buffer(gl.ARRAY_BUFFER, mesh.uvs),
      joints: buffer(gl.ARRAY_BUFFER, mesh.joints), weights: buffer(gl.ARRAY_BUFFER, mesh.weights),
      parts: buffer(gl.ARRAY_BUFFER, mesh.parts), csr: buffer(gl.ARRAY_BUFFER, mesh.csr), xcsr: buffer(gl.ARRAY_BUFFER, mesh.xcsr),
      dynPos: buffer(gl.ARRAY_BUFFER, new Float32Array(2 * model.vertexCount), gl.DYNAMIC_DRAW),
    };
    this.vbo = vbo;
    const ibo = buffer(gl.ELEMENT_ARRAY_BUFFER, allIdx);
    const attrF = (loc, b, size) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    const attrI = (loc, b, size, type) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribIPointer(loc, size, type, 0, 0); };

    this.vaoGpu = gl.createVertexArray();
    gl.bindVertexArray(this.vaoGpu);
    attrF(0, vbo.pos, 2); attrF(1, vbo.uv, 2); attrI(2, vbo.joints, 4, gl.UNSIGNED_SHORT);
    attrF(3, vbo.weights, 4); attrI(4, vbo.parts, 1, gl.UNSIGNED_INT); attrI(5, vbo.csr, 2, gl.UNSIGNED_INT);
    attrI(6, vbo.xcsr, 2, gl.UNSIGNED_INT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

    this.vaoCpu = gl.createVertexArray();
    gl.bindVertexArray(this.vaoCpu);
    attrF(0, vbo.dynPos, 2); attrF(1, vbo.uv, 2); attrI(4, vbo.parts, 1, gl.UNSIGNED_INT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);

    const texture = this.texture, floatTex = this.floatTex;
    const entryRows = Math.max(1, Math.ceil(model.entryCount / ENTRY_W));
    const entryData = new Float32Array(ENTRY_W * entryRows * 4);
    entryData.set(mesh.entries);
    this.entryTex = floatTex(ENTRY_W, entryRows, entryData);
    const xRows = Math.max(1, Math.ceil(mesh.extraWeights.length / 4 / ENTRY_W));
    const xData = new Float32Array(ENTRY_W * xRows * 4);
    xData.set(mesh.extraWeights);
    this.xweightTex = floatTex(ENTRY_W, xRows, xData);
    this.partTex = texture(PARTS_W, partTex.length / 4 / PARTS_W, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, partTex);
    this.ibo = ibo;

    const same = this.images && this.images.length === images.length && this.images.every((im, i) => im === images[i]);
    if (!same) this.setImages(images);
    else this.timings.setImages = 0;
    this.timings.setModel = performance.now() - t0; // (setImages included)
    this.stride = model.frameFloats / 4; // texels per instance
    this.frameRows = 0; // the frame layout may have changed
  }

  // every atlas page in one texture array, so all parts draw in one call
  setImages(images) {
    const gl = this.gl;
    const t0 = performance.now();
    if (this.atlas) gl.deleteTexture(this.atlas);
    this.images = images.slice();
    const pages = images.slice(0, 64);
    const aw = Math.max(...pages.map((im) => im.width)), ah = Math.max(...pages.map((im) => im.height));
    this.texScale = new Float32Array(128).fill(1);
    pages.forEach((im, i) => { this.texScale[2 * i] = im.width / aw; this.texScale[2 * i + 1] = im.height / ah; });
    this.atlasSize = [aw, ah];
    const T = gl.TEXTURE_2D_ARRAY;
    this.atlas = gl.createTexture();
    gl.bindTexture(T, this.atlas);
    // smaller pages are padded with transparent black: WebGL starts every texture at 0, so
    // nothing needs uploading for it (uploading zeros took 0.4 s for four 4096 px pages)
    gl.texStorage3D(T, 1 + Math.floor(Math.log2(Math.max(aw, ah))), gl.RGBA8, aw, ah, pages.length);
    // premultiplied alpha (images from loadImage() are already premultiplied)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    pages.forEach((im, i) => {
      gl.texSubImage3D(T, 0, 0, 0, i, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im);
      for (const e of UgoRenderer.pageEdges(im, aw, ah)) gl.texSubImage3D(T, 0, e.x, e.y, i, e.source.width, e.source.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, e.source);
    });
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(T);
    this.applySampling();
    gl.texParameteri(T, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(T, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    (this.timings ??= {}).setImages = performance.now() - t0;
  }

  /**
   * The texels to put next to a page smaller than the texture array's layers (aw × ah): its last column and row
   * repeated (up to 64 texels out, and the corner), as [{ source, x, y }] (source: an OffscreenCanvas). Without them the
   * padding is transparent, and the mipmaps of a part drawn small mix it into the page's far edges (a see-through
   * seam); with them a page samples as clamped to its own edge at every mipmap level a part is drawn with (as the C
   * renderer does). [] for a page as large as the layers, or a source that cannot be drawn on a canvas.
   */
  static pageEdges(im, aw, ah) {
    const w = im.width, h = im.height, mx = Math.min(64, aw - w), my = Math.min(64, ah - h), out = [];
    if ((mx <= 0 && my <= 0) || typeof OffscreenCanvas === 'undefined') return out;
    const strip = (sx, sy, sw, sh, dw, dh, x, y) => {
      const c = new OffscreenCanvas(dw, dh), g = c.getContext('2d');
      g.imageSmoothingEnabled = false; // each source texel repeated as it is
      g.globalCompositeOperation = 'copy';
      g.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
      out.push({ source: c, x, y });
    };
    try {
      if (mx > 0) strip(w - 1, 0, 1, h, mx, h, w, 0);
      if (my > 0) strip(0, h - 1, w, 1, w, my, 0, h);
      if (mx > 0 && my > 0) strip(w - 1, h - 1, 1, 1, mx, my, w, h);
    } catch { return []; }
    return out;
  }

  // the GPU objects of the current model (not the shaders, the atlas or the mask images)
  disposeModel() {
    const gl = this.gl;
    if (!this.vbo) return;
    for (const b of Object.values(this.vbo)) gl.deleteBuffer(b);
    gl.deleteBuffer(this.ibo);
    for (const t of [this.entryTex, this.xweightTex, this.partTex]) gl.deleteTexture(t);
    for (const v of [this.vaoGpu, this.vaoCpu]) gl.deleteVertexArray(v);
    this.vbo = null;
  }

  /** Frees every GPU object this renderer made. */
  dispose() {
    const gl = this.gl;
    this.disposeModel();
    for (const t of [this.atlas, this.frameTex, ...this.maskTex]) if (t) gl.deleteTexture(t);
    if (this.maskFbo) gl.deleteFramebuffer(this.maskFbo);
    for (const p of [this.gpu, this.cpu, this.gpuMask, this.cpuMask]) if (p) gl.deleteProgram(p.p);
    this.atlas = this.frameTex = this.maskFbo = null;
    this.maskTex = [];
    this.images = null;
  }

  ensureFrameCapacity(count) {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil((count * this.stride) / FRAME_W));
    if (rows > this.frameRows) {
      if (this.frameTex) gl.deleteTexture(this.frameTex);
      this.frameRows = Math.max(rows, this.frameRows * 2);
      this.staging = new Float32Array(FRAME_W * this.frameRows * 4);
      this.frameTex = this.floatTex(FRAME_W, this.frameRows, null);
    }
    return rows;
  }

  // screen-sized mask images (4 channels each) and the framebuffer that draws them all at once
  ensureMasks(width, height) {
    const gl = this.gl;
    if (this.maskSize[0] === width && this.maskSize[1] === height) return;
    this.maskTex.forEach((t) => gl.deleteTexture(t));
    if (this.maskFbo) gl.deleteFramebuffer(this.maskFbo);
    const n = Math.ceil(this.model.maskChannels / 4);
    this.maskTex = Array.from({ length: n }, () => this.texture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null));
    const prev = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    this.maskFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.maskFbo);
    this.maskTex.forEach((t, i) => gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(this.maskTex.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prev);
    this.maskSize = [width, height];
  }

  setUniforms(prog, width, height) {
    const gl = this.gl, model = this.model, u = prog.u;
    gl.useProgram(prog.p);
    gl.uniform1i(u.uFrame, 0); gl.uniform1i(u.uEntries, 1); gl.uniform1i(u.uAtlas, 2); gl.uniform1i(u.uParts, 3);
    gl.uniform1i(u.uMask0, 4); gl.uniform1i(u.uMask1, 5); gl.uniform1i(u.uMask2, 6); gl.uniform1i(u.uMask3, 7);
    gl.uniform1i(u.uXWeights, 8);
    gl.uniform1i(u.uFrameW, FRAME_W); gl.uniform1i(u.uStride, this.stride);
    gl.uniform1i(u.uSkinT, model.skinOffset / 4); gl.uniform1i(u.uOpF, model.opacityOffset);
    gl.uniform1i(u.uMorphF, model.morphOffset); gl.uniform1i(u.uColorF, model.colorOffset); gl.uniform1i(u.uEntryW, ENTRY_W);
    gl.uniform4f(u.uView, 2 / width, -2 / height, -1, 1);
    gl.uniform2fv(u.uTexScale, this.texScale);
    gl.uniform2f(u.uAtlasSize, this.atlasSize[0], this.atlasSize[1]);
  }

  /** 'linear' (smooth, mipmapped) or 'nearest' (each texel as it is, for pixel art). Takes effect at once. */
  setSampling(mode) {
    this.sampling = mode === 'nearest' ? 'nearest' : 'linear';
    this.applySampling();
  }
  applySampling() {
    const gl = this.gl, T = gl.TEXTURE_2D_ARRAY, near = this.sampling === 'nearest';
    if (!this.atlas) return;
    gl.bindTexture(T, this.atlas);
    gl.texParameteri(T, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(T, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
  }

  // blend function for a run of parts (see the shader)
  setBlend(cls) {
    const gl = this.gl;
    if (this.dual) {
      const ext = this.dual;
      gl.blendFuncSeparate(gl.ONE, ext.SRC1_COLOR_WEBGL, gl.ONE, ext.SRC1_ALPHA_WEBGL);
    } else if (cls === 1) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE); // multiply
    else if (cls === 2) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // screen
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // the blend runs that draw `inst` in its draw order (0.8): the stored order's, or a slot's
  runsFor(inst) {
    if (!this.model.hasDrawOrder) return this.runs;
    const key = inst.drawOrderKey();
    if (key === 0) return this.runs;
    const list = inst.drawOrder(), use = ++this.orderUse;
    let o = this.orders.get(key);
    if (o && o.list.length === list.length && o.list.every((x, i) => x === list[i])) { o.used = use; return o.runs; }
    if (o) this.orders.delete(key); // another list with the same key: its slot is reused
    let slot = o ? o.slot : this.orders.size;
    if (!o && slot >= ORDER_SLOTS) { // the order used longest ago gives up its slot
      let old = null;
      for (const [k, x] of this.orders) if (!old || x.used < old[1].used) old = [k, x];
      this.orders.delete(old[0]);
      slot = old[1].slot;
    }
    o = { list: list.slice(), runs: this.layOut(list, slot), slot, used: use };
    this.orders.set(key, o);
    return o.runs;
  }

  /**
   * Draws the instances (already updated) into the bound framebuffer.
   * mode 'gpu': vertices deformed in the shader; one instanced draw (plus one
   *             for masks, and one per blend run without dual-source blending).
   * mode 'cpu': like Live2D/Spine runtimes, deform every vertex on the CPU
   *             and upload it, drawing character by character (for comparison).
   * Returns { drawCalls, uploadBytes, cpuDeformMs }.
   */
  draw(instances, width, height, mode = 'gpu') {
    const gl = this.gl, model = this.model, n = instances.length;
    const ff = model.frameFloats;
    const rows = this.ensureFrameCapacity(n);
    for (let i = 0; i < n; i++) this.staging.set(instances[i].frame(), i * ff);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FRAME_W, rows, gl.RGBA, gl.FLOAT, this.staging, 0);
    let uploadBytes = n * ff * 4, drawCalls = 0, cpuDeformMs = 0;
    const target = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);

    const masks = this.masks && n > 0;
    if (masks) this.ensureMasks(width, height); // (creating textures changes the bound unit's texture)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.entryTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.partTex);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, this.xweightTex);
    for (let k = 0; k < 4; k++) {
      gl.activeTexture(gl.TEXTURE4 + k);
      gl.bindTexture(gl.TEXTURE_2D, masks ? this.maskTex[Math.min(k, this.maskTex.length - 1)] : null);
    }
    gl.enable(gl.BLEND);

    const gpu = mode === 'gpu';
    const main = gpu ? this.gpu : this.cpu, maskProg = gpu ? this.gpuMask : this.cpuMask;
    // draws instances [first, first + count) with the mask pass first (runs: in their draw order)
    const drawSome = (first, count, runs = this.runs) => {
      if (masks) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.maskFbo);
        gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
        for (let i = 1; i < this.maskTex.length; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]);
        this.setUniforms(maskProg, width, height);
        gl.uniform1i(maskProg.u.uInstanceBase, first);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawElementsInstanced(gl.TRIANGLES, this.maskCount, gl.UNSIGNED_INT, this.maskFirst * 4, count);
        gl.blendEquation(gl.FUNC_ADD);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
        drawCalls++;
      }
      this.setUniforms(main, width, height);
      gl.uniform1i(main.u.uInstanceBase, first);
      for (const r of runs) {
        this.setBlend(r.cls);
        gl.drawElementsInstanced(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, r.first * 4, count);
        drawCalls++;
      }
    };

    if (gpu) {
      gl.bindVertexArray(this.vaoGpu);
      if (masks && this.strictMasks) for (let i = 0; i < n; i++) drawSome(i, 1, this.runsFor(instances[i]));
      else if (!model.hasDrawOrder) drawSome(0, n);
      else { // characters next to each other with the same draw order are drawn together (0.8)
        for (let i = 0; i < n;) {
          const runs = this.runsFor(instances[i]);
          let j = i + 1;
          while (j < n && this.runsFor(instances[j]) === runs) j++;
          drawSome(i, j - i, runs);
          i = j;
        }
      }
    } else {
      const rt = model.rt, nv = model.vertexCount;
      if (!this.scratch) this.scratch = rt.alloc(8 * nv);
      gl.bindVertexArray(this.vaoCpu);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo.dynPos);
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        rt.ex.ugo_deform_cpu(instances[i].ptr, this.scratch);
        cpuDeformMs += performance.now() - t0;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, rt.f32(this.scratch, 2 * nv));
        drawSome(i, 1, this.runsFor(instances[i]));
      }
      uploadBytes += n * nv * 8;
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    return { drawCalls, uploadBytes, cpuDeformMs };
  }
}

/** Loads an image for texImage2D (works with URLs and Blobs). */
export async function loadImage(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  // ImageBitmaps ignore UNPACK_PREMULTIPLY_ALPHA_WEBGL, so premultiply here
  return createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
}
