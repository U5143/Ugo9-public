// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// What a model loses on the way to an export target, said before exporting (the editor's export
// window shows it). Plain ES module, reads the working JSON only (no wasm).
//
//   import { checkExport } from '../tools/check_export.mjs';
//   const { notes, warnings, ok } = checkExport(model, 'gltf'); // 'ugo' | 'gltf' | 'vrm'
//
// notes: [{ code, level, vars, text, fix }] (tools/notes.mjs, plus `fix`: what to do about it, in
// English; the editor words both from the code and vars). level: 'error' (the export stops),
// 'warn' (the picture or the motion differs in the target), 'info' (written another way, much
// the same). vars hold the names: parts, bones (the first 10), count (all of them).
// ok: no 'error'. The targets:
//   'ugo'   the .ug9 and what draws it as it is (Web, three.js, Unity, Godot, PNG, GIF, video):
//           only the compiler's own errors and warnings (compileUgo checkOnly)
//   'gltf'  tools/export_gltf.mjs; 'vrm'  tools/export_vrm.mjs (glTF too, plus a humanoid)

import { makeNotes } from './notes.mjs';
import { compileUgo } from './compile.mjs';
import { DEFAULT_EXPRESSIONS, PARAM_ALTERNATIVES } from './vrm_export.mjs';

const first = (list) => list.slice(0, 10);
// the eye and mouth parameters the engines' blink and lip sync move (Live2D's names too)
const BLINK = /^(Param)?Eye(Open[LR]|[LR]Open)$/i, MOUTH = /^(Param)?MouthOpen(Y)?$/i;
// texture memory past which a model is slow to load (the editor's export window says it as a warning)
const TEXTURE_MB = 256, TEXTURE_PX = 4096;
// the parameters each VRM expression can come from (the standard names, then the older ones)
const VRM_EXPRESSIONS = { blink: ['EyeOpenL', 'EyeOpenR'], aa: ['MouthOpen'], lookLeft: ['PupilX', 'EyeBallX'], lookUp: ['PupilY', 'EyeBallY'], angry: ['BrowHeightL', 'BrowHeightR', 'BrowY'] };

/** model: working JSON; target: 'ugo' | 'gltf' | 'vrm'; opts.expressions (vrm): the expression -> parameter values the
 *  VRM is written with (default: exportVrm's); opts.textureSizes (ugo): [[width, height]] of the atlas pages, in
 *  model.textures' order (without it the texture memory is not looked at) -> { notes, warnings, ok } */
export function checkExport(model, target = 'ugo', opts = {}) {
  const { warnings, notes, note: plain } = makeNotes();
  const note = (code, vars, text, level, fix) => { plain(code, vars, text, level); notes[notes.length - 1].fix = fix; };
  if (!['ugo', 'gltf', 'vrm'].includes(target)) throw new Error(`checkExport: unknown target ${target}`);

  // the compiler first: what it refuses stops every export
  const cw = [];
  try { compileUgo(model, { warnings: cw, checkOnly: true }); } catch (e) {
    note('exportCompileError', { path: e.path ?? '', code: e.code ?? '', message: e.message }, `the model does not compile: ${e.message}`, 'error', 'fix the error the editor shows in its problems list');
    return { notes, warnings, ok: false };
  }
  if (target === 'ugo') {
    for (const w of cw) note(w.code, w.vars || {}, w.message, w.level === 'info' ? 'info' : 'warn', '');
    // what the paid checking tools look at, beyond what the compiler refuses (利用者の声 #400 の 4): the parameters the
    // engines' automatic blink and lip sync move, and the texture memory
    const pids = (model.parameters || []).map((p) => p.id);
    if (!pids.some((id) => BLINK.test(id))) note('exportNoBlink', {}, 'no eye parameter (EyeOpenL / EyeOpenR): the engines\' automatic blink does nothing', 'info',
      'make the eyes and the mouth with the editor (Parameters > make eyes and mouth), or name the eye parameters EyeOpenL / EyeOpenR');
    if (!pids.some((id) => MOUTH.test(id))) note('exportNoMouth', {}, 'no mouth parameter (MouthOpen): lip sync does nothing', 'info',
      'make the eyes and the mouth with the editor (Parameters > make eyes and mouth), or name the mouth parameter MouthOpen');
    const sizes = opts.textureSizes || [];
    if (sizes.length) {
      const bytes = sizes.reduce((s, [w, h]) => s + w * h * 4, 0), largest = Math.max(...sizes.flat());
      if (bytes > TEXTURE_MB * 2 ** 20 || largest > TEXTURE_PX) note('exportTextureMemory', { bytes, mipmapBytes: Math.round((bytes * 4) / 3), largest },
        `the textures take ${(bytes / 2 ** 20).toFixed(0)} MB (${((bytes * 4) / 3 / 2 ** 20).toFixed(0)} MB with mipmaps), pages up to ${largest} px: slow to load on phones and some engines`, 'warn',
        'also write a half-size version (ugo9.mjs export --light, or the atlases at several sizes), or make the atlas smaller when opening the PSD');
    }
    return { notes, warnings, ok: true };
  }

  const parts = model.parts || [], bones = model.bones || [], deformers = model.deformers || [], anims = model.animations || [];
  const names = (list) => ({ parts: first(list), count: list.length });
  const ids = (list) => list.map((x) => x.id);

  // ---- glTF (and VRM, which is glTF): what it has no place for ----
  const masked = ids(parts.filter((p) => p.mask?.length || p.maskOnly));
  if (masked.length) note('exportMasks', names(masked), `masks are not written: ${masked.length} parts are drawn unclipped`, 'warn', 'draw the clipped parts already clipped in the PSD, or leave them out of this export');
  const blended = ids(parts.filter((p) => p.blend && p.blend !== 'normal'));
  if (blended.length) note('exportBlend', names(blended), `blend modes are not written: ${blended.length} parts are drawn as normal`, 'warn', 'paint the effect into the picture (multiply / screen / add) in the drawing app');
  const coloured = ids(parts.filter((p) => p.color != null));
  if (coloured.length) note('exportColors', names(coloured), `part colours (multiply / screen / tint) are not written: ${coloured.length} parts keep their picture's colours`, 'warn', 'bake the colours into the pictures, or leave colour changes out of this export');
  const orderParts = new Set();
  for (const d of deformers) for (const id of Object.keys(d.order || {})) orderParts.add(id);
  for (const a of anims) for (const id of Object.keys(a.order || {})) orderParts.add(id);
  if (orderParts.size) note('exportDrawOrder', names([...orderParts]), `the draw order changes (${orderParts.size} parts): the export keeps the order at rest`, 'warn', 'split the parts that change places into two parts (one in front, one behind) and switch them with opacity');
  // the skeleton: written flat (each bone's world matrix baked every frame) where parents alone do not give it
  const shear = bones.filter((b) => b.shearX || b.shearY).map((b) => b.id), inherit = bones.filter((b) => b.inherit && b.inherit !== 'normal').map((b) => b.id);
  const constrained = [...new Set((model.constraints || []).flatMap((c) => c.bones || []))], inWarp = bones.filter((b) => b.warp).map((b) => b.id);
  const flat = [...new Set([...shear, ...inherit, ...constrained, ...inWarp])];
  if (flat.length && target === 'gltf') note('exportFlatSkeleton', { bones: first(flat), count: flat.length }, `IK / transform constraints, shear, inheritance or bones in grids: the bones are written flat, each frame baked (${flat.length} bones)`, 'info', 'nothing to do; to keep a parent-child skeleton, use normal inheritance, no shear and no constraints');
  // grids: their bending becomes morph targets (fitted each frame in the baked animations)
  const gridParts = ids(parts.filter((p) => p.warp));
  if (gridParts.length && target === 'gltf') note('exportGridMorphs', names(gridParts), `${gridParts.length} parts in warp grids: their bending is written as morph targets (close, not exact where two parameters bend a grid together)`, 'info', 'nothing to do');
  // weights past four bones a vertex
  let many = 0;
  const manyParts = [];
  for (const p of parts) { const n = (p.weights || []).filter((w) => w.length > 4).length; if (n) { many += n; manyParts.push(p.id); } }
  if (many) note(target === 'vrm' ? 'exportWeightsCut' : 'exportManyWeights', { parts: first(manyParts), count: many },
    target === 'vrm' ? `${many} vertices are weighted to more than 4 bones: VRM keeps the strongest 4` : `${many} vertices are weighted to more than 4 bones: written as extra JOINTS_n sets (three.js reads only the first 4)`,
    target === 'vrm' ? 'warn' : 'info', target === 'vrm' ? 'keep each vertex on 4 bones at most (the editor\'s weight tools can limit it)' : 'nothing to do for Blender, Godot and Unity');
  // motion that reacts (physics, chains): baked into the animations, not live in the target
  const sway = [...(model.physics || []).map((p) => p.output), ...(model.chains || []).map((c) => c.id)];
  if (sway.length && target === 'gltf') note('exportPhysicsBaked', { names: first(sway), count: sway.length }, `physics and swaying chains (${sway.length}) are baked into the animations: they do not react in the target app`, 'info', 'nothing to do; for live swaying use the .ug9 (Web, Unity, Godot) or VRM spring bones');

  // ---- VRM ----
  if (target === 'vrm') {
    const named = (re) => bones.some((b) => re.test(b.id));
    if (!named(/head/i) || !named(/body|spine|chest|torso/i)) note('vrmNoHumanoid', { head: named(/head/i), body: named(/body|spine|chest|torso/i) },
      'VRM needs a humanoid: bones named like "head" and "body" / "spine" were not found', 'error', 'name the head bone "head" and the body bone "body" (or "spine")');
    if (shear.length || inherit.length || constrained.length) note('vrmSkeleton', { bones: first([...new Set([...shear, ...inherit, ...constrained])]), count: new Set([...shear, ...inherit, ...constrained]).size },
      'IK / transform constraints, shear or non-normal inheritance: the VRM skeleton does not reproduce them', 'warn', 'use normal inheritance, no shear and no constraints on the bones that should move in VRM');
    const loose = (model.chains || []).filter((c) => (c.inertia ?? 1) < 1 || (c.mix ?? 1) < 1).map((c) => c.id);
    if (loose.length) note('vrmChainInertia', { names: first(loose), count: loose.length }, `chains with inertia or mix below 1 (${loose.length}): VRM spring bones use 1 and 1`, 'info', 'nothing to do; they swing a little more freely in VRM');
    const params = new Set((model.parameters || []).map((p) => p.id));
    const missing = Object.entries(VRM_EXPRESSIONS).filter(([, ps]) => ps.every((p) => !params.has(p))).map(([e]) => e);
    // what a VRM app does not move (利用者の声 #400 の 5): VRM has no animations, and moves a model only by its humanoid
    // bones, its expressions and its spring bones
    if (anims.length) note('vrmAnimations', { names: first(ids(anims)), count: anims.length }, `${anims.length} animation(s) are not written: a VRM has none (the app moves the model)`, 'warn',
      'nothing to do for VRM; for the animations use the .ug9 (Web, Unity, Godot), glTF or a video');
    const exprs = opts.expressions || DEFAULT_EXPRESSIONS, inExpr = new Set();
    for (const vals of Object.values(exprs)) for (const n of Object.keys(vals)) for (const m of [n, ...(PARAM_ALTERNATIVES[n] || []).flat()]) { inExpr.add(m); inExpr.add('Param' + m); }
    const swung = new Set((model.physics || []).map((p) => p.output));
    const unused = [...params].filter((p) => !inExpr.has(p) && !swung.has(p));
    if (unused.length) note('vrmParamsUnused', { params: first(unused), count: unused.length }, `${unused.length} parameter(s) no expression uses do nothing in VRM: the app turns the head and body bones itself`, 'warn',
      'give a parameter that should work in VRM an expression (export_vrm.mjs --expressions)');
    if (swung.size) note('vrmPhysicsParams', { params: first([...swung]), count: swung.size }, `${swung.size} parameter(s) swung by physics do not swing in VRM: only swaying chains (bones) become spring bones`, 'warn',
      'swing the hair with a swaying chain of bones (the editor\'s chains) instead of physics on a parameter');
    if (missing.length) note('vrmExpressionsMissing', { expressions: missing, count: missing.length }, `no parameters for the VRM expressions ${missing.join(', ')}: they are left out`, 'info', 'add EyeOpenL / EyeOpenR, MouthOpen, PupilX / PupilY or BrowHeightL / BrowHeightR (older EyeBallX / EyeBallY / BrowY work too; the first drafts make the eyes and the mouth)');
  }
  for (const w of cw) if (w.level !== 'info') note(w.code, w.vars || {}, w.message, 'warn', '');
  return { notes, warnings, ok: !notes.some((n) => n.level === 'error') };
}
