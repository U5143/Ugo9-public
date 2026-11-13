// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Physics from one model onto another, added to what it has (利用者の声 #26, tools/copy_physics.mjs): the other's own
// physics and chains are kept (said), or replaced when asked; the others are added. Brought onto a model whose
// parameter ids and ranges differ (AngleX -30..30 → HeadTurnX -45..45, Sway -1..1 → HairSway -2..2), the same head
// turn sways the same: run in the runtime, the brought one's output is the original's carried into the other range
// (×2) on every frame. An input the other lacks is left out; an output it lacks, or a chain whose bones it lacks or
// whose bone already sways in another chain, is not brought; the chain's gravity follows the canvas; the command line.
//   node tests/copy_physics_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UgoRuntime } from '../web/ugo.js';
import { compileUgo } from '../tools/compile.mjs';
import { copyPhysics } from '../tools/copy_physics.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const quad = [-5, -5, 5, -5, 5, 5, -5, 5], mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
const P = (id, min, max, def = 0) => ({ id, min, max, default: def });
const B = (id, parent, length = 20) => ({ id, ...(parent ? { parent } : {}), length });
const from = {
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [P('AngleX', -30, 30), P('BodyX', -10, 10), P('Sway', -1, 1), P('Ribbon', -1, 1), P('Tail', -1, 1)],
  bones: [B('root'), B('hair1', 'root'), B('hair2', 'hair1'), B('tail1', 'root'), B('skirt1', 'root')],
  parts: [{ id: 'a', bone: 'root', vertices: quad, ...mesh }],
  physics: [
    { output: 'Sway', inputs: { AngleX: 1, BodyX: 2 }, stiffness: 30, damping: 5, gain: 0.12, min: -1, max: 1 },
    { output: 'Ribbon', inputs: { AngleX: 0.5 }, stiffness: 20, damping: 3, gain: 0.1 },
    { output: 'Tail', inputs: { AngleX: 1 }, stiffness: 10, damping: 2, gain: 0.1 },
  ],
  chains: [{ id: 'hair', bones: ['hair1', 'hair2'], stiffness: 40, damping: 4, gravity: [0, 600] }, { id: 'tail', bones: ['tail1'], gravity: [0, 300] }, { id: 'skirt', bones: ['skirt1'] }],
};
const to = {
  format: 'ugo9', canvas: { width: 200, height: 200 },
  parameters: [P('HeadTurnX', -45, 45), P('HairSway', -2, 2), P('Ribbon', -1, 1)],
  bones: [B('root'), B('hair1', 'root'), B('hair2', 'hair1'), B('skirt1', 'root'), B('skirtB', 'root')],
  parts: [{ id: 'a', bone: 'root', vertices: quad, ...mesh }],
  physics: [{ output: 'Ribbon', inputs: { HeadTurnX: 0.2 }, stiffness: 50, damping: 9, gain: 0.3 }],
  chains: [{ id: 'mine', bones: ['skirt1'] }],
};
const map = { AngleX: 'HeadTurnX', Sway: 'HairSway' };
const r = copyPhysics(from, to, { paramMap: map });
const has = (code, f = () => true) => r.notes.some((n) => n.code === code && f(n.vars));
const sway = r.model.physics.find((p) => p.output === 'HairSway');
check(r.physics.join() === 'HairSway' && sway && Math.abs(sway.inputs.HeadTurnX - 2 / 3) < 1e-9 && !('BodyX' in sway.inputs) && Math.abs(sway.gain - 0.24) < 1e-9 && sway.min === -2 && sway.max === 2,
  `Sway → HairSway: the input's weight × 2/3 (${sway?.inputs.HeadTurnX.toFixed(4)}), the gain × 2 (${sway?.gain}), min / max into -2..2; BodyX left out`);
check(has('copyPhysicsInputLeft', (v) => v.id === 'Sway' && v.input === 'BodyX') && has('copyPhysicsKept', (v) => v.id === 'Ribbon') && r.model.physics.find((p) => p.output === 'Ribbon').stiffness === 50 && has('copyPhysicsMissing', (v) => v.id === 'Tail' && v.kind === 'parameter'),
  'the input it lacks said; its own Ribbon kept (said); Tail: no parameter, not brought (said)');
check(r.chains.join() === 'hair' && r.model.chains.find((c) => c.id === 'hair').gravity.join() === '0,1200' && has('copyPhysicsMissing', (v) => v.id === 'tail' && v.kind === 'bone' && v.missing === 'tail1') && has('copyPhysicsBoneTaken', (v) => v.id === 'skirt' && v.chain === 'mine') && r.model.chains.some((c) => c.id === 'mine'),
  'chain hair brought (gravity × 2 with the canvas); tail: no bone; skirt: its bone sways in mine (not brought); mine kept');
const rep = copyPhysics(from, to, { paramMap: map, existing: 'replace' });
check(rep.model.physics.find((p) => p.output === 'Ribbon').stiffness === 20 && rep.notes.some((n) => n.code === 'copyPhysicsReplaced' && n.vars.id === 'Ribbon') && rep.model.physics.length === 2,
  "existing 'replace': the brought Ribbon in its place (said)");
const auto = copyPhysics(from, to, { paramMap: 'auto' });
check(auto.notes.some((n) => n.code === 'copyParamMapped' && /AngleX→HeadTurnX/.test(n.vars.pairs)) && auto.notes.some((n) => n.code === 'copyPhysicsMissing' && n.vars.id === 'Sway') && copyPhysics(from, to, { only: ['hair'] }).physics.length === 0,
  "'auto' takes the suggestions (AngleX → HeadTurnX; Sway has no near name on the other: not brought); only: just those named");

// in the runtime: the same head turn sways the same, carried into the other range
const a = rt.loadModel(compileUgo(from)).createInstance(), b = rt.loadModel(compileUgo(r.model)).createInstance();
let worst = 0, most = 0;
for (let i = 0; i < 120; i++) {
  const turn = 30 * Math.sin(i / 8) * (i < 60 ? 1 : 0);
  a.set('AngleX', turn); b.set('HeadTurnX', turn * 1.5);
  a.update(1 / 30); b.update(1 / 30);
  worst = Math.max(worst, Math.abs(b.get('HairSway') - 2 * a.get('Sway'))); most = Math.max(most, Math.abs(a.get('Sway')));
}
check(most > 0.2 && worst < 1e-4, `in the runtime, 120 frames: HairSway = 2 × Sway (sways up to ${most.toFixed(2)}; off by ${worst.toExponential(1)} at most)`);

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cphys-')), at = (f) => path.join(dir, f);
fs.writeFileSync(at('from.json'), JSON.stringify(from)); fs.writeFileSync(at('to.json'), JSON.stringify(to));
const c = spawnSync(process.execPath, ['tools/copy_physics.mjs', at('from.json'), at('to.json'), '--out', at('o.json'), '--map', 'AngleX=HeadTurnX,Sway=HairSway', '--no-chains'], { encoding: 'utf8' });
const o = c.status === 0 && JSON.parse(fs.readFileSync(at('o.json'), 'utf8'));
check(o && o.physics.some((p) => p.output === 'HairSway') && o.chains.length === 1 && /kept/.test(c.stderr) && spawnSync(process.execPath, ['tools/copy_physics.mjs', at('from.json')]).status === 2,
  'command line: --map, --no-chains, the notes on stderr; wrong: 2');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall physics copy checks passed');
process.exit(failures ? 1 : 0);
