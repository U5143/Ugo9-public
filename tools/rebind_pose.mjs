// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Rebind to the current pose (Spine's "set the setup pose to the current pose"): a pose of the bones
// becomes the model's rest pose. The model at rest then looks as it did posed, and its morphs move the
// same way on the turned mesh.
//
//   import { rebindPose } from './tools/rebind_pose.mjs';
//   const { model, warnings } = rebindPose(runtime, src, { armL: { rotate: 30 }, head: { x: 4 } });
//
// What changes in the authoring JSON (a copy is returned):
//   - each bone's x, y, rotate, scaleX, scaleY: its pose relative to its parent (as the core computes it)
//   - each bone-driven part's vertices: where the pose puts them (the skinning of the core, weights kept)
//   - each morph's deltas on those vertices: turned and scaled as the pose turns that vertex
//   - warp grids: each grid's rest rectangle and angle, the model-space vertices and deltas of the parts in
//     it and its own point deltas, moved as the pose moves the bone that carries the grid (a nested grid:
//     its outermost grid's bone). Exact when that move turns, shifts and scales evenly (else a warning)
// Parameters are at their defaults while posing. Animation and deformer bone values stay offsets, now
// from the new rest (as in Spine). Constraints and chains act again on the new rest. Sheared or specially
// inheriting bones are warned about.
import { compileUgo } from './compile.mjs';

export function rebindPose(runtime, src, offsets = {}) {
  const warnings = [];
  const model = structuredClone(src);
  const m = runtime.loadModel(compileUgo(src)), inst = m.createInstance();
  inst.reset();
  for (const [bone, pose] of Object.entries(offsets)) {
    if (m.boneIndex(bone) === undefined) throw new Error(`ugo rebind: no bone "${bone}"`);
    inst.setBoneOffset(bone, pose);
  }
  inst.update(0);
  // bones: the pose relative to the parent
  for (const b of model.bones || []) {
    const l = inst.boneLocal(b.id);
    if (b.shearX || b.shearY || (b.inherit && b.inherit !== 'normal')) warnings.push(`bone ${b.id}: shear and special inheritance are not carried over exactly`);
    Object.assign(b, { x: l.x, y: l.y, rotate: l.rotate, scaleX: l.scaleX, scaleY: l.scaleY });
  }
  // the skin matrices of this pose, and each vertex's blend of them
  const mesh = m.meshData(), frame = inst.frame(), skin = (j) => frame.subarray(m.skinOffset + 8 * j, m.skinOffset + 8 * j + 6);
  const blend = (v) => { // sum of w * S over the vertex's bones: [a, b, c, d, tx, ty]
    const M = [0, 0, 0, 0, 0, 0];
    const add = (j, w) => { const S = skin(j); for (let k = 0; k < 6; k++) M[k] += w * S[k]; };
    for (let k = 0; k < 4; k++) if (mesh.weights[4 * v + k]) add(mesh.joints[4 * v + k], mesh.weights[4 * v + k]);
    for (let e = 0; e < mesh.xcsr[2 * v + 1]; e++) { const x = mesh.xcsr[2 * v] + e; add(mesh.extraWeights[4 * x], mesh.extraWeights[4 * x + 1]); }
    return M;
  };
  const parts = m.partData().parts, byName = new Map(parts.map((p, i) => [p.name, i]));
  const turn = new Map(); // part id -> (vertex) => its blend of skin matrices
  for (const p of model.parts || []) {
    const i = byName.get(p.id), info = parts[i];
    if (i === undefined || info.warp >= 0) continue;
    if (info.vertexCount * 2 !== (p.vertices || []).length) { warnings.push(`part ${p.id}: its vertices were changed by the compiler (glue?), left as they were`); continue; }
    const Ms = [];
    for (let k = 0; k < info.vertexCount; k++) {
      const v = info.firstVertex + k, M = blend(v), x = mesh.positions[2 * v], y = mesh.positions[2 * v + 1];
      p.vertices[2 * k] = M[0] * x + M[2] * y + M[4];
      p.vertices[2 * k + 1] = M[1] * x + M[3] * y + M[5];
      Ms.push(M);
    }
    turn.set(p.id, (k) => Ms[k]);
  }
  // warp grids: moved by the skin matrix of the bone that carries the outermost grid
  const grids = new Map((model.warps || []).map((w) => [w.id, w]));
  const gridMove = new Map();
  const moveOf = (w) => {
    if (gridMove.has(w.id)) return gridMove.get(w.id);
    const M = w.parent != null ? moveOf(grids.get(w.parent)) : Array.from(skin(m.boneIndex(w.bone ?? model.bones[0].id)));
    gridMove.set(w.id, M);
    return M;
  };
  const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  for (const w of model.warps || []) {
    const M = moveOf(w), sx = Math.hypot(M[0], M[1]), sy = Math.hypot(M[2], M[3]), det = M[0] * M[3] - M[1] * M[2];
    if (Math.abs(sx - sy) > 1e-6 * Math.max(1, sx) || Math.abs(M[0] * M[2] + M[1] * M[3]) > 1e-6 * Math.max(1, sx * sy) || det < 0)
      warnings.push(`warp ${w.id}: its bone's pose is not a turn, shift and even scale; the grid is placed as near as a turned rectangle can be`);
    const [x, y, ww, hh] = w.rect, [cx, cy] = apply(M, x + ww / 2, y + hh / 2), k = Math.sqrt(Math.abs(det));
    w.rect = [cx - ww * k / 2, cy - hh * k / 2, ww * k, hh * k];
    w.angle = (w.angle ?? 0) + Math.atan2(M[1], M[0]) * 180 / Math.PI;
  }
  for (const p of model.parts || []) {
    if (p.warp == null || !grids.has(p.warp)) continue;
    const M = moveOf(grids.get(p.warp));
    for (let k = 0; k < (p.vertices || []).length; k += 2) [p.vertices[k], p.vertices[k + 1]] = apply(M, p.vertices[k], p.vertices[k + 1]);
    turn.set(p.id, () => M); // the same move for every vertex in the grid
  }
  for (const d of model.deformers || []) {
    for (const [wid, wo] of Object.entries(d.warps || {})) {
      const w = grids.get(wid);
      if (!w) continue;
      const M = moveOf(w), one = (arr, at) => { const dx = arr[at], dy = arr[at + 1]; arr[at] = M[0] * dx + M[2] * dy; arr[at + 1] = M[1] * dx + M[3] * dy; };
      if (Array.isArray(wo.dense)) for (let k = 0; k < wo.dense.length; k += 2) one(wo.dense, k);
      else if (Array.isArray(wo.deltas)) for (let k = 0; k < wo.deltas.length; k += 2) one(wo.deltas, k);
    }
  }
  for (const d of model.deformers || []) {
    for (const [pid, mo] of Object.entries(d.morphs || {})) {
      const turnOf = turn.get(pid);
      if (!turnOf) continue;
      const one = (k, arr, at) => { const M = turnOf(k), dx = arr[at], dy = arr[at + 1]; arr[at] = M[0] * dx + M[2] * dy; arr[at + 1] = M[1] * dx + M[3] * dy; };
      if (Array.isArray(mo.dense)) for (let k = 0; k < mo.dense.length / 2; k++) one(k, mo.dense, 2 * k);
      else if (Array.isArray(mo.vertices)) mo.vertices.forEach((k, n) => one(k, mo.deltas, 2 * n));
    }
  }
  if ((model.animations || []).some((a) => a.bones && Object.keys(a.bones).length)) warnings.push('animations: bone tracks stay offsets, now from the new rest pose');
  return { model, warnings };
}
