// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The one command (tools/ugo9.mjs, 機能の比べ #96): pack and unpack give the files back as they were (with the roles
// of the files the editor keeps, such as an underlay), and the editor reads the .ugo9; import finds the importer by what
// the file is (PSD, Procreate, a folder of PNG, Spine, .ug9, .ugo9) and writes a folder or a .ugo9; export writes a .ug9
// the same as compiling, a Spine folder, a Web page, and (with ugo_export) a sheet and a GIF; a wrong command line
// answers 2.
//   node tests/ugo9_cli_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kindOf } from '../tools/ugo9.mjs';
import { readUgo9 } from '../tools/lib/ugo9file.js';
import { sp } from './sample_names.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo9cli-')), at = (...p) => path.join(dir, ...p);
const cli = (...a) => spawnSync(process.execPath, ['tools/ugo9.mjs', ...a], { encoding: 'utf8' });
const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
const exe = ['build/ugo_export', 'build/ugo_export.exe'].find((p) => fs.existsSync(p));

// what a file is, by its first bytes
check(kindOf('tests/psd/face.psd') === 'psd' && kindOf('samples/basic/model.ug9') === 'ug9' && kindOf('tests/procreate/scene.procreate') === 'layers'
  && kindOf('tests/spine/rig.json') === 'spine' && kindOf('samples/basic/model.json') === 'model' && kindOf('samples/basic') === 'project' && kindOf('tests/layers/png') === 'folder',
  'what a file is, from its content: PSD, .ug9, Procreate (a zip), Spine, a model, a project folder, a folder of pictures');

// pack and unpack
const r1 = cli('pack', 'samples/basic', '--out', at('a.ugo9')), r2 = cli('unpack', at('a.ugo9'), '--out', at('u'));
check(r1.status === 0 && r2.status === 0 && kindOf(at('a.ugo9')) === 'ugo9' && same(at('u', 'model.json'), 'samples/basic/model.json') && same(at('u', 'atlas.png'), 'samples/basic/atlas.png'),
  'pack, then unpack: model.json and the atlas byte for byte');
const editor = await readUgo9(new Uint8Array(fs.readFileSync(at('a.ugo9'))));
check(editor.text === fs.readFileSync('samples/basic/model.json', 'utf8') && editor.files.map((f) => f.name).join() === 'atlas.png' && editor.manifest?.files?.[0]?.role === 'texture',
  'the editor\'s reader opens it (the JSON, the atlas as a texture)');
// a file the editor keeps beside the textures (an underlay) goes round with its role
fs.copyFileSync('samples/basic/atlas.png', at('u', 'under.png'));
const card = JSON.parse(fs.readFileSync(at('u', 'manifest.json'), 'utf8'));
card.files.push({ name: 'under.png', role: 'underlay' });
fs.writeFileSync(at('u', 'manifest.json'), JSON.stringify(card));
cli('pack', at('u'), '--out', at('b.ugo9')); cli('unpack', at('b.ugo9'), '--out', at('v'));
const card2 = JSON.parse(fs.readFileSync(at('v', 'manifest.json'), 'utf8'));
check(same(at('v', 'under.png'), at('u', 'under.png')) && card2.files.find((f) => f.name === 'under.png')?.role === 'underlay', 'an underlay listed in manifest.json goes round with its role');

// import, by what the file is
const imp = (src, out) => cli('import', src, '--out', out);
const i1 = imp('tests/psd/face.psd', at('face.ugo9')), i2 = imp('tests/procreate/scene.procreate', at('scene')), i3 = imp('tests/layers/png', at('pngs'));
const i4 = imp('tests/spine/rig.json', at('rig')), i5 = imp('samples/basic/model.ug9', at('back')), i6 = imp(at('a.ugo9'), at('again'));
const parts = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).parts.length;
await readUgo9(new Uint8Array(fs.readFileSync(at('face.ugo9')))).then((x) => fs.writeFileSync(at('face.json'), x.text));
check([i1, i2, i3, i4, i5, i6].every((r) => r.status === 0) && parts(at('face.json')) > 0 && parts(at('scene', 'model.json')) > 0 && parts(at('pngs', 'model.json')) > 0
  && parts(at('rig', 'model.json')) === 5 && parts(at('back', 'model.json')) === 16 && same(at('again', 'model.json'), 'samples/basic/model.json'),
  `import: PSD → .ugo9, Procreate, a folder of PNG, Spine (its .atlas found beside it), .ug9, .ugo9 (${[i1, i2, i3, i4, i5, i6].map((r) => r.status).join(',')})`);
fs.writeFileSync(at('x.svg'), '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
const sv = imp(at('x.svg'), at('svg'));
check(sv.status !== 0 && /editor/.test(sv.stderr), 'SVG: says to open it in the editor (it needs a browser to draw)');

// export
const e1 = cli('export', at('a.ugo9'), '--out', at('a.ug9')), e2 = cli('export', 'samples/basic', '--out', at('sp', 'x'), '--as', 'spine'), e3 = cli('export', 'samples/basic/model.json', '--out', at('a.html'));
check(e1.status === 0 && same(at('a.ug9'), 'samples/basic/model.ug9'), 'export a .ugo9 to .ug9: the same bytes as the sample\'s');
check(e2.status === 0 && fs.existsSync(at('sp', 'x.json')) && fs.existsSync(at('sp', 'x.atlas')) && e3.status === 0 && fs.readFileSync(at('a.html'), 'utf8').includes('<html'),
  'export to Spine (a folder and name) and to a Web page (from model.json: compiled beside its textures first)');
if (exe) {
  const e4 = cli('export', 'samples/basic/model.ug9', '--out', at('s.png'), '--as', 'sheet', '--', '--fps', '4'), e5 = cli('export', at('a.ugo9'), '--out', at('b.gif'), '--', '--frames', '3', '--fps', '3');
  check(e4.status === 0 && fs.existsSync(at('s.png')) && fs.existsSync(at('s.json')) && e5.status === 0 && fs.readFileSync(at('b.gif')).subarray(0, 3).toString() === 'GIF',
    'export a sheet (options after -- go to the exporter) and a GIF from a .ugo9');
} else console.log('skip sheet and GIF (no build/ugo_export)');

// info: how heavy, the same from a folder, a .ugo9 and a .ug9
{
  const i1 = cli('info', 'samples/basic'), i2 = cli('info', at('a.ugo9')), i3 = cli('info', 'samples/basic/model.ug9'), i4 = cli('info', 'samples/basic', '--json');
  check([i1, i2, i3].every((r) => r.status === 0) && i1.stdout === i2.stdout && i1.stdout === i3.stdout && /draws \(estimated\)/.test(i1.stdout) && JSON.parse(i4.stdout).stats.parts === 16,
    'info: the same from a folder, a .ugo9 and a .ug9 (and --json)');
}

// --target 1.0 (機能の比べ #13): a model with curve keys written for a 1.0 player moves the same
{
  const curved = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
  curved.animations[0].tracks[sp('AngleX')] = [[0, 0, 'bezier', 0.1, 0.9, 0.4, 1], [1.5, 10, 'bezier', 0.5, 0, 0.6, 1], [3, -6], [6, 0]];
  fs.mkdirSync(at('curved')); fs.writeFileSync(at('curved', 'model.json'), JSON.stringify(curved)); fs.copyFileSync('samples/basic/atlas.png', at('curved', 'atlas.png'));
  const t0 = cli('export', at('curved'), '--out', at('c10.ug9'), '--target', '1.0'), t1 = cli('export', at('curved'), '--out', at('c11.ug9'), '--target', '1.1');
  const minor = (f) => fs.readFileSync(f).readUInt16LE(6);
  check(t0.status === 0 && t1.status === 0 && minor(at('c10.ug9')) === 0 && minor(at('c11.ug9')) === 1 && /format 1\.0/.test(t0.stdout),
    `--target 1.0 writes a 1.0 file, --target 1.1 a 1.1 file (${t0.stdout.trim()} / ${t1.stdout.trim()})`);
  const { UgoRuntime } = await import('../web/ugo.js');
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync('web/ugo.wasm'), {})).instance.exports);
  const pose = (f) => { const m = rt.loadModel(fs.readFileSync(f)), inst = m.createInstance(), out = []; for (let t = 0; t <= 3; t += 0.25) { inst.reset(); inst.play('idle', t); inst.update(0); out.push(...inst.deformedPositions()); } return out; };
  const a = pose(at('c10.ug9')), b = pose(at('c11.ug9'));
  check(a.length === b.length && a.every((x, i) => x === b[i]), 'the 1.0 file moves the same as the 1.1 file (every vertex, bit for bit, through the curves)');
  const t2 = cli('export', at('curved'), '--out', at('x.ug9'), '--target', '0.9'), t3 = cli('export', at('curved'), '--out', at('x.html'), '--target', '1.0');
  check(t2.status === 2 && /1\.0, 1\.1/.test(t2.stderr) && t3.status === 2 && /--as ug9/.test(t3.stderr), '--target: a version it does not write, or not a .ug9: 2 and why');
}

// --light (利用者の声 #400 の 3): a lighter version beside the .ug9, its pages half the size, the same model
{
  fs.mkdirSync(at('light'));
  const l1 = cli('export', 'samples/basic', '--out', at('light', 'm.ug9'), '--light'), l2 = cli('export', 'samples/basic/model.ug9', '--out', at('light', 'q.ug9'), '--light', '0.25', '--target', '1.0');
  const { UgoRuntime } = await import('../web/ugo.js');
  const { decodePng } = await import('../tools/png.mjs');
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync('web/ugo.wasm'), {})).instance.exports);
  const half = decodePng(fs.readFileSync(at('light', 'atlas@0.5x.png'))), quarter = decodePng(fs.readFileSync(at('light', 'atlas@0.25x.png'))), full = decodePng(fs.readFileSync('samples/basic/atlas.png'));
  const lm = rt.loadModel(fs.readFileSync(at('light', 'm@0.5x.ug9'))), m = rt.loadModel(fs.readFileSync(at('light', 'm.ug9')));
  check(l1.status === 0 && half.width === full.width / 2 && lm.textures.join() === 'atlas@0.5x.png' && lm.vertexCount === m.vertexCount && lm.animations.length === m.animations.length,
    `--light: m@0.5x.ug9 beside m.ug9, its page ${half.width}×${half.height} (from ${full.width}×${full.height}), the same model (${lm.vertexCount} vertices, ${lm.animations.length} animations)`);
  check(l2.status === 0 && quarter.width === full.width / 4 && fs.readFileSync(at('light', 'q@0.25x.ug9')).readUInt16LE(6) === 0, '--light 0.25 from a .ug9 (its pictures beside it), with --target 1.0 for both');
  // a page over 4096 px: pointed out
  const big = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));
  fs.mkdirSync(at('big'));
  const { encodePng } = await import('../tools/png.mjs');
  fs.writeFileSync(at('big', 'atlas.png'), encodePng(4100, 8, new Uint8Array(4100 * 8 * 4)));
  fs.writeFileSync(at('big', 'model.json'), JSON.stringify(big));
  const b1 = cli('export', at('big'), '--out', at('big', 'b.ug9')), b2 = cli('export', 'samples/basic', '--out', at('light', 'x.html'), '--light');
  check(b1.status === 0 && /up to 4100 px/.test(b1.stdout) && /--light/.test(b1.stdout) && !/4096/.test(l1.stdout) && b2.status === 2 && /--light/.test(b2.stderr), 'pages over 4096 px are pointed out (not the sample\'s); --light with a Web page: 2');
}

// a wrong command line
const bad =[cli(), cli('pack'), cli('fly', 'samples/basic', '--out', at('z')), cli('export', 'samples/basic', '--out', at('z.zzz'))];
check(bad.slice(0, 3).every((r) => r.status === 2 && /usage/.test(r.stderr)) && bad[3].status === 2 && /--as/.test(bad[3].stderr), 'a wrong command line: 2 and the usage (or what to add)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall ugo9 command checks passed');
process.exit(failures ? 1 : 0);
