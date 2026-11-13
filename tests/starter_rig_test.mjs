// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/starter_rig.mjs: every draft at once on a model just made from a PSD. The result is written
// the way the editor writes it (grids, parts into them, parameters, motions as regions, the idle
// animation), compiled and moved in the core: the face turns, each eye closes on its own
// parameter, the mouth opens, the idle animation plays. Pressing it again adds nothing.
//   node tests/starter_rig_test.mjs
import fs from 'node:fs';
import { importPsd } from '../tools/import_psd.mjs';
import { makeStarterRig } from '../tools/starter_rig.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

// a small character: the eyes in folders named 左目 / 右目 (their layers have no side), a mouth in three
const sq = (name, left, top, w, h, colour) => ({ name, left, top, width: w, height: h, pixel: () => colour });
const folder = (name, inside) => [{ name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, ...inside, { name, section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }];
const layers = [
  sq('体', 70, 220, 60, 80, [90, 90, 200, 255]),
  ...folder('頭', [
    sq('顔', 50, 60, 100, 120, [250, 220, 200, 255]),
    ...folder('左目', [sq('白目', 65, 100, 24, 12, [255, 255, 255, 255]), sq('瞳', 72, 99, 10, 14, [60, 40, 30, 255]), sq('まつ毛', 63, 95, 28, 6, [20, 20, 20, 255])]),
    ...folder('右目', [sq('白目', 111, 100, 24, 12, [255, 255, 255, 255]), sq('瞳', 118, 99, 10, 14, [60, 40, 30, 255]), sq('まつ毛', 109, 95, 28, 6, [20, 20, 20, 255])]),
    sq('上唇', 90, 150, 20, 4, [200, 80, 80, 255]), sq('口の中', 91, 153, 18, 4, [120, 30, 40, 255]), sq('下唇', 90, 156, 20, 4, [200, 80, 80, 255]),
    sq('前髪', 45, 50, 110, 40, [80, 50, 30, 255]),
  ]),
];
const res = importPsd(writePsd(200, 300, layers), { groupBones: true });
const model = { ...res.model, version: '0.6', source: { psd: { layers: res.layers.map(({ rgba, ...l }) => l) } } };

// as the editor writes it: one step, in this order
const apply = (m, r) => {
  const out = structuredClone(m);
  out.warps = [...(out.warps || []), ...r.warps];
  for (const p of out.parts) if (r.assign[p.id]) { delete p.bone; delete p.weights; p.warp = r.assign[p.id]; }
  for (const [id, min, def, max] of r.params) out.parameters.push({ id, min, default: def, max });
  const tent = (id, v) => { // between neighbour keys (the face turn has a key every 10°), else from the default
    const ks = r.keys?.[id];
    if (ks) { const i = ks.indexOf(v); return [ks[Math.max(0, i - 1)], v, ks[Math.min(ks.length - 1, i + 1)]]; }
    const p = out.parameters.find((q) => q.id === id); return v > p.default ? [p.default, v, v] : [v, v, p.default];
  };
  for (const mo of r.motions) out.deformers.push({ region: Object.fromEntries(Object.entries(mo.at).map(([k, v]) => [k, tent(k, v)])), ...(mo.warps ? { warps: mo.warps } : {}), ...(mo.morphs ? { morphs: mo.morphs } : {}) });
  if (r.animation) out.animations.push(r.animation);
  return out;
};

const r = makeStarterRig(model);
const made = Object.fromEntries(r.notes.filter((n) => n.code === 'starterMade').map((n) => [n.vars.step, n.vars.count]));
check(JSON.stringify(made) === '{"grid":4,"angles":34,"blink":2,"mouth":1,"idle":1}', `made: ${JSON.stringify(made)}`);
check(r.warps.map((w) => w.id).join() === 'face,eyeL,eyeR,mouth' && r.warps[0].bone === '頭' && r.warps.slice(1).every((w) => w.parent === 'face'), `grids ${r.warps.map((w) => `${w.id}${w.parent ? ' in ' + w.parent : ' on bone ' + w.bone}`).join(', ')}`);
const assigned = (g) => Object.entries(r.assign).filter(([, w]) => w === g).map(([p]) => p).sort().join(',');
const same = (a, b) => a === b.split(',').sort().join(',');
check(same(assigned('eyeL'), '瞳,白目,まつ毛') && same(assigned('eyeR'), '瞳_2,白目_2,まつ毛_2') && same(assigned('mouth'), '上唇,下唇,口の中') && assigned('face') === '顔' && !('前髪' in r.assign) && !('体' in r.assign),
  `the eyes go into their grids by the PSD folders 左目 / 右目 (L: ${assigned('eyeL')}), the hair and the body stay on their bones`);
check(r.params.map((p) => p[0]).join() === 'HeadTurnX,HeadTurnY,EyeOpenL,EyeOpenR,MouthOpen' && !r.notes.some((n) => n.code === 'eyeNoSide'), `parameters to add: ${r.params.map((p) => p[0]).join(', ')}`);
{ // a model that already has the older AngleX / AngleY keeps them (利用者の声 #409: the readers read both)
  const older = structuredClone(model);
  older.parameters = [...(older.parameters || []), { id: 'AngleX', min: -30, default: 0, max: 30 }, { id: 'AngleY', min: -30, default: 0, max: 30 }];
  const o = makeStarterRig(older);
  check(!o.params.some((p) => /HeadTurn|Angle/.test(p[0])) && Object.keys(o.keys).includes('AngleX'), `a model with AngleX / AngleY: keeps them, nothing to add for the turn (${o.params.map((p) => p[0]).join(', ')})`);
}

const rigged = apply(model, r);
const compileWarnings = [];
const inst = rt.loadModel(compileUgo(rigged, { warnings: compileWarnings })).createInstance();
check(!compileWarnings.some((w) => /outside warp grid/.test(w.message)), `compiles; no part sticks out of its grid (${compileWarnings.length} other warnings)`);
const ids = rigged.parts.map((p) => p.id), at0 = (k) => { let n = 0; for (const p of rigged.parts) { if (p.id === k) return n; n += p.vertices.length; } };
const pose = (set, anim) => { inst.reset(); for (const [k, v] of Object.entries(set)) inst.set(k, v); if (anim) inst.play(anim[0], anim[1]); inst.update(0); return inst.deformedPositions(); };
const rest = pose({});
const vy = (pos, part, k = 1) => pos[at0(part) + k], vx = (pos, part, k = 0) => pos[at0(part) + k];
const turned = pose({ HeadTurnX: 30 });
check(vx(turned, '瞳') - vx(rest, '瞳') > 3 && Math.abs(vx(turned, '体') - vx(rest, '体')) < 1e-4, `HeadTurnX = 30 (the standard name) turns the face (an iris moves ${(vx(turned, '瞳') - vx(rest, '瞳')).toFixed(1)} px), not the body`);
const blinkL = pose({ EyeOpenL: 0 });
check(vy(blinkL, 'まつ毛') - vy(rest, 'まつ毛') > 3 && Math.abs(vy(blinkL, 'まつ毛_2') - vy(rest, 'まつ毛_2')) < 1e-4, 'EyeOpenL = 0 closes the left eye only');
const open = pose({ MouthOpen: 1 });
check(vy(open, '下唇') - vy(rest, '下唇') > 3, `MouthOpen = 1 opens the mouth (${(vy(open, '下唇') - vy(rest, '下唇')).toFixed(1)} px)`);
const anim = rigged.animations.find((a) => a.id === 'idle');
const moves = [0.5, 1, 1.5, 2].some((t) => Math.abs(vx(pose({}, ['idle', t]), '瞳') - vx(rest, '瞳')) > 0.3);
check(anim && moves, `the idle animation (${Object.keys(anim.tracks).join(', ')}) moves the face`);

// again, on the rigged model: everything is there, nothing is added
const again = makeStarterRig(rigged);
check(!again.warps.length && !Object.keys(again.assign).length && !again.params.length && !again.motions.length && !again.animation
  && ['grid', 'angles', 'blink', 'mouth', 'idle'].every((s) => again.notes.some((n) => n.code === 'starterSkipped' && n.vars.step === s)), `pressed again: nothing new (${again.notes.filter((n) => n.code === 'starterSkipped').map((n) => n.vars.step).join(', ')} skipped)`);
// a part named like a grid: the grid gets another id
const clash = makeStarterRig({ ...model, parts: model.parts.map((p) => (p.id === '体' ? { ...p, id: 'face' } : p)) });
check(clash.warps[0].id === 'face_grid' && clash.warps.slice(1).every((w) => w.parent === 'face_grid'), `a part called "face": the grid is ${clash.warps[0].id}`);
// no face: no grid, the rest still comes
const noFace = makeStarterRig({ ...model, parts: model.parts.filter((p) => p.id !== '顔') });
check(!noFace.warps.length && noFace.notes.some((n) => n.code === 'starterNoFace') && noFace.motions.length === 3, `no face part: ${noFace.notes.filter((n) => n.code.startsWith('starter')).map((n) => n.code + (n.vars.step ? ':' + n.vars.step : '')).join(', ')}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall starter rig checks passed');
process.exit(failures ? 1 : 0);
