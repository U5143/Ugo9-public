// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 characters inside a three.js 3D scene, with every Ugo9 feature
// (parameters, fades, tracking, physics, masks, blend modes, colours, warp
// grids). The vertex shader is the same as the 2D renderer's; the character
// is a flat sheet placed by the object's matrix.
//
//   const factory = new UgoThreeCharacterFactory(THREE, model, textures); // one THREE.Texture per model texture
//   const ch = factory.create({ metresPerPixel: 1.6 / 600, billboard: true });
//   scene.add(ch);
//   // each frame: ch.instance.reset(); ch.instance.play('idle', t); ch.place(); ch.instance.update(dt); ch.sync(renderer);
//   // (place() tells the core where the object is, so swaying chains feel it move; optional)
//   // expressions (format 0.8): ch.instance is web/ugo.js's UgoInstance, so the Web runtime's
//   // UgoExpressionMixer works as is: mixer.show('smile'); each frame, after play/set and before
//   // update: mixer.update(dt).apply(ch.instance). Presets: model.loadExpressions(json) (see web/ugo.js)
//
// Masks: each character draws its mask parts into its own images laid over
// the model's canvas (model space, not screen space), so masks stay exact
// however the sheet is placed, and characters never see each other's masks.
// ch.sync(renderer) draws them; models without masks need no renderer.
// ch.color (a THREE.Color) and ch.opacity tint the whole character; ch.renderOrder sorts it as any mesh.
// ch.partAt(raycaster) names the part under the mouse; ch.partBounds(name) boxes a part.
//
// THREE is passed in so this file works with any copy of three.js (r150+).

// format numbers, as in core/include/ugo.h (UGO_PART_*, UGO_BLEND_*); tests/constants_test.mjs compares them
const PART_MASK_INVERT = 1, PART_HIDDEN = 2, PART_SOLID = 4;
const BLEND_NORMAL = 0, BLEND_ADD = 1, BLEND_MULTIPLY = 2, BLEND_SCREEN = 3;
const ORDER_SLOTS = 8; // draw orders kept per model (as web/ugo.js)
const MAX_TEXTURES = 8;

const VERT = `
precision highp float;
precision highp int;
precision highp sampler2D;
in uvec4 aJoints;
in vec4 aWeights;
in uvec2 aCsr;
in uvec2 aXw;               // influences beyond four: first entry, count
uniform sampler2D uFrame;
uniform sampler2D uEntries;
uniform sampler2D uXWeights; // (bone, weight, 0, 0)
uniform sampler2D uParts;    // 2 texels per part, as in web/ugo.js (stored as floats)
uniform int uSkinT, uOpF, uMorphF, uColorF, uEntryW, uFrameW, uPartsW;
uniform vec4 uCanvas;        // width, height, originX, originY
uniform float uUnit, uDepth;
uniform bool uBillboard;
uniform vec4 uTint;          // the whole character's colour and opacity (mesh.color, mesh.opacity)
out vec2 vUV;
out vec2 vMask;              // where the vertex is on the mask images (0..1 over the canvas)
out float vOpacity;
flat out vec4 vInfo;
flat out vec3 vX, vY;

vec4 frameTexel(int t) { return texelFetch(uFrame, ivec2(t % uFrameW, t / uFrameW), 0); }
float frameFloat(int f) {
  vec4 v = frameTexel(f >> 2);
  int c = f & 3;
  return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
}
vec4 table(sampler2D s, int w, int t) { return texelFetch(s, ivec2(t % w, t / w), 0); }

// a warp grid's surface at cell coordinates p: uniform cubic B-spline over
// the (cols+3) x (rows+3) points (2 per texel) from texel t, straight on outside
vec2 warpPoint(int t, int k) { vec4 v = frameTexel(t + (k >> 1)); return (k & 1) == 0 ? v.xy : v.zw; }
vec4 bspline(float t) { float s = 1.0 - t, t2 = t * t, t3 = t2 * t; return vec4(s * s * s, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0; }
vec4 bsplineD(float t) { float s = 1.0 - t, t2 = t * t; return vec4(-0.5 * s * s, -2.0 * t + 1.5 * t2, 0.5 + t - 1.5 * t2, 0.5 * t2); }
vec2 warpAt(int t, vec2 size, vec2 p) {
  vec2 q = clamp(p, vec2(0.0), size), c = min(floor(q), size - 1.0), f = q - c, e = p - q;
  vec4 bu = bspline(f.x), bv = bspline(f.y), du = bsplineD(f.x), dv = bsplineD(f.y);
  int W = int(size.x) + 3, k0 = int(c.y) * W + int(c.x);
  vec2 o = vec2(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    o += (bu[i] * bv[j] + du[i] * bv[j] * e.x + bu[i] * dv[j] * e.y) * warpPoint(t, k0 + j * W + i);
  }
  return o;
}
vec2 skin(int bone, vec2 p) {
  int t = uSkinT + 2 * bone;
  vec4 m0 = frameTexel(t), m1 = frameTexel(t + 1);
  return vec2(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
}

void main() {
  vec2 p = position.xy; // model space: pixels, y down; position.z holds the part number
  int part = int(position.z + 0.5);
  vInfo = table(uParts, uPartsW, 2 * part);
  vec4 warp = table(uParts, uPartsW, 2 * part + 1);
  for (uint e = 0u; e < aCsr.y; e++) {
    vec4 en = table(uEntries, uEntryW, int(aCsr.x + e));
    p += frameFloat(uMorphF + int(en.x)) * en.yz;
  }
  vec2 o = vec2(0.0);
  if (warp.x > 0.0) o = warpAt(int(warp.x) - 1, warp.yz, p); // in a warp grid: no bones
  else {
    for (int j = 0; j < 4; j++) if (aWeights[j] > 0.0) o += aWeights[j] * skin(int(aJoints[j]), p);
    for (uint e = 0u; e < aXw.y; e++) {
      vec4 xw = table(uXWeights, uEntryW, int(aXw.x + e));
      o += xw.y * skin(int(xw.x), p);
    }
  }
  vUV = uv;
  vMask = (o + uCanvas.zw) / uCanvas.xy;
  int bits = int(vInfo.z);
#ifdef UGO_MASK_PASS
  vOpacity = 1.0; // masks ignore opacity (and hidden parts are masks too)
  gl_Position = vec4(vMask * 2.0 - 1.0, 0.0, 1.0);
#else
  vOpacity = frameFloat(uOpF + part);
  if ((bits & ${PART_HIDDEN}) != 0) vOpacity = 0.0;
  vX = vec3(1.0); vY = vec3(0.0);
  if (vInfo.w > 0.0) {
    int c = (uColorF >> 2) + 2 * (int(vInfo.w) - 1);
    vX = frameTexel(c).xyz; vY = frameTexel(c + 1).xyz;
  }
  vX *= uTint.rgb; vY *= uTint.rgb; vOpacity *= uTint.a;
  vec3 local = vec3(o.x * uUnit, -o.y * uUnit, float(part) * uDepth); // metres, y up
  vec4 mv;
  if (uBillboard) {
    // keep the object's position and scale, drop its rotation and the camera's: always faces the camera
    vec3 scale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
    mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xyz += local * scale;
  } else {
    mv = modelViewMatrix * vec4(local, 1.0);
  }
  gl_Position = vOpacity > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
#endif
}`;

const FRAG = `
precision mediump float;
precision highp int;
uniform sampler2D uAtlas0, uAtlas1, uAtlas2, uAtlas3, uAtlas4, uAtlas5, uAtlas6, uAtlas7;
uniform sampler2D uMask0, uMask1, uMask2, uMask3;
uniform int uMaskGroup;
in vec2 vUV;
in vec2 vMask;
in float vOpacity;
flat in vec4 vInfo;
flat in vec3 vX, vY;
out vec4 ugoColor;

vec4 atlas(int i) {
  return i == 0 ? texture(uAtlas0, vUV) : i == 1 ? texture(uAtlas1, vUV) : i == 2 ? texture(uAtlas2, vUV) : i == 3 ? texture(uAtlas3, vUV)
       : i == 4 ? texture(uAtlas4, vUV) : i == 5 ? texture(uAtlas5, vUV) : i == 6 ? texture(uAtlas6, vUV) : texture(uAtlas7, vUV);
}
float maskAt(int ch) {
  vec4 m = ch < 4 ? texture(uMask0, vMask) : ch < 8 ? texture(uMask1, vMask) : ch < 12 ? texture(uMask2, vMask) : texture(uMask3, vMask);
  int c = ch & 3;
  return c == 0 ? m.x : c == 1 ? m.y : c == 2 ? m.z : m.w;
}

void main() {
  int bits = int(vInfo.z);
  vec4 c = atlas(min(bits >> 16, ${MAX_TEXTURES - 1})); // premultiplied
#ifdef UGO_MASK_PASS
  float a = (bits & ${PART_SOLID}) != 0 ? 1.0 : c.a;
  int w = int(vInfo.x) >> (4 * uMaskGroup);
  ugoColor = vec4(float(w & 1), float((w >> 1) & 1), float((w >> 2) & 1), float((w >> 3) & 1)) * a;
#else
  c.rgb = c.rgb * vX + c.a * vY;
  float k = vOpacity;
  int read = int(vInfo.y);
  if ((read & 32) != 0) {
    float m = maskAt(read & 15);
    k *= (read & 16) != 0 ? 1.0 - m : m;
  }
  c *= k;
  if (((bits >> 8) & 255) == ${BLEND_ADD}) c.a = 0.0; // add: rgb = s + d, alpha unchanged
  ugoColor = c; // multiply / screen: the material's blend function does the rest
#endif
}`;

const ENTRY_W = 2048;
const FRAME_W = 1024;
const PARTS_W = 1024;
// blend classes that need their own blend function: normal and add share one
const CLASS_NORMAL = 0, CLASS_MULTIPLY = 1, CLASS_SCREEN = 2;

const floatTexture = (THREE, texels, width) => {
  const rows = Math.max(1, Math.ceil(texels.length / 4 / width));
  const data = new Float32Array(width * rows * 4);
  data.set(texels);
  const t = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
};

export class UgoThreeCharacterFactory {
  /**
   * Shared GPU data for one model; make many characters from it.
   * textures: a THREE.Texture, or one per model texture (up to 8), from loadImage() images.
   * options.maskScale: size of each character's mask images relative to the canvas (default 1).
   * options.sampling: 'linear' (default) or 'nearest' (pixel art: texel by texel, no mipmaps).
   */
  constructor(THREE, model, textures, { maskScale = 1, sampling = 'linear' } = {}) {
    this.THREE = THREE;
    this.model = model;
    this.maskScale = maskScale;
    const mesh = model.meshData();
    const info = model.partData();
    const nv = model.vertexCount;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(3 * nv);
    for (let i = 0; i < nv; i++) { pos[3 * i] = mesh.positions[2 * i]; pos[3 * i + 1] = mesh.positions[2 * i + 1]; pos[3 * i + 2] = mesh.parts[i]; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    const intAttr = (name, data, size) => {
      const a = new THREE.BufferAttribute(data, size);
      a.gpuType = THREE.IntType;
      geo.setAttribute(name, a);
    };
    intAttr('aJoints', mesh.joints, 4);
    geo.setAttribute('aWeights', new THREE.BufferAttribute(mesh.weights, 4));
    intAttr('aCsr', mesh.csr, 2);
    intAttr('aXw', mesh.xcsr, 2);

    // triangles: runs of drawn parts that share a blend class (one material each), in draw order
    const maskIdx = [];
    const maskParts = new Set(info.masks.flatMap((k) => k.parts));
    info.parts.forEach((p, i) => { if (maskParts.has(i)) maskIdx.push(...mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount)); });
    // the drawn parts' triangles in the order of `list` (part numbers), with one group per blend run
    this.layOut = (g, list) => {
      const drawn = [], groups = [];
      for (const i of list) {
        const p = info.parts[i];
        if (p.flags & PART_HIDDEN || !p.indexCount) continue;
        const tris = mesh.indices.subarray(p.firstIndex, p.firstIndex + p.indexCount);
        const cls = p.blend === BLEND_MULTIPLY ? CLASS_MULTIPLY : p.blend === BLEND_SCREEN ? CLASS_SCREEN : CLASS_NORMAL;
        const last = groups[groups.length - 1];
        if (last && last.materialIndex === cls) last.count += tris.length;
        else groups.push({ start: drawn.length, count: tris.length, materialIndex: cls });
        drawn.push(...tris);
      }
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(drawn), 1));
      for (const x of groups) g.addGroup(x.start, x.count, x.materialIndex);
      return g;
    };
    this.geometry = this.layOut(geo, info.parts.map((_, i) => i));
    // draw orders in use (format 0.8): key -> { list, geometry } sharing the vertex attributes; up to ORDER_SLOTS kept
    this.orders = new Map();
    this.orderUse = 0;
    if (maskIdx.length) { // the same vertices, only the mask parts' triangles
      this.maskGeometry = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) this.maskGeometry.setAttribute(name, attr);
      this.maskGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(maskIdx), 1));
    }
    this.maskGroups = Math.ceil(model.maskChannels / 4);

    this.entries = floatTexture(THREE, mesh.entries, ENTRY_W);
    this.xweights = floatTexture(THREE, mesh.extraWeights, ENTRY_W);
    // part table, the same meaning as web/ugo.js
    const texList = (Array.isArray(textures) ? textures : [textures]).slice(0, MAX_TEXTURES);
    const pt = new Float32Array(8 * Math.max(1, model.partCount));
    info.masks.forEach((k) => { for (const p of k.parts) pt[8 * p] += 1 << k.channel; });
    info.parts.forEach((p, i) => {
      if (p.mask >= 0) pt[8 * i + 1] = info.masks[p.mask].channel | (p.flags & PART_MASK_INVERT ? 16 : 0) | 32;
      pt[8 * i + 2] = p.flags | (p.blend << 8) | (Math.min(p.texture, texList.length - 1) << 16);
      pt[8 * i + 3] = p.color + 1;
      if (p.warp >= 0) {
        const w = info.warps[p.warp];
        pt.set([w.offset / 4 + 1, w.cols, w.rows, 0], 8 * i + 4);
      }
    });
    this.parts = floatTexture(THREE, pt, PARTS_W);

    // atlases: ImageBitmaps from loadImage() are premultiplied; colours stay as stored (no colour space conversion)
    for (const texture of texList) {
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = false;
      texture.premultiplyAlpha = false;
      const nearest = sampling === 'nearest';
      texture.generateMipmaps = !nearest;
      texture.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
      texture.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
      texture.needsUpdate = true;
    }
    this.textures = texList;
    this.texture = texList[0];
  }

  create(options = {}) {
    return new UgoThreeCharacter(this, options);
  }

  /** The geometry that draws `instance` (after update) in its draw order (format 0.8). */
  geometryFor(instance) {
    if (!this.model.hasDrawOrder) return this.geometry;
    const key = instance.drawOrderKey();
    if (key === 0) return this.geometry;
    const list = instance.drawOrder(), use = ++this.orderUse;
    let o = this.orders.get(key);
    if (o && o.list.length === list.length && o.list.every((x, i) => x === list[i])) { o.used = use; return o.geometry; }
    if (!o && this.orders.size >= ORDER_SLOTS) { // forget the order used longest ago (characters drawing with it keep it)
      let old = null;
      for (const [k, x] of this.orders) if (!old || x.used < old[1].used) old = [k, x];
      this.orders.delete(old[0]);
    }
    const g = new this.THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.geometry.attributes)) g.setAttribute(name, attr);
    o = { list: list.slice(), geometry: this.layOut(g, list), used: use };
    this.orders.set(key, o);
    return o.geometry;
  }
}

export class UgoThreeCharacter {
  /**
   * Returns a THREE.Mesh (with .instance and .sync(renderer)) — built this way so
   * the class does not need to extend a particular copy of THREE.Mesh.
   * options: metresPerPixel (0.01), billboard (false), depth (0, metres per part)
   */
  constructor(factory, { metresPerPixel = 0.01, billboard = false, depth = 0 } = {}) {
    const THREE = factory.THREE, model = factory.model;
    const instance = model.createInstance();
    const frameRows = Math.max(1, Math.ceil(model.frameFloats / 4 / FRAME_W));
    const frameData = new Float32Array(FRAME_W * frameRows * 4);
    const frameTex = new THREE.DataTexture(frameData, FRAME_W, frameRows, THREE.RGBAFormat, THREE.FloatType);
    frameTex.needsUpdate = true;

    // each character's mask images (4 channels each), over the model's canvas
    const [cw, ch, ox, oy] = model.canvas;
    const masks = Array.from({ length: factory.maskGroups }, () => new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(cw * factory.maskScale)), Math.max(1, Math.round(ch * factory.maskScale)),
      { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false }));

    const uniforms = {
      uFrame: { value: frameTex }, uEntries: { value: factory.entries }, uXWeights: { value: factory.xweights }, uParts: { value: factory.parts },
      uSkinT: { value: model.skinOffset / 4 }, uOpF: { value: model.opacityOffset }, uMorphF: { value: model.morphOffset },
      uColorF: { value: model.colorOffset }, uEntryW: { value: ENTRY_W }, uFrameW: { value: FRAME_W }, uPartsW: { value: PARTS_W },
      uCanvas: { value: new THREE.Vector4(cw, ch, ox, oy) },
      uUnit: { value: metresPerPixel }, uDepth: { value: depth }, uBillboard: { value: billboard }, uMaskGroup: { value: 0 },
      uTint: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    for (let i = 0; i < MAX_TEXTURES; i++) uniforms[`uAtlas${i}`] = { value: factory.textures[Math.min(i, factory.textures.length - 1)] };
    for (let i = 0; i < 4; i++) uniforms[`uMask${i}`] = { value: masks[Math.min(i, masks.length - 1)]?.texture ?? null };

    const material = (blend) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      forceSinglePass: true, // one pass in draw order (three.js splits double-sided transparent materials into back and front passes)
      blending: THREE.CustomBlending, ...blend,
    });
    const F = THREE;
    const materials = [
      material({ blendSrc: F.OneFactor, blendDst: F.OneMinusSrcAlphaFactor, blendSrcAlpha: F.OneFactor, blendDstAlpha: F.OneMinusSrcAlphaFactor }),
      material({ blendSrc: F.DstColorFactor, blendDst: F.OneMinusSrcAlphaFactor, blendSrcAlpha: F.ZeroFactor, blendDstAlpha: F.OneFactor }), // multiply
      material({ blendSrc: F.OneFactor, blendDst: F.OneMinusSrcColorFactor, blendSrcAlpha: F.OneFactor, blendDstAlpha: F.OneMinusSrcAlphaFactor }), // screen
    ];
    const mesh = new THREE.Mesh(factory.geometry, materials);
    mesh.frustumCulled = false; // the sheet deforms on the GPU; its bounds are not known here
    mesh.instance = instance;
    mesh.color = new THREE.Color(1, 1, 1); // the whole character's colour and opacity (applied by sync)
    mesh.opacity = 1;
    mesh.ugo = { frameData, frameTex, material: materials[0], materials, masks };

    let maskScene = null, maskCamera = null, maskMaterial = null;
    if (masks.length) {
      maskMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: { ...uniforms, uMaskGroup: { value: 0 } },
        defines: { UGO_MASK_PASS: 1 }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: F.OneFactor, blendDst: F.OneFactor, // overlaps: max
      });
      maskScene = new THREE.Scene();
      const m = new THREE.Mesh(factory.maskGeometry, maskMaterial);
      m.frustumCulled = false;
      maskScene.add(m);
      maskCamera = new THREE.Camera(); // the mask shader writes clip space itself
    }

    // the object's world position, in model pixels (y down), as the instance's placement: only the
    // physics reads it (the shader places the sheet with the object's matrix). Call before update().
    mesh.place = () => {
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      instance.setTransform(1, 0, 0, 1, e[12] / metresPerPixel, -e[13] / metresPerPixel);
    };
    // picking by part name, as of the last update(): a THREE.Raycaster (e.g. setFromCamera with the
    // mouse), hit against the character's sheet, or a world point on the sheet. The part's name, or null.
    // A billboarded sheet faces the camera, so it needs the raycaster (its camera gives the sheet's axes).
    let partNames = null;
    const plane = new THREE.Plane(), hit = new THREE.Vector3(), centre = new THREE.Vector3(), scale = new THREE.Vector3();
    const right = new THREE.Vector3(), up = new THREE.Vector3(), normal = new THREE.Vector3(), inv = new THREE.Matrix4();
    mesh.partAt = (rayOrPoint, minOpacity = 0.01) => {
      mesh.updateWorldMatrix(true, false);
      centre.setFromMatrixPosition(mesh.matrixWorld);
      const ray = rayOrPoint.ray, cam = rayOrPoint.camera;
      if (billboard && !cam) return null;
      if (billboard) { right.setFromMatrixColumn(cam.matrixWorld, 0).normalize(); up.setFromMatrixColumn(cam.matrixWorld, 1).normalize(); normal.crossVectors(right, up); }
      else normal.set(0, 0, 1).transformDirection(mesh.matrixWorld);
      let p = rayOrPoint;
      if (ray) {
        if (!ray.intersectPlane(plane.setFromNormalAndCoplanarPoint(normal, centre), hit)) return null;
        p = hit;
      }
      let x, y;
      if (billboard) { // measured along the camera's axes, in the object's scale
        scale.setFromMatrixScale(mesh.matrixWorld);
        const d = p.clone().sub(centre);
        x = d.dot(right) / scale.x; y = d.dot(up) / scale.y;
      } else {
        const local = p.clone().applyMatrix4(inv.copy(mesh.matrixWorld).invert());
        x = local.x; y = local.y;
      }
      const part = instance.pickPart(x / metresPerPixel, -y / metresPerPixel, minOpacity);
      if (part < 0) return null;
      partNames ??= Array.from({ length: model.partCount }, (_, i) => model.rt.str(model.rt.ex.ugo_part_name(model.ptr, i)));
      return partNames[part];
    };
    // the box [x0, y0, x1, y1] in model pixels (y down) around a part by name, or the whole character; null if empty
    mesh.partBounds = (name) => instance.bounds(name ?? -1);
    mesh.sync = (renderer) => {
      frameData.set(instance.frame());
      uniforms.uTint.value.set(mesh.color.r, mesh.color.g, mesh.color.b, mesh.opacity);
      frameTex.needsUpdate = true;
      mesh.geometry = factory.geometryFor(instance); // the draw order (format 0.8)
      if (!masks.length) return;
      if (!renderer) throw new Error('Ugo9: this model has masks: call sync(renderer)');
      const target = renderer.getRenderTarget(), clear = new THREE.Color(), alpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      renderer.setClearColor(0x000000, 0);
      masks.forEach((rt, g) => {
        maskMaterial.uniforms.uMaskGroup.value = g;
        renderer.setRenderTarget(rt);
        renderer.clear(true, false, false);
        renderer.render(maskScene, maskCamera);
      });
      renderer.setRenderTarget(target);
      renderer.setClearColor(clear, alpha);
    };
    instance.update(0);
    frameData.set(instance.frame());
    return mesh;
  }
}
