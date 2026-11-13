// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Loops without a jump (ugo_export --seamless, 利用者の声 #35): a model whose physics settles slowly (the sample's sway
// with little damping) jumps where its loop starts again after the usual one-loop warmup; with --seamless the physics
// runs more loops until the pose at the loop's start stops changing, and the frame one loop later is the first frame
// again. Said on stderr (how many loops, the seam left); too few loops allowed: said, still written; no animation: left
// as it is; with --each-anim; a bad --seamless-loops refused.
//   node tests/export_seamless_test.mjs   (needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExporter } from '../tools/compare_frames.mjs';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = findExporter();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seamless-'));
fs.copyFileSync('samples/basic/atlas.png', path.join(dir, 'atlas.png'));
const base = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
const slow = structuredClone(base);
for (const p of slow.physics) { p.damping = 0.2; p.stiffness = 8; } // sways long after a push
fs.writeFileSync(path.join(dir, 'slow.ug9'), new Uint8Array(compileUgo(slow, { warnings: [] })));
const still = structuredClone(base); still.animations = [];
fs.writeFileSync(path.join(dir, 'still.ug9'), new Uint8Array(compileUgo(still, { warnings: [] })));

const W = 105, H = 150, N = W * H * 4, FPS = 10, LOOP = 6; // idle is 6 s long: frame 60 is the first again
const run = (model, ...more) => {
  const out = path.join(dir, 'f.rgba');
  const r = spawnSync(exe, [model, '--anim', 'idle', '--fps', String(FPS), '--frames', String(LOOP * FPS + 1), '--size', `${W}x${H}`, '--format', 'raw', '--out', out, ...more], { encoding: 'utf8' });
  if (r.status !== 0) return { status: r.status, err: r.stderr };
  const f = fs.readFileSync(out);
  let most = 0;
  for (let i = 0; i < N; i++) most = Math.max(most, Math.abs(f[i] - f[LOOP * FPS * N + i]));
  return { status: 0, err: r.stderr, seam: most };
};
const S = path.join(dir, 'slow.ug9');
const plain = run(S), smooth = run(S, '--seamless'), few = run(S, '--seamless', '--seamless-loops', '2');
check(plain.seam > 50, `slow physics, the usual warmup: the loop jumps (a pixel ${plain.seam} levels off one loop later)`);
check(smooth.seam <= 1 && /seamless: settled after \d+ more loop/.test(smooth.err), `--seamless: one loop later is the first frame again (${smooth.seam} level; ${smooth.err.trim().split('\n')[0]})`);
check(few.status === 0 && /not settled after 2 more loops/.test(few.err), '--seamless-loops 2: too few, said (still written)');
const sample = run('samples/basic/model.ug9', '--seamless');
check(sample.seam <= 1 && /settled after 1 more loop/.test(sample.err), 'the sample (settles in its warmup): one more loop to see it, no jump');
const st = spawnSync(exe, [path.join(dir, 'still.ug9'), '--frames', '2', '--size', `${W}x${H}`, '--format', 'raw', '--out', path.join(dir, 's.rgba'), '--seamless'], { encoding: 'utf8' });
check(st.status === 0 && /no animation to loop/.test(st.stderr), 'no animation: left as it is, said');
const each = spawnSync(exe, [S, '--each-anim', '--seamless', '--frames', '2', '--size', `${W}x${H}`, '--format', 'raw', '--out', path.join(dir, 'e_{anim}.rgba')], { encoding: 'utf8' });
check(each.status === 0 && fs.existsSync(path.join(dir, 'e_idle.rgba')) && fs.existsSync(path.join(dir, 'e_talk.rgba')) && (each.stderr.match(/seamless: settled/g) || []).length === 2, 'with --each-anim: each animation looped without a jump (the model path after --seamless still found)');
// the same from a preset: "seamless": true (and "seamlessLoops")
{
  const pr = path.join(dir, 'p.json');
  fs.writeFileSync(pr, JSON.stringify({ ugo9ExportPreset: 1, seamless: true, seamlessLoops: 2 }));
  const viaPreset = run(S, '--preset', pr);
  check(viaPreset.status === 0 && /not settled after 2 more loops/.test(viaPreset.err), 'a preset\'s "seamless": true with "seamlessLoops": 2 does what --seamless --seamless-loops 2 does');
  fs.writeFileSync(pr, JSON.stringify({ ugo9ExportPreset: 1, seamless: true }));
  const p2 = run(S, '--preset', pr);
  check(p2.seam <= 1 && /settled after \d+ more loop/.test(p2.err), 'and with the default loops: no jump');
}
check(spawnSync(exe, [S, '--seamless-loops', '0', '--out', path.join(dir, 'x.gif')]).status === 2, '--seamless-loops 0: refused');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall seamless checks passed');
process.exit(failures ? 1 : 0);
