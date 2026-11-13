// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// ugo_export's ways out: each error stops with its code and a line that names the problem, and
// (under AddressSanitizer, with UGO_EXPORT set to such a build) every way out frees what it took
// and closes what it opened. Also the sprite sheet without --anim (it used to crash).
//   node tests/export_exit_test.mjs                       (needs build/ugo_export)
//   UGO_EXPORT=./ugo_export_asan node tests/export_exit_test.mjs   (in CI, the sanitizers job)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExporter } from '../tools/compare_frames.mjs';
import { sp } from './sample_names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_exit_test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const exe = process.env.UGO_EXPORT ? path.resolve(process.env.UGO_EXPORT) : findExporter();
const MODEL = path.join(ROOT, 'samples/basic/model.ug9');
const o = (name) => path.join(OUT, name);
const run = (args) => spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1' } });
const sanitizer = (r) => /Sanitizer|runtime error|leak/i.test(r.stderr);

const preset = o('pinned.json');
fs.writeFileSync(preset, JSON.stringify({ ugo9ExportPreset: 1, pinned: { [sp('AngleX')]: 5, Nope: 1 } }));
fs.writeFileSync(o('broken.ug9'), fs.readFileSync(MODEL).subarray(0, 200));
fs.mkdirSync(o('lonely'));
fs.copyFileSync(MODEL, o('lonely/model.ug9')); // without its textures

const cases = [
  ['an animation that is not there', [MODEL, '--anim', 'nope', '--frames', '1', '--out', o('a.rgba')], 1, /no animation named nope/],
  ['a parameter that is not there', [MODEL, '--param', 'Nope=1', '--frames', '1', '--out', o('a.rgba')], 1, /no parameter named Nope/],
  ['a pinned value of the preset that is not there', [MODEL, '--preset', preset, '--frames', '1', '--out', o('a.rgba')], 1, /no parameter named Nope/],
  ['--param without =', [MODEL, '--param', sp('AngleX'), '--frames', '1', '--out', o('a.rgba')], 2, /NAME=VALUE/],
  ['an unknown format', [MODEL, '--format', 'bogus', '--frames', '1', '--out', o('a.x')], 2, /unknown format bogus/],
  ['an APNG into a folder that is not there', [MODEL, '--frames', '2', '--out', o('nodir/a.apng'), '--out', o('b.rgba')], 1, /cannot write/],
  ['PNG frames into a folder that is not there', [MODEL, '--frames', '2', '--format', 'frames', '--out', o('nodir/x')], 1, /cannot write/],
  ['a GIF into a folder that is not there', [MODEL, '--frames', '2', '--out', o('nodir/a.gif')], 1, /cannot write/],
  ['a sprite sheet into a folder that is not there', [MODEL, '--frames', '2', '--format', 'sheet', '--out', o('nodir/s.png')], 1, /cannot write/],
  ['a model that is cut short', [o('broken.ug9'), '--frames', '1', '--out', o('a.rgba')], 1, /cut short.*\(error 1\)/],
  ['a model without its textures', [o('lonely/model.ug9'), '--frames', '1', '--out', o('a.rgba')], 1, /cannot load texture/],
];
for (const [label, args, code, msg] of cases) {
  const r = run(args);
  check(r.status === code && msg.test(r.stderr) && !sanitizer(r), `${label}: exit ${r.status} (want ${code}), "${r.stderr.trim().split('\n')[0]}"${sanitizer(r) ? ' + a sanitizer report' : ''}`);
}

for (const [label, args] of [['APNG and raw together', ['--out', o('ok.apng'), '--out', o('ok.rgba')]], ['GIF', ['--out', o('ok.gif')]], ['PNG frames', ['--format', 'frames', '--out', OUT]]]) {
  const r = run([MODEL, '--frames', '2', ...args]);
  check(r.status === 0 && !sanitizer(r), `${label}: written, exit 0, nothing left behind`);
}
const sheet = run([MODEL, '--frames', '2', '--format', 'sheet', '--out', o('s.png')]);
const json = sheet.status === 0 ? JSON.parse(fs.readFileSync(o('s.png.json'), 'utf8')) : null;
check(sheet.status === 0 && json?.meta?.frameTags?.[0]?.name === 'idle' && !sanitizer(sheet), `a sprite sheet without --anim: written, its tag is the first animation (idle) (it used to crash; exit ${sheet.status})`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall exit checks passed');
process.exit(failures ? 1 : 0);
