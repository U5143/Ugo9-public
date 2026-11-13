// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// First drafts of the eyes closing and the mouth opening, as vertex moves (morphs) of the parts,
// found by their names (PSD layer names, Japanese or English). Plain ES module: the editor imports it.
//
//   import { makeEyeBlink, makeMouthOpen } from '../tools/eye_mouth.mjs';
//   const { motions, warnings } = makeEyeBlink(model);            // both eyes, found by name
//   const one = makeEyeBlink(model, { parts: ['eyeUpperL', 'eyeWhiteL', 'irisL'], param: 'EyeOpenL' });
//   // motions: [{ at: { EyeOpenL: 0 }, morphs: { eyeUpperL: { dense: [dx0, dy0, ...] }, ... } }, ...]
//   const mouth = makeMouthOpen(model);                          // [{ at: { MouthOpen: 1 }, morphs }]
//
// Eyes: the upper lid comes down and the lower lid up until they meet a little below the middle
// of the eye white; the white, the iris and the other eye parts are squashed onto that line.
// Mouth: the lower lip (or jaw) goes down, the upper lip up a little, and the inside of the mouth
// stretches between them. Deltas are model px in the rest pose, as the format's morphs take them.

import { makeNotes } from './notes.mjs';

const NAME = (p) => `${p.id ?? ''} ${p.name ?? ''}`;
const BROW = /brow|眉|まゆ/i;
const EYE = /eye|目|瞳|まぶた|瞼|まつ|睫|lash|iris|pupil|sclera/i;
const EYE_ROLES = [
  ['lower', /lower|下まぶた|下瞼|下まつ|下睫/i],
  ['upper', /upper|上まぶた|上瞼|まつ毛|まつげ|睫|lash|lid|まぶた|瞼/i],
  ['white', /white|白目|sclera/i],
  ['iris', /iris|pupil|瞳|黒目|ハイライト|highlight/i],
];
const MOUTH = /mouth|口|唇|lip|teeth|歯|tongue|舌|jaw|あご|顎/i;
const MOUTH_ROLES = [
  ['inside', /inside|inner|口内|口の中|中|teeth|歯|tongue|舌|oral/i],
  ['lower', /lower|下唇|下|jaw|あご|顎|chin/i],
  ['upper', /upper|上唇|上/i],
];
const roleOf = (p, roles, other) => (roles.find(([, re]) => re.test(NAME(p))) || [other])[0];
// a side from words: 左 / left / a final L (eyeUpperL, eye_L, eye.l); the same for R
const sideIn = (s, id = s) => {
  if (/左|left/i.test(s)) return 'L';
  if (/右|right/i.test(s)) return 'R';
  if (/(?:^|[^A-Z])L\d*$|[_\-. ]l\d*$/.test(id)) return 'L';
  if (/(?:^|[^A-Z])R\d*$|[_\-. ]r\d*$/.test(id)) return 'R';
  return null;
};
/** The character's side of each part: from its name, else from the PSD folders it was in (the
 *  innermost folder that names a side, e.g. 左目), else null. Folders come from opts.layers
 *  (importPsd's layers, { part, path }) or model.source.psd.layers. -> (part) => 'L' | 'R' | null */
export function sideOfPart(model, opts = {}) {
  const layers = opts.layers || model.source?.psd?.layers || [];
  const folders = new Map(layers.filter((l) => l.part).map((l) => [l.part, (l.path || []).slice(0, -1)]));
  return (p) => sideIn(NAME(p), String(p.id ?? '')) || (folders.get(p.id) || []).map((g) => sideIn(String(g))).reverse().find(Boolean) || null;
}
const box = (parts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) for (let i = 0; i < p.vertices.length; i += 2) {
    x0 = Math.min(x0, p.vertices[i]); x1 = Math.max(x1, p.vertices[i]); y0 = Math.min(y0, p.vertices[i + 1]); y1 = Math.max(y1, p.vertices[i + 1]);
  }
  return { x0, y0, x1, y1 };
};
const r3 = (v) => +v.toFixed(3);
const shift = (p, dy) => ({ dense: p.vertices.map((_, i) => (i % 2 ? r3(dy) : 0)) });
// y in [a0, a1] -> [b0, b1] (straight), as deltas
const remap = (p, a0, a1, b0, b1) => ({ dense: p.vertices.map((v, i) => (i % 2 ? r3(b0 + ((v - a0) / ((a1 - a0) || 1)) * (b1 - b0) - v) : 0)) });
const onto = (p, y) => ({ dense: p.vertices.map((v, i) => (i % 2 ? r3(y - v) : 0)) });
// the parameter to drive, the value its motion sits on
function pickParam(model, names, fallback, note, toward, params) {
  const ps = model.parameters || [];
  const p = names.map((n) => ps.find((q) => q.id === n)).find(Boolean);
  if (!p) { if (!params.some((q) => q[0] === fallback.id)) params.push([fallback.id, fallback.min, fallback.default, fallback.max]); note('paramMissing', { param: fallback.id, min: fallback.min, default: fallback.default, max: fallback.max }, `no parameter ${fallback.id}: the motion is made for ${fallback.id} = ${fallback.at} (add it: min ${fallback.min}, default ${fallback.default}, max ${fallback.max})`); return [fallback.id, fallback.at]; }
  const def = p.default ?? 0;
  return [p.id, toward === 'min' ? (def !== p.min ? p.min : p.max) : (def !== p.max ? p.max : p.min)];
}

/**
 * model: working JSON. opts:
 *   parts    the parts of one eye (default: every eye part, found by name, grouped by side: the
 *            part's name, else its PSD folder's (opts.layers or model.source.psd.layers), else the screen)
 *   param    its parameter (default EyeOpenL / EyeOpenR by side; an eye without a side (or opts.parts) drives both,
 *            each with half the motion, so that both at 0 close it once (利用者の声 #409: only the standard
 *            names are made); a model that has the older single EyeOpen keeps it)
 *   closeAt  where the lids meet, from the top of the eye white (0..1, default 0.6)
 * -> { motions: [{ at: { EyeOpenL: 0 }, morphs }], warnings, notes, params }
 *    params: the parameters to add first, [[id, min, default, max]] (empty when all are there)
 */
export function makeEyeBlink(model, opts = {}) {
  const { warnings, notes, note } = makeNotes(), motions = [], params = [];
  const all = (model.parts || []).filter((p) => p.vertices?.length);
  let eyes; // [{ side, parts }]
  if (opts.parts) {
    const parts = opts.parts.map((id) => all.find((p) => p.id === id) || note('partMissing', { part: id }, `no part ${id}`)).filter((p) => typeof p === 'object');
    eyes = parts.length ? [{ side: null, parts }] : [];
  } else {
    const found = all.filter((p) => EYE.test(NAME(p)) && !BROW.test(NAME(p)));
    const by = new Map();
    const sideOf = sideOfPart(model, opts);
    for (const p of found) { const s = sideOf(p); if (!by.has(s)) by.set(s, []); by.get(s).push(p); }
    const unsided = by.get(null) || [];
    by.delete(null);
    if (unsided.length && !by.size) { // no sides in the names: split by where they are on the screen
      const b = box(unsided), mid = (b.x0 + b.x1) / 2, left = unsided.filter((p) => { const q = box([p]); return (q.x0 + q.x1) / 2 < mid; });
      const right = unsided.filter((p) => !left.includes(p));
      if (left.length && right.length) { by.set('L', left); by.set('R', right); note('eyeNoSide', {}, 'the eye parts\' names have no side: the screen-left eye is taken as L, the screen-right as R (swap the parameters if that is wrong)'); }
      else by.set(null, unsided);
    } else if (unsided.length) note('eyeUnsidedSkipped', { parts: unsided.map((p) => p.id) }, `eye parts without a side are left out: ${unsided.map((p) => p.id).join(', ')}`);
    eyes = [...by].map(([side, parts]) => ({ side, parts }));
    if (!eyes.length) note('eyeNotFound', {}, 'no eye parts found by name (eye / 目 / まぶた / 瞳 / 白目 ...): pass opts.parts');
  }
  const closeAt = opts.closeAt ?? 0.6;
  for (const { side, parts } of eyes) {
    const roles = { upper: [], lower: [], white: [], iris: [], other: [] };
    for (const p of parts) roles[roleOf(p, EYE_ROLES, 'other')].push(p);
    if (!roles.upper.length) note('eyeNoUpperLid', { side: side || '' }, `eye${side ? ' ' + side : ''}: no upper lid part (upper / 上まぶた / まつ毛 ...); the eye is only squashed`);
    const ref = box(roles.white.length ? roles.white : roles.other.length ? roles.other : parts);
    const y = ref.y0 + closeAt * (ref.y1 - ref.y0);
    const morphs = {};
    for (const p of roles.upper) { const b = box([p]); morphs[p.id] = shift(p, Math.max(0, y - b.y1)); }
    for (const p of roles.lower) { const b = box([p]); morphs[p.id] = shift(p, Math.min(0, y - b.y0)); }
    for (const p of [...roles.white, ...roles.iris, ...roles.other]) morphs[p.id] = onto(p, y); // squashed onto the line
    const put = (names, m) => {
      const [id, at] = pickParam(model, names, { id: names[0], at: 0, min: 0, default: 1, max: 1 }, note, 'min', params);
      const same = motions.find((x) => x.at[id] === at);
      if (same) Object.assign(same.morphs, m); else motions.push({ at: { [id]: at }, morphs: m });
    };
    const has = (id) => (model.parameters || []).some((q) => q.id === id);
    const single = ['EyeOpen', 'ParamEyeOpen'].find(has); // an older file's one parameter for both eyes: read as it is
    if (opts.param) put([opts.param], morphs);
    else if (side) put([`EyeOpen${side}`, `Eye${side}Open`, `ParamEye${side}Open`, ...(single ? [single] : [])], morphs);
    else if (single) put([single], morphs);
    else { // no side: the standard two, each half of the motion (the morphs add: both at 0 close the eye once)
      const half = Object.fromEntries(Object.entries(morphs).map(([k, v]) => [k, { dense: v.dense.map((d) => r3(d / 2)) }]));
      put(['EyeOpenL', 'EyeLOpen', 'ParamEyeLOpen'], half);
      put(['EyeOpenR', 'EyeROpen', 'ParamEyeROpen'], structuredClone(half));
    }
  }
  return { motions, warnings, notes, params };
}

/**
 * model: working JSON. opts:
 *   parts    the mouth's parts (default: found by name: mouth / 口 / 唇 / 歯 / 舌 ...)
 *   param    its parameter (default MouthOpen, else MouthOpenY / ParamMouthOpenY)
 *   open     how far the lower lip goes down, px (default: 0.3 x the mouth's width)
 * -> { motions: [{ at: { MouthOpen: 1 }, morphs }], warnings, notes, params }
 */
export function makeMouthOpen(model, opts = {}) {
  const { warnings, notes, note } = makeNotes(), params = [];
  const all = (model.parts || []).filter((p) => p.vertices?.length);
  const parts = opts.parts
    ? opts.parts.map((id) => all.find((p) => p.id === id) || note('partMissing', { part: id }, `no part ${id}`)).filter((p) => typeof p === 'object')
    : all.filter((p) => MOUTH.test(NAME(p)));
  if (!parts.length) { note('mouthNotFound', {}, 'no mouth parts found by name (mouth / 口 / 唇 ...): pass opts.parts'); return { motions: [], warnings, notes, params }; }
  const roles = { upper: [], lower: [], inside: [], line: [] };
  for (const p of parts) roles[roleOf(p, MOUTH_ROLES, 'line')].push(p);
  const all_ = box(parts), h = opts.open ?? 0.3 * (all_.x1 - all_.x0), up = 0.15 * h;
  const morphs = {};
  for (const p of roles.lower) morphs[p.id] = shift(p, h);
  for (const p of roles.upper) morphs[p.id] = shift(p, -up);
  // the inside, and a mouth drawn as one part, stretch from the upper lip to the lower
  for (const p of [...roles.inside, ...roles.line]) { const b = box([p]); morphs[p.id] = remap(p, b.y0, b.y1, b.y0 - up, b.y1 + h); }
  if (roles.line.length && !roles.lower.length) note('mouthOnePart', { parts: roles.line.map((p) => p.id) }, `the mouth is one drawing (${roles.line.map((p) => p.id).join(', ')}): it is only stretched; split the lips and the inside into layers for a better opening`);
  const names = opts.param ? [opts.param] : ['MouthOpen', 'MouthOpenY', 'ParamMouthOpenY'];
  const [id, at] = pickParam(model, names, { id: names[0], at: 1, min: 0, default: 0, max: 1 }, note, 'max', params);
  return { motions: [{ at: { [id]: at }, morphs }], warnings, notes, params };
}
