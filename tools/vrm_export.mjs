// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 -> VRM 1.0 (.vrm) for 3D VTuber apps (Warudo, VMagicMirror, ...) — the work itself, without
// files, so it runs in the browser too (the editor's export window). The command
// tools/export_vrm.mjs reads and writes the files around it.
//
//   node tools/export_vrm.mjs model.ug9 out.vrm [options]   (a .ugo of before the rename is read too)
//     --height 1.0        height of the model canvas in metres
//     --name "..."        model name (default: the file name)
//     --author "..."      author (default: "Unknown")
//     --expressions f.json  expression -> parameter values, e.g.
//                         {"blink": {"EyeOpenL": 0, "EyeOpenR": 0}, "aa": {"MouthOpen": 1}}
//     --spring a,b        bones that start a swaying chain (default: bones named like hair/ribbon/tail/skirt)
//
// The character stays a flat sheet facing +Z. VRM apps move it with humanoid
// bones (so turning the head turns the sheet) and with expressions. Each
// expression is baked by running the Ugo9 core with the parameter values
// above; parts that are hidden in that state are collapsed to a point, so
// switching parts (open eye / closed eye) works in every app.
// Arms and legs that a 2D bust-up model does not have are added as unused
// bones, because VRM requires them. Meta defaults are the most restrictive
// ones: set the licence terms you want before sharing the file.

import { OLD_NAME, OLD_GROUP } from './lib/paramnames.js';
import { GltfBuilder, FLOAT, UINT, USHORT, mul2d, inv2d, mat4of2d, primitiveRuns } from './gltf_writer.mjs';

// The standard parameter names (docs/パラメータの名前.md); the older ones (EyeBallX, BrowY ...) and "Param" prefixed
// names are read too (PARAM_ALTERNATIVES). Screen-left eye = the character's right eye (VRM's blinkRight).
export const DEFAULT_EXPRESSIONS = {
  blink: { EyeOpenL: 0, EyeOpenR: 0 },
  blinkLeft: { EyeOpenR: 0 },
  blinkRight: { EyeOpenL: 0 },
  aa: { MouthOpen: 1 },
  oh: { MouthOpen: 0.7 },
  ou: { MouthOpen: 0.45 },
  ee: { MouthOpen: 0.35 },
  ih: { MouthOpen: 0.25 },
  lookLeft: { PupilX: 1 },
  lookRight: { PupilX: -1 },
  lookUp: { PupilY: 1 },
  lookDown: { PupilY: -1 },
  surprised: { BrowHeightL: 1, BrowHeightR: 1, MouthOpen: 0.5 },
  angry: { BrowHeightL: -1, BrowHeightR: -1 },
  sad: { BrowHeightL: -0.6, BrowHeightR: -0.6 },
};

/** A name an expression gives -> the other names that stand for it, as sets that must all be there (利用者の声 #409:
 *  the standard names and the older ones are both read; BrowY moves both brows, BrowHeightL / R one each). Made from
 *  the editor's one table of names (tools/lib/paramnames.js: OLD_NAME one to one, OLD_GROUP the older one for several). */
export const PARAM_ALTERNATIVES = (() => {
  const alt = {}, add = (k, set) => (alt[k] ||= []).push(set);
  for (const [std, old] of Object.entries(OLD_NAME)) { add(std, [old]); add(old, [std]); }
  const groups = {};
  for (const [std, old] of Object.entries(OLD_GROUP)) { add(std, [old]); (groups[old] ||= []).push(std); }
  for (const [old, stds] of Object.entries(groups)) add(old, stds);
  return alt;
})();

/** An expression's { param: value } in the names the model has (has(name) -> boolean): a name it lacks is replaced by
 *  an alternative set it has (each of them gets the value); left as it is when none (then reported missing). */
export function resolveExpression(params, has) {
  const out = {}, there = (n) => has(n) || has('Param' + n);
  for (const [n, v] of Object.entries(params)) {
    if (there(n)) { out[n] = v; continue; }
    const alt = (PARAM_ALTERNATIVES[n] || []).find((set) => set.every(there));
    if (alt) for (const m of alt) out[m] = v; else out[n] = v;
  }
  return out;
}
const PRESETS = new Set(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral']);

/**
 * rt: a UgoRuntime (web/ugo.js), ugoBytes: the .ug9 (or .ugo) bytes, png: the textures' PNG bytes (an array, one per
 * atlas page as model.textures lists them; one Uint8Array for a one-page model).
 * opts: height (metres, 1.0), name ('model'), author ('Unknown'), expressions ({ name: { param: value } },
 * default DEFAULT_EXPRESSIONS), spring ('a,b': the bones that start swaying chains), log (warnings,
 * default console.warn) -> { vrm: Uint8Array, summary }. Throws (code vrmNoHumanoid) without head / body bones.
 */
export function exportVrm(rt, ugoBytes, png, opts = {}) {
  const CLI = { '--height': opts.height, '--name': opts.name, '--author': opts.author, '--spring': Array.isArray(opts.spring) ? opts.spring.join(',') : opts.spring };
  const opt = (name, def) => CLI[name] ?? def;
  const log = opts.log || ((s) => console.warn(s));
  const ex = rt.ex;
  const bytes = ugoBytes instanceof Uint8Array ? ugoBytes : new Uint8Array(ugoBytes);
  const model = rt.loadModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const mesh = model.meshData();
  if (Array.from({ length: model.vertexCount }, (_, v) => mesh.xcsr[2 * v + 1]).some((n) => n > 0))
    log('warning: vertices weighted to more than 4 bones keep the core\'s first 4 here (VRM apps read JOINTS_0 only)');
  if (!rt.ex.ugo_skeleton_is_simple(model.ptr)) {
    log('warning: this model uses IK / transform constraints, shear or non-normal bone inheritance; the exported skeleton does not reproduce them exactly yet (docs/3D.md)');
  }
  const nv = model.vertexCount, nb = model.boneCount, np = model.partCount, nm = model.morphCount;
  const UNIT = Number(opt('--height', 1.0)) / model.canvas[1];
  const scratch = rt.alloc(64);
  const bones = Array.from({ length: nb }, (_, i) => {
    ex.ugo_bone_rest(model.ptr, i, scratch);
    return { name: rt.str(ex.ugo_bone_name(model.ptr, i)), parent: ex.ugo_bone_parent(model.ptr, i), rest: Array.from(rt.f32(scratch, 5)) };
  });
  const parts = Array.from({ length: np }, (_, i) => {
    const r = rt.u32(scratch, 4);
    ex.ugo_part_range(model.ptr, i, scratch);
    return { name: rt.str(ex.ugo_part_name(model.ptr, i)), firstVert: r[0], vertCount: r[1] };
  });
  const warn = (w) => log(`warning: ${w}`);

  // ---- baking: model-space positions before skinning, hidden parts collapsed ----------
  const inst = model.createInstance();
  // parts in warp grids (format 0.5): their mesh positions are grid cells. They are skinned whole
  // to the grid's bone, and baked from the core's own shape seen from that bone's rest pose
  const warpOwner = new Map(), worldPx = (b) => { ex.ugo_bone_world(inst.ptr, b, scratchW); return Array.from(rt.f32(scratchW, 6)); };
  const scratchW = rt.alloc(32), deformBuf = rt.alloc(8 * nv);
  parts.forEach((p, pi) => {
    let w = ex.ugo_part_warp(model.ptr, pi);
    if (w < 0) return;
    while (ex.ugo_warp_parent(model.ptr, w) >= 0) w = ex.ugo_warp_parent(model.ptr, w);
    const b = Math.max(0, ex.ugo_warp_bone(model.ptr, w));
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) {
      warpOwner.set(v, b);
      mesh.joints.set([b, 0, 0, 0], 4 * v); mesh.weights.set([1, 0, 0, 0], 4 * v);
    }
  });
  let warpRestWorld = null;
  if (warpOwner.size) { inst.reset(); inst.update(0); warpRestWorld = Array.from({ length: nb }, (_, b) => worldPx(b)); }
  function bake(params) {
    inst.reset();
    for (const [name, v] of Object.entries(params)) {
      const i = model.paramIndex.has(name) ? model.paramIndex.get(name) : model.paramIndex.get('Param' + name);
      if (i !== undefined) inst.set(i, v);
    }
    inst.update(0);
    const fr = inst.frame();
    const out = new Float32Array(2 * nv);
    for (let v = 0; v < nv; v++) {
      let x = mesh.positions[2 * v], y = mesh.positions[2 * v + 1];
      for (let e = mesh.csr[2 * v]; e < mesh.csr[2 * v] + mesh.csr[2 * v + 1]; e++) {
        const w = fr[model.morphOffset + mesh.entries[4 * e]];
        x += w * mesh.entries[4 * e + 1]; y += w * mesh.entries[4 * e + 2];
      }
      out[2 * v] = x; out[2 * v + 1] = y;
    }
    if (warpOwner.size) {
      ex.ugo_deform_cpu(inst.ptr, deformBuf);
      const P = rt.f32(deformBuf, 2 * nv), local = new Map();
      for (const [v, b] of warpOwner) {
        if (!local.has(b)) local.set(b, mul2d(warpRestWorld[b], inv2d(worldPx(b))));
        const M = local.get(b), x = P[2 * v], y = P[2 * v + 1];
        out[2 * v] = M[0] * x + M[2] * y + M[4]; out[2 * v + 1] = M[1] * x + M[3] * y + M[5];
      }
    }
    parts.forEach((p, pi) => {
      if (fr[model.opacityOffset + pi] >= 0.5) return;
      let cx = 0, cy = 0;
      for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) { cx += out[2 * v]; cy += out[2 * v + 1]; }
      cx /= p.vertCount; cy /= p.vertCount;
      for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) { out[2 * v] = cx; out[2 * v + 1] = cy; }
    });
    return out;
  }
  const known = (params) => Object.keys(params).every((n) => model.paramIndex.has(n) || model.paramIndex.has('Param' + n));
  const neutral = bake({});

  // ---- skeleton: Ugo9 bones + humanoid bones ------------------------------------------------
  const toTRS = ([x, y, rot, sx, sy]) => ({ t: [x * UNIT, -y * UNIT, 0], r: [0, 0, Math.sin(-rot / 2), Math.cos(-rot / 2)], s: [sx, sy, 1] });
  const affine = ({ t, r, s }) => { const a = 2 * Math.atan2(r[2], r[3]), c = Math.cos(a), sn = Math.sin(a); return [c * s[0], sn * s[0], -sn * s[1], c * s[1], t[0], t[1]]; };
  const restTRS = bones.map((b) => toTRS(b.rest));
  const world = [];
  bones.forEach((b, i) => { const L = affine(restTRS[i]); world.push(b.parent < 0 ? L : mul2d(world[b.parent], L)); });
  const find = (re) => bones.findIndex((b) => re.test(b.name));
  const head = find(/^head$/i) >= 0 ? find(/^head$/i) : find(/head/i);
  const neck = find(/neck/i);
  const spine = find(/^(body|spine|chest|torso)$/i) >= 0 ? find(/^(body|spine|chest|torso)$/i) : find(/body|spine|chest|torso/i);
  if (head < 0 || spine < 0) { const e = new Error('need bones named like "head" and "body"/"spine" to map the humanoid'); e.code = 'vrmNoHumanoid'; throw e; }

  const nodes = bones.map((b, i) => {
    const n = { name: b.name, translation: restTRS[i].t, rotation: restTRS[i].r, scale: restTRS[i].s };
    const kids = bones.map((c, j) => (c.parent === i ? j : -1)).filter((j) => j >= 0);
    if (kids.length) n.children = kids;
    return n;
  });
  const addNode = (n, parent) => { nodes.push(n); if (parent !== undefined) (nodes[parent].children ||= []).push(nodes.length - 1); return nodes.length - 1; };
  const worldPos = (i) => [world[i][4], world[i][5]];
  // hips at the model origin (bottom of the canvas), legs hanging below it, unused
  const hips = addNode({ name: 'hips', children: bones.map((b, i) => (b.parent < 0 ? i : -1)).filter((i) => i >= 0) });
  const legLen = 0.45 * Number(opt('--height', 1.0));
  const leg = (side) => {
    const sx = side * 0.1 * Number(opt('--height', 1.0));
    const up = addNode({ name: `${side > 0 ? 'left' : 'right'}UpperLeg`, translation: [sx, -0.05, 0] }, hips);
    const low = addNode({ name: `${side > 0 ? 'left' : 'right'}LowerLeg`, translation: [0, -legLen, 0] }, up);
    const foot = addNode({ name: `${side > 0 ? 'left' : 'right'}Foot`, translation: [0, -legLen, 0] }, low);
    return [up, low, foot];
  };
  // arms from the spine bone at shoulder height, straight out (T-pose; the model faces +Z, its left is +X)
  const shoulderY = (neck >= 0 ? worldPos(neck)[1] : worldPos(head)[1]) - worldPos(spine)[1];
  const armLen = 0.25 * Number(opt('--height', 1.0));
  const arm = (side) => {
    const up = addNode({ name: `${side > 0 ? 'left' : 'right'}UpperArm`, translation: [side * 0.12 * Number(opt('--height', 1.0)), shoulderY - 0.02, 0] }, spine);
    const low = addNode({ name: `${side > 0 ? 'left' : 'right'}LowerArm`, translation: [side * armLen, 0, 0] }, up);
    const hand = addNode({ name: `${side > 0 ? 'left' : 'right'}Hand`, translation: [side * armLen, 0, 0] }, low);
    return [up, low, hand];
  };
  const [lUL, lLL, lF] = leg(1), [rUL, rLL, rF] = leg(-1);
  const [lUA, lLA, lH] = arm(1), [rUA, rLA, rH] = arm(-1);
  const humanBones = {
    hips: { node: hips }, spine: { node: spine }, head: { node: head },
    leftUpperLeg: { node: lUL }, leftLowerLeg: { node: lLL }, leftFoot: { node: lF },
    rightUpperLeg: { node: rUL }, rightLowerLeg: { node: rLL }, rightFoot: { node: rF },
    leftUpperArm: { node: lUA }, leftLowerArm: { node: lLA }, leftHand: { node: lH },
    rightUpperArm: { node: rUA }, rightLowerArm: { node: rLA }, rightHand: { node: rH },
  };
  if (neck >= 0) humanBones.neck = { node: neck };

  // ---- spring bones: chains from Ugo9 bones, each with a tail node -----------------------------
  const springNames = opt('--spring', null);
  const isSwing = (b) => /hair|ribbon|tail|skirt|bang|sway/i.test(b.name);
  const roots = springNames ? springNames.split(',').map((n) => find(new RegExp(`^${n}$`))).filter((i) => i >= 0)
    : bones.map((b, i) => (isSwing(b) && !(b.parent >= 0 && isSwing(bones[b.parent])) ? i : -1)).filter((i) => i >= 0);
  // the model's own swaying chains (format 0.6), when it has some and --spring is not given.
  // Ugo9's chains are springs with mass (Verlet: stiffness k 1/s², damping d 1/s, gravity g px/s²);
  // VRM's spring bones move the tip each frame by stiffness·dt towards the rest direction and
  // gravityPower·dt along gravityDir, and keep (1 − dragForce) of the last frame's motion. So:
  //   dragForce = 1 − e^(−d/60)          (the motion a 60 fps frame keeps)
  //   stiffness = 0.1 · √k · L
  //   gravityPower = stiffness · |g| / (k · L_px)   (it hangs as far as Ugo9's chain does at rest)
  // with L the joint's bone length in metres. The 0.1 was fitted: VRM pulls back at a constant
  // speed rather than like a spring, and with it the largest swing after the body moves matches
  // Ugo9's chain within about 10 % for stiffness 10..100 and damping 2..8 (docs/3D.md).
  // inertia and mix have no VRM counterpart.
  const chainSprings = !springNames && model.chains?.length ? model.chains.map((c) => {
    const chain = c.bones, last = chain[chain.length - 1], prev = chain.length > 1 ? chain[chain.length - 2] : null;
    const seg = (a, b) => Math.hypot(worldPos(b)[0] - worldPos(a)[0], worldPos(b)[1] - worldPos(a)[1]);
    const lastLen = prev !== null ? seg(prev, last) : 0.1 * Number(opt('--height', 1.0));
    const scale = Math.hypot(world[last][0], world[last][1]) || 1;
    const tailNode = addNode({ name: `${bones[last].name}_tail`, translation: [lastLen / scale, 0, 0] }, last); // along the bone (+x)
    const g = Math.hypot(c.gravity[0], c.gravity[1]), dir = g ? [c.gravity[0] / g, -c.gravity[1] / g, 0] : [0, -1, 0];
    const dragForce = Math.min(1, Math.max(0, 1 - Math.exp(-c.damping / 60)));
    if (c.inertia < 1 || c.mix < 1) warn(`chain from ${bones[chain[0]].name}: inertia ${c.inertia} and mix ${c.mix} have no VRM counterpart (VRM uses 1 and 1)`);
    return {
      name: bones[chain[0]].name,
      joints: [...chain, tailNode].map((node, k) => {
        const L = k + 1 < chain.length ? seg(chain[k], chain[k + 1]) : lastLen; // metres
        const stiffness = 0.1 * Math.sqrt(Math.max(0, c.stiffness)) * L, Lpx = L / UNIT;
        const gravityPower = c.stiffness > 0 ? (stiffness * g) / (c.stiffness * Lpx) : g * UNIT;
        return { node, hitRadius: 0.02, stiffness: +stiffness.toFixed(5), gravityPower: +gravityPower.toFixed(5), gravityDir: dir, dragForce: +dragForce.toFixed(4) };
      }),
    };
  }) : null;
  const springs = chainSprings || roots.map((r) => {
    const chain = [r];
    for (;;) {
      const kids = bones.map((b, i) => (b.parent === chain[chain.length - 1] ? i : -1)).filter((i) => i >= 0);
      if (kids.length !== 1) break;
      chain.push(kids[0]);
    }
    // tail: continue the last segment (or hang down)
    const last = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : null;
    let tail = [0, -0.1 * Number(opt('--height', 1.0)), 0];
    if (prev !== null) { const [ax, ay] = worldPos(prev), [bx, by] = worldPos(last); tail = [(bx - ax) * UNIT, -(by - ay) * UNIT, 0]; }
    const tailNode = addNode({ name: `${bones[last].name}_tail`, translation: tail }, last);
    return {
      name: bones[r].name,
      joints: [...chain, tailNode].map((node) => ({ node, hitRadius: 0.02, stiffness: 1.2, gravityPower: 0.3, gravityDir: [0, -1, 0], dragForce: 0.4 })),
    };
  });

  // ---- mesh --------------------------------------------------------------------------------
  const W = new GltfBuilder();
  const positions = new Float32Array(3 * nv);
  for (let v = 0; v < nv; v++) { positions[3 * v] = neutral[2 * v] * UNIT; positions[3 * v + 1] = -neutral[2 * v + 1] * UNIT; }
  const attributes = {
    POSITION: W.accessor(positions, 'VEC3', FLOAT, { target: 34962, bounds: true }),
    TEXCOORD_0: W.accessor(mesh.uvs, 'VEC2', FLOAT, { target: 34962 }),
    JOINTS_0: W.accessor(mesh.joints, 'VEC4', USHORT, { target: 34962 }),
    WEIGHTS_0: W.accessor(mesh.weights, 'VEC4', FLOAT, { target: 34962 }),
  };
  // the draw order (format 0.8): the triangles in the parts' order at rest; VRM has no order that changes
  let restOrder = null;
  if (model.hasDrawOrder) {
    inst.reset(); inst.update(0);
    restOrder = Array.from(inst.drawOrder());
    const restKey = inst.drawOrderKey();
    let changes = false;
    for (const [k, v] of model.params.flatMap((p, k) => [[k, p.min], [k, p.max]])) { inst.reset(); inst.set(k, v); inst.update(0); if (inst.drawOrderKey() !== restKey) changes = true; }
    if (changes) warn('parameters change the draw order (format 0.8): VRM keeps the order at rest');
    inst.reset(); inst.update(0);
  }
  // the triangles: one primitive per run of parts on the same atlas page (maskOnly parts left out)
  const pngs = Array.isArray(png) ? png : [png], runs = primitiveRuns(model, mesh, restOrder);
  for (const r of runs) if (!pngs[r.texture]) throw new Error(`exportVrm: no picture for texture ${r.texture} (${model.textures[r.texture] || '?'})`);
  const runIndices = runs.map((r) => W.accessor(r.indices, 'SCALAR', UINT, { target: 34963 }));
  let exprMap = DEFAULT_EXPRESSIONS;
  if (opts.expressions) exprMap = opts.expressions;
  const targets = [], targetNames = [], expressions = { preset: {}, custom: {} };
  const meshNode = nodes.length;
  for (const [name, given] of Object.entries(exprMap)) {
    const params = resolveExpression(given, (n) => model.paramIndex.has(n));
    if (!known(params)) { warn(`expression ${name}: the model has no parameter ${Object.keys(params).filter((n) => !model.paramIndex.has(n) && !model.paramIndex.has('Param' + n)).join(', ')} (skipped)`); continue; }
    const baked = bake(params);
    const map = new Map();
    for (let v = 0; v < nv; v++) {
      const dx = (baked[2 * v] - neutral[2 * v]) * UNIT, dy = -(baked[2 * v + 1] - neutral[2 * v + 1]) * UNIT;
      if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) map.set(v, [dx, dy, 0]);
    }
    if (!map.size) { warn(`expression ${name}: changes nothing (skipped)`); continue; }
    targets.push({ POSITION: W.sparseVec3(map, nv) });
    targetNames.push(name);
    const expr = { morphTargetBinds: [{ node: meshNode, index: targets.length - 1, weight: 1 }], isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' };
    (PRESETS.has(name) ? expressions.preset : expressions.custom)[name] = expr;
  }
  nodes.push({ name: 'face', mesh: 0, skin: 0 });

  // skin
  const ibm = new Float32Array(16 * nb);
  world.forEach((M, i) => ibm.set(mat4of2d(inv2d(M)), 16 * i));
  const ibmAccessor = W.accessor(ibm, 'MAT4', FLOAT);

  // texture
  const imageViews = pngs.map((b) => W.view(new Uint8Array(b))); // the atlas pages' PNG

  const headY = worldPos(head)[1];
  const gltf = {
    asset: { version: '2.0', generator: 'Ugo9 tools/export_vrm.mjs' },
    extensionsUsed: ['KHR_materials_unlit', 'VRMC_vrm', 'VRMC_springBone'],
    scene: 0,
    scenes: [{ nodes: [hips, meshNode] }],
    nodes,
    meshes: [{ name: 'face', primitives: runs.map((r, k) => ({ attributes, indices: runIndices[k], material: r.texture, mode: 4, targets })), weights: targets.map(() => 0), extras: { targetNames } }],
    skins: [{ joints: bones.map((_, i) => i), inverseBindMatrices: ibmAccessor, skeleton: hips }],
    materials: pngs.map((_, k) => ({ // one per atlas page
      name: k ? `atlas_${k + 1}` : 'atlas', pbrMetallicRoughness: { baseColorTexture: { index: k }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'BLEND', doubleSided: true, extensions: { KHR_materials_unlit: {} },
    })),
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: imageViews.map((v) => ({ bufferView: v, mimeType: 'image/png' })),
    textures: imageViews.map((_, k) => ({ sampler: 0, source: k })),
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: {
          name: opt('--name', 'model'),
          version: '1',
          authors: [opt('--author', 'Unknown')],
          licenseUrl: 'https://vrm.dev/licenses/1.0/',
          avatarPermission: 'onlyAuthor',
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          commercialUsage: 'personalNonProfit',
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
          creditNotation: 'required',
          allowRedistribution: false,
          modification: 'prohibited',
        },
        humanoid: { humanBones },
        lookAt: {
          type: 'expression',
          offsetFromHeadBone: [0, (headY - (neck >= 0 ? worldPos(neck)[1] : headY)) * -UNIT + 0.1 * Number(opt('--height', 1.0)), 0],
          rangeMapHorizontalInner: { inputMaxValue: 30, outputScale: 1 },
          rangeMapHorizontalOuter: { inputMaxValue: 30, outputScale: 1 },
          rangeMapVerticalDown: { inputMaxValue: 25, outputScale: 1 },
          rangeMapVerticalUp: { inputMaxValue: 25, outputScale: 1 },
        },
        expressions,
      },
      VRMC_springBone: { specVersion: '1.0', springs },
    },
  };

  const vrm = W.glb(gltf);
  return { vrm, summary: `${vrm.length} bytes; ${Object.keys(expressions.preset).length + Object.keys(expressions.custom).length} expressions (${targetNames.join(', ')}), ${springs.length} spring chain(s), humanoid head = ${bones[head].name}` };
}
