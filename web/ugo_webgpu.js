// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// WebGPU renderer for Ugo9 models: the same picture as UgoRenderer (WebGL2), drawn with WebGPU.
//
//   import { createRenderer } from './ugo_webgpu.js';
//   const r = await createRenderer(canvas, model, images);   // WebGPU when it can show frames, else WebGL2
//   r.kind;                                                  // 'webgpu' or 'webgl2'
//   r.draw(instances, canvas.width, canvas.height);          // WebGPU clears to transparent first (see draw)
//
// Like UgoRenderer: vertices are deformed in the vertex shader from each character's frame block, every
// character in one instanced draw (one per blend run: multiply and screen need their own blend state), masks
// drawn first into screen-sized mask images, draw orders that change (0.8) kept as index slots. The
// shaders are the WebGL2 ones in WGSL, reading the same tables from storage buffers. Plain ES module.
import { UgoRenderer } from './ugo.js';

const PART_HIDDEN = 2, PART_SOLID = 4;
const ORDER_SLOTS = 8;

const WGSL = /* wgsl */ `
struct U {
  view: vec4f,          // pixel -> clip: scale.xy, offset.zw
  atlasSize: vec2f,     // layer size in texels
  stride: u32,          // texels (vec4) per instance in the frame buffer
  skinT: u32,           // texel of the first skin matrix
  opF: u32, morphF: u32, colorF: u32, pad: u32,
  texScale: array<vec4f, 32>, // each texture's size over the layer size, two per vec4
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> frame: array<vec4f>;    // per-instance frame blocks
@group(0) @binding(2) var<storage, read> entries: array<vec4f>;  // sparse morph deltas: (morph, dx, dy, 0)
@group(0) @binding(3) var<storage, read> xweights: array<vec4f>; // influences beyond four: (bone, weight, 0, 0)
@group(0) @binding(4) var<storage, read> parts: array<vec4u>;    // 2 per part (see UgoRenderer's uParts)
@group(0) @binding(5) var atlas: texture_2d_array<f32>;
@group(0) @binding(6) var atlasSampler: sampler;
@group(1) @binding(0) var mask0: texture_2d<f32>;
@group(1) @binding(1) var mask1: texture_2d<f32>;
@group(1) @binding(2) var mask2: texture_2d<f32>;
@group(1) @binding(3) var mask3: texture_2d<f32>;

override MASK_PASS = false;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacity: f32,
  @location(2) @interpolate(flat) layer: u32,
  @location(3) @interpolate(flat) uvMax: vec2f,
  @location(4) @interpolate(flat) info: vec4u,
  @location(5) @interpolate(flat) cx: vec3f,
  @location(6) @interpolate(flat) cy: vec3f,
};

fn frameFloat(base: u32, f: u32) -> f32 { return frame[base + (f >> 2u)][f & 3u]; }
fn warpPoint(t: u32, k: u32) -> vec2f { let v = frame[t + (k >> 1u)]; return select(v.zw, v.xy, (k & 1u) == 0u); }
fn bspline(t: f32) -> vec4f { let s = 1.0 - t; let t2 = t * t; let t3 = t2 * t; return vec4f(s * s * s, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0; }
fn bsplineD(t: f32) -> vec4f { let s = 1.0 - t; let t2 = t * t; return vec4f(-0.5 * s * s, -2.0 * t + 1.5 * t2, 0.5 + t - 1.5 * t2, 0.5 * t2); }
// a warp grid's surface at cell coordinates p: uniform cubic B-spline over the (cols+3) x (rows+3) points from texel t
fn warpAt(t: u32, w: vec4u, p: vec2f) -> vec2f {
  let size = vec2f(w.yz);
  let q = clamp(p, vec2f(0.0), size);
  let c = min(floor(q), size - 1.0);
  let f = q - c;
  let e = p - q;
  let bu = bspline(f.x); let bv = bspline(f.y); let du = bsplineD(f.x); let dv = bsplineD(f.y);
  let W = w.y + 3u;
  let k0 = u32(c.y) * W + u32(c.x);
  var o = vec2f(0.0);
  for (var j = 0u; j < 4u; j++) {
    for (var i = 0u; i < 4u; i++) {
      o += (bu[i] * bv[j] + du[i] * bv[j] * e.x + bu[i] * dv[j] * e.y) * warpPoint(t, k0 + j * W + i);
    }
  }
  return o;
}
fn skin(t: u32, p: vec2f) -> vec2f {
  let m0 = frame[t]; let m1 = frame[t + 1u];
  return vec2f(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
}

fn finish(o: vec2f, uv: vec2f, part: u32, base: u32) -> VOut {
  var out: VOut;
  let info = parts[2u * part];
  out.info = info;
  let x0 = frame[base]; let x1 = frame[base + 1u];
  let world = vec2f(x0.x * o.x + x0.z * o.y + x1.x, x0.y * o.x + x0.w * o.y + x1.y);
  let tex = min(info.z >> 16u, 63u);
  let s4 = u.texScale[tex >> 1u];
  let ts = select(s4.zw, s4.xy, (tex & 1u) == 0u);
  out.layer = tex;
  out.uv = uv * ts;
  out.uvMax = ts - 0.5 / u.atlasSize;
  var op = 1.0; // masks ignore opacity
  if (!MASK_PASS) {
    op = frameFloat(base, u.opF + part);
    if ((info.z & ${PART_HIDDEN}u) != 0u) { op = 0.0; }
  }
  out.opacity = op;
  out.cx = vec3f(1.0); out.cy = vec3f(0.0);
  if (info.w > 0u) {
    let c = base + (u.colorF >> 2u) + 2u * (info.w - 1u);
    out.cx = frame[c].xyz; out.cy = frame[c + 1u].xyz;
  }
  out.pos = select(vec4f(2.0, 2.0, 2.0, 1.0), vec4f(world * u.view.xy + u.view.zw, 0.0, 1.0), op > 0.0);
  return out;
}

@vertex fn vsGpu(@builtin(instance_index) inst: u32, @location(0) aPos: vec2f, @location(1) aUV: vec2f, @location(2) aJoints: vec4u,
                 @location(3) aWeights: vec4f, @location(4) aPart: u32, @location(5) aCsr: vec2u, @location(6) aXw: vec2u) -> VOut {
  let base = inst * u.stride;
  var p = aPos;
  for (var e = 0u; e < aCsr.y; e++) {
    let en = entries[aCsr.x + e];
    p += frameFloat(base, u.morphF + u32(en.x)) * en.yz;
  }
  var o = vec2f(0.0);
  let warp = parts[2u * aPart + 1u];
  if (warp.x > 0u) {
    o = warpAt(base + warp.x - 1u, warp, p); // in a warp grid: no bones
  } else {
    for (var j = 0u; j < 4u; j++) {
      if (aWeights[j] > 0.0) { o += aWeights[j] * skin(base + u.skinT + 2u * aJoints[j], p); }
    }
    for (var e = 0u; e < aXw.y; e++) {
      let xw = xweights[aXw.x + e];
      o += xw.y * skin(base + u.skinT + 2u * u32(xw.x), p);
    }
  }
  return finish(o, aUV, aPart, base);
}

@vertex fn vsCpu(@builtin(instance_index) inst: u32, @location(0) aPos: vec2f, @location(1) aUV: vec2f, @location(4) aPart: u32) -> VOut {
  return finish(aPos, aUV, aPart, inst * u.stride); // already deformed on the CPU
}

struct MaskOut { @location(0) m0: vec4f, @location(1) m1: vec4f, @location(2) m2: vec4f, @location(3) m3: vec4f };
fn bits(w: u32, shift: u32) -> vec4f { return vec4f((vec4u(w) >> (vec4u(0u, 1u, 2u, 3u) + shift)) & vec4u(1u)); }
@fragment fn fsMask(v: VOut) -> MaskOut {
  let t = textureSample(atlas, atlasSampler, min(v.uv, v.uvMax), v.layer).a;
  let a = select(t, 1.0, (v.info.z & ${PART_SOLID}u) != 0u);
  var o: MaskOut;
  o.m0 = bits(v.info.x, 0u) * a; o.m1 = bits(v.info.x, 4u) * a;
  o.m2 = bits(v.info.x, 8u) * a; o.m3 = bits(v.info.x, 12u) * a;
  return o;
}

fn maskAt(ch: u32, p: vec2i) -> f32 {
  var m: vec4f;
  if (ch < 4u) { m = textureLoad(mask0, p, 0); } else if (ch < 8u) { m = textureLoad(mask1, p, 0); }
  else if (ch < 12u) { m = textureLoad(mask2, p, 0); } else { m = textureLoad(mask3, p, 0); }
  return m[ch & 3u];
}
@fragment fn fsMain(v: VOut) -> @location(0) vec4f {
  var c = textureSample(atlas, atlasSampler, min(v.uv, v.uvMax), v.layer); // premultiplied
  c = vec4f(c.rgb * v.cx + c.a * v.cy, c.a);
  var k = v.opacity;
  if ((v.info.y & 32u) != 0u) {
    let m = maskAt(v.info.y & 15u, vec2i(v.pos.xy));
    k *= select(m, 1.0 - m, (v.info.y & 16u) != 0u);
  }
  c *= k;
  if (((v.info.z >> 8u) & 255u) == 1u) { c.a = 0.0; } // add: rgb = s + d, alpha unchanged
  return c;                                         // multiply / screen: the run's blend state does the rest
}

// mipmaps: each level from the one above (a 2x2 box through the linear sampler)
struct BOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsBlit(@builtin(vertex_index) i: u32) -> BOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: BOut; o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}
@group(0) @binding(0) var blitSrc: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;
@fragment fn fsBlit(v: BOut) -> @location(0) vec4f { return textureSample(blitSrc, blitSampler, v.uv); }
`;

const BLENDS = [
  { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }, // normal, add
  { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } }, // multiply
  { color: { srcFactor: 'one', dstFactor: 'one-minus-src' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }, // screen
];
const MAX_BLEND = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } };

export class UgoGPURenderer {
  /**
   * device: a GPUDevice. context: a canvas's 'webgpu' context (configured here with `format` and premultiplied alpha),
   * or null to draw only into views given to draw(). images, options.strictMasks and options.sampling: as UgoRenderer.
   * options.format: the colour format drawn into (default: the canvas's preferred one).
   */
  constructor(device, context, model, images, options = {}) {
    this.device = device;
    this.context = context;
    this.kind = 'webgpu';
    this.strictMasks = !!options.strictMasks;
    this.sampling = options.sampling === 'nearest' ? 'nearest' : 'linear';
    this.format = options.format || (typeof navigator !== 'undefined' && navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm');
    if (context) context.configure({ device, format: this.format, alphaMode: 'premultiplied' });
    this.dual = null; // blend runs, as UgoRenderer without dual-source blending
    this.module = device.createShaderModule({ code: WGSL });
    const tex = (n) => ({ binding: n, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
    const sto = (n) => ({ binding: n, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } });
    this.layout0 = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }, sto(1), sto(2), sto(3),
      { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }] });
    this.layout1 = device.createBindGroupLayout({ entries: [tex(0), tex(1), tex(2), tex(3)].map((e) => ({ ...e, texture: { sampleType: 'unfilterable-float' } })) });
    this.pipelines = new Map();
    this.uniform = device.createBuffer({ size: 560, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameBuf = null;
    this.frameCap = 0;
    this.maskTex = [];
    this.maskSize = [0, 0];
    this.dummyMask = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.timings = { setModel: 0, setImages: 0 };
    this.setModel(model, images);
  }

  pipeline(kind, cls, maskTargets = 0) { // kind 'gpu' | 'cpu'; cls: blend class, or -1 for the mask pass
    const key = `${kind}:${cls}:${maskTargets}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    const f2 = (loc) => ({ shaderLocation: loc, offset: 0, format: 'float32x2' });
    const buffers = kind === 'gpu'
      ? [{ arrayStride: 8, attributes: [f2(0)] }, { arrayStride: 8, attributes: [f2(1)] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint16x4' }] },
        { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'uint32' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 5, offset: 0, format: 'uint32x2' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 6, offset: 0, format: 'uint32x2' }] }]
      : [{ arrayStride: 8, attributes: [f2(0)] }, { arrayStride: 8, attributes: [f2(1)] },
        { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'uint32' }] }];
    const mask = cls < 0;
    p = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: mask ? [this.layout0] : [this.layout0, this.layout1] }),
      vertex: { module: this.module, entryPoint: kind === 'gpu' ? 'vsGpu' : 'vsCpu', buffers, constants: { MASK_PASS: mask ? 1 : 0 } },
      fragment: {
        module: this.module, entryPoint: mask ? 'fsMask' : 'fsMain',
        targets: mask ? Array.from({ length: maskTargets }, () => ({ format: 'rgba8unorm', blend: MAX_BLEND })) : [{ format: this.format, blend: BLENDS[cls] }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, p);
    return p;
  }

  /** Switches to another model; the atlas is kept when `images` are the same objects (see UgoRenderer.setModel). */
  setModel(model, images) {
    const device = this.device, t0 = performance.now();
    this.disposeModel();
    this.model = model;
    const mesh = model.meshData(), info = model.partData();
    this.mesh = mesh;
    this.masks = model.maskChannels > 0;
    if (this.maskChannels !== model.maskChannels) this.maskSize = [0, 0];
    this.maskChannels = model.maskChannels;

    const partTab = new Uint32Array(Math.max(1, 2 * model.partCount) * 4);
    info.masks.forEach((k) => { for (const p of k.parts) partTab[8 * p] |= 1 << k.channel; });
    info.parts.forEach((p, i) => {
      if (p.mask >= 0) partTab[8 * i + 1] = info.masks[p.mask].channel | (p.flags & 1 ? 16 : 0) | 32;
      partTab[8 * i + 2] = p.flags | (p.blend << 8) | (Math.min(p.texture, images.length - 1, 63) << 16);
      partTab[8 * i + 3] = p.color + 1;
      if (p.warp >= 0) { const w = info.warps[p.warp]; partTab.set([w.offset / 4 + 1, w.cols, w.rows, 0], 8 * i + 4); }
    });

    // indices: the drawn parts in order, then the mask parts, then ORDER_SLOTS copies for changing draw orders
    const maskParts = new Set(info.masks.flatMap((k) => k.parts));
    const shown = (p) => !(p.flags & PART_HIDDEN) && p.indexCount;
    let nDrawn = 0, nMask = 0;
    info.parts.forEach((p, i) => { if (shown(p)) nDrawn += p.indexCount; if (maskParts.has(i)) nMask += p.indexCount; });
    const slots = model.hasDrawOrder ? ORDER_SLOTS : 0;
    const allIdx = new Uint32Array(Math.max(1, nDrawn * (1 + slots) + nMask));
    const blendClass = (b) => (b < 2 ? 0 : b - 1);
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
    info.parts.forEach((p, i) => { if (maskParts.has(i)) { allIdx.set(mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount), masked); masked += p.indexCount; } });
    this.maskFirst = nDrawn;
    this.maskCount = nMask;
    this.orders = new Map();
    this.orderUse = 0;
    const orderSlot = (k) => nDrawn + nMask + k * nDrawn;
    // used by UgoRenderer.prototype.runsFor: writes a slot's indices (see draw() for why a frame may be split)
    this.layOut = (list, k) => {
      const part = new Uint32Array(nDrawn), runs = layOut(list, part, 0);
      for (const r of runs) r.first += orderSlot(k);
      if (this.beforeSlotWrite) this.beforeSlotWrite(k);
      device.queue.writeBuffer(this.ibo, 4 * orderSlot(k), part);
      return runs;
    };

    const buf = (data, usage) => {
      const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
      const b = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
      if (data.byteLength) device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength & ~3);
      return b;
    };
    const V = GPUBufferUsage.VERTEX, S = GPUBufferUsage.STORAGE;
    this.vbo = {
      pos: buf(mesh.positions, V), uv: buf(mesh.uvs, V), joints: buf(mesh.joints, V), weights: buf(mesh.weights, V),
      parts: buf(mesh.parts, V), csr: buf(mesh.csr, V), xcsr: buf(mesh.xcsr, V),
    };
    this.ibo = buf(allIdx, GPUBufferUsage.INDEX);
    this.entryBuf = buf(new Float32Array(mesh.entries), S);
    this.xweightBuf = buf(new Float32Array(mesh.extraWeights), S);
    this.partBuf = buf(partTab, S);
    this.dynPos = null;

    const same = this.images && this.images.length === images.length && this.images.every((im, i) => im === images[i]);
    if (!same) this.setImages(images);
    else this.timings.setImages = 0;
    this.stride = model.frameFloats / 4;
    this.frameCap = 0;
    this.bind0 = null;
    this.timings.setModel = performance.now() - t0;
  }

  /** Every atlas page in one texture array (premultiplied, mipmapped). */
  setImages(images) {
    const device = this.device, t0 = performance.now();
    if (this.atlas) this.atlas.destroy();
    this.images = images.slice();
    const pages = images.slice(0, 64);
    const aw = Math.max(...pages.map((im) => im.width)), ah = Math.max(...pages.map((im) => im.height));
    this.texScale = new Float32Array(128).fill(1);
    pages.forEach((im, i) => { this.texScale[2 * i] = im.width / aw; this.texScale[2 * i + 1] = im.height / ah; });
    this.atlasSize = [aw, ah];
    const levels = 1 + Math.floor(Math.log2(Math.max(aw, ah)));
    this.atlas = device.createTexture({
      size: [aw, ah, Math.max(pages.length, 2)], // 2+ layers: a 1-layer texture's default view is 2d, not 2d-array
      format: 'rgba8unorm', mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    pages.forEach((im, i) => {
      device.queue.copyExternalImageToTexture({ source: im }, { texture: this.atlas, origin: [0, 0, i], premultipliedAlpha: true }, [im.width, im.height]);
      // a smaller page's edge texels repeated into the padding next to it (else the mipmaps mix the padding in)
      for (const e of UgoRenderer.pageEdges(im, aw, ah)) device.queue.copyExternalImageToTexture({ source: e.source }, { texture: this.atlas, origin: [e.x, e.y, i], premultipliedAlpha: true }, [e.source.width, e.source.height]);
    });
    this.makeMipmaps(levels, Math.max(pages.length, 2));
    this.makeSampler();
    this.bind0 = null;
    this.timings.setImages = performance.now() - t0;
  }

  makeMipmaps(levels, layers) {
    const device = this.device;
    if (!this.blit) {
      this.blit = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vsBlit' },
        fragment: { module: this.module, entryPoint: 'fsBlit', targets: [{ format: 'rgba8unorm' }] },
      });
      this.blitSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    }
    const enc = device.createCommandEncoder();
    for (let l = 0; l < layers; l++) {
      for (let m = 1; m < levels; m++) {
        const view = (level) => this.atlas.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: l, arrayLayerCount: 1 });
        const bg = device.createBindGroup({ layout: this.blit.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(m - 1) }, { binding: 1, resource: this.blitSampler }] });
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: view(m), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] });
        pass.setPipeline(this.blit); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
      }
    }
    device.queue.submit([enc.finish()]);
  }

  makeSampler() {
    const near = this.sampling === 'nearest';
    this.sampler = this.device.createSampler({
      minFilter: near ? 'nearest' : 'linear', magFilter: near ? 'nearest' : 'linear', mipmapFilter: near ? 'nearest' : 'linear',
      ...(near ? { lodMaxClamp: 0 } : {}),
    });
    this.bind0 = null;
  }

  /** 'linear' (smooth, mipmapped) or 'nearest' (each texel as it is). */
  setSampling(mode) { this.sampling = mode === 'nearest' ? 'nearest' : 'linear'; this.makeSampler(); }

  // the current model's buffers (not the pipelines, the atlas or the mask images)
  disposeModel() {
    if (!this.vbo) return;
    for (const b of [...Object.values(this.vbo), this.ibo, this.entryBuf, this.xweightBuf, this.partBuf, this.dynPos, this.frameBuf]) if (b) b.destroy();
    this.vbo = this.dynPos = this.frameBuf = null;
  }

  /** Frees every GPU object this renderer made (not the device). */
  dispose() {
    this.disposeModel();
    for (const t of [this.atlas, ...this.maskTex, this.dummyMask]) if (t) t.destroy();
    this.uniform.destroy();
    this.atlas = null; this.maskTex = []; this.images = null;
  }

  ensureFrameCapacity(count) {
    const need = Math.max(1, count) * this.stride;
    if (need > this.frameCap) {
      if (this.frameBuf) this.frameBuf.destroy();
      this.frameCap = Math.max(need, 2 * this.frameCap);
      this.frameBuf = this.device.createBuffer({ size: 16 * this.frameCap, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.staging = new Float32Array(4 * this.frameCap);
      this.bind0 = null;
    }
  }

  ensureMasks(width, height) {
    if (this.maskSize[0] === width && this.maskSize[1] === height) return;
    this.maskTex.forEach((t) => t.destroy());
    const n = Math.ceil(this.model.maskChannels / 4);
    this.maskTex = Array.from({ length: n }, () => this.device.createTexture({
      size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    this.maskSize = [width, height];
    this.bind1 = null;
  }

  runsFor(inst) { return UgoRenderer.prototype.runsFor.call(this, inst); }

  /**
   * Draws the instances (already updated). target: a GPUTextureView in this.format (default: the canvas's current
   * texture). options.clear: [r, g, b, a] (premultiplied) to clear the target first (default transparent), or null
   * to draw over what is there. mode 'gpu' or 'cpu' as UgoRenderer. Returns { drawCalls, uploadBytes, cpuDeformMs }.
   */
  draw(instances, width, height, mode = 'gpu', target = null, options = {}) {
    const device = this.device, model = this.model, n = instances.length, ff = model.frameFloats;
    const view = target || this.context.getCurrentTexture().createView();
    this.ensureFrameCapacity(n);
    for (let i = 0; i < n; i++) this.staging.set(instances[i].frame(), i * ff);
    if (n) device.queue.writeBuffer(this.frameBuf, 0, this.staging.buffer, 0, 4 * n * ff);
    const u = new ArrayBuffer(560), uf = new Float32Array(u), uu = new Uint32Array(u);
    uf.set([2 / width, -2 / height, -1, 1, this.atlasSize[0], this.atlasSize[1]]);
    uu.set([this.stride, model.skinOffset / 4, model.opacityOffset, model.morphOffset, model.colorOffset, 0], 6);
    uf.set(this.texScale, 12);
    device.queue.writeBuffer(this.uniform, 0, u);
    let uploadBytes = n * ff * 4, drawCalls = 0, cpuDeformMs = 0;

    const masks = this.masks && n > 0;
    if (masks) this.ensureMasks(width, height);
    if (!this.bind0) {
      this.bind0 = device.createBindGroup({ layout: this.layout0, entries: [
        { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.frameBuf } },
        { binding: 2, resource: { buffer: this.entryBuf } }, { binding: 3, resource: { buffer: this.xweightBuf } },
        { binding: 4, resource: { buffer: this.partBuf } },
        { binding: 5, resource: this.atlas.createView({ dimension: '2d-array' }) }, { binding: 6, resource: this.sampler }] });
    }
    if (!this.bind1) {
      const m = (k) => (this.maskTex.length ? this.maskTex[Math.min(k, this.maskTex.length - 1)] : this.dummyMask).createView();
      this.bind1 = device.createBindGroup({ layout: this.layout1, entries: [0, 1, 2, 3].map((k) => ({ binding: k, resource: m(k) })) });
    }

    const gpu = mode === 'gpu';
    const kind = gpu ? 'gpu' : 'cpu';
    let enc = device.createCommandEncoder(), clear = options.clear === undefined ? [0, 0, 0, 0] : options.clear;
    // a draw order's indices are written with queue.writeBuffer, which lands before any command not yet
    // submitted: when a slot already drawn from this frame is about to be rewritten, submit what came before
    const usedSlots = new Set();
    this.beforeSlotWrite = (k) => {
      if (!usedSlots.has(k)) return;
      device.queue.submit([enc.finish()]);
      enc = device.createCommandEncoder();
      usedSlots.clear();
    };
    const setVertices = (pass, i) => {
      if (gpu) ['pos', 'uv', 'joints', 'weights', 'parts', 'csr', 'xcsr'].forEach((k, j) => pass.setVertexBuffer(j, this.vbo[k]));
      else { pass.setVertexBuffer(0, this.dynPos, 8 * model.vertexCount * i); pass.setVertexBuffer(1, this.vbo.uv); pass.setVertexBuffer(2, this.vbo.parts); }
      pass.setIndexBuffer(this.ibo, 'uint32');
    };
    const drawSome = (first, count, runs) => {
      for (const r of runs) if (r.first >= this.maskFirst + this.maskCount) usedSlots.add(Math.floor((r.first - this.maskFirst - this.maskCount) / Math.max(1, this.maskFirst)));
      if (masks) {
        const pass = enc.beginRenderPass({ colorAttachments: this.maskTex.map((t) => ({ view: t.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' })) });
        pass.setPipeline(this.pipeline(kind, -1, this.maskTex.length));
        pass.setBindGroup(0, this.bind0);
        setVertices(pass, first);
        if (this.maskCount) pass.drawIndexed(this.maskCount, count, this.maskFirst, 0, first);
        pass.end();
        drawCalls++;
      }
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: clear ? 'clear' : 'load', clearValue: clear || [0, 0, 0, 0], storeOp: 'store' }] });
      clear = null;
      pass.setBindGroup(0, this.bind0);
      pass.setBindGroup(1, this.bind1);
      setVertices(pass, first);
      for (const r of runs) {
        pass.setPipeline(this.pipeline(kind, r.cls));
        if (r.count) pass.drawIndexed(r.count, count, r.first, 0, first);
        drawCalls++;
      }
      pass.end();
    };

    if (gpu) {
      if (masks && this.strictMasks) for (let i = 0; i < n; i++) drawSome(i, 1, this.runsFor(instances[i]));
      else if (!model.hasDrawOrder) drawSome(0, n, this.runs);
      else {
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
      if (!this.scratch) this.scratch = rt.alloc(8 * nv + 8);
      const size = Math.max(16, 8 * nv * n);
      if (!this.dynPos || this.dynPos.size < size) { if (this.dynPos) this.dynPos.destroy(); this.dynPos = device.createBuffer({ size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); }
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        rt.ex.ugo_deform_cpu(instances[i].ptr, this.scratch);
        cpuDeformMs += performance.now() - t0;
        device.queue.writeBuffer(this.dynPos, 8 * nv * i, rt.f32(this.scratch, 2 * nv));
      }
      for (let i = 0; i < n; i++) drawSome(i, 1, this.runsFor(instances[i]));
      uploadBytes += n * nv * 8;
    }
    if (clear) { // nothing drawn: still clear
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', clearValue: clear, storeOp: 'store' }] });
      pass.end();
    }
    device.queue.submit([enc.finish()]);
    this.beforeSlotWrite = null;
    return { drawCalls, uploadBytes, cpuDeformMs };
  }
}

/**
 * Whether this device can show frames on a canvas: one clear presented on a canvas of its own. Some setups give
 * an adapter that renders but cannot present (headless browsers on software GPUs: the submit then fails), and a
 * canvas cannot change to WebGL2 once it has a WebGPU context, so this is asked before touching the real canvas.
 */
async function canPresent(device) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const ctx = c.getContext('webgpu');
    ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
    const enc = device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] }).end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    ctx.unconfigure();
    return true;
  } catch {
    return false;
  }
}

/**
 * A renderer for a canvas: UgoGPURenderer when WebGPU has an adapter that can show frames (and options.webgpu is
 * not false), else UgoRenderer on WebGL2 (kind 'webgl2'; draw into the canvas as with UgoRenderer, clearing it yourself).
 */
export async function createRenderer(canvas, model, images, options = {}) {
  if (options.webgpu !== false && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const probe = await navigator.gpu.requestAdapter();
      if (probe && await canPresent(await probe.requestDevice())) {
        const adapter = await navigator.gpu.requestAdapter(); // an adapter gives one device: a fresh one for drawing
        const device = adapter && await adapter.requestDevice();
        if (device) return new UgoGPURenderer(device, canvas.getContext('webgpu'), model, images, options);
      }
    } catch { /* fall back to WebGL2 */ }
  }
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, ...(options.contextAttributes || {}) });
  if (!gl) throw new Error('ugo: neither WebGPU nor WebGL2 is available');
  const r = new UgoRenderer(gl, model, images, options);
  r.kind = 'webgl2';
  return r;
}
