// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/eye_mouth.mjs and tools/suggest_chains.mjs: drafts found by part and bone names.
// The eye / mouth motions are put into a model as regions on their keys (as the editor does)
// and the core's vertices are checked: the lids meet, the white is squashed, the mouth opens.
//   node tests/eye_mouth_test.mjs
import fs from 'node:fs';
import { makeEyeBlink, makeMouthOpen } from '../tools/eye_mouth.mjs';
import { suggestChains } from '../tools/suggest_chains.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const sq = (id, x0, y0, x1, y1, more = {}) => ({ id, texture: 0, vertices: [x0, y0, x1, y0, x1, y1, x0, y1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], bone: 'head', ...more });
const model = {
  format: 'ugo9', version: '0.6', canvas: { width: 400, height: 400, originX: 200, originY: 380 },
  parameters: [{ id: 'EyeOpenL', min: 0, default: 1, max: 1 }, { id: 'EyeOpenR', min: 0, default: 1, max: 1 }, { id: 'MouthOpen', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'head', parent: 'root', y: -200 }],
  parts: [
    sq('顔', -100, -300, 100, -60),
    // the character's left eye in Japanese layer names, the right one in English
    sq('白目 左', 20, -220, 60, -200), sq('瞳 左', 32, -222, 48, -198, { mask: ['白目 左'] }), sq('まつ毛 左', 15, -230, 65, -218),
    sq('eyeWhiteR', -60, -220, -20, -200), sq('irisR', -48, -222, -32, -198), sq('eyeUpperR', -65, -230, -15, -218), sq('eyeLowerR', -60, -201, -20, -197),
    sq('眉 左', 20, -250, 60, -244),
    sq('上唇', -20, -130, 20, -124), sq('下唇', -20, -122, 20, -116), sq('口の中', -18, -125, 18, -121),
  ],
  textures: ['none.png'], deformers: [], animations: [],
};
const tent = (id, v) => { const p = model.parameters.find((q) => q.id === id); return v > p.default ? [p.default, v, v] : [v, v, p.default]; };
const run = (motions, set) => {
  const m = structuredClone(model);
  m.deformers = motions.map((mo) => ({ region: Object.fromEntries(Object.entries(mo.at).map(([k, v]) => [k, tent(k, v)])), morphs: mo.morphs }));
  const um = rt.loadModel(compileUgo(m)), inst = um.createInstance();
  for (const [k, v] of Object.entries(set)) inst.set(k, v);
  inst.update(0);
  const pos = inst.deformedPositions(), out = {};
  let at = 0;
  for (const p of m.parts) { const n = p.vertices.length; out[p.id] = Array.from(pos.slice(at, at + n)); at += n; }
  return out;
};
const ys = (a) => a.filter((_, i) => i % 2), near = (a, b) => Math.abs(a - b) < 1e-3;

// eyes: both found by name, each on its own parameter
const eye = makeEyeBlink(model);
check(eye.motions.length === 2 && eye.motions.some((m) => m.at.EyeOpenL === 0) && eye.motions.some((m) => m.at.EyeOpenR === 0) && eye.warnings.length === 0,
  `two eye motions: ${eye.motions.map((m) => `${JSON.stringify(m.at)} ${Object.keys(m.morphs).join(', ')}`).join(' / ')}`);
check(!eye.motions.some((m) => '眉 左' in m.morphs || '顔' in m.morphs), 'brows and the face are left alone');
const closed = run(eye.motions, { EyeOpenL: 0, EyeOpenR: 0 }), y = -220 + 0.6 * 20;
check(near(Math.max(...ys(closed['まつ毛 左'])), y) && near(Math.max(...ys(closed.eyeUpperR)), y) && near(Math.min(...ys(closed.eyeLowerR)), y),
  `closed: the upper lids come down and the lower lid up to y ${y} (60% down the white)`);
check(ys(closed['白目 左']).every((v) => near(v, y)) && ys(closed.irisR).every((v) => near(v, y)), 'closed: the whites and irises are squashed onto that line');
const half = run(eye.motions, { EyeOpenL: 0.5, EyeOpenR: 1 });
check(near(Math.max(...ys(half['まつ毛 左'])), (-218 + y) / 2) && near(Math.max(...ys(half.eyeUpperR)), -218), 'EyeOpenL = 0.5 is half way, the right eye stays open');
const one = makeEyeBlink(model, { parts: ['eyeUpperR', 'eyeWhiteR'], param: 'EyeOpenR' });
check(one.motions.length === 1 && one.motions[0].at.EyeOpenR === 0 && Object.keys(one.motions[0].morphs).join() === 'eyeUpperR,eyeWhiteR', 'opts.parts and opts.param: one eye as given');
const noSide = structuredClone(model);
noSide.parts = noSide.parts.map((p) => ({ ...p, id: p.id.replace(/ 左$/, '').replace(/R$/, '') })).filter((p, i, a) => a.findIndex((q) => q.id === p.id) === i);
noSide.parts.push(sq('白目2', 20, -220, 60, -200));
const ns = makeEyeBlink({ ...noSide, parameters: [] });
check(ns.notes.length === ns.warnings.length && ns.notes.every((n, i) => n.text === ns.warnings[i]) && ns.notes.some((n) => n.code === 'eyeNoSide')
  && JSON.stringify(ns.notes.find((n) => n.code === 'paramMissing').vars) === '{"param":"EyeOpenL","min":0,"default":1,"max":1}', `eye notes: ${ns.notes.map((n) => n.code).join(', ')}`);
check(ns.warnings.some((w) => /no side/.test(w)) && ns.warnings.some((w) => /no parameter EyeOpenL/.test(w)) && JSON.stringify(ns.params) === '[["EyeOpenL",0,1,1],["EyeOpenR",0,1,1]]' && eye.params.length === 0, `without sides in the names: split on the screen, missing parameters warned and returned in params ${JSON.stringify(ns.params)}`);

// an eye without a side (利用者の声 #409, the hub's (b)): the standard EyeOpenL and EyeOpenR, each with half the motion,
// so both at 0 close it once and one alone half; a model with the older single EyeOpen keeps it
{
  const plain = structuredClone(model);
  plain.parameters = plain.parameters.filter((p) => p.id === 'MouthOpen');
  const u = makeEyeBlink(plain, { parts: ['eyeUpperR', 'eyeWhiteR'] });
  check(JSON.stringify(u.params) === '[["EyeOpenL",0,1,1],["EyeOpenR",0,1,1]]' && u.motions.length === 2 && !u.motions.some((m) => 'EyeOpen' in m.at), `no side: EyeOpenL and EyeOpenR are made (${JSON.stringify(u.params)}), no EyeOpen`);
  const withBoth = (set) => { const m = structuredClone(model); m.deformers = u.motions.map((mo) => ({ region: Object.fromEntries(Object.entries(mo.at).map(([k, v]) => [k, [v, v, 1]])), morphs: mo.morphs }));
    const um = rt.loadModel(compileUgo(m)), inst = um.createInstance(); for (const [k, v] of Object.entries(set)) inst.set(k, v); inst.update(0);
    const pos = inst.deformedPositions(); let at = 0, out = {}; for (const p of m.parts) { out[p.id] = Array.from(pos.slice(at, at + p.vertices.length)); at += p.vertices.length; } return out; };
  const both = withBoth({ EyeOpenL: 0, EyeOpenR: 0 }), oneSide = withBoth({ EyeOpenL: 0, EyeOpenR: 1 });
  check(near(Math.max(...ys(both.eyeUpperR)), y) && near(Math.max(...ys(oneSide.eyeUpperR)), (-218 + y) / 2), `both at 0 close it once (the lid at ${Math.max(...ys(both.eyeUpperR)).toFixed(2)}); one alone half way`);
  const older = structuredClone(plain);
  older.parameters.push({ id: 'EyeOpen', min: 0, default: 1, max: 1 });
  const o = makeEyeBlink(older, { parts: ['eyeUpperR', 'eyeWhiteR'] });
  check(o.params.length === 0 && o.motions.length === 1 && o.motions[0].at.EyeOpen === 0, 'a model with the older EyeOpen keeps it (read as it is, nothing added)');
}

// sides from the PSD folders (左目 / 右目) when the layer names have none
{
  const byFolder = structuredClone(noSide);
  byFolder.parameters = model.parameters;
  byFolder.source = { psd: { layers: byFolder.parts.map((p) => ({ part: p.id, path: ['頭', p.vertices[0] > 0 ? '左目' : 'right eye', p.id] })) } };
  const f = makeEyeBlink(byFolder);
  const sideL = f.motions.find((m) => m.at.EyeOpenL === 0), sideR = f.motions.find((m) => m.at.EyeOpenR === 0);
  check(!f.notes.some((n) => n.code === 'eyeNoSide') && sideL && sideR && Object.keys(sideL.morphs).every((id) => byFolder.parts.find((p) => p.id === id).vertices[0] > 0),
    `no side in the names, but in the PSD folders (左目 / right eye): split by them (L: ${sideL && Object.keys(sideL.morphs).join(', ')})`);
}

// mouth
const mouth = makeMouthOpen(model);
check(mouth.motions.length === 1 && mouth.motions[0].at.MouthOpen === 1 && Object.keys(mouth.motions[0].morphs).sort().join() === '上唇,下唇,口の中' && mouth.warnings.length === 0, `mouth: ${JSON.stringify(mouth.motions[0].at)} moves ${Object.keys(mouth.motions[0].morphs).join(', ')}`);
const open = run(mouth.motions, { MouthOpen: 1 }), h = 0.3 * 40;
check(near(Math.min(...ys(open['下唇'])), -122 + h) && near(Math.max(...ys(open['上唇'])), -124 - 0.15 * h), `open: the lower lip goes down ${h} px, the upper up ${0.15 * h} px`);
check(near(Math.min(...ys(open['口の中'])), -125 - 0.15 * h) && near(Math.max(...ys(open['口の中'])), -121 + h), 'open: the inside stretches with them');
const line = makeMouthOpen({ ...model, parts: [sq('mouth', -20, -125, 20, -121)] });
check(JSON.stringify(line.notes.map((n) => [n.code, n.vars])) === '[["mouthOnePart",{"parts":["mouth"]}]]' && makeMouthOpen({ ...model, parts: [] }).notes[0].code === 'mouthNotFound'
  && makeEyeBlink(model, { parts: ['nope'] }).notes[0].code === 'partMissing', 'mouth notes: mouthOnePart, mouthNotFound; partMissing');
check(line.warnings.some((w) => /one drawing/.test(w)) && line.motions[0].morphs.mouth && JSON.stringify(makeMouthOpen({ ...model, parameters: [] }).params) === '[["MouthOpen",0,0,1]]', 'a mouth in one part is stretched, with a warning; a missing MouthOpen comes back in params');

// swinging candidates
const rig = {
  bones: [{ id: 'root' }, { id: 'body', parent: 'root' }, { id: 'head', parent: 'body' },
    { id: '前髪', parent: 'head', rotation: -90 }, { id: 'hairL', parent: 'head', rotation: 90 }, { id: 'hairL2', parent: 'hairL' }, { id: 'hairL3', parent: 'hairL2' },
    { id: 'skirt', parent: 'body', rotation: 90 }, { id: 'skirtF', parent: 'skirt' }, { id: 'skirtB', parent: 'skirt' },
    { id: 'arm', parent: 'body' }, { id: 'eyeBone', parent: 'head' }, { id: 'tail', parent: 'body' }, { id: 'tail2', parent: 'tail' }, { id: 'brow', warp: 'face' }, { id: 'hairWarp', warp: 'face' },
    { id: 'hairBox', parent: 'root' }, { id: 'box2', parent: 'hairBox' }],
  parts: [{ id: 'リボン', bone: 'arm' }, { id: 'bangs', bone: 'head' }, { id: 'ponytail', bone: 'body' }, { id: 'shirt', bone: 'body' }, { id: 'hairBase', bone: 'hairBox' }],
  chains: [{ id: 't', bones: ['tail', 'tail2'] }],
};
const sc = suggestChains(rig), got = Object.fromEntries(sc.map((c) => [c.root, c]));
check(Object.keys(got).join() === '前髪,hairL,skirt,skirtF,skirtB,arm', `candidates: ${sc.map((c) => `${c.root} [${c.bones.join(' ')}] (${c.reason})`).join(', ')}`);
check(got.hairL.bones.join() === 'hairL,hairL2,hairL3' && got.skirt.bones.join() === 'skirt' && got.arm.reason === 'part リボン: ribbon' && JSON.stringify(got.arm.reasonNote.vars) === '{"kind":"ribbon","parts":["リボン"]}' && got.hairL.reasonNote.code === 'chainName', 'a line follows single children; a split starts new candidates; parts\' names count');
check(got['前髪'].warning && !got.hairL.warning && got['前髪'].note.code === 'chainPointsUp' && got['前髪'].note.vars.bone === '前髪', 'a bone pointing up is warned about (a chain hangs from its root)');
check(!got.head && !got.body && !got.hairBox, 'the head (bangs on it, but other parts and steady child bones) and a hair bone with a steady child are left out');

console.log(failures ? `\n${failures} check(s) failed` : '\nall eye / mouth / chain checks passed');
process.exit(failures ? 1 : 0);
