// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Japanese names all the way round (利用者の声 #400 の 2): a model in a folder named in Japanese, its texture, parts,
// bones, a parameter and an animation named in Japanese — compiled, the .ug9 keeps every name as it was (UTF-8);
// ugo_export finds the texture by its Japanese name in the Japanese folder and draws the same picture as the model
// with ASCII names; read back from the .ug9 the names are the same; packed into a .ugo9 and unpacked, the files and
// names come back, and the zip marks its names as UTF-8 (bit 11), so other zip tools (Python's zipfile, Info-ZIP's
// unzip) read them as written, not garbled.
//   node tests/japanese_names_test.mjs   (the drawing check needs build/ugo_export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileUgo } from '../tools/compile.mjs';
import { importUg9 } from '../tools/import_ug9.mjs';
import { applyNamesCsv } from '../tools/names_csv.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { findExporter } from '../tools/compare_frames.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-')), dir = path.join(root, 'キャラ　テスト'), plain = path.join(root, 'plain');
fs.mkdirSync(dir); fs.mkdirSync(plain);

// the sample with Japanese names (every reference renamed with them)
const json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
const names = { part: [['face', '顔'], ['bangs', '前髪']], bone: [['neck', '首'], ['head', '頭']], param: [['BrowY', '眉の高さ']], anim: [['idle', '待機・呼吸']] };
const csv = 'kind,id,new_id\n' + Object.entries(names).flatMap(([k, list]) => list.map(([a, b]) => `${k},${a},${b}`)).join('\n');
const r = applyNamesCsv(json, csv), jp = r.model;
jp.textures = ['絵（アトラス）.png'];
check(!r.notes.length && r.renamed.length === 6, `the sample renamed: ${r.renamed.map((x) => x.to).join(', ')}, texture ${jp.textures[0]}`);
fs.copyFileSync('samples/basic/atlas.png', path.join(dir, jp.textures[0]));
fs.copyFileSync('samples/basic/atlas.png', path.join(plain, 'atlas.png'));
fs.writeFileSync(path.join(dir, 'モデル.json'), JSON.stringify(jp));
const ug9 = new Uint8Array(compileUgo(jp, { warnings: [] }));
fs.writeFileSync(path.join(dir, 'モデル.ug9'), ug9);
fs.writeFileSync(path.join(plain, 'model.ug9'), new Uint8Array(compileUgo(json, { warnings: [] })));

// the .ug9 keeps the names (the runtime reads them back as written)
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync('web/ugo.wasm'), {})).instance.exports);
const m = rt.loadModel(ug9), parts = m.partData().parts.map((p) => p.name);
check(m.textures[0] === '絵（アトラス）.png' && parts.includes('顔') && parts.includes('前髪') && m.boneIndex('首') >= 0 && m.params.some((p) => p.name === '眉の高さ') && m.animations.some((a) => a.name === '待機・呼吸'),
  'in the .ug9: the texture, parts, bones, parameter and animation names as written');

// ugo_export: the texture found by its Japanese name in the Japanese folder; the same picture as with ASCII names
const exe = (() => { try { return findExporter(); } catch { return null; } })();
if (exe) {
  const draw = (file, anim, out) => spawnSync(exe, [file, '--anim', anim, '--frames', '3', '--size', '140x200', '--out', out], { encoding: 'utf8' });
  const a = draw(path.join(dir, 'モデル.ug9'), '待機・呼吸', path.join(dir, '出力.rgba')), b = draw(path.join(plain, 'model.ug9'), 'idle', path.join(plain, 'out.rgba'));
  check(a.status === 0 && b.status === 0 && fs.readFileSync(path.join(dir, '出力.rgba')).equals(fs.readFileSync(path.join(plain, 'out.rgba'))),
    `ugo_export: the Japanese-named model in "キャラ　テスト" draws the same bytes as the ASCII one (${a.stderr.trim() || 'ok'})`);
} else console.log('skip ugo_export (no build/ugo_export)');

// read back from the .ug9
const back = importUg9(ug9).json;
check(back.textures[0] === '絵（アトラス）.png' && back.parts.some((p) => p.id === '顔') && back.bones.some((b) => b.id === '頭') && back.parameters.some((p) => p.id === '眉の高さ') && back.animations.some((a) => a.id === '待機・呼吸'),
  'import_ug9: the names come back as written');

// a .ugo9 (the editor's zip) and other zip tools
const cli = (...a) => spawnSync(process.execPath, ['tools/ugo9.mjs', ...a], { encoding: 'utf8' });
fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(jp));
const p1 = cli('pack', dir, '--out', path.join(root, '作品.ugo9')), p2 = cli('unpack', path.join(root, '作品.ugo9'), '--out', path.join(root, 'ほどいた'));
check(p1.status === 0 && p2.status === 0 && fs.existsSync(path.join(root, 'ほどいた', '絵（アトラス）.png')) && JSON.parse(fs.readFileSync(path.join(root, 'ほどいた', 'model.json'), 'utf8')).parts.some((p) => p.id === '顔'),
  '.ugo9: packed and unpacked, the Japanese-named texture and the names come back');
const zip = fs.readFileSync(path.join(root, '作品.ugo9'));
let flagged = 0, entries = 0;
for (let i = 0; i + 30 < zip.length; i++) if (zip.readUInt32LE(i) === 0x02014b50) { entries++; if (zip.readUInt16LE(i + 8) & 0x800) flagged++; }
check(entries > 0 && flagged === entries, `the zip marks every name as UTF-8 (${flagged} of ${entries} entries, bit 11)`);
const py = spawnSync('python3', ['-I', '-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', path.join(root, '作品.ugo9')], { encoding: 'utf8' });
check(py.status !== 0 || py.stdout.split('\n').includes('絵（アトラス）.png'), `Python's zipfile reads the names as written (${py.status === 0 ? py.stdout.trim().split('\n').join(', ') : 'no python3: skipped'})`);
const uz = spawnSync('unzip', ['-Z1', path.join(root, '作品.ugo9')], { encoding: 'utf8' });
check(uz.error || uz.stdout.split('\n').includes('絵（アトラス）.png'), `unzip lists them as written (${uz.error ? 'no unzip: skipped' : uz.stdout.trim().split('\n').join(', ')})`);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall Japanese name checks passed');
process.exit(failures ? 1 : 0);
