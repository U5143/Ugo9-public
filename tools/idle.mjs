// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A first draft of an idle animation (breathing, blinking, a small sway) from what the model
// already has: its parameters and bones. Plain ES module: the editor imports it.
//
//   import { makeIdle } from '../tools/idle.mjs';
//   const { animation, params, notes, warnings } = makeIdle(model, { duration: 4, blinks: 2 });
//   // animation: { id: 'idle', duration: 4, loop: true, tracks: { Breath: [[0, 0, 'smooth'], ...] }, bones: {...} }
//
// Every track loops: it ends where it starts. Swaying keys sit only on the turning points, so the
// format's 'smooth' keys (smoothstep between keys) make them a cosine-like wave with no kink at
// the loop's seam. Blinks are placed by a seeded random, so the same seed gives the same animation.

import { makeNotes } from './notes.mjs';

const BODY = /^(body|chest|torso|spine|upper_?body)|体|胸|胴|上半身/i;
const HAIR_PARAM = /hair.*(sway|swing|move)|(sway|swing).*hair|髪.*揺|揺.*髪|^(Param)?Hair(Front|Back|Side)?$/i;
const r3 = (v) => +v.toFixed(3);
// a small seeded random (mulberry32)
const random = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * model: working JSON. opts:
 *   duration  seconds (default 4); blinks  how many in it (default 2); amount  scales every move (default 1)
 *   seed      for the blinks' places (default 1); id  the animation's id (default 'idle', else idle2, ...)
 * -> { animation, params, notes, warnings }
 *   params: parameters to add first, [[id, min, default, max]] (makeIdle drives only what is there,
 *   so it is empty: a parameter without keyforms would move nothing; make them with the other drafts)
 */
export function makeIdle(model, opts = {}) {
  const { warnings, notes, note } = makeNotes();
  const d = opts.duration ?? 4, amount = opts.amount ?? 1, nBlinks = opts.blinks ?? 2, rnd = random(opts.seed ?? 1);
  const ps = model.parameters || [];
  const find = (...names) => names.map((n) => ps.find((p) => p.id === n)).find(Boolean);
  const range = (p) => [p.min ?? 0, p.default ?? 0, p.max ?? 1];
  const ids = new Set((model.animations || []).map((a) => a.id));
  let id = opts.id || 'idle';
  for (let k = 2; !opts.id && ids.has(id); k++) id = `idle${k}`;
  const animation = { id, duration: d, loop: true, tracks: {} };
  // a wave through the turning points only: `cycles` whole waves, starting at +a (or -a)
  const wave = (base, a, cycles, sign = 1) => {
    const keys = [];
    for (let k = 0; k <= 2 * cycles; k++) keys.push([r3((k * d) / (2 * cycles)), r3(base + (k % 2 ? -1 : 1) * sign * a), 'smooth']);
    return keys;
  };

  // breathing: the Breath parameter in and out, else the body bone's height a little
  const breath = find('Breath', 'ParamBreath'), cycles = Math.max(1, Math.round(d / 3.5));
  if (breath) {
    const [, def, max] = range(breath), top = def + (max - def) * Math.min(1, amount);
    animation.tracks[breath.id] = wave((def + top) / 2, (top - def) / 2, cycles, -1); // from the rest value up and back
  } else {
    const body = (model.bones || []).find((b) => BODY.test(`${b.id} ${b.name ?? ''}`) && b.warp == null);
    if (body) {
      const s = 0.012 * amount;
      animation.bones = { [body.id]: { scaleY: wave(s / 2, s / 2, cycles, -1) } };
      note('idleBreathBone', { bone: body.id }, `no Breath parameter: breathing moves the height of bone ${body.id} a little`, 'info');
    } else note('idleNoBreath', {}, 'no Breath parameter and no body bone (body / chest / 体 / 胸): no breathing');
  }

  // blinking: both eyes at once, closing in 0.06 s, closed 0.02 s, opening in 0.08 s
  const eyeL = find('EyeOpenL', 'EyeLOpen', 'ParamEyeLOpen'), eyeR = find('EyeOpenR', 'EyeROpen', 'ParamEyeROpen');
  const eyes = eyeL || eyeR ? [eyeL, eyeR].filter(Boolean) : [find('EyeOpen', 'ParamEyeOpen')].filter(Boolean);
  if (eyes.length && nBlinks > 0) {
    const span = 0.16, lo = 0.1 * d, hi = d - span - 0.05, seg = (hi - lo) / nBlinks;
    const at = [];
    for (let k = 0; k < nBlinks; k++) at.push(lo + seg * (k + 0.2 + 0.6 * rnd()));
    for (const p of eyes) {
      const [min, def, max] = range(p), shut = def !== min ? min : max, keys = [[0, def, 'smooth']];
      for (const t of at) keys.push([r3(t), def, 'smooth'], [r3(t + 0.06), shut, 'smooth'], [r3(t + 0.08), shut, 'smooth'], [r3(t + span), def, 'smooth']);
      keys.push([d, def]);
      animation.tracks[p.id] = keys;
    }
  } else if (!eyes.length) note('idleNoBlink', {}, 'no EyeOpenL / EyeOpenR (or EyeOpen) parameter: no blinking (make the eye blink draft first)');

  // swaying: the head's angles a tenth of their range, X once, Y twice, Z once against X
  let swayed = 0;
  // (the standard names of docs/パラメータの名前.md first, then the older ones)
  for (const [names, share, cycles, sign] of [[['HeadTurnX', 'AngleX', 'ParamAngleX'], 0.1, 1, 1], [['HeadTurnY', 'AngleY', 'ParamAngleY'], 0.06, 2, -1], [['HeadTilt', 'AngleZ', 'ParamAngleZ'], 0.08, 1, -1]]) {
    const p = find(...names);
    if (!p) continue;
    const [min, def, max] = range(p), a = share * amount * Math.min(max - def, def - min);
    if (a > 0) { animation.tracks[p.id] = wave(def, a, cycles, sign); swayed++; }
  }
  if (!swayed) note('idleNoSway', {}, 'no HeadTurnX / HeadTurnY / HeadTilt (or AngleX / AngleY / AngleZ) parameter: no swaying');

  // hair: chains swing it by themselves; else a hair sway parameter, if any
  if (!(model.chains || []).length) {
    const hair = ps.filter((p) => HAIR_PARAM.test(p.id) && !animation.tracks[p.id]);
    for (const p of hair) {
      const [min, def, max] = range(p), a = 0.3 * amount * Math.min(max - def, def - min);
      if (a > 0) animation.tracks[p.id] = wave(def, a, 2, 1);
    }
  }
  if (!Object.keys(animation.tracks).length && !animation.bones) note('idleNothing', {}, 'nothing to move: add Breath, EyeOpenL / EyeOpenR or HeadTurnX / HeadTurnY / HeadTilt (with their keyforms) first');
  return { animation, params: [], notes, warnings };
}
