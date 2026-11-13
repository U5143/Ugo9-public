// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// checkExport (tools/check_export.mjs): what a model loses on the way to glTF / VRM, said before
// exporting, with codes, levels, names and a fix. Models: samples/basic, the pose rig (IK,
// transform, a chain), tests/psd/clip.psd (clipping masks, multiply) and small made-up ones.
//   node tests/check_export_test.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { checkExport } from '../tools/check_export.mjs';
import { importPsd } from '../tools/import_psd.mjs';
import { sp } from './sample_names.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const codes = (r) => r.notes.map((n) => `${n.code}:${n.level}`).join(' ');
const find = (r, code) => r.notes.find((n) => n.code === code);

// every note: a code, a level, an English text and a fix; notes and warnings side by side
const wellFormed = (r) => r.notes.length === r.warnings.length && r.notes.every((n, i) => n.code && ['error', 'warn', 'info'].includes(n.level) && n.text === r.warnings[i] && typeof n.fix === 'string');

// samples/basic: it exports to both (colours and masks it has are said)
{
  const m = read('../samples/basic/model.json'), g = checkExport(m, 'gltf'), v = checkExport(m, 'vrm');
  check(g.ok && v.ok && wellFormed(g) && wellFormed(v) && !find(v, 'vrmNoHumanoid'), `samples/basic: glTF ok (${codes(g)}), VRM ok (${codes(v)})`);
  const u = checkExport(m, 'ugo');
  check(u.ok && !u.notes.some((n) => n.code.startsWith('export') || n.code.startsWith('vrm')), `samples/basic for the .ugo: only the compiler's own notes (${codes(u) || 'none'})`);
}
// the pose rig: IK, transform constraints, shear and a chain
{
  const m = read('./pose/rig.json'), g = checkExport(m, 'gltf'), v = checkExport(m, 'vrm');
  const flat = find(g, 'exportFlatSkeleton'), baked = find(g, 'exportPhysicsBaked');
  check(flat?.level === 'info' && flat.vars.count > 0 && flat.vars.bones.length <= 10 && baked?.vars.names.includes('sway'), `pose rig, glTF: bones written flat (${flat?.vars.count} bones: ${flat?.vars.bones.join(', ')}), the chain baked into the animations`);
  check(!v.ok && find(v, 'vrmNoHumanoid')?.level === 'error' && find(v, 'vrmSkeleton')?.level === 'warn', `pose rig, VRM: no head / body bones (an error, the export stops) and a skeleton VRM can't follow (${codes(v)})`);
}
// clip.psd: clipping masks and a multiply layer, named
{
  const res = importPsd(fs.readFileSync(new URL('./psd/clip.psd', import.meta.url)), { inflate: (b) => zlib.inflateSync(b) });
  const m = { ...res.model, version: '0.7' }, g = checkExport(m, 'gltf');
  const masks = find(g, 'exportMasks'), blend = find(g, 'exportBlend');
  const clipped = m.parts.filter((p) => p.mask).map((p) => p.id), multiplied = m.parts.filter((p) => p.blend && p.blend !== 'normal').map((p) => p.id);
  check(masks?.level === 'warn' && masks.vars.count === clipped.length && masks.vars.parts.join() === clipped.join() && /PSD/.test(masks.fix), `clip.psd: the clipped parts are named (${masks?.vars.parts.join(', ')}), with a fix`);
  check(blend?.vars.parts.join() === multiplied.join(), `clip.psd: the multiply parts are named (${blend?.vars.parts.join(', ')})`);
}
// made up: many bones on a vertex, the draw order changing, a model that does not compile
{
  const base = read('../samples/basic/model.json');
  const heavy = structuredClone(base), p = heavy.parts.find((q) => q.weights) || heavy.parts[0];
  delete p.bone;
  p.weights = Array.from({ length: p.vertices.length / 2 }, () => ['root', 'body', 'neck', 'head', 'hairL1'].map((b) => [b, 0.2]));
  const g = find(checkExport(heavy, 'gltf'), 'exportManyWeights'), v = find(checkExport(heavy, 'vrm'), 'exportWeightsCut');
  check(g?.level === 'info' && v?.level === 'warn' && v.vars.count === p.vertices.length / 2 && v.vars.parts.includes(p.id), `5 bones a vertex: glTF writes them (info), VRM keeps 4 (warn, ${v?.vars.count} vertices of ${v?.vars.parts.join(', ')})`);
  const ordered = structuredClone(base);
  ordered.animations = [...(ordered.animations || []), { id: 'swap', duration: 1, order: { [ordered.parts[0].id]: [[0, 500], [1, 100, 'step']] } }];
  const o = find(checkExport(ordered, 'gltf'), 'exportDrawOrder');
  check(o?.level === 'warn' && o.vars.parts[0] === ordered.parts[0].id, `an animation changing the draw order: said for glTF (${o?.vars.parts.join(', ')})`);
  const broken = structuredClone(base);
  broken.parts[0].mask = ['nothing-here'];
  const r = checkExport(broken, 'gltf');
  check(!r.ok && r.notes.length === 1 && r.notes[0].code === 'exportCompileError' && r.notes[0].level === 'error', `a model that does not compile: one error, the export stops (${r.notes[0]?.text})`);
  const headless = structuredClone(base);
  headless.bones = headless.bones.map((b) => ({ ...b, id: b.id === 'head' ? 'atama' : b.id, ...(b.parent === 'head' ? { parent: 'atama' } : {}) }));
  for (const q of headless.parts) { if (q.bone === 'head') q.bone = 'atama'; if (q.weights) q.weights = q.weights.map((w) => w.map(([b, x]) => [b === 'head' ? 'atama' : b, x])); }
  for (const d of headless.deformers || []) if (d.bones?.head) { d.bones.atama = d.bones.head; delete d.bones.head; }
  for (const a of headless.animations || []) if (a.bones?.head) { a.bones.atama = a.bones.head; delete a.bones.head; }
  for (const c of headless.chains || []) c.bones = c.bones.map((b) => (b === 'head' ? 'atama' : b));
  for (const w of headless.warps || []) if (w.bone === 'head') w.bone = 'atama';
  const h = checkExport(headless, 'vrm');
  check(!h.ok && find(h, 'vrmNoHumanoid')?.vars.head === false && /head/.test(find(h, 'vrmNoHumanoid').fix), `no bone named head: VRM can't map the humanoid (${codes(h)})`);
}
// what a VRM app does not move (利用者の声 #400 の 5): the animations, parameters no expression uses, physics on parameters
{
  const m = read('../samples/basic/model.json'), v = checkExport(m, 'vrm'), g = checkExport(m, 'gltf');
  const an = find(v, 'vrmAnimations'), un = find(v, 'vrmParamsUnused'), ph = find(v, 'vrmPhysicsParams');
  check(an?.vars.count === 2 && an.vars.names.join() === 'idle,talk' && an.level === 'warn' && an.fix, `VRM: the animations are not written (${an?.vars.names})`);
  check(un?.vars.params.includes(sp('AngleX')) && !un.vars.params.includes('EyeOpenL') && !un.vars.params.includes(sp('HairSway')), `VRM: parameters no expression uses (${un?.vars.params}); not the eyes (an expression) nor the swung hair`);
  check(ph?.vars.params.join() === [sp('HairSway'), 'HairBackSway'].join() && /chain/.test(ph.fix), `VRM: parameters swung by physics do not swing (${ph?.vars.params})`);
  const all = checkExport(m, 'vrm', { expressions: { blink: { EyeOpenL: 0 }, a: { [sp('AngleX')]: 1, [sp('AngleY')]: 1, [sp('AngleZ')]: 1, [sp('BodyAngleX')]: 1, Breath: 1, FaceColor: 1, EyeOpenR: 0, MouthOpen: 1, [sp('EyeBallX')]: 1, [sp('EyeBallY')]: 1, BrowY: 1 } } });
  check(!find(all, 'vrmParamsUnused') && v.ok && !['vrmAnimations', 'vrmParamsUnused', 'vrmPhysicsParams'].some((c) => find(g, c)), 'every parameter in an expression: none listed; still ok to export; glTF says none of these');
}

// for the .ug9, what the paid checking tools look at (利用者の声 #400 の 4): no blink, no mouth (info), the texture memory
{
  const sample = checkExport(read('../samples/basic/model.json'), 'ugo', { textureSizes: [[1024, 1024]] }), rig = checkExport(read('./pose/rig.json'), 'ugo');
  check(!['exportNoBlink', 'exportNoMouth', 'exportTextureMemory'].some((c) => find(sample, c)), 'samples/basic: eyes, a mouth, a 1024 px page: none of these said');
  check(rig.ok && find(rig, 'exportNoBlink')?.level === 'info' && find(rig, 'exportNoMouth')?.level === 'info' && /eyes and the mouth/.test(find(rig, 'exportNoBlink').fix),
    'a rig without eye and mouth parameters: no blink, no mouth (info; still ok to export)');
  const live2d = read('./pose/rig.json');
  live2d.parameters.push({ id: 'ParamEyeLOpen', min: 0, max: 1, default: 1 }, { id: 'ParamMouthOpenY', min: 0, max: 1, default: 0 });
  const l = checkExport(live2d, 'ugo');
  check(!find(l, 'exportNoBlink') && !find(l, 'exportNoMouth'), 'Live2D\'s names (ParamEyeLOpen, ParamMouthOpenY) count');
  const heavy = find(checkExport(read('./pose/rig.json'), 'ugo', { textureSizes: [[8192, 8192], [8192, 8192]] }), 'exportTextureMemory');
  const edge = checkExport(read('./pose/rig.json'), 'ugo', { textureSizes: [[4096, 4096]] }), tall = find(checkExport(read('./pose/rig.json'), 'ugo', { textureSizes: [[8192, 64]] }), 'exportTextureMemory');
  check(heavy?.level === 'warn' && heavy.vars.bytes === 2 * 8192 * 8192 * 4 && heavy.vars.largest === 8192 && /--light/.test(heavy.fix) && !find(edge, 'exportTextureMemory') && tall?.vars.largest === 8192,
    `texture memory: two 8192 px pages (${heavy?.text}); one 4096 px page: nothing; a page 8192 px long but small: said for its size`);
}

let bad = '';
try { checkExport({}, 'fbx'); } catch (e) { bad = e.message; }
check(/unknown target/.test(bad), 'an unknown target is refused');

console.log(failures ? `\n${failures} check(s) failed` : '\nall export check checks passed');
process.exit(failures ? 1 : 0);
