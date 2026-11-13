// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Why a .ug9 does not load, in words (利用者の声 #400 の 1): ugo_export and tools/import_ug9.mjs say "made with a newer
// Ugo9" with the file's format and what this build reads (a later major, or a later 1.x with a table it must know),
// "made with an old Ugo9 … compile it again" for a format before 0.7/1.0, a file cut short, and a file that is not a
// .ug9; ugo_export keeps the error number at the end; import_ug9 keeps its codes (ug9Version with newer, ug9Newer).
//   node tests/load_error_test.mjs   (the ugo_export checks need build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileUgo } from '../tools/compile.mjs';
import { readUg9Tables } from '../tools/import_ug9.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loaderr-')), sample = fs.readFileSync('samples/basic/model.ug9');
fs.copyFileSync('samples/basic/atlas.png', path.join(dir, 'atlas.png'));
const file = (name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); return path.join(dir, name); };
const edited = (f) => { const c = Buffer.from(sample); f(c); return c; };
const json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
const files = {
  major2: file('major2.ug9', edited((c) => c.writeUInt16LE(2, 4))),
  needs19: file('needs19.ug9', new Uint8Array(compileUgo(json, { warnings: [], future: { minor: 9, tables: [{ kind: 900, count: 1, recSize: 4, flag: 2 }] } }))),
  old06: file('old06.ug9', edited((c) => { c.writeUInt16LE(0, 4); c.writeUInt16LE(6, 6); })),
  cut: file('cut.ug9', sample.subarray(0, sample.length - 100)),
  png: file('png.ug9', fs.readFileSync('samples/basic/atlas.png')),
};

// tools/import_ug9.mjs
const thrown = (f) => { try { readUg9Tables(fs.readFileSync(f)); return null; } catch (e) { return e; } };
const a = thrown(files.major2), b = thrown(files.needs19), c = thrown(files.old06);
check(a?.code === 'ug9Version' && a.vars.newer === true && /newer Ugo9/.test(a.message) && /2\.0/.test(a.message), `import_ug9, format 2.0: ${a?.message}`);
check(b?.code === 'ug9Newer' && b.vars.version === '1.9' && /newer Ugo9/.test(b.message) && /1\.9/.test(b.message), `import_ug9, 1.9 with a table it must know: ${b?.message}`);
check(c?.code === 'ug9Version' && c.vars.newer === false && /old Ugo9/.test(c.message) && /compile it again/.test(c.message), `import_ug9, format 0.6: ${c?.message}`);

// ugo_export
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (exe) {
  const say = (f) => { const r = spawnSync(exe, [f, '--frames', '1', '--out', path.join(dir, 'x.rgba')], { encoding: 'utf8' }); return { status: r.status, text: r.stderr.trim().split('\n').pop() }; };
  const m2 = say(files.major2), n19 = say(files.needs19), o6 = say(files.old06), cut = say(files.cut), png = say(files.png);
  check(m2.status === 1 && /made with a newer Ugo9: the file is format 2\.0 and needs a newer ugo_export \(this one reads 1\.0 to 1\.\d+\) \(error 3\)/.test(m2.text), `ugo_export, format 2.0: ${m2.text.split(': ').slice(1).join(': ')}`);
  check(n19.status === 1 && /newer Ugo9: the file is format 1\.9/.test(n19.text), `ugo_export, 1.9 with a table it must know: ${n19.text.split(': ').slice(1).join(': ')}`);
  check(/old Ugo9 \(format 0\.6/.test(o6.text) && /compile it again/.test(o6.text), `ugo_export, format 0.6: ${o6.text.split(': ').slice(1).join(': ')}`);
  check(/cut short/.test(cut.text) && /\(error 1\)$/.test(cut.text) && /not a \.ug9 file/.test(png.text) && /\(error 2\)$/.test(png.text), 'ugo_export: a file cut short, a PNG named .ug9 (each with its error number)');
} else console.log('skip ugo_export (no build/ugo_export)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall load error checks passed');
process.exit(failures ? 1 : 0);
