// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/idle.mjs: the idle animation draft. It is put into the sample character and played in
// the core: it breathes, blinks and sways, every track loops without a jump, and a model without
// a Breath parameter breathes with its body bone.
//   node tests/idle_test.mjs
import fs from 'node:fs';
import { makeIdle } from '../tools/idle.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { sp } from './sample_names.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const sample = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));

const { animation: a, params, notes, warnings } = makeIdle(sample, { seed: 7 });
check(a.id === 'idle2' && a.loop && a.duration === 4 && params.length === 0 && notes.length === warnings.length && warnings.length === 0,
  `the sample already has "idle": the new one is ${a.id}, ${Object.keys(a.tracks).join(', ')}`);
const m = structuredClone(sample);
m.animations.push(a);
const compileWarnings = [];
const inst = rt.loadModel(compileUgo(m, { warnings: compileWarnings })).createInstance();
const at = (t) => { inst.reset(); inst.play(a.id, t); return Object.fromEntries(Object.keys(a.tracks).map((k) => [k, inst.get(k)])); };
check(!compileWarnings.some((w) => /animations/.test(w.path)), 'the animation compiles without warnings');

// every track ends where it starts, and the seam has no kink (the slope just before the end is
// the slope just after the start)
const e = 1e-3, s0 = at(0), s1 = at(e), sEnd = at(4 - e), s4 = at(4);
let jump = 0, kink = 0;
for (const k of Object.keys(a.tracks)) { jump = Math.max(jump, Math.abs(s0[k] - s4[k])); kink = Math.max(kink, Math.abs((s1[k] - s0[k]) - (s4[k] - sEnd[k])) / e); }
check(jump < 1e-4 && kink < 0.05, `the loop's seam: no jump (${jump.toExponential(1)}), no kink (slopes differ by ${kink.toFixed(3)} per second)`);
// breathing: in and out once in 4 s
check(at(0).Breath === 0 && Math.abs(at(2).Breath - 1) < 1e-4, 'Breath goes 0 -> 1 -> 0');
// blinking: closed for a moment twice, both eyes at once, open the rest of the time
let closedAt = [];
for (let t = 0; t < 4; t += 0.01) { const v = at(t); if (v.EyeOpenL < 0.05) closedAt.push(+t.toFixed(2)); if (v.EyeOpenL !== v.EyeOpenR) closedAt = ['both differ']; }
const runs = closedAt.filter((t, i) => i === 0 || t - closedAt[i - 1] > 0.015);
check(runs.length === 2 && closedAt.length <= 2 * 5, `two blinks, both eyes at once, shut for a moment each (at ${runs.join(', ')} s)`);
check(makeIdle(sample, { seed: 7 }).animation.tracks.EyeOpenL.join() === a.tracks.EyeOpenL.join() && makeIdle(sample, { seed: 8 }).animation.tracks.EyeOpenL.join() !== a.tracks.EyeOpenL.join(), 'the same seed gives the same blinks, another seed others');
// swaying: a tenth of the range at most, hair sways (the sample has no chains)
const maxOf = (k) => Math.max(...Array.from({ length: 81 }, (_, i) => Math.abs(at(i * 0.05)[k])));
check(Math.abs(maxOf(sp('AngleX')) - 3) < 0.01 && maxOf(sp('AngleY')) <= 1.81 && maxOf(sp('HairSway')) > 0, `small sways: AngleX up to ${maxOf(sp('AngleX')).toFixed(2)}, AngleY ${maxOf(sp('AngleY')).toFixed(2)}, HairSway ${maxOf(sp('HairSway')).toFixed(2)}`);
check(!makeIdle({ ...sample, chains: [{ id: 'c', bones: ['hairL1', 'hairL2'] }] }).animation.tracks[sp('HairSway')], 'with chains, the hair is left to them');

// no Breath parameter: the body bone's height breathes
{
  const nb = structuredClone(sample);
  nb.parameters = nb.parameters.filter((p) => p.id !== 'Breath');
  nb.deformers = nb.deformers.filter((d) => !('Breath' in (d.region || {})));
  nb.animations = nb.animations.map((an) => { const c = structuredClone(an); if (c.tracks) delete c.tracks.Breath; return c; });
  const r = makeIdle(nb);
  check(r.animation.bones?.body?.scaleY && r.notes.some((n) => n.code === 'idleBreathBone' && n.vars.bone === 'body' && n.level === 'info'), `without Breath: ${r.warnings[0]}`);
  nb.animations.push(r.animation);
  const i2 = rt.loadModel(compileUgo(nb)).createInstance(), bi = nb.bones.findIndex((b) => b.id === 'body');
  const sy = (t) => { i2.reset(); i2.play(r.animation.id, t); i2.update(0); const w = i2.boneWorld(bi); return Math.hypot(w[2], w[3]); };
  check(sy(2) > sy(0) * 1.005 && Math.abs(sy(4) - sy(0)) < 1e-5, `the body bone grows ${((sy(2) / sy(0) - 1) * 100).toFixed(1)}% taller at the breath's top and is back at the end`);
}
// nothing to move
const none = makeIdle({ parameters: [], bones: [{ id: 'root' }], parts: [] });
check(['idleNoBreath', 'idleNoBlink', 'idleNoSway', 'idleNothing'].every((c) => none.notes.some((n) => n.code === c)), `an empty model: ${none.notes.map((n) => n.code).join(', ')}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall idle checks passed');
process.exit(failures ? 1 : 0);
