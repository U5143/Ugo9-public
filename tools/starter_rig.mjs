// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// All the first drafts in one go, for a model just made from a PSD: a face warp grid (with grids
// for the eyes and the mouth inside it), the face turning, the eyes and the mouth opening and
// closing, and an idle animation. Plain ES module: the editor's "make all drafts" button.
//
//   import { makeStarterRig } from '../tools/starter_rig.mjs';
//   const r = makeStarterRig(model);   // model is not changed
//   // r.warps: grids to add; r.assign: { partId: gridId } (those parts lose bone / weights);
//   // r.params: [[id, min, default, max]] to add; r.motions: [{ at, warps?, morphs? }];
//   // r.animation: the idle animation (or null); r.notes / r.warnings
//
// The editor writes them in that order (warps, assign, params, motions, animation) as one step.
// What the model has already is kept (a face grid, parts in grids, parameters with keyforms, an
// idle animation): that step is skipped with a note, so pressing the button again breaks nothing.

import { makeNotes } from './notes.mjs';
import { makeFaceAngles } from './face_angles.mjs';
import { makeEyeBlink, makeMouthOpen, sideOfPart } from './eye_mouth.mjs';
import { makeIdle } from './idle.mjs';

const NAME = (p) => `${p.id ?? ''} ${p.name ?? ''}`;
const HAIR = /hair|髪|bang|もみあげ/i;
const KINDS = [ // what a part is, by its name (first match)
  ['brow', /brow|眉|まゆ/i],
  ['eye', /eye|目|瞳|まぶた|瞼|まつ|睫|lash|iris|pupil|sclera/i],
  ['mouth', /mouth|口|唇|lip|teeth|歯|tongue|舌/i],
  ['nose', /nose|鼻|はな/i],
  ['cheek', /cheek|頬|ほほ|チーク|blush|照れ/i],
  ['face', /face|顔|輪郭|かお/i],
];
const kindOf = (p) => (HAIR.test(NAME(p)) ? null : (KINDS.find(([, re]) => re.test(NAME(p))) || [null])[0]);
const box = (parts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) for (let i = 0; i < p.vertices.length; i += 2) {
    x0 = Math.min(x0, p.vertices[i]); x1 = Math.max(x1, p.vertices[i]); y0 = Math.min(y0, p.vertices[i + 1]); y1 = Math.max(y1, p.vertices[i + 1]);
  }
  return [x0, y0, x1, y1];
};
const r1 = (v) => +v.toFixed(1);
const rectOf = (parts, grow) => {
  const [x0, y0, x1, y1] = box(parts), mx = Math.max(4, (x1 - x0) * grow), my = Math.max(4, (y1 - y0) * grow);
  return [r1(x0 - mx), r1(y0 - my), r1(x1 - x0 + 2 * mx), r1(y1 - y0 + 2 * my)];
};

/**
 * model: working JSON (format 0.5+). opts:
 *   layers   importPsd's layers ({ part, path }) for the folder names (default: model.source.psd.layers)
 *   faceCols, faceRows  the face grid's cells (default 14 x 14: the sphere bake follows a real sphere within 1 % with it)
 *   idle     options for makeIdle (duration, blinks, seed ...)
 * -> { warps, assign, params, motions, animation, keys, notes, warnings }
 *    keys: { param: [values] } of the face turn (a key every 10°): regions go between neighbour keys
 */
export function makeStarterRig(model, opts = {}) {
  const { warnings, notes, note } = makeNotes();
  const parts = (model.parts || []).filter((p) => p.vertices?.length);
  const warps = model.warps || [], deformers = model.deformers || [], ps = model.parameters || [];
  const out = { warps: [], assign: {}, params: [], motions: [], animation: null, keys: {} };
  const made = (step, count) => { if (count) note('starterMade', { step, count }, `made ${count} ${step}`, 'info'); };
  const skipped = (step) => note('starterSkipped', { step }, `${step}: the model has it already (kept)`, 'info');
  const pass = (r) => { for (const n of r.notes) note(n.code, n.vars, n.text, n.level); };

  // ids not taken by parts, bones or grids
  const taken = new Set([...parts.map((p) => p.id), ...(model.bones || []).map((b) => b.id), ...warps.map((w) => w.id)]);
  const freeId = (want) => { let id = want; for (let k = 2; taken.has(id); k++) id = k === 2 ? `${want}_grid` : `${want}_grid${k - 1}`; taken.add(id); return id; };

  // the face's parts and the sides of the eyes (the layer name, else the PSD folders, else the screen)
  const kinds = new Map(parts.map((p) => [p, kindOf(p)]));
  const of = (k) => parts.filter((p) => kinds.get(p) === k);
  const sideOf = sideOfPart(model, opts); // the name, else the PSD folders
  const eyes = of('eye'), sides = { L: [], R: [] };
  const unsided = eyes.filter((p) => { const s = sideOf(p); if (s) sides[s].push(p); return !s; });
  if (unsided.length) { // by where they are on the screen
    const [x0, , x1] = box(eyes), mid = (x0 + x1) / 2;
    for (const p of unsided) { const [a, , b] = box([p]); sides[(a + b) / 2 < mid ? 'L' : 'R'].push(p); }
    note('eyeNoSide', {}, 'the eye parts\' names have no side: the screen-left eye is taken as L, the screen-right as R (swap the parameters if that is wrong)');
  }
  const mouth = of('mouth'), faces = of('face');

  // the face grid: an existing one, else a new one over the face and its features
  const features = [...faces, ...eyes, ...mouth, ...of('brow'), ...of('nose'), ...of('cheek')];
  const inGrid = (p) => p.warp != null;
  let faceGrid = warps.find((w) => w.id === 'face' && w.parent == null) || warps.find((w) => !w.parent && faces.some((p) => p.warp === w.id));
  const virtual = structuredClone(model);
  virtual.warps ||= []; virtual.parameters ||= [];
  if (faceGrid) skipped('grid');
  else if (!faces.length) note('starterNoFace', {}, 'no face part (face / 顔 / 輪郭): no face grid and no face turning');
  else {
    const bones = faces.map((p) => p.bone ?? p.weights?.[0]?.[0]?.[0]).filter(Boolean);
    // the face turn is a sphere a little larger than the face (its edge at 0.9) whose move fades out
    // by 1.6 of its radius: the grid reaches that far (so the outside stays still) and is fine
    // enough (14 x 14) to follow the sphere within 1 % (tools/sphere_bake.mjs)
    const [fx0, fy0, fx1, fy1] = box(faces), reach = 1.6 / 0.9, cxF = (fx0 + fx1) / 2, cyF = (fy0 + fy1) / 2, hx = ((fx1 - fx0) / 2) * reach, hy = ((fy1 - fy0) / 2) * reach;
    const [ax0, ay0, aw, ah] = rectOf(features, 0.1), x0 = Math.min(ax0, cxF - hx), y0 = Math.min(ay0, cyF - hy), x1 = Math.max(ax0 + aw, cxF + hx), y1 = Math.max(ay0 + ah, cyF + hy);
    faceGrid = { id: freeId('face'), cols: opts.faceCols || 14, rows: opts.faceRows || 14, rect: [r1(x0), r1(y0), r1(x1 - x0), r1(y1 - y0)], bone: bones[0] ?? model.bones?.[0]?.id };
    out.warps.push(faceGrid);
  }
  if (faceGrid) {
    const put = (p, id) => {
      if (inGrid(p)) { if (p.warp !== id) note('starterPartInGrid', { part: p.id, grid: p.warp }, `part ${p.id} is in grid ${p.warp} already (kept there)`); return; }
      out.assign[p.id] = id;
    };
    // grids inside the face grid for each eye and the mouth (only for parts not in a grid yet)
    const inner = (id, list, cols, rows) => {
      const free = list.filter((p) => !inGrid(p));
      if (!free.length) { list.forEach((p) => put(p, faceGrid.id)); return; }
      const g = { id: freeId(id), cols, rows, rect: rectOf(free, 0.25), parent: faceGrid.id };
      out.warps.push(g);
      list.forEach((p) => put(p, g.id));
    };
    if (sides.L.length) inner('eyeL', sides.L, 3, 2);
    if (sides.R.length) inner('eyeR', sides.R, 3, 2);
    if (mouth.length) inner('mouth', mouth, 3, 2);
    for (const p of [...faces, ...of('brow'), ...of('nose'), ...of('cheek')]) put(p, faceGrid.id);
    made('grid', out.warps.length);
    virtual.warps.push(...out.warps);
    for (const p of virtual.parts) if (out.assign[p.id]) { delete p.bone; delete p.weights; p.warp = out.assign[p.id]; }
  }

  // parameters: added where a draft below needs one the model doesn't have
  const has = (id) => virtual.parameters.some((p) => p.id === id);
  const keyed = (id) => deformers.some((d) => d.region && id in d.region);
  const need = (id, min, def, max) => { if (!has(id)) { const q = [id, min, def, max]; out.params.push(q); virtual.parameters.push({ id, min, default: def, max }); } };
  // the head's turn: the standard names (docs/パラメータの名前.md, 利用者の声 #409), unless the model has the older ones
  const pick = (std, old) => (!has(std) && has(old) ? old : std), turnX = pick('HeadTurnX', 'AngleX'), turnY = pick('HeadTurnY', 'AngleY');
  if (faceGrid) { need(turnX, -30, 0, 30); need(turnY, -30, 0, 30); }
  if (sides.L.length) need('EyeOpenL', 0, 1, 1);
  if (sides.R.length) need('EyeOpenR', 0, 1, 1);
  if (mouth.length) need('MouthOpen', 0, 0, 1);

  // the drafts, on the copy that has the grids, the parts in them and the parameters
  if (faceGrid) {
    if (keyed(turnX) || keyed(turnY)) skipped('angles');
    else { const r = makeFaceAngles(virtual, { warp: faceGrid.id, auto: 'parts', paramX: turnX, paramY: turnY }); pass(r); out.motions.push(...r.motions); Object.assign(out.keys, r.keys); made('angles', r.motions.length); }
  }
  let blinks = 0, blinkSkipped = false;
  for (const s of ['L', 'R']) {
    if (!sides[s].length) continue;
    if (keyed(`EyeOpen${s}`)) { if (!blinkSkipped) skipped('blink'); blinkSkipped = true; continue; }
    const r = makeEyeBlink(virtual, { parts: sides[s].map((p) => p.id), param: `EyeOpen${s}` });
    pass(r); out.motions.push(...r.motions); blinks += r.motions.length;
  }
  made('blink', blinks);
  if (mouth.length) {
    if (keyed('MouthOpen')) skipped('mouth');
    else { const r = makeMouthOpen(virtual, { parts: mouth.map((p) => p.id), param: 'MouthOpen' }); pass(r); out.motions.push(...r.motions); made('mouth', r.motions.length); }
  }
  if ((model.animations || []).some((a) => a.id === 'idle')) skipped('idle');
  else {
    const r = makeIdle(virtual, { ...(opts.idle || {}), id: 'idle' });
    pass(r);
    if (Object.keys(r.animation.tracks).length || r.animation.bones) { out.animation = r.animation; made('idle', 1); }
  }
  return { ...out, notes, warnings };
}
