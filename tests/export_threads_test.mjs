// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export draws several frames at once (--threads, 進行 #391 の 3): each thread's instance takes the same pose steps
// (the warmup, --seamless, every drawn frame), so the picture is the same bytes for 1, 2, 3, 4 and 8 threads: with
// the swinging physics, two layered animations, a held parameter, on twos (--hold 2), --seamless, a camera with a cut,
// nearest sampling, a background, a crop, and a frame count that does not divide by the threads. A GIF and an APNG
// written beside are the same files. A wrong --threads answers 2.
//   node tests/export_threads_test.mjs [old_ugo_export]   (needs build/ugo_export; with an old build: the same bytes as it)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (!exe) { console.log('skip: no build/ugo_export'); process.exit(0); }
const old = process.argv[2];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-')), model = 'samples/basic/model.ug9';
const run = (bin, args, name) => {
  const out = path.join(dir, name), r = spawnSync(bin, [model, ...args, '--out', out + '.rgba', '--out', out + '.gif', '--out', out + '.png'], { encoding: 'utf8' });
  if (r.status) throw new Error(`${name}: ${r.stderr}`);
  return { raw: fs.readFileSync(out + '.rgba'), gif: fs.readFileSync(out + '.gif'), png: fs.readFileSync(out + '.png'), err: r.stderr };
};

const cases = [
  ['physics, 2 animations, a held parameter', ['--anim', 'idle', '--anim', 'talk', '--param', 'EyeOpenL=0.3', '--frames', '13', '--size', '120x170']],
  ['on twos, --seamless', ['--anim', 'idle', '--hold', '2', '--seamless', '--frames', '11', '--size', '100x140']],
  ['a camera with a cut, nearest, a background, a crop', ['--anim', 'idle', '--camera', '0:1', '--camera', '0.2:2:cut', '--nearest', '--ss', '1', '--bg', '#204060', '--crop', '10,20,90,110', '--frames', '9', '--size', '120x170']],
];
for (const [what, args] of cases) {
  const one = run(exe, [...args, '--threads', '1'], 't1');
  const others = [2, 3, 4, 8].map((n) => [n, run(exe, [...args, '--threads', String(n)], 't' + n)]);
  const same = others.filter(([, r]) => r.raw.equals(one.raw) && r.gif.equals(one.gif) && r.png.equals(one.png)).map(([n]) => n);
  check(same.length === others.length, `${what}: the same bytes with 1, ${same.join(', ')} threads (raw, GIF, APNG)`);
  const said = (r) => r.err.split('\n').filter((l) => /seamless/.test(l));
  if (/seamless/.test(what)) check(others.every(([, r]) => said(r).join() === said(one).join()) && said(one).length === 1, `  --seamless says it once, the same (${said(one)[0]})`);
  const auto = run(exe, args, 'auto');
  check(auto.raw.equals(one.raw), `  without --threads (one per processor, here ${os.cpus().length}): the same bytes`);
  if (old) check(run(old, args, 'old').raw.equals(one.raw), '  the same bytes as the build before threads');
}
const bad = spawnSync(exe, [model, '--threads', '0', '--out', path.join(dir, 'x.rgba')], { encoding: 'utf8' });
check(bad.status === 2 && /--threads/.test(bad.stderr), 'a wrong --threads: 2 and why');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall thread checks passed');
process.exit(failures ? 1 : 0);
