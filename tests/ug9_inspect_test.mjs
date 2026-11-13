// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// tools/ug9_inspect.mjs: the summary agrees with the model, two files that read the same compare equal, and
// changed parameters, bones, animations, tables and versions are listed; broken files are said to be so;
// the command line's exit codes.
//   node tests/ug9_inspect_test.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compileUgo } from '../tools/compile.mjs';
import { compare, inspect } from '../tools/ug9_inspect.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const quad = [0, 0, 10, 0, 10, 10, 0, 10];
const src = {
  format: 'ugo9', canvas: { width: 100, height: 100 },
  parameters: [{ id: 'A', min: 0, default: 0, max: 1 }, { id: 'B', min: -1, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root' }],
  parts: [{ id: 'p', bone: 'arm', vertices: quad, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  animations: [{ id: 'wave', duration: 1, tracks: { A: [[0, 0], [1, 1]] } }],
};
const bytes = new Uint8Array(compileUgo(src));
const r = await inspect(bytes);
check(r.version === '1.0' && r.read.counts.parameters === 2 && r.read.bones.join() === 'root,arm' && r.read.parts.join() === 'p' && r.read.animations[0].name === 'wave',
  `the summary agrees with the model (format ${r.version}, ${r.tables.length} tables)`);
check(r.tables.every((t) => /^[0-9a-f]{16}$/.test(t.hash) && t.name), 'every table has its name and a hash of its bytes');
check((await compare(bytes, new Uint8Array(compileUgo(src)))).changes.length === 0, 'the same model compiled twice compares equal');
const changed = structuredClone(src);
changed.parameters[1].max = 2; changed.bones.push({ id: 'hand', parent: 'arm' }); changed.animations[0].duration = 2;
const c = (await compare(bytes, new Uint8Array(compileUgo(changed)))).changes;
check(c.some((x) => x.startsWith('parameter B:')) && c.some((x) => x === 'bones: added hand') && c.some((x) => x.startsWith('animation wave: 1 s')) && c.some((x) => x.startsWith('table bones:')),
  `changes are listed (${c.length}: ${c.slice(0, 4).join(' | ')} ...)`);
const broken = bytes.slice(); broken[8] ^= 1;
const b = await inspect(broken);
check(b.refused && /error/.test(b.refused), `a broken file is said to be refused (${b.refused})`);
check((await inspect(new Uint8Array(10))).error, 'a file that is not a .ug9 is said to be so');
const v11 = await inspect(fs.readFileSync(new URL('./v11/model.ug9', import.meta.url)));
check(v11.version === '1.1' && v11.tables.some((t) => t.name === 'keyCurves'), 'a 1.1 file shows its curve tables');
const cli = (...a) => { try { execFileSync(process.execPath, [new URL('../tools/ug9_inspect.mjs', import.meta.url).pathname, ...a], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
fs.mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
const f1 = new URL('../build/inspect_a.ug9', import.meta.url).pathname, f2 = new URL('../build/inspect_b.ug9', import.meta.url).pathname;
fs.writeFileSync(f1, bytes); fs.writeFileSync(f2, new Uint8Array(compileUgo(changed)));
check(cli(f1) === 0 && cli(f1, f1) === 0 && cli(f1, f2) === 1 && cli() === 2, 'the command line: 0 for a summary or no change, 1 for changes, 2 for a wrong call');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all inspect checks passed');
