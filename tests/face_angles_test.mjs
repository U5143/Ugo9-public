// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/face_angles.mjs: the face turning draft. The older way (method 'points': control points
// moved to the turned ellipsoid, keys at the ends) first, then the default (the sphere bake). The motions are put into a model as regions on
// their keys (as the editor does), and the core's control points are checked: at each end and at
// each corner they sit where the turned ellipsoid puts them; the face moves the right way.
//   node tests/face_angles_test.mjs
import fs from 'node:fs';
import { makeFaceAngles } from '../tools/face_angles.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

// a face grid 6 x 6 over a 200 x 240 face, AngleX -30..30, AngleY -30..30
const model = {
  format: 'ugo9', version: '0.6', canvas: { width: 400, height: 400, originX: 200, originY: 380 },
  parameters: [{ id: 'AngleX', min: -30, default: 0, max: 30 }, { id: 'AngleY', min: -30, default: 0, max: 30 }],
  bones: [{ id: 'root' }],
  warps: [{ id: 'face', cols: 6, rows: 6, rect: [-100, -300, 200, 240] }],
  parts: [{ id: 'dot', texture: 0, vertices: [0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], warp: 'face' }],
  textures: ['none.png'], deformers: [], animations: [],
};
const { motions, warnings } = makeFaceAngles(model, { warp: 'face', method: 'points' });
check(motions.length === 8 && warnings.length === 1 && /centre \[0, -180\], radius \[100, 120\] \(from the grid\)/.test(warnings[0]), `8 motions: ${motions.map((m) => JSON.stringify(m.at)).join(' ')}`);

// as regions on their keys: a single key is a tent from the default, a corner the product of two
const tent = (id, v) => { const p = model.parameters.find((q) => q.id === id); return v > p.default ? [p.default, v, v] : [v, v, p.default]; };
const m2 = structuredClone(model);
m2.deformers = motions.map((m) => ({ region: Object.fromEntries(Object.entries(m.at).map(([k, v]) => [k, tent(k, v)])), warps: m.warps }));
const um = rt.loadModel(compileUgo(m2)), inst = um.createInstance();
const points = (ax, ay) => { inst.reset(); inst.set('AngleX', ax); inst.set('AngleY', ay); inst.update(0); return Array.from(inst.warpPoints(0)); };
const rest = points(0, 0), n = rest.length / 2, centre = 3 * 7 + 3; // the middle control point

// the ellipsoid turned both ways, computed here
const turned = (yawDeg, pitchDeg) => {
  const out = [], yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180, depth = 0.6 * 100;
  for (let k = 0; k < n; k++) {
    const x = rest[2 * k], y = rest[2 * k + 1], u = x / 100, v = (y + 180) / 120;
    let X = x, Y = y + 180, Z = depth * Math.sqrt(Math.max(0, 1 - u * u - v * v));
    [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)];
    [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)];
    out.push(X, Y - 180);
  }
  return out;
};
const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
let worst = 0;
for (const [ax, ay, yaw, pitch] of [[30, 0, 30, 0], [-30, 0, -30, 0], [0, 30, 0, 20], [0, -30, 0, -20], [30, 30, 30, 20], [30, -30, 30, -20], [-30, 30, -30, 20], [-30, -30, -30, -20]])
  worst = Math.max(worst, diff(points(ax, ay), turned(yaw, pitch)));
check(worst < 1e-3, `at every end and corner the core's control points are the turned ellipsoid's (largest difference ${worst.toExponential(1)} px)`);
const r = points(30, 0), u = points(0, 30);
check(r[2 * centre] - rest[2 * centre] > 20 && Math.abs(r[2 * centre + 1] - rest[2 * centre + 1]) < 1e-6, `AngleX = 30 turns the face to the right (the middle moves ${(r[2 * centre] - rest[2 * centre]).toFixed(1)} px)`);
check(u[2 * centre + 1] - rest[2 * centre + 1] < -10, `AngleY = 30 turns the face up (the middle moves ${(u[2 * centre + 1] - rest[2 * centre + 1]).toFixed(1)} px)`);
const h = points(15, 0), half = rest.map((v, i) => v + (r[i] - v) / 2);
check(diff(h, half) < 1e-3, 'half way (AngleX = 15) is half the move: a draft for the editor to refine');
const { warnings: w2 } = makeFaceAngles({ ...model, parameters: [] }, { warp: 'face' });
check(w2.some((w) => /no parameter (AngleX|HeadTurnX)/.test(w)) && makeFaceAngles({ ...model, parameters: [] }, { warp: 'face' }).notes.filter((n) => n.code === 'paramMissing').map((n) => n.vars.param).join() === 'HeadTurnX,HeadTurnY' && JSON.stringify(makeFaceAngles({ ...model, parameters: [] }, { warp: 'face' }).params) === '[["HeadTurnX",-30,0,30],["HeadTurnY",-30,0,30]]', 'a missing parameter is warned about and returned in params, with the standard names (HeadTurnX, HeadTurnY; 利用者の声 #409)');
{ // a model with the older names keeps them; with both, the standard ones
  const both = { ...model, parameters: [...model.parameters, { id: 'HeadTurnX', min: -30, default: 0, max: 30 }, { id: 'HeadTurnY', min: -30, default: 0, max: 30 }] };
  const old = makeFaceAngles(model, { warp: 'face' }), std = makeFaceAngles(both, { warp: 'face' });
  check(old.params.length === 0 && Object.keys(old.keys).join() === 'AngleX,AngleY' && Object.keys(std.keys).join() === 'HeadTurnX,HeadTurnY', 'a model that has AngleX / AngleY keeps them (nothing to add); one that has HeadTurnX / HeadTurnY uses those');
}

// the face's centre and radius from the parts in the grid: a face part smaller than the grid
// (with a margin), hair that is bigger; the face part decides
{
  const sq = (id, x0, y0, x1, y1, warp) => ({ id, texture: 0, vertices: [x0, y0, x1, y0, x1, y1, x0, y1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], warp });
  const m3 = { ...model, parts: [sq('前髪', -100, -300, 100, -200, 'face'), sq('顔', -80, -280, 80, -80, 'face'), sq('nose', -5, -170, 5, -150, 'face')] };
  const a = makeFaceAngles(m3, { auto: 'parts' });
  check(a.center.join() === '0,-180' && a.radius.join() === '80,100' && /from part 顔/.test(a.warnings[0])
    && JSON.stringify(a.notes[0]) === JSON.stringify({ code: 'faceCentre', vars: { center: [0, -180], radius: [80, 100], from: 'parts', parts: ['顔'] }, level: 'info', text: a.warnings[0] }), `auto: 'parts' takes the face part: ${a.warnings[0]}`);
  m3.parts = m3.parts.filter((p) => p.id !== '顔');
  const b = makeFaceAngles(m3, { auto: 'parts' });
  check(b.center.join() === '0,-160' && b.radius.join() === '5,10' && /from the parts in the grid/.test(b.warnings[0]), `without a face part, all but hair: ${b.warnings[0]}`);
  const c = makeFaceAngles(m3, { auto: 'parts', radius: [90, 110] });
  check(c.center.join() === '0,-160' && c.radius.join() === '90,110', 'a given radius is kept');
}

// grids inside the face grid: an eye grid in the face, a pupil grid in the eye. Their control
// points (as the core puts them, through the turned face surface) land on the turned ellipsoid too
{
  const m4 = structuredClone(model);
  m4.warps.push({ id: 'eye', cols: 3, rows: 2, rect: [-70, -230, 60, 30], parent: 'face' }, { id: 'pupil', cols: 2, rows: 2, rect: [-50, -225, 20, 20], parent: 'eye' });
  const { motions: mm, warnings: ww } = makeFaceAngles(m4, { method: 'points' });
  check(mm.every((m) => Object.keys(m.warps).join() === 'face,eye,pupil') && ww.length === 1, 'every motion moves the face, the eye and the pupil grids');
  const m5 = structuredClone(m4);
  m5.deformers = mm.map((m) => ({ region: Object.fromEntries(Object.entries(m.at).map(([k, v]) => [k, tent(k, v)])), warps: m.warps }));
  const um5 = rt.loadModel(compileUgo(m5)), i5 = um5.createInstance();
  const at = (ax, ay, g) => { i5.reset(); i5.set('AngleX', ax); i5.set('AngleY', ay); i5.update(0); return Array.from(i5.warpPoints(g)); };
  const turnedPts = (pts, yawDeg, pitchDeg) => {
    const out = [], yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180, depth = 0.6 * 100;
    for (let k = 0; k < pts.length; k += 2) {
      const x = pts[k], y = pts[k + 1], u = x / 100, v = (y + 180) / 120;
      let X = x, Y = y + 180, Z = depth * Math.sqrt(Math.max(0, 1 - u * u - v * v));
      [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)];
      [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)];
      out.push(X, Y - 180);
    }
    return out;
  };
  let worstEye = 0, worstPupil = 0, plain = 0;
  const restEye = at(0, 0, 1), restPupil = at(0, 0, 2);
  for (const [ax, ay, yaw, pitch] of [[30, 0, 30, 0], [-30, 0, -30, 0], [0, 30, 0, 20], [0, -30, 0, -20], [30, 30, 30, 20], [30, -30, 30, -20], [-30, 30, -30, 20], [-30, -30, -30, -20]]) {
    worstEye = Math.max(worstEye, diff(at(ax, ay, 1), turnedPts(restEye, yaw, pitch)));
    worstPupil = Math.max(worstPupil, diff(at(ax, ay, 2), turnedPts(restPupil, yaw, pitch)));
  }
  // the same model with only the face grid moved: the eye follows the smooth face surface and misses
  const m6 = structuredClone(m4);
  m6.deformers = makeFaceAngles(m4, { nested: false, method: 'points' }).motions.map((m) => ({ region: Object.fromEntries(Object.entries(m.at).map(([k, v]) => [k, tent(k, v)])), warps: m.warps }));
  const i6 = rt.loadModel(compileUgo(m6)).createInstance();
  i6.set('AngleX', 30); i6.update(0); plain = diff(Array.from(i6.warpPoints(1)), turnedPts(restEye, 30, 0));
  check(worstEye < 0.01 && worstPupil < 0.01, `the eye and pupil grids' points are on the turned ellipsoid at every end and corner (largest difference ${Math.max(worstEye, worstPupil).toExponential(1)} px; with the face grid alone ${plain.toFixed(2)} px)`);
  check(plain > 0.5, 'moving the grids inside matters');
}

// the default: the sphere bake (tools/sphere_bake.mjs, checked in depth in sphere_bake_test.mjs):
// keys every 10°, the face's points within 1 % of the exact ellipsoid at in-between angles
{
  const m7 = structuredClone(model);
  m7.warps = [{ id: 'face', cols: 14, rows: 14, rect: [-180, -400, 360, 440] }];
  m7.parts = [{ id: 'face', texture: 0, vertices: [0, -180, 100, -180, 0, -60, -100, -180, 0, -300], uvs: new Array(10).fill(0.5), triangles: [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1], warp: 'face' }];
  const r = makeFaceAngles(m7, { auto: 'parts' });
  check(r.motions.length === 34 && r.keys.AngleX.join() === '-30,-20,-10,0,10,20,30' && r.keys.AngleY.join() === '-30,-15,0,15,30' && /face centre \[0, -180\], radius \[100, 120\]/.test(r.warnings[0]),
    `keys every 10°: AngleX ${r.keys.AngleX.join(' ')}, AngleY ${r.keys.AngleY.join(' ')} (20° at its ends), ${r.motions.length} motions`);
  const neighbours = (id, v) => { const ks = r.keys[id], i = ks.indexOf(v); return [ks[Math.max(0, i - 1)], v, ks[Math.min(ks.length - 1, i + 1)]]; };
  m7.deformers = r.motions.map((mo) => ({ region: Object.fromEntries(Object.entries(mo.at).map(([k, v]) => [k, neighbours(k, v)])), warps: mo.warps }));
  const i7 = rt.loadModel(compileUgo(m7)).createInstance(), D = Math.PI / 180;
  let worst = 0;
  for (const [ax, ay] of [[5, 0], [15, 0], [25, 0], [15, 15], [-12, 25], [30, 30]]) {
    i7.reset(); i7.set('AngleX', ax); i7.set('AngleY', ay); i7.update(0);
    const yaw = ax * D, pitch = (ay / 30) * 20 * D;
    for (let y = -108; y <= 108; y += 12) for (let x = -90; x <= 90; x += 12) {
      if ((x / 100) ** 2 + (y / 120) ** 2 > 0.81) continue;
      const [sx, sy] = r.shape.radius; // the sphere is a little larger than the face (its edge at 0.9 of it)
      let X = x, Y = y, Z = r.shape.depth * sx * Math.sqrt(1 - (x / sx) ** 2 - (y / sy) ** 2);
      [X, Z] = [X * Math.cos(yaw) + Z * Math.sin(yaw), -X * Math.sin(yaw) + Z * Math.cos(yaw)];
      [Y, Z] = [Y * Math.cos(pitch) - Z * Math.sin(pitch), Y * Math.sin(pitch) + Z * Math.cos(pitch)];
      const q = i7.warpEval(0, x, y - 180);
      worst = Math.max(worst, Math.hypot(q[0] - X, q[1] - (Y - 180)));
    }
  }
  check(worst < 1, `in-between angles: the face's points within ${worst.toFixed(2)} px of the exact ellipsoid (the face's radius 100: under 1 %)`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall face angle checks passed');
process.exit(failures ? 1 : 0);
