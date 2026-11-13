// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Skeleton pose in Ugo9 model space (y down, angles clockwise on screen):
// bone transform inheritance modes, shear, IK and transform constraints.
// The same rules as core/src/ugo.c; the importers use this to find the posed
// setup skeleton, and the tests use it as a second, independent reference.
//
// Matrices are [a, b, c, d, tx, ty]: (a, b) is the x axis, (c, d) the y axis.

export const INHERIT = { normal: 0, onlyTranslation: 1, noRotationOrReflection: 2, noScale: 3, noScaleOrReflection: 4 };

const wrap = (r) => { r %= 2 * Math.PI; if (r > Math.PI) r -= 2 * Math.PI; else if (r <= -Math.PI) r += 2 * Math.PI; return r; };

/** Local matrix of [x, y, rot, sx, sy, shx, shy]. */
export function localMatrix(l) {
  const [x, y, r, sx, sy, shx, shy] = l;
  return [Math.cos(r + shx) * sx, Math.sin(r + shx) * sx, -Math.sin(r + shy) * sy, Math.cos(r + shy) * sy, x, y];
}

/** The part of the parent's world matrix a bone's axes inherit. */
export function inheritedLinear(P, mode) {
  if (!P || mode === INHERIT.normal) return P ? [P[0], P[1], P[2], P[3]] : [1, 0, 0, 1];
  if (mode === INHERIT.onlyTranslation) return [1, 0, 0, 1];
  const det = P[0] * P[3] - P[2] * P[1];
  const len = Math.hypot(P[0], P[1]);
  const th = len > 1e-9 ? Math.atan2(P[1], P[0]) : 0;
  const c = Math.cos(th), s = Math.sin(th);
  if (mode === INHERIT.noRotationOrReflection) {
    // the parent's scale and shear without its rotation or reflection
    const k = c * P[2] + s * P[3]; // y axis along the parent's x axis
    return [len, 0, k, len > 1e-9 ? Math.abs(det) / len : 0];
  }
  const f = mode === INHERIT.noScale && det < 0 ? -1 : 1; // noScale keeps a reflection
  return [c, s, -s * f, c * f];
}

function compose(P, l, mode) {
  const L = localMatrix(l);
  const Q = inheritedLinear(P, mode);
  const a = Q[0] * L[0] + Q[2] * L[1], b = Q[1] * L[0] + Q[3] * L[1];
  const c = Q[0] * L[2] + Q[2] * L[3], d = Q[1] * L[2] + Q[3] * L[3];
  if (!P) return [a, b, c, d, l[0], l[1]];
  return [a, b, c, d, P[0] * l[0] + P[2] * l[1] + P[4], P[1] * l[0] + P[3] * l[1] + P[5]];
}

const inv2 = (m) => { const det = m[0] * m[3] - m[2] * m[1]; if (Math.abs(det) < 1e-12) return null; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det]; };
const mulv = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

/** Local values that reproduce world matrix W under parent P (shear goes to shy). */
function decompose(W, P, mode, out) {
  if (P) {
    const ip = inv2(P);
    if (ip) [out[0], out[1]] = mulv(ip, W[4] - P[4], W[5] - P[5]);
  } else { out[0] = W[4]; out[1] = W[5]; }
  const Q = inheritedLinear(P, mode), iq = inv2(Q);
  if (!iq) return;
  const [a, b] = mulv(iq, W[0], W[1]), [c, d] = mulv(iq, W[2], W[3]);
  const sx = Math.hypot(a, b), r = Math.atan2(b, a);
  let sy = Math.hypot(c, d), shy = wrap(Math.atan2(d, c) - r - Math.PI / 2);
  if (a * d - c * b < 0) { sy = -sy; shy = wrap(shy + Math.PI); }
  out[2] = r; out[3] = sx; out[4] = sy; out[5] = 0; out[6] = shy;
}

/**
 * World matrices of a skeleton.
 * bones: [{ parent (-1 for none), inherit, length }]
 * locals: one [x, y, rot, sx, sy, shx, shy] per bone (not modified)
 * constraints: sorted by order; { type: 'ik', bones, target, mix, bend, compress, stretch, uniform }
 *   or { type: 'transform', bones, target, local, relative, offRot, offX, offY, offSx, offSy, offShy,
 *        mixRot, mixX, mixY, mixSx, mixSy, mixShear }
 */
export function poseWorld(bones, locals, constraints = []) {
  const n = bones.length;
  const L = locals.map((l) => l.slice());
  const W = new Array(n);
  const update = (from) => {
    for (let i = from; i < n; i++) W[i] = compose(bones[i].parent >= 0 ? W[bones[i].parent] : null, L[i], bones[i].inherit);
  };
  const setWorld = (i, w) => {
    const p = bones[i].parent;
    decompose(w, p >= 0 ? W[p] : null, bones[i].inherit, L[i]);
    update(i);
  };
  update(0);
  for (const c of constraints) {
    if (c.type === 'ik') applyIk(c, bones, L, W, update);
    else if (c.type === 'transform') applyTransform(c, bones, L, W, update, setWorld);
  }
  return W;
}

// rotation (local) that makes bone i's x axis point at world point (tx, ty)
function aimRotation(i, bones, L, W, tx, ty) {
  const p = bones[i].parent;
  const Q = inheritedLinear(p >= 0 ? W[p] : null, bones[i].inherit);
  const iq = inv2(Q);
  if (!iq) return { rot: L[i][2], dist: 0 };
  const [dx, dy] = mulv(iq, tx - W[i][4], ty - W[i][5]);
  return { rot: Math.atan2(dy, dx) - L[i][5], dist: Math.hypot(dx, dy) };
}

function applyIk(c, bones, L, W, update) {
  const T = W[c.target];
  const mix = c.mix;
  if (!mix) return;
  if (c.bones.length === 1) {
    const i = c.bones[0];
    const { rot, dist } = aimRotation(i, bones, L, W, T[4], T[5]);
    L[i][2] += wrap(rot - L[i][2]) * mix;
    const b = bones[i].length * L[i][3];
    if (b > 1e-4 && ((c.compress && dist < b) || (c.stretch && dist > b))) {
      const s = (dist / b - 1) * mix + 1;
      L[i][3] *= s;
      if (c.uniform) L[i][4] *= s;
    }
    update(i);
    return;
  }
  const [a, ch] = c.bones;
  const r0 = L[a][2], rc0 = L[ch][2];
  const A = W[a], C = W[ch];
  const l1 = Math.hypot(C[4] - A[4], C[5] - A[5]);
  const l2 = bones[ch].length * Math.hypot(C[0], C[1]);
  let d = Math.hypot(T[4] - A[4], T[5] - A[5]);
  if (c.stretch && l1 + l2 > 1e-4 && d > l1 + l2) {
    const s = (d / (l1 + l2) - 1) * mix + 1;
    L[a][3] *= s;
    if (c.uniform) L[a][4] *= s;
    update(a);
  }
  if (l1 > 1e-4 && d > 1e-4) {
    // angle at the first bone between the target and the second bone (law of cosines)
    let cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    cos = Math.max(-1, Math.min(1, cos));
    const det = A[0] * A[3] - A[2] * A[1];
    const want = Math.atan2(T[5] - A[5], T[4] - A[4]) + c.bend * (det < 0 ? -1 : 1) * Math.acos(cos);
    const cur = Math.atan2(W[ch][5] - A[5], W[ch][4] - A[4]);
    const delta = wrap(want - cur);
    const cs = Math.cos(delta), sn = Math.sin(delta);
    const ax = A[0] * cs - A[1] * sn, ay = A[0] * sn + A[1] * cs;
    const { rot } = aimRotation(a, bones, L, W, A[4] + ax, A[5] + ay);
    L[a][2] = rot;
    update(a);
  }
  const { rot } = aimRotation(ch, bones, L, W, T[4], T[5]);
  L[ch][2] = rot;
  if (mix !== 1) {
    L[a][2] = r0 + wrap(L[a][2] - r0) * mix;
    L[ch][2] = rc0 + wrap(L[ch][2] - rc0) * mix;
  }
  update(Math.min(a, ch));
}

function applyTransform(c, bones, L, W, update, setWorld) {
  if (!c.mixRot && !c.mixX && !c.mixY && !c.mixSx && !c.mixSy && !c.mixShear) return; // no effect (as in the C core)
  for (const i of c.bones) {
    const T = W[c.target];
    if (c.local) {
      const t = L[c.target], l = L[i];
      if (c.relative) {
        l[2] += (t[2] + c.offRot) * c.mixRot;
        l[0] += (t[0] + c.offX) * c.mixX; l[1] += (t[1] + c.offY) * c.mixY;
        l[3] *= ((t[3] - 1 + c.offSx) * c.mixSx + 1); l[4] *= ((t[4] - 1 + c.offSy) * c.mixSy + 1);
        l[6] += (t[6] + c.offShy) * c.mixShear;
      } else {
        l[2] += wrap(t[2] - l[2] + c.offRot) * c.mixRot;
        l[0] += (t[0] - l[0] + c.offX) * c.mixX; l[1] += (t[1] - l[1] + c.offY) * c.mixY;
        if (l[3]) l[3] += (t[3] - l[3] + c.offSx) * c.mixSx;
        if (l[4]) l[4] += (t[4] - l[4] + c.offSy) * c.mixSy;
        l[6] += wrap(t[6] - l[6] + c.offShy) * c.mixShear;
      }
      update(i);
      continue;
    }
    const w = W[i].slice();
    const tdet = T[0] * T[3] - T[2] * T[1];
    const refl = tdet < 0 ? -1 : 1;
    if (c.mixRot) {
      let r = c.relative ? Math.atan2(T[1], T[0]) + c.offRot * refl
        : wrap(Math.atan2(T[1], T[0]) - Math.atan2(w[1], w[0]) + c.offRot * refl);
      r = wrap(r) * c.mixRot;
      const cs = Math.cos(r), sn = Math.sin(r);
      [w[0], w[1]] = [cs * w[0] - sn * w[1], sn * w[0] + cs * w[1]];
      [w[2], w[3]] = [cs * w[2] - sn * w[3], sn * w[2] + cs * w[3]];
    }
    if (c.mixX || c.mixY) {
      const tx = T[0] * c.offX + T[2] * c.offY + T[4], ty = T[1] * c.offX + T[3] * c.offY + T[5];
      if (c.relative) { w[4] += (tx - T[4] + 0) * c.mixX; w[5] += (ty - T[5]) * c.mixY; } else { w[4] += (tx - w[4]) * c.mixX; w[5] += (ty - w[5]) * c.mixY; }
    }
    if (c.mixSx) {
      const s = Math.hypot(w[0], w[1]);
      if (s > 1e-5) {
        const ts = Math.hypot(T[0], T[1]);
        const k = c.relative ? ((ts - 1 + c.offSx) * c.mixSx + 1) : (s + (ts - s + c.offSx) * c.mixSx) / s;
        w[0] *= k; w[1] *= k;
      }
    }
    if (c.mixSy) {
      const s = Math.hypot(w[2], w[3]);
      if (s > 1e-5) {
        const ts = Math.hypot(T[2], T[3]);
        const k = c.relative ? ((ts - 1 + c.offSy) * c.mixSy + 1) : (s + (ts - s + c.offSy) * c.mixSy) / s;
        w[2] *= k; w[3] *= k;
      }
    }
    if (c.mixShear) {
      const bx = Math.atan2(w[1], w[0]), by = Math.atan2(w[3], w[2]);
      const tsh = wrap(Math.atan2(T[3], T[2]) - Math.atan2(T[1], T[0]));
      let r = c.relative ? tsh - Math.PI / 2 : wrap(tsh - (by - bx));
      r = by + (wrap(r) + c.offShy) * c.mixShear;
      const s = Math.hypot(w[2], w[3]);
      w[2] = Math.cos(r) * s; w[3] = Math.sin(r) * s;
    }
    setWorld(i, w);
  }
}
