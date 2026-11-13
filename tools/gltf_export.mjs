// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A .ug9 model into glTF 2.0 binary (.glb) — the work itself, without files, so it runs in the
// browser too (the editor's export window). The command tools/export_gltf.mjs reads and writes the
// files around it (see docs/検証_glTF.md for how far glTF carries an Ugo9 character).
//
//   node tools/export_gltf.mjs model.ug9 [out.glb] [options]   (a .ugo of before the rename is read too)
//     --fps 30          animation sampling rate
//     --height 1.6      character height in metres (the model canvas's height);
//                       default 1 px = 1 cm
//     --lit             let scene lights shade it (default: unlit, like 2D art)
//     --depth 0.002     spread parts towards the camera by this many metres per
//                       part, for a little parallax when the camera moves
//     --billboard       mark the character to turn to face the camera (glTF has
//                       no billboard; engines read extras.ugo9.billboard)
//     --flat            bake every bone's world matrix (automatic when the skeleton uses
//                       IK / transform constraints, shear or non-normal inheritance)
//
// What it writes:
// - one skinned mesh (parts in draw order; a primitive and a material per atlas page that the
//   parts in a row use; maskOnly parts left out; unlit, alpha blend)
// - bones as nodes (2D, y flipped to glTF's y-up, 1 px = 1 cm). A skeleton that plain
//   parent-child nodes cannot carry (constraints, shear, inheritance modes) is written
//   "flat": every bone is two nodes under one root, "bone:basis" (translation,
//   rotation, scale) and "bone" (rotation, scale ±1), so the pair can hold any 2D affine
//   world matrix (polar + eigen decomposition), and each frame's world matrix is baked
// - every Ugo9 morph as a sparse morph target (blend shape)
// - parts whose opacity changes get their own "visibility" bone that is
//   scaled to (almost) zero to hide them: glTF has no portable opacity
//   animation, and bone scale works in every engine. (Collapsing parts with
//   a morph target leaves slivers once other morphs add their deltas.)
// - each Ugo9 animation baked at --fps: bone TRS + all morph weights
// What it cannot write: the parameter logic (regions, physics) itself.

import { GltfBuilder, FLOAT, UINT, USHORT, mul2d, inv2d, mat4of2d, primitiveRuns } from './gltf_writer.mjs';

/**
 * rt: a UgoRuntime (web/ugo.js), ugoBytes: the .ug9 (or .ugo) bytes, png: the textures' PNG bytes (an array, one per
 * atlas page as model.textures lists them; one Uint8Array for a one-page model).
 * opts: fps (30), height (metres, 0 = 1 px is 1 cm), depth (0), lit, billboard, flat, log (for the
 * warnings and notes, default console.warn) -> { glb: Uint8Array, summary }
 */
export function exportGlb(rt, ugoBytes, png, opts = {}) {
  const FPS = opts.fps ?? 30, HEIGHT = opts.height ?? 0, DEPTH = opts.depth ?? 0, LIT = !!opts.lit, BILLBOARD = !!opts.billboard, FORCE_FLAT = !!opts.flat;
  const log = opts.log || ((s) => console.warn(s));
  // ---- load the model with the real runtime --------------------------------------
  const ex = rt.ex;
  const fileBytes = ugoBytes instanceof Uint8Array ? ugoBytes : new Uint8Array(ugoBytes);
  const model = rt.loadModel(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
  const mesh = model.meshData();
  { // format 0.4 features that glTF materials cannot carry
    const ids = [...Array(model.partCount).keys()], name = (i) => rt.str(ex.ugo_part_name(model.ptr, i));
    const masked = ids.filter((i) => ex.ugo_part_mask(model.ptr, i) >= 0), blended = ids.filter((i) => ex.ugo_part_blend(model.ptr, i) !== 0), coloured = ids.filter((i) => ex.ugo_part_color(model.ptr, i) >= 0);
    if (masked.length) log(`warning: masks are not written (glTF has none): ${masked.length} parts are drawn unclipped (${masked.slice(0, 3).map(name).join(', ')}...)`);
    if (blended.length) log(`warning: blend modes are not written: ${blended.length} parts are drawn as normal (${blended.slice(0, 3).map(name).join(', ')}...)`);
    if (coloured.length) log(`warning: part colours (multiply / screen / tint) are not written: ${coloured.length} parts`);
  }
  // influences in sets of four (format 0.4: any number of bones per vertex): set 0 is the core's
  // joints / weights, sets 1.. take the extra influences in order -> JOINTS_n / WEIGHTS_n
  const extraMax = Array.from({ length: model.vertexCount }, (_, v) => mesh.xcsr[2 * v + 1]).reduce((a, b) => Math.max(a, b), 0);
  const jointSets = [mesh.joints], weightSets = [mesh.weights];
  for (let s = 0; s < Math.ceil(extraMax / 4); s++) { jointSets.push(new Uint16Array(4 * model.vertexCount)); weightSets.push(new Float32Array(4 * model.vertexCount)); }
  for (let v = 0; v < model.vertexCount; v++) for (let k = 0; k < mesh.xcsr[2 * v + 1]; k++) {
    const e = mesh.xcsr[2 * v] + k, s = 1 + (k >> 2), slot = 4 * v + (k & 3);
    jointSets[s][slot] = mesh.extraWeights[4 * e]; weightSets[s][slot] = mesh.extraWeights[4 * e + 1];
  }
  if (extraMax) log(`note: vertices with up to ${4 + extraMax} bones: written as ${jointSets.length} JOINTS_n / WEIGHTS_n sets (three.js reads only the first four; Blender, Godot and Unity read more)`);
  let FLAT = FORCE_FLAT || !rt.ex.ugo_skeleton_is_simple(model.ptr);
  if (FLAT && !FORCE_FLAT) log('note: the skeleton uses IK / transform constraints, shear or non-normal inheritance: bones are written flat, with each frame\'s world matrix baked (docs/3D.md)');
  const nv = model.vertexCount, nb = model.boneCount, np = model.partCount, nm = model.morphCount;
  const UNIT = HEIGHT > 0 ? HEIGHT / model.canvas[1] : 0.01; // metres per pixel
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
  const inst = model.createInstance();
  const frameOf = () => inst.frame();
  const morphW = () => Array.from(frameOf().subarray(model.morphOffset, model.morphOffset + nm));
  const opacities = () => Array.from(frameOf().subarray(model.opacityOffset, model.opacityOffset + np));
  const poseOf = (b) => { ex.ugo_bone_pose(inst.ptr, b, scratch); return Array.from(rt.f32(scratch, 5)); };

  // name each morph after the parameter that drives it, find parts whose opacity changes
  const morphNames = new Array(nm).fill(null);
  const changingParts = new Set();
  inst.reset(); inst.update(0);
  const restOpacity = opacities();
  restOpacity.forEach((o, i) => { if (o < 1) changingParts.add(i); });
  model.params.forEach((p, pi) => {
    for (const v of [p.min, p.max, (p.min + p.def) / 2, (p.max + p.def) / 2]) {
      if (v === p.def) continue;
      inst.reset(); inst.resetPhysics(); inst.set(pi, v); inst.update(0);
      morphW().forEach((w, mi) => { if (w > 0.4 && !morphNames[mi]) morphNames[mi] = `${p.name}${v > p.def ? '+' : '-'}`; });
      opacities().forEach((o, i) => { if (Math.abs(o - restOpacity[i]) > 1e-4) changingParts.add(i); });
    }
  });
  // animations show and hide parts too (Spine's attachment switches and draw order copies)
  model.animations.forEach((anim, ai) => {
    for (let f = 0; f <= Math.round(anim.duration * FPS); f++) {
      inst.reset(); inst.play(ai, f / FPS); inst.update(0);
      opacities().forEach((o, i) => { if (Math.abs(o - restOpacity[i]) > 1e-4) changingParts.add(i); });
    }
  });
  morphNames.forEach((n, i) => { if (!n) morphNames[i] = `morph${i}`; });
  const visParts = [...changingParts].sort((a, b) => a - b);

  // ---- coordinate conversion: Ugo9 (px, y down) -> glTF (m, y up) ------------------
  const toTRS = ([x, y, rot, sx, sy]) => ({
    t: [x * UNIT, -y * UNIT, 0],
    r: [0, 0, Math.sin(-rot / 2), Math.cos(-rot / 2)],
    s: [sx, sy, 1],
  });
  // 2D affine (a, b, c, d, tx, ty) helpers for bind matrices
  const affine = ({ t, r, s }) => {
    const ang = 2 * Math.atan2(r[2], r[3]), c = Math.cos(ang), sn = Math.sin(ang);
    return [c * s[0], sn * s[0], -sn * s[1], c * s[1], t[0], t[1]];
  };
  // flat skeleton: world matrix in glTF units (C M C^-1, C = diag(UNIT, -UNIT)) and its split
  // into basis (T, R(θ + φ), Λ) and joint (R(-φ), diag(1, ±1)): M = T R P F, P = Q Λ Qᵀ
  const worldGl = (b) => {
    ex.ugo_bone_world(inst.ptr, b, scratch);
    const [a, bb, c, d, tx, ty] = rt.f32(scratch, 6);
    return [a, -bb, -c, d, tx * UNIT, -ty * UNIT];
  };
  const quatZ = (ang) => [0, 0, Math.sin(ang / 2), Math.cos(ang / 2)];
  function decompose([a, b, c, d, tx, ty]) {
    const flip = a * d - b * c < 0 ? -1 : 1;
    const c2 = c * flip, d2 = d * flip; // M F
    const th = Math.atan2(b - c2, a + d2), co = Math.cos(th), si = Math.sin(th);
    const p11 = co * a + si * b, p22 = -si * c2 + co * d2, q = (co * c2 + si * d2 - si * a + co * b) / 2; // P = Rᵀ M F
    const phi = Math.abs(q) < 1e-7 ? 0 : 0.5 * Math.atan2(2 * q, p11 - p22), cp = Math.cos(phi), sp = Math.sin(phi);
    const l1 = p11 * cp * cp + 2 * q * sp * cp + p22 * sp * sp, l2 = p11 * sp * sp - 2 * q * sp * cp + p22 * cp * cp;
    return { t: [tx, ty, 0], r: quatZ(th + phi), s: [l1, l2, 1], jr: quatZ(-phi), js: [1, flip, 1] };
  }
  // bones in warp grids (format 0.5) ride the grid, which parent-child nodes cannot follow: if the
  // nested poses do not rebuild the core's world matrices somewhere, write the skeleton flat
  if (!FLAT) {
    const off = () => {
      const world = [];
      return bones.some((b, i) => {
        const L = affine(toTRS(poseOf(i)));
        world.push(b.parent < 0 ? L : mul2d(world[b.parent], L));
        const G = worldGl(i);
        return world[i].some((v, k) => Math.abs(v - G[k]) > (k < 4 ? 1e-4 : 1e-3 * UNIT));
      });
    };
    const tries = [() => {}, ...model.params.flatMap((p, pi) => [p.min, p.max].map((v) => () => inst.set(pi, v))),
      ...model.animations.flatMap((a, ai) => [0, 0.25, 0.5, 0.75].map((f) => () => inst.play(ai, f * a.duration)))];
    if (tries.some((t) => { inst.reset(); inst.resetPhysics(); t(); inst.update(0); return off(); })) {
      FLAT = true;
      log('note: the bones do not follow from their parents alone (bones in warp grids): bones are written flat (docs/3D.md)');
    }
  }
  const W = new GltfBuilder();
  const view = (typed, target) => W.view(typed, target);
  const accessor = (...args) => W.accessor(...args);
  const mul = mul2d, inv = inv2d, mat4 = mat4of2d;

  // ---- draw order (format 0.8) -------------------------------------------------------
  // the parts' order at rest (their draw order values): triangles in that order, later parts in front.
  // glTF has no draw order that changes: where parameters or animations change it, the rest order stays
  let rank = (k) => k, restOrder = null;
  if (model.hasDrawOrder) {
    inst.reset(); inst.update(0);
    restOrder = Array.from(inst.drawOrder());
    const restKey = inst.drawOrderKey(), at = new Map(restOrder.map((p, k) => [p, k]));
    rank = (k) => at.get(k);
    let changes = false;
    for (const [k, v] of model.params.flatMap((p, k) => [[k, p.min], [k, p.max]])) { inst.reset(); inst.set(k, v); inst.update(0); if (inst.drawOrderKey() !== restKey) changes = true; }
    model.animations.forEach((a, ai) => { for (const f of [0, 0.25, 0.5, 0.75, 1]) { inst.reset(); inst.play(ai, f * a.duration); inst.update(0); if (inst.drawOrderKey() !== restKey) changes = true; } });
    if (changes) log('warning: parameters or animations change the draw order (format 0.8): glTF keeps the order at rest');
    inst.reset(); inst.update(0);
  }

  // ---- mesh ------------------------------------------------------------------------
  const positions = new Float32Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    positions[3 * i] = mesh.positions[2 * i] * UNIT;
    positions[3 * i + 1] = -mesh.positions[2 * i + 1] * UNIT;
    positions[3 * i + 2] = rank(mesh.parts[i]) * DEPTH; // later parts in front
  }
  const attributes = { // POSITION is added after the warp grids put their rest shape in
    TEXCOORD_0: accessor(mesh.uvs, 'VEC2', FLOAT, { target: 34962 }),
  };
  if (LIT) { // flat sheet facing +z
    const normals = new Float32Array(3 * nv);
    for (let i = 0; i < nv; i++) normals[3 * i + 2] = 1;
    attributes.NORMAL = accessor(normals, 'VEC3', FLOAT, { target: 34962 });
  }
  // the triangles: one primitive per run of parts on the same atlas page (maskOnly parts left out)
  const pngs = Array.isArray(png) ? png : [png], runs = primitiveRuns(model, mesh, restOrder);
  for (const r of runs) if (!pngs[r.texture]) throw new Error(`exportGlb: no picture for texture ${r.texture} (${model.textures[r.texture] || '?'})`);
  const runIndices = runs.map((r) => accessor(r.indices, 'SCALAR', UINT, { target: 34963 }));

  // morph targets: sparse POSITION deltas
  const perMorph = Array.from({ length: nm }, () => new Map());
  for (let v = 0; v < nv; v++) {
    const start = mesh.csr[2 * v], count = mesh.csr[2 * v + 1];
    for (let e = start; e < start + count; e++) {
      const m = mesh.entries[4 * e], dx = mesh.entries[4 * e + 1], dy = mesh.entries[4 * e + 2];
      perMorph[m].set(v, [dx * UNIT, -dy * UNIT]);
    }
  }
  // ---- warp grids (format 0.5) -------------------------------------------------------------
  // glTF has no warp grids. A part in a grid is skinned whole to the grid's bone (the outermost
  // grid's; bone 0 for a grid in model space) at its rest shape, and the grids' bending becomes
  // morph targets: one per parameter end (the shape at the parameter's min or max, the others at
  // their defaults). Baked animations pick, each frame, the weights of those targets that come
  // closest to the core's shape (least squares), so they are close but not exact where grids
  // bend in ways the parameter ends do not add up to (docs/3D.md).
  const warpVerts = [], warpOwner = [];
  parts.forEach((p, pi) => {
    let w = ex.ugo_part_warp(model.ptr, pi);
    if (w < 0) return;
    while (ex.ugo_warp_parent(model.ptr, w) >= 0) w = ex.ugo_warp_parent(model.ptr, w);
    const b = Math.max(0, ex.ugo_warp_bone(model.ptr, w));
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) { warpVerts.push(v); warpOwner.push(b); }
  });
  const deformBuf = warpVerts.length ? rt.alloc(8 * nv) : 0;
  let warpRest = null, warpW0 = null;
  // where each grid vertex sits in the bind pose so that its bone's skinning puts it where the core does
  const warpBind = () => {
    ex.ugo_deform_cpu(inst.ptr, deformBuf);
    const P = rt.f32(deformBuf, 2 * nv), out = new Float64Array(2 * warpVerts.length), local = new Map();
    warpVerts.forEach((v, k) => {
      const b = warpOwner[k];
      if (!local.has(b)) local.set(b, mul(warpW0[b], inv(worldGl(b))));
      const M = local.get(b), x = P[2 * v] * UNIT, y = -P[2 * v + 1] * UNIT;
      out[2 * k] = M[0] * x + M[2] * y + M[4]; out[2 * k + 1] = M[1] * x + M[3] * y + M[5];
    });
    return out;
  };
  const warpTargets = [], warpNames = [];
  let warpFit = null;
  if (warpVerts.length) {
    inst.reset(); inst.resetPhysics(); inst.update(0);
    warpW0 = bones.map((_, b) => worldGl(b));
    warpRest = warpBind();
    warpVerts.forEach((v, k) => {
      positions[3 * v] = warpRest[2 * k]; positions[3 * v + 1] = warpRest[2 * k + 1]; // mesh positions are grid cells: use the rest shape
      for (let s = 0; s < jointSets.length; s++) for (let c = 0; c < 4; c++) { jointSets[s][4 * v + c] = s || c ? 0 : warpOwner[k]; weightSets[s][4 * v + c] = s || c ? 0 : 1; }
      mesh.xcsr[2 * v + 1] = 0;
      for (const m of perMorph) m.delete(v); // their deltas are in grid cells; the targets below hold them
    });
    const basis = [], shapeAt = (set, name) => {
      inst.reset(); inst.resetPhysics(); set(); inst.update(0);
      const d = warpBind().map((q, i) => q - warpRest[i]);
      if (d.every((x) => Math.abs(x) < 1e-7)) return false;
      basis.push(d); warpNames.push(name);
      const map = new Map();
      warpVerts.forEach((vv, k) => { if (d[2 * k] || d[2 * k + 1]) map.set(vv, [d[2 * k], d[2 * k + 1]]); });
      warpTargets.push(map);
      return true;
    };
    // each parameter's ends and half-way points, then (if there are not too many) the corners of
    // every pair of those parameters: grids bend non-linearly, nested grids multiply
    const ends = [];
    model.params.forEach((p, pi) => {
      for (const v of [p.min, p.max]) {
        if (v === p.def) continue;
        const sign = v > p.def ? '+' : '-';
        if (shapeAt(() => inst.set(pi, v), `warp:${p.name}${sign}`)) {
          ends.push([pi, v, `${p.name}${sign}`]);
          shapeAt(() => inst.set(pi, (p.def + v) / 2), `warp:${p.name}${sign}/2`);
        }
      }
    });
    const pairs = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) if (ends[i][0] !== ends[j][0]) pairs.push([ends[i], ends[j]]);
    if (basis.length + pairs.length <= 96) for (const [a, c] of pairs) shapeAt(() => { inst.set(a[0], a[1]); inst.set(c[0], c[1]); }, `warp:${a[2]}&${c[2]}`);
    else log(`note: ${pairs.length} pairs of parameters bend warp grids: only single parameters are written (the fit is rougher)`);
    // least squares: (Dᵀ D + λ I) w = Dᵀ (q - rest), by Cholesky
    const K = basis.length, A = Array.from({ length: K }, (_, i) => basis.map((dj) => basis[i].reduce((s, x, n) => s + x * dj[n], 0)));
    const ridge = 1e-9 * Math.max(1e-12, ...A.map((r, i) => r[i]));
    const L = A.map((r) => r.map(() => 0));
    for (let i = 0; i < K; i++) for (let j = 0; j <= i; j++) {
      let sum = A[i][j] + (i === j ? ridge : 0);
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-30)) : sum / L[j][j];
    }
    warpFit = (q) => {
      const r = q.map((x, i) => x - warpRest[i]), y = basis.map((d) => d.reduce((s, x, n) => s + x * r[n], 0));
      for (let i = 0; i < K; i++) { for (let k = 0; k < i; k++) y[i] -= L[i][k] * y[k]; y[i] /= L[i][i]; }
      for (let i = K - 1; i >= 0; i--) { for (let k = i + 1; k < K; k++) y[i] -= L[k][i] * y[k]; y[i] /= L[i][i]; }
      return y;
    };
    log(`note: ${warpVerts.length} vertices in warp grids: written as ${K} morph targets (parameter ends, half-way points and pairs); baked animations fit their weights each frame (docs/3D.md)`);
  }

  attributes.POSITION = accessor(positions, 'VEC3', FLOAT, { target: 34962, bounds: true });
  const sparseTarget = (map) => ({ POSITION: W.sparseVec3(map, nv) });
  const targets = [...perMorph, ...warpTargets].map(sparseTarget);
  const targetNames = [...morphNames, ...warpNames];
  inst.reset(); inst.resetPhysics(); inst.update(0);
  const defaultWeights = [...morphW(), ...warpNames.map(() => 0)];
  const HIDDEN = 1e-4; // not exactly 0: some engines reject singular bone matrices
  const visScale = (o) => (o >= 0.5 ? 1 : HIDDEN);
  const defaultOpacity = opacities();

  // ---- skin -----------------------------------------------------------------------------
  // visibility bones: a child of the bone that carries the part (parts bound rigidly to one bone).
  // A part skinned to several bones gets its own copy of each of those bones instead: a child
  // of the bone with no offset while the part shows; while it is hidden each copy moves to one
  // common point (the first bone's origin) and shrinks, so the whole part collapses there.
  const visBones = [], skinnedVis = [];
  for (const pi of visParts) {
    const p = parts[pi];
    const j = mesh.joints[4 * p.firstVert];
    let rigid = true;
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) if (mesh.joints[4 * v] !== j || mesh.weights[4 * v] < 0.9999 || mesh.xcsr[2 * v + 1]) rigid = false;
    if (!rigid) { skinnedVis.push(pi); continue; }
    const index = nb + visBones.length;
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) mesh.joints[4 * v] = index;
    visBones.push({ part: pi, parent: j, index });
  }
  const copies = []; // { part, bone, common }: joint position nb + visBones.length + index
  for (const pi of skinnedVis) {
    const p = parts[pi], mine = new Map();
    for (let v = p.firstVert; v < p.firstVert + p.vertCount; v++) for (let s = 0; s < jointSets.length; s++) for (let k = 0; k < 4; k++) {
      if (!weightSets[s][4 * v + k]) continue;
      const b = jointSets[s][4 * v + k];
      if (!mine.has(b)) { mine.set(b, nb + visBones.length + copies.length); copies.push({ part: pi, bone: b }); }
      jointSets[s][4 * v + k] = mine.get(b);
    }
    const common = copies.find((c) => c.part === pi).bone;
    for (const c of copies) if (c.part === pi) c.common = common;
  }
  jointSets.forEach((js, s) => {
    attributes[`JOINTS_${s}`] = accessor(js, 'VEC4', USHORT, { target: 34962 });
    attributes[`WEIGHTS_${s}`] = accessor(weightSets[s], 'VEC4', FLOAT, { target: 34962 });
  });
  const restTRS = bones.map((b) => toTRS(b.rest));
  const world = [];
  inst.reset(); inst.resetPhysics(); inst.update(0);
  const restFlat = FLAT ? bones.map((_, b) => decompose(worldGl(b))) : null;
  if (FLAT) bones.forEach((_, b) => world.push(worldGl(b)));
  else bones.forEach((b, i) => { const L = affine(restTRS[i]); world.push(b.parent < 0 ? L : mul(world[b.parent], L)); });
  const ibm = new Float32Array(16 * (nb + visBones.length + copies.length));
  world.forEach((W, i) => ibm.set(mat4(inv(W)), 16 * i));
  visBones.forEach((vb, k) => ibm.set(mat4(inv(world[vb.parent])), 16 * (nb + k))); // identity offset from the parent
  copies.forEach((c, k) => ibm.set(mat4(inv(world[c.bone])), 16 * (nb + visBones.length + k)));
  const ibmAccessor = accessor(ibm, 'MAT4', FLOAT);

  // ---- animations (baked from the runtime) -----------------------------------------------
  // Bake every clip first, then key everything that moves in ANY clip in EVERY
  // clip: engines (Godot was checked) keep the last value of a property a clip
  // does not key, so switching clips would otherwise leave stale poses.
  const baked = model.animations.map((anim, ai) => {
    const frames = Math.max(2, Math.round(anim.duration * FPS) + 1);
    const dt = 1 / FPS;
    inst.reset(); inst.resetPhysics();
    for (let t = -anim.duration; t < -1e-9; t += dt) { inst.reset(); inst.play(ai, t); inst.update(dt); } // settle physics
    const times = new Float32Array(frames);
    const poses = [], weights = [], visFrames = [], flats = [], worlds = [];
    for (let f = 0; f < frames; f++) {
      times[f] = f / FPS;
      inst.reset(); inst.play(ai, f / FPS); inst.update(dt);
      poses.push(bones.map((_, b) => toTRS(poseOf(b))));
      const wf = bones.map((_, b) => worldGl(b));
      worlds.push(wf);
      if (FLAT) flats.push(wf.map(decompose));
      weights.push(warpFit ? [...morphW(), ...warpFit(warpBind())] : morphW());
      visFrames.push(opacities());
    }
    return { name: anim.name, times, poses: FLAT ? flats : poses, weights, visFrames, worlds };
  });
  const moves = { t: new Set(), r: new Set(), s: new Set(), jr: new Set(), js: new Set(), vis: new Set() };
  const restOf = FLAT ? restFlat : restTRS;
  for (const bk of baked) {
    bones.forEach((_, b) => {
      for (const k of FLAT ? ['t', 'r', 's', 'jr', 'js'] : ['t', 'r', 's']) if (bk.poses.some((p) => p[b][k].some((v, i) => Math.abs(v - restOf[b][k][i]) > 1e-6))) moves[k].add(b);
    });
    visBones.forEach((vb, k) => {
      if (bk.visFrames.some((op) => visScale(op[vb.part]) !== visScale(defaultOpacity[vb.part]))) moves.vis.add(k);
    });
  }
  const basisIndex = (b) => nb + visBones.length + 2 + b; // after the mesh node and the character node
  const copyNode = (k) => nb + visBones.length + 2 + (FLAT ? nb : 0) + k; // after the basis nodes
  // the copy's offset from its bone: none while shown; while hidden, at the common point, shrunk
  const copyLocal = (c, w, op) => {
    if (op[c.part] >= 0.5) return { t: [0, 0, 0], s: [1, 1, 1] };
    const B = w[c.bone], P = w[c.common], I = inv(B);
    return { t: [I[0] * P[4] + I[2] * P[5] + I[4], I[1] * P[4] + I[3] * P[5] + I[5], 0], s: [HIDDEN, HIDDEN, 1] };
  };
  const quatTrack = (poses, b, k) => {
    const q = [];
    let prev = null;
    for (const p of poses) { let r = p[b][k]; if (prev && r[2] * prev[2] + r[3] * prev[3] < 0) r = r.map((v) => -v); q.push(...r); prev = r; }
    return new Float32Array(q);
  };
  // drop keys that interpolation between the kept ones reproduces (within tol); STEP keeps changes
  const slerp = (a, b, t) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const s = d < 0 ? -1 : 1; d *= s;
    if (d > 0.9995) { const r = a.map((v, i) => v + (s * b[i] - v) * t), l = Math.hypot(...r); return r.map((v) => v / l); }
    const th = Math.acos(d), k0 = Math.sin((1 - t) * th) / Math.sin(th), k1 = (s * Math.sin(t * th)) / Math.sin(th);
    return a.map((v, i) => k0 * v + k1 * b[i]);
  };
  function reduceKeys(times, data, n, interpolation, tol, quat) {
    const key = (i) => Array.from(data.subarray(i * n, i * n + n)), last = times.length - 1, keep = [0];
    if (interpolation === 'STEP') {
      for (let i = 1; i <= last; i++) if (key(i).some((v, c) => v !== data[keep[keep.length - 1] * n + c])) keep.push(i);
      if (keep[keep.length - 1] !== last) keep.push(last);
    } else {
      let i0 = 0;
      while (i0 < last) {
        let j = i0 + 1;
        for (; j + 1 <= last; j++) { // can the segment i0 .. j+1 skip everything between?
          const A = key(i0), B = key(j + 1);
          let ok = true;
          for (let m = i0 + 1; m <= j && ok; m++) {
            const t = (times[m] - times[i0]) / (times[j + 1] - times[i0]), want = key(m);
            const got = quat ? slerp(A, B, t) : A.map((v, c) => v + (B[c] - v) * t);
            const sgn = quat && got.reduce((s2, v, c) => s2 + v * want[c], 0) < 0 ? -1 : 1;
            for (let c = 0; c < n; c++) if (Math.abs(sgn * got[c] - want[c]) > tol) { ok = false; break; }
          }
          if (!ok) break;
        }
        keep.push(j); i0 = j;
      }
    }
    return { times: Float32Array.from(keep, (i) => times[i]), data: Float32Array.from(keep.flatMap((i) => key(i))) };
  }
  const TOL = { translation: 0.002 * UNIT, rotation: 1e-5, scale: 1e-5, weights: 1e-4 }; // 0.002 px, about 0.001 degrees
  const N = { VEC3: 3, VEC4: 4, SCALAR: 1 };
  W.beginPack();
  const animations = baked.map(({ name, times, poses, weights, visFrames, worlds }) => {
    const inputs = new Map();
    const inputOf = (t) => { const k = Array.from(t).join(','); if (!inputs.has(k)) inputs.set(k, accessor(t, 'SCALAR', FLOAT, { bounds: true })); return inputs.get(k); };
    const samplers = [], channels = [];
    const add = (node, pathName, data, type, interpolation = 'LINEAR') => {
      const n = pathName === 'weights' ? data.length / times.length : N[type];
      if (!n) return;
      const r = reduceKeys(times, data, n, interpolation, TOL[pathName], pathName === 'rotation');
      samplers.push({ input: inputOf(r.times), output: accessor(r.data, type, FLOAT), interpolation });
      channels.push({ sampler: samplers.length - 1, target: { node, path: pathName } });
    };
    bones.forEach((_, b) => {
      const node = FLAT ? basisIndex(b) : b;
      if (moves.t.has(b)) add(node, 'translation', new Float32Array(poses.flatMap((p) => p[b].t)), 'VEC3');
      if (moves.r.has(b)) add(node, 'rotation', quatTrack(poses, b, 'r'), 'VEC4');
      if (moves.s.has(b)) add(node, 'scale', new Float32Array(poses.flatMap((p) => p[b].s)), 'VEC3');
      if (moves.jr.has(b)) add(b, 'rotation', quatTrack(poses, b, 'jr'), 'VEC4');
      if (moves.js.has(b)) add(b, 'scale', new Float32Array(poses.flatMap((p) => p[b].js)), 'VEC3', 'STEP');
    });
    add(nb + visBones.length, 'weights', new Float32Array(weights.flat()), 'SCALAR');
    visBones.forEach((vb, k) => {
      if (!moves.vis.has(k)) return;
      const sc = visFrames.map((op) => visScale(op[vb.part]));
      add(vb.index, 'scale', new Float32Array(sc.flatMap((v) => [v, v, 1])), 'VEC3', 'STEP');
    });
    copies.forEach((c, k) => {
      const cl = worlds.map((w, f) => copyLocal(c, w, visFrames[f]));
      add(copyNode(k), 'translation', new Float32Array(cl.flatMap((x) => x.t)), 'VEC3', 'STEP');
      add(copyNode(k), 'scale', new Float32Array(cl.flatMap((x) => x.s)), 'VEC3', 'STEP');
    });
    return { name, samplers, channels };
  });

  W.endPack();

  // ---- images (the atlas pages, PNG) ---------------------------------------------------------
  const imageViews = pngs.map((b) => view(new Uint8Array(b)));

  // ---- json + glb ------------------------------------------------------------------------
  const nodes = bones.map((b, i) => {
    const n = FLAT ? { name: b.name, rotation: restFlat[i].jr, scale: restFlat[i].js }
      : { name: b.name, translation: restTRS[i].t, rotation: restTRS[i].r, scale: restTRS[i].s };
    const kids = FLAT ? [] : bones.map((c, j) => (c.parent === i ? j : -1)).filter((j) => j >= 0);
    if (kids.length) n.children = kids;
    return n;
  });
  for (const vb of visBones) {
    const s = visScale(defaultOpacity[vb.part]);
    nodes.push({ name: `vis:${parts[vb.part].name}`, scale: [s, s, 1] });
    (nodes[vb.parent].children ||= []).push(vb.index);
  }
  nodes.push({ name: 'character', mesh: 0, skin: 0 });
  const roots = FLAT ? bones.map((_, b) => basisIndex(b)) : bones.map((b, i) => (b.parent < 0 ? i : -1)).filter((i) => i >= 0);
  // One node holds the skeleton: moving it moves the character. The skinned
  // mesh node stays at the scene root, as glTF requires (its own transform is
  // ignored; the joints place it).
  const top = nodes.length;
  nodes.push({
    name: 'Ugo9 character', children: roots,
    extras: { ugo9: { billboard: BILLBOARD, metresPerPixel: UNIT, canvas: model.canvas, lit: LIT, mesh: nb + visBones.length, flatSkeleton: FLAT } },
  });
  if (FLAT) bones.forEach((b, i) => {
    if (nodes.length !== basisIndex(i)) throw new Error('node order');
    nodes.push({ name: `${b.name}:basis`, translation: restFlat[i].t, rotation: restFlat[i].r, scale: restFlat[i].s, children: [i] });
  });
  copies.forEach((c, k) => {
    const r = copyLocal(c, world, defaultOpacity);
    if (nodes.length !== copyNode(k)) throw new Error('node order');
    nodes.push({ name: `vis:${parts[c.part].name}:${bones[c.bone].name}`, translation: r.t, scale: r.s });
    (nodes[c.bone].children ||= []).push(copyNode(k));
  });
  const gltf = {
    asset: { version: '2.0', generator: 'Ugo9 tools/export_gltf.mjs' },
    ...(LIT ? {} : { extensionsUsed: ['KHR_materials_unlit'] }),
    scene: 0,
    scenes: [{ name: 'Ugo9', nodes: [top, nb + visBones.length] }],
    nodes,
    meshes: [{
      name: 'character',
      primitives: runs.map((r, k) => ({ attributes, indices: runIndices[k], material: r.texture, mode: 4, targets })),
      weights: defaultWeights,
      extras: { targetNames },
    }],
    skins: [{ joints: [...bones.map((_, i) => i), ...visBones.map((vb) => vb.index), ...copies.map((_, k) => copyNode(k))], inverseBindMatrices: ibmAccessor, skeleton: FLAT ? top : roots[0] }],
    materials: pngs.map((_, k) => ({ // one per atlas page
      name: k ? `atlas_${k + 1}` : 'atlas',
      pbrMetallicRoughness: { baseColorTexture: { index: k }, metallicFactor: 0, roughnessFactor: 1 },
      alphaMode: 'BLEND', doubleSided: true,
      ...(LIT ? {} : { extensions: { KHR_materials_unlit: {} } }),
    })),
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: imageViews.map((v) => ({ bufferView: v, mimeType: 'image/png' })),
    textures: imageViews.map((_, k) => ({ sampler: 0, source: k })),
    animations,
  };

  const glb = W.glb(gltf);
  return { glb, summary: `${glb.length} bytes; ${nv} vertices, ${nb} bones + ${visBones.length} visibility bones + ${copies.length} bone copies for ${skinnedVis.length} skinned parts that show and hide, ${targets.length} morph targets, ${animations.length} animations at ${FPS} fps` };
}
