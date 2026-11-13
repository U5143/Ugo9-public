// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Fewer keys (an editor's "reduce keys", Spine's "clean up"): in a model's authoring JSON, drops the keys
// of straight runs that a straight line between the kept ones already gives within a tolerance (at every
// dropped key's time; between them the old line is straight too, so the gap stays about as small), and finds
// looping animations whose tracks do not end where they start (the seam jumps).
//
//   import { reduceKeys } from './tools/key_reduce.mjs';
//   const { model, removed, kept, seams } = reduceKeys(src, { fixSeams: false });
//
// Only straight pieces are touched: a key that is step, smooth or bezier, or that a step / smooth / bezier
// piece starts or ends at, is kept, so the curves play exactly as before. Tolerances (the same as the
// compiler's curve pieces): angles 0.05°, positions 0.05 px, parameters 1/1000 of their range, other values
// 1/1000, draw order 0.5. Plain ES module; the source is not changed (a copy is returned).

const TOL = { rotate: 0.05, shearX: 0.05, shearY: 0.05, x: 0.05, y: 0.05, scaleX: 0.001, scaleY: 0.001 };

const straight = (k) => k.length < 3 || k[2] === 'linear' || k[2] == null;

/** Keys [[t, v, interp?, ...]] of one track, numbers or [r, g, b] values -> the kept keys. */
export function reduceTrack(keys, tolerance) {
  if (!Array.isArray(keys) || keys.length < 3) return keys;
  const vec = (k) => (Array.isArray(k[1]) ? k[1] : [k[1]]);
  const within = (a, b, mid) => { // mid on the straight line from a to b, every channel
    const f = b[0] > a[0] ? (mid[0] - a[0]) / (b[0] - a[0]) : 0, va = vec(a), vb = vec(b), vm = vec(mid);
    return vm.every((v, c) => Math.abs(va[c] + (vb[c] - va[c]) * f - v) <= tolerance);
  };
  const out = [keys[0]];
  let anchor = 0;
  for (let j = 1; j < keys.length; j++) {
    const prev = keys[j - 1];
    // a key can go only inside a straight run: the key itself, and the pieces on both sides, straight
    const canDrop = j < keys.length - 1 && straight(keys[anchor]) && straight(prev) && straight(keys[j]) && anchor < j
      && keys[j + 1][0] > keys[j][0] && keys[j][0] > keys[anchor][0];
    if (canDrop) {
      let ok = true;
      for (let m = anchor + 1; m <= j && ok; m++) ok = within(keys[anchor], keys[j + 1], keys[m]);
      if (ok) continue;
    }
    out.push(keys[j]);
    anchor = j;
  }
  return out;
}

function eachTrack(anim, params, fn) {
  const range = new Map((params || []).map((p) => [p.id, (p.max ?? 1) - (p.min ?? 0)]));
  for (const [id, ks] of Object.entries(anim.tracks || {})) fn(anim.tracks, id, ks, (range.get(id) ?? 1) / 1000, `tracks.${id}`);
  for (const [bid, props] of Object.entries(anim.bones || {}))
    for (const [prop, ks] of Object.entries(props)) fn(props, prop, ks, TOL[prop] ?? 0.001, `bones.${bid}.${prop}`);
  for (const [pid, ks] of Object.entries(anim.opacity || {})) fn(anim.opacity, pid, ks, 0.001, `opacity.${pid}`);
  for (const [pid, ks] of Object.entries(anim.order || {})) fn(anim.order, pid, ks, 0.5, `order.${pid}`);
  for (const [mid, ks] of Object.entries(anim.morphs || {})) fn(anim.morphs, mid, ks, 0.001, `morphs.${mid}`);
  for (const [cid, props] of Object.entries(anim.colors || {}))
    for (const [prop, ks] of Object.entries(props)) fn(props, prop, ks, 0.001, `colors.${cid}.${prop}`);
  for (const [cid, props] of Object.entries(anim.constraints || {}))
    for (const [prop, ks] of Object.entries(props)) fn(props, prop, ks, 0.001, `constraints.${cid}.${prop}`);
}

/**
 * A model's authoring JSON -> { model (a copy, keys reduced), removed, kept, seams: [{ animation, track,
 * first, last }] } (looping animations whose track ends somewhere else than it starts; with fixSeams the
 * last key takes the first key's value).
 */
export function reduceKeys(src, { fixSeams = false, scale = 1 } = {}) {
  const model = structuredClone(src);
  let removed = 0, kept = 0;
  const seams = [];
  for (const anim of model.animations || []) {
    eachTrack(anim, model.parameters, (holder, key, ks, tol, track) => {
      if (!Array.isArray(ks)) return;
      const out = reduceTrack(ks, tol * scale);
      removed += ks.length - out.length;
      kept += out.length;
      holder[key] = out;
      if (anim.loop !== false && out.length >= 2) {
        const a = out[0][1], b = out.at(-1)[1];
        const differ = Array.isArray(a) ? a.some((v, c) => Math.abs(v - b[c]) > tol) : Math.abs(a - b) > tol;
        if (differ) {
          seams.push({ animation: anim.id, track, first: a, last: b });
          if (fixSeams) out[out.length - 1] = [out.at(-1)[0], Array.isArray(a) ? [...a] : a, ...out.at(-1).slice(2)];
        }
      }
    });
  }
  return { model, removed, kept, seams };
}
