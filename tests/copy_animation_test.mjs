// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animations onto another model (tools/copy_animation.mjs, 利用者の声 #23). Onto the same model twice as
// large (tools/scale_model.mjs) they become what scaling the model gives: the same JSON and the same
// .ug9, bone moves and their curve handles doubled. A parameter with another range: its values carried
// about the default on each side, curve handles too. What the other model lacks: left out, said by name.
// An animation already there: renamed, replaced or kept. With addBones / addParams what it lacks comes along (a tail
// and its parent onto a model without one, scaled); a template of some animations goes onto another model as the
// whole model would.
//   node tests/copy_animation_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyAnimations, makeTemplate } from '../tools/copy_animation.mjs';
import { scaleModel } from '../tools/scale_model.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { sp } from './sample_names.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const base = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));
// a bone animation too, with a curve key on x
const bone = base.bones[base.bones.length - 1].id;
base.animations.push({ id: 'wave', duration: 1, loop: true, bones: { [bone]: { x: [[0, 0, 'bezier', 0.2, 5, 0.8, -3], [1, 10]], rotate: [[0, 0], [1, 20]] } }, tracks: { [sp('AngleX')]: [[0, 0, 'bezier', 0.3, 5, 0.7, 10], [1, 10]] } });

// onto the same model twice as large: what scaling gives
{
  const big = scaleModel(base, 2), target = { ...structuredClone(big), animations: [] };
  const r = copyAnimations(base, target);
  check(r.notes.length === 0 && r.copied.join() === base.animations.map((a) => a.id).join(), `every animation copied (${r.copied.join(', ')}), nothing left out`);
  check(JSON.stringify(r.model.animations) === JSON.stringify(big.animations), 'onto the model twice as large: the same animations as scaling the model (bone moves and their curve handles doubled)');
  check(Buffer.compare(Buffer.from(compileUgo(r.model)), Buffer.from(compileUgo(big))) === 0, 'and the same .ug9');
}
// a parameter with another range: AngleX -45..45, then -60..30
{
  const t = structuredClone(base); t.animations = [];
  t.parameters.find((p) => p.id === sp('AngleX')).min = -45; t.parameters.find((p) => p.id === sp('AngleX')).max = 45;
  const k = copyAnimations(base, t).model.animations.find((a) => a.id === 'wave').tracks[sp('AngleX')];
  check(JSON.stringify(k) === JSON.stringify([[0, 0, 'bezier', 0.3, 7.5, 0.7, 15], [1, 15]]), `AngleX -30..30 onto -45..45: 10 becomes 15, the curve's handles 5, 10 become 7.5, 15 (${JSON.stringify(k)})`);
  const u = structuredClone(t); Object.assign(u.parameters.find((p) => p.id === sp('AngleX')), { min: -60, max: 15 });
  const src = structuredClone(base); src.animations = [{ id: 'a', duration: 1, tracks: { [sp('AngleX')]: [[0, -10], [1, 10]] } }];
  const k2 = copyAnimations(src, u).model.animations[0].tracks[sp('AngleX')];
  check(k2[0][1] === -20 && k2[1][1] === 5, `onto -60..15: below the default by the lower side (-10 → ${k2[0][1]}), above by the upper (10 → ${k2[1][1]})`);
  const same = copyAnimations(src, u, { remapParams: false }).model.animations[0].tracks[sp('AngleX')];
  check(same[1][1] === 10, 'remapParams false: the values as they are');
}
// what the other model lacks
{
  const t = structuredClone(base); t.animations = [];
  t.bones = t.bones.filter((b) => b.id !== bone);
  t.parameters = t.parameters.filter((p) => p.id !== 'BrowY');
  const r = copyAnimations(base, t), missing = r.notes.filter((n) => n.code === 'copyMissing').map((n) => `${n.vars.kind} ${n.vars.id}`);
  const wave = r.model.animations.find((a) => a.id === 'wave'), talk = r.model.animations.find((a) => a.id === 'talk');
  check(missing.includes(`bone ${bone}`) && missing.includes('parameter BrowY') && !(bone in wave.bones) && !('BrowY' in talk.tracks) && 'MouthOpen' in talk.tracks, `left out and said by name: ${missing.join(', ')}`);
}
// an animation already there
{
  const t = structuredClone(base);
  const renamed = copyAnimations(base, t, { anims: ['idle'] }), replaced = copyAnimations(base, t, { anims: ['idle'], existing: 'replace' }), kept = copyAnimations(base, t, { anims: ['idle'], existing: 'skip' });
  check(renamed.copied[0] === 'idle_2' && renamed.model.animations.length === t.animations.length + 1 && replaced.model.animations.length === t.animations.length && kept.copied.length === 0,
    'already there: copied as idle_2 (rename, the default), replaced, or kept (skip)');
  check(JSON.stringify(t) === JSON.stringify(structuredClone(t)) && t.animations.length === base.animations.length, 'the models given are not changed');
}

// bringing what the other lacks along: a tail of two bones and its parameter, onto the model twice as large without them
const withTail = structuredClone(base);
withTail.bones.push({ id: 'tail1', parent: 'body', x: 30, y: -10, rotation: 90, length: 40 }, { id: 'tail2', parent: 'tail1', x: 40, y: 0, length: 30 });
withTail.parameters.push({ id: 'TailSway', min: -1, default: 0, max: 1 });
withTail.animations.push({ id: 'swish', duration: 1, loop: true, tracks: { TailSway: [[0, -1], [0.5, 1], [1, -1]] }, bones: { tail2: { rotate: [[0, -20], [0.5, 20], [1, -20]] }, tail1: { x: [[0, 0], [1, 4]] } } });
{
  const target = { ...scaleModel(base, 2), animations: [] };
  const plain = copyAnimations(withTail, target, { anims: ['swish'] });
  const sw = plain.model.animations[0];
  check(!sw.bones?.tail1 && !sw.bones?.tail2 && !sw.tracks?.TailSway && plain.notes.filter((n) => n.code === 'copyMissing').length === 3, 'without addBones / addParams: the tail\'s bones and parameter are left out (3 notes)');
  const r = copyAnimations(withTail, target, { anims: ['swish'], addBones: true, addParams: true });
  const b = Object.fromEntries(r.model.bones.map((x) => [x.id, x])), s2 = r.model.animations[0];
  check(r.addedBones.join() === 'tail1,tail2' && b.tail1.parent === 'body' && b.tail2.parent === 'tail1' && b.tail1.x === 60 && b.tail1.y === -20 && b.tail1.length === 80 && b.tail2.x === 80 && b.tail1.rotation === 90,
    `addBones: the bones come along parent first (${r.addedBones.join(', ')}), onto the body the other model has, their place and length doubled`);
  check(r.addedParams.join() === 'TailSway' && r.model.parameters.at(-1).max === 1 && JSON.stringify(s2.tracks.TailSway) === JSON.stringify(withTail.animations.at(-1).tracks.TailSway)
    && JSON.stringify(s2.bones.tail2.rotate) === JSON.stringify(withTail.animations.at(-1).bones.tail2.rotate) && JSON.stringify(s2.bones.tail1.x) === '[[0,0],[1,8]]',
    'addParams: the parameter with its range; the tracks kept (angles as they are, the move doubled)');
  check(r.notes.some((n) => n.code === 'copyBonesAdded' && /weights/.test(n.text)) && !r.notes.some((n) => n.code === 'copyMissing'), 'a note says no part follows them until weighted; nothing left out');
  let ok = true;
  try { compileUgo(r.model, { warnings: [] }); } catch (e) { ok = e.message; }
  check(ok === true, `the model with the brought bones compiles (${ok})`);
  // only the bones that are missing: tail2 alone when tail1 is there
  const t1 = structuredClone(target); t1.bones.push({ id: 'tail1', parent: 'neck', x: 1, y: 1 });
  const r1 = copyAnimations(withTail, t1, { anims: ['swish'], addBones: true });
  check(r1.addedBones.join() === 'tail2' && r1.model.bones.find((x) => x.id === 'tail1').parent === 'neck', 'only what is missing: tail2 onto the other model\'s own tail1');

  // a template: the swish and idle animations by themselves
  const tpl = makeTemplate(withTail, { anims: ['swish', 'idle'] });
  check(tpl.animations.map((a) => a.id).join() === 'idle,swish' && tpl.parameters.map((p) => p.id).sort().join() === [...new Set([...Object.keys(withTail.animations[0].tracks), 'TailSway'])].sort().join()
    && tpl.bones.map((x) => x.id).join() === 'root,body,tail1,tail2' && !tpl.parts.length && tpl.canvas.height === withTail.canvas.height,
    `a template keeps only the animations, the parameters they drive (${tpl.parameters.length}) and the bones they move with their parents (${tpl.bones.map((x) => x.id).join(', ')})`);
  const fromTpl = copyAnimations(JSON.parse(JSON.stringify(tpl)), target, { addBones: true, addParams: true });
  const fromAll = copyAnimations(withTail, target, { anims: ['idle', 'swish'], addBones: true, addParams: true });
  check(JSON.stringify(fromTpl.model) === JSON.stringify(fromAll.model), 'the template (saved and read) onto the other model gives what the whole model gives');
  let threw = null;
  try { makeTemplate(withTail, { anims: ['nope'] }); } catch (e) { threw = e.message; }
  check(/nope/.test(threw || ''), 'a template of an animation the model lacks: an error naming it');

  // the command line: a template from a .ug9, then onto a model
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animtpl-'));
  fs.writeFileSync(path.join(dir, 'tail.json'), JSON.stringify(withTail));
  fs.writeFileSync(path.join(dir, 'to.json'), JSON.stringify(target));
  const node = (...a) => execFileSync('node', ['tools/copy_animation.mjs', ...a], { encoding: 'utf8' });
  node('--template', path.join(dir, 'tail.json'), '--anims', 'swish', '--out', path.join(dir, 'swish.anim.json'));
  node(path.join(dir, 'swish.anim.json'), path.join(dir, 'to.json'), '--add-bones', '--add-params', '--out', path.join(dir, 'out.json'));
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  node('--template', 'samples/basic/model.ug9', '--out', path.join(dir, 'u.anim.json'));
  const u = JSON.parse(fs.readFileSync(path.join(dir, 'u.anim.json'), 'utf8'));
  check(out.animations.map((a) => a.id).join() === 'swish' && out.bones.some((x) => x.id === 'tail2') && u.animations.map((a) => a.id).join() === 'idle,talk',
    'command line: --template (also from a .ug9), then the template onto a model with --add-bones --add-params');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall animation copy checks passed');
process.exit(failures ? 1 : 0);
