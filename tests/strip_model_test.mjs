// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// What goes into an export (tools/strip_model.mjs, 機能の比べ #91): only the animations asked for, no physics, chains
// or expressions when not wanted; the rest of the .ug9 (positions, UVs, parts, bones, parameters, deformers) the same;
// nothing asked: the same .ug9; an animation not there: said, and the command line stops.
//   node tests/strip_model_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripModel } from '../tools/strip_model.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { readUg9Tables } from '../tools/import_ug9.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const base = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
// a chain and an expression too
base.chains = [{ id: 'hairL', bones: ['hairL1', 'hairL2'], stiffness: 40, damping: 4, gravity: [0, 600] }];
base.expressions = [{ id: 'smile', params: { MouthOpen: ['add', 0.3] } }];
base.editor = { note: 'the editor\'s' };
const bin = (m) => new Uint8Array(compileUgo(m, { warnings: [] }));
const full = bin(base), T = readUg9Tables(full);

const same = stripModel(base, { editorData: true });
check(Buffer.compare(Buffer.from(bin(same.model)), Buffer.from(full)) === 0 && same.model.editor && !same.notes.length, 'nothing asked: the same .ug9 (and with editorData true the editor\'s data kept)');
check(!('editor' in stripModel(base).model), 'by default the editor\'s own data is left out (the .ug9 has no place for it)');

const r = stripModel(base, { anims: ['idle'], physics: false, chains: false, expressions: false }), S = readUg9Tables(bin(r.model));
check(r.model.animations.map((a) => a.id).join() === 'idle' && r.removed.animations.join() === 'talk' && r.removed.physics === 2 && r.removed.chains === 1 && r.removed.expressions === 1,
  `kept idle; left out talk, 2 physics, 1 chain, 1 expression`);
check(S.counts.animations === 1 && S.counts.physics === 0 && S.counts.chains === 0 && S.counts.expressions === 0 && S.counts.tracks < T.counts.tracks && S.counts.keys < T.counts.keys,
  `the .ug9: 1 animation (tracks ${T.counts.tracks} → ${S.counts.tracks}, keys ${T.counts.keys} → ${S.counts.keys}), no physics, chains or expressions`);
check(['pos', 'uv', 'parts', 'bones', 'params', 'indices', 'deltas', 'regions', 'morphs', 'boneDrivers'].every((k) => JSON.stringify(S[k]) === JSON.stringify(T[k])),
  'the rest the same: positions, UVs, parts, bones, parameters, indices, deformers');
const n = stripModel(base, { anims: ['idle', 'nope'] });
check(n.notes.some((x) => x.code === 'stripNoAnimation' && x.vars.anim === 'nope') && n.model.animations.length === 1, 'an animation not there: said (stripNoAnimation)');
check(JSON.stringify(base.animations.map((a) => a.id)) === '["idle","talk"]' && base.physics.length === 2, 'the model given is not changed');

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-'));
fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify(base));
const run = (...a) => spawnSync(process.execPath, ['tools/strip_model.mjs', ...a], { encoding: 'utf8' });
const ok = run(path.join(dir, 'm.json'), '--out', path.join(dir, 'g.ug9'), '--anims', 'idle', '--no-physics', '--no-chains', '--no-expressions');
const fromUg9 = run('samples/basic/model.ug9', '--out', path.join(dir, 'g.json'), '--anims', 'talk');
const bad = run(path.join(dir, 'm.json'), '--out', path.join(dir, 'x.ug9'), '--anims', 'nope');
check(ok.status === 0 && /left out animations talk; 2 physics; 1 chains; 1 expressions/.test(ok.stdout) && readUg9Tables(fs.readFileSync(path.join(dir, 'g.ug9'))).counts.animations === 1
  && fromUg9.status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'g.json'), 'utf8')).animations.map((a) => a.id).join() === 'talk' && bad.status === 1 && !fs.existsSync(path.join(dir, 'x.ug9')),
  'command line: a .ug9 out (the sizes said), a .json out from a .ug9, an animation not there stops with 1 and writes nothing');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall strip checks passed');
process.exit(failures ? 1 : 0);
