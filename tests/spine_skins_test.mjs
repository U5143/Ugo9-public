// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Spine skins (tools/import_spine.mjs, 利用者の声 #44): the test rig with two more skins ("red": the torso drawn with the
// flag's picture, the eye with the closed one; "blue": the torso with the arm's mesh linked from the default skin). By
// default the default skin shows and the others come as hidden parts slot/attachment@skin, in their slot's place; with
// skin "red" the red attachments show (over the default skin, as Spine looks them up) and default's are not there; a
// skin not there is refused; the animations still switch the shown attachments; the command line takes --skin.
//   node tests/spine_skins_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importSpine } from '../tools/import_spine.mjs';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const skel = JSON.parse(fs.readFileSync('tests/spine/rig.json', 'utf8')), atlas = fs.readFileSync('tests/spine/rig.atlas', 'utf8');
skel.skins.push(
  { name: 'red', attachments: { torso: { torso: { path: 'flag', x: 0, y: 0, width: 40, height: 80 } }, eye: { 'eye-open': { path: 'eye-closed', x: 0, y: 30, width: 10, height: 10 } } } },
  { name: 'blue', attachments: { torso: { torso: { type: 'linkedmesh', parent: 'arm', skin: 'default', path: 'arm' } } } },
);
// the blue torso links to the default skin's arm mesh, which lives in the arm slot: Spine links within a slot, so
// give the arm slot a linked mesh too
skel.skins[2].attachments.arm = { arm: { type: 'linkedmesh', parent: 'arm', skin: 'default', path: 'arm' } };
const ids = (r) => r.model.parts.map((p) => p.id);
const base = importSpine(JSON.parse(fs.readFileSync('tests/spine/rig.json', 'utf8')), atlas);
const d = importSpine(skel, atlas);
const extra = ids(d).filter((id) => /@/.test(id));
check(JSON.stringify(ids(d).filter((id) => !/@/.test(id))) === JSON.stringify(ids(base)) && d.model.parts.filter((p) => /@/.test(p.id)).every((p) => p.opacity === 0),
  `default skin shown: the same parts as without the other skins; theirs hidden (${extra.join(', ')})`);
check(extra.includes('torso/torso@red') && extra.includes('eye/eye-open@red') && extra.includes('arm/arm@blue') && d.skins.names.join() === 'default,red,blue' && d.skins.hidden.red.length === 2,
  'each other skin\'s attachments as slot/attachment@skin; the result lists them by skin');
const pos = (r, id) => ids(r).indexOf(id);
check(pos(d, 'torso/torso@red') > pos(d, 'torso/torso') && pos(d, 'torso/torso@red') < pos(d, 'arm/arm'), 'a hidden part sits in its slot\'s place in the drawing order');
check(d.warnings.some((w) => /skin default shown; the other skins \(red, blue\)/.test(w)), 'said: which skin is shown, the others hidden');

// skin red shown
const r = importSpine(skel, atlas, { skin: 'red' });
const torso = r.model.parts.find((p) => p.id === 'torso/torso'), torso0 = d.model.parts.find((p) => p.id === 'torso/torso');
const flagUv = d.model.parts.find((p) => p.id === 'flag/flag').uvs;
check(torso && Math.min(...torso.uvs.filter((_, i) => i % 2 === 0)) >= Math.min(...flagUv.filter((_, i) => i % 2 === 0)) - 1e-9 && JSON.stringify(torso.uvs) !== JSON.stringify(torso0.uvs) && torso.opacity > 0,
  'skin red: the torso drawn with red\'s picture (the flag\'s), shown');
check(!ids(r).includes('torso/torso@red') && ids(r).includes('arm/arm@blue') && !ids(r).some((id) => id.endsWith('@default')), 'the shown skin\'s parts are the slot\'s own; blue still hidden; default not doubled');
const eyeOpen = r.model.parts.find((p) => p.id === 'eye/eye-open'), eyeClosed = r.model.parts.find((p) => p.id === 'eye/eye-closed');
check(eyeOpen && eyeClosed && eyeOpen.opacity > 0 && JSON.stringify(eyeOpen.uvs) === JSON.stringify(eyeClosed.uvs), 'red\'s eye-open (the closed picture) over the default skin\'s; eye-closed still the default skin\'s');
// the animations still switch the shown attachments, and the models compile
const blink = (m) => JSON.stringify((m.animations || []).map((a) => Object.keys(a.opacity || {}).sort()));
check(blink(d.model) === blink(base.model) && blink(r.model) === blink(base.model), 'the animations switch the same (shown) parts as before');
let ok = true;
try { compileUgo(d.model, { warnings: [] }); compileUgo(r.model, { warnings: [] }); } catch (e) { ok = e.message; }
check(ok === true, `both compile (${ok})`);
let threw = null;
try { importSpine(skel, atlas, { skin: 'green' }); } catch (e) { threw = e.message; }
check(/no skin named green.*default, red, blue/.test(threw || ''), 'a skin not there: refused, the skins named');

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skins-'));
fs.writeFileSync(path.join(dir, 'rig.json'), JSON.stringify(skel));
fs.copyFileSync('tests/spine/rig.atlas', path.join(dir, 'rig.atlas')); fs.copyFileSync('tests/spine/rig.png', path.join(dir, 'rig.png'));
execFileSync('node', ['tools/import_spine.mjs', path.join(dir, 'rig.json'), path.join(dir, 'rig.atlas'), path.join(dir, 'out'), '--skin', 'red'], { encoding: 'utf8' });
const m = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'model.json'), 'utf8'));
check(m.parts.some((p) => p.id === 'arm/arm@blue') && !m.parts.some((p) => p.id.endsWith('@red')), 'command line: --skin red');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall Spine skin checks passed');
process.exit(failures ? 1 : 0);
