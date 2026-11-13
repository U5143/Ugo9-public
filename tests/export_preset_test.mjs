// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Export presets (web/export_preset.js and ugo_export --preset, 利用者の声 #25): read, written
// again with unknown fields kept, bad values dropped with notes, turned into the editor's export
// options; the camera functions match ugo_export --camera; ugo_export reads the same JSON and
// options written after --preset win. Settings per animation (perAnim, 利用者の声 #25「ループをシーンごとに決められない」):
// read, kept and written again; presetToExportOptions(preset, anim) puts them over the rest (loops as seconds, skip as
// null); ugo_export with eachAnim writes each animation with its own (skip: not written), the same bytes as the flags.
//   node tests/export_preset_test.mjs        (the ugo_export part needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readExportPreset, writeExportPreset, presetToExportOptions, presetFileName, cameraAt, cameraTransform, frameSize } from '../web/export_preset.js';
import { findExporter } from '../tools/compare_frames.mjs';
import { sp } from './sample_names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_preset_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);

// ---- reading and writing ----
const full = {
  ugo9ExportPreset: 1, name: 'PV 1080p 60', formats: ['webm-alpha', 'png-zip'], fps: 60, size: { width: 1920, height: 1080 },
  background: null, anim: 'idle', seconds: 4, pinned: { [sp('AngleX')]: 10 }, fileName: '{doc}_{anim}_{fps}',
  camera: [{ t: 0, zoom: 1 }, { t: 2, zoom: 2.5, x: 0, y: -420 }],
};
{
  const { preset, notes } = readExportPreset(JSON.stringify(full));
  check(same(preset, full) && notes.length === 0, 'a full preset reads as written, no notes');
  const withFuture = { ...full, loopCount: 3, future: { a: [1, 2] } };
  const again = readExportPreset(writeExportPreset(readExportPreset(withFuture).preset)).preset;
  check(same(again, withFuture), 'fields this version does not know are kept when written again (loopCount, future)');
  const text = writeExportPreset({ fps: 30, name: 'x' });
  check(text.startsWith('{\n  "ugo9ExportPreset": 1,\n  "name": "x",\n  "fps": 30'), 'written: the version first, then the known fields in a fixed order');
  check(same(readExportPreset({ ugo9ExportPreset: 1 }), { preset: { ugo9ExportPreset: 1 }, notes: [] }), 'only the version: everything else may be left out');
  const sp = readExportPreset({ ugo9ExportPreset: 1, sampling: 'nearest' }), spBad = readExportPreset({ ugo9ExportPreset: 1, sampling: 'blurry' });
  check(sp.preset.sampling === 'nearest' && presetToExportOptions(sp.preset).sampling === 'nearest' && !('sampling' in spBad.preset) && spBad.notes[0]?.kind === 'presetBadValue',
    '"sampling": "nearest" reads and goes to the options (the renderer\'s setSampling); "blurry" is dropped with a note');
  const nw = readExportPreset({ ugo9ExportPreset: 1, formats: ['jpeg', 'gif'], jpegQuality: 75, region: { x: -10, y: -20.5, width: 30, height: 40, z: 1 }, eachAnim: true, holdFrames: 2, seamless: true, seamlessLoops: 80 });
  const o = presetToExportOptions(nw.preset);
  check(!nw.notes.length && nw.preset.formats.join() === 'jpeg,gif' && o.jpegQuality === 75 && same(o.region, { x: -10, y: -20.5, width: 30, height: 40 }) && o.eachAnim === true && o.holdFrames === 2 && o.seamless === true && o.seamlessLoops === 80,
    'jpeg, jpegQuality, region (model pixels), eachAnim, holdFrames, seamless and seamlessLoops read and go to the options');
  const bd = readExportPreset({ ugo9ExportPreset: 1, backdrop: { file: 'bg.png', x: -10, y: -20, width: 30, height: 40, z: 1 } }), bs = readExportPreset({ ugo9ExportPreset: 1, backdrop: '背景.png' });
  const bx = readExportPreset({ ugo9ExportPreset: 1, backdrop: { file: 'bg.png', x: 0, y: 0, width: 5 } }), bn = readExportPreset({ ugo9ExportPreset: 1, backdrop: { x: 0 } });
  check(same(presetToExportOptions(bd.preset).backdrop, { file: 'bg.png', x: -10, y: -20, width: 30, height: 40 }) && presetToExportOptions(bs.preset).backdrop === '背景.png' && !('backdrop' in bx.preset) && !('backdrop' in bn.preset) && bx.notes.length === 1,
    'backdrop: a file name, or with where it lies (model pixels), to the options; a part of the rectangle or no file: dropped with a note');
  const nb = readExportPreset({ ugo9ExportPreset: 1, jpegQuality: 0, region: { x: 0, y: 0, width: 0, height: 1 }, eachAnim: 'yes', holdFrames: 13, seamless: 1, seamlessLoops: 0 });
  check(['jpegQuality', 'region', 'eachAnim', 'holdFrames', 'seamless', 'seamlessLoops'].every((k) => !(k in nb.preset)) && nb.notes.length === 6, 'out of range or of the wrong kind: each dropped with a note');
}
{
  const { preset, notes } = readExportPreset({
    ugo9ExportPreset: 1, fps: 0, size: { width: -1, height: 10 }, background: 'red', formats: ['gif', 'xyz', 'gif'],
    pinned: { A: 1, B: 'x' }, camera: [{ t: 1, zoom: 2 }, { t: -1, zoom: 1 }, { t: 0, zoom: 1, x: 3 }, { t: 0.5, zoom: 4, x: 1, y: 2 }], fileName: 'a/b', seconds: 2,
  });
  check(!('fps' in preset) && !('size' in preset) && !('background' in preset) && !('fileName' in preset) && preset.seconds === 2,
    'values that do not read are dropped (fps 0, a negative size, "red", a file name with /); the rest is read');
  check(same(preset.formats, ['gif']) && same(preset.pinned, { A: 1 }) && same(preset.camera, [{ t: 0.5, zoom: 4, x: 1, y: 2 }, { t: 1, zoom: 2 }]),
    'lists keep what reads: formats [gif], pinned {A}, camera keys sorted by time without the bad ones');
  check(notes.every((n) => n.kind === 'presetBadValue') && notes.length === 8, `a note for each dropped value (${notes.length}: ${notes.map((n) => n.message).join('; ')})`);
}
{
  const newer = readExportPreset({ ugo9ExportPreset: 2, fps: 24, other: 1 });
  check(newer.preset.fps === 24 && newer.preset.other === 1 && newer.notes[0]?.kind === 'presetNewer', 'a newer version: what is known is read, the rest kept, with a note');
  const not = readExportPreset({ fps: 24 });
  check(same(not.preset, { ugo9ExportPreset: 1 }) && not.notes[0]?.kind === 'presetNotPreset', 'no version: not a preset (empty, with a note)');
  let err = '';
  try { readExportPreset('{ fps: '); } catch (e) { err = e.message; }
  check(/not an export preset/.test(err), 'text that is not JSON: a clear error');
}

// ---- options for the editor ----
{
  const o = presetToExportOptions(readExportPreset({ ...full, scale: 2, background: '#FF8000' }).preset);
  check(o.size === 'frame:1920x1080' && !('scale' in o) && close(o.background, [1, 128 / 255, 0]) && o.pinned instanceof Map && o.pinned.get(sp('AngleX')) === 10 && o.fps === 60 && same(o.formats, full.formats),
    'options for exportAnimation: size frame:1920x1080 (the size wins over the scale), background in 0..1, pinned as a Map');
  check(presetToExportOptions({ ugo9ExportPreset: 1, size: { long: 3840 } }).size === 'long:3840' && presetToExportOptions({ ugo9ExportPreset: 1, scale: 0.5 }).size === 0.5,
    'size { long } -> long:3840; a scale alone -> size 0.5');
  check(same(presetToExportOptions({ ugo9ExportPreset: 1 }), {}) && presetToExportOptions({ ugo9ExportPreset: 1, background: null }).background === null, 'only what the preset says (nothing -> {}; background null stays transparent)');
  check(presetFileName('{doc}_{anim}_{fps}', { doc: 'face', anim: 'idle', fps: 60 }) === 'face_idle_60' && presetFileName(undefined, { doc: 'a:b', anim: '' }) === 'a_b_still',
    'file names: {doc}_{anim}_{fps} -> face_idle_60; the default {doc}_{anim}, still without an animation, : becomes _');
}

// ---- the camera ----
{
  const canvas = [420, 600, 210, 590], out = { w: 420, h: 600 };
  check(close(cameraTransform(out, canvas, null, [], 0), [1, 0, 0, 1, 210, 590]), 'no keys: the canvas fitted as without a camera');
  check(close(cameraTransform(out, { width: 420, height: 600, originX: 210, originY: 590 }, null, [{ t: 0, zoom: 2 }], 0), [2, 0, 0, 2, 210, 880]),
    'zoom 2 about the middle (model point 0,-290 stays in the middle; the JSON canvas reads the same)');
  const keys = [{ t: 0, zoom: 1 }, { t: 2, zoom: 4, x: 10, y: -300 }];
  const c = cameraAt(keys, 1, [0, -290]);
  check(Math.abs(c.zoom - 2) < 1e-12 && Math.abs(c.x - 5) < 1e-12 && Math.abs(c.y + 295) < 1e-12, `halfway: zoom 2 (log scale), the point halfway (${c.zoom}, ${c.x}, ${c.y})`);
  const q = cameraAt(keys, 0.5, [0, -290]), u = 0.25 * 0.25 * (3 - 0.5);
  check(Math.abs(q.x - 10 * u) < 1e-12 && Math.abs(q.zoom - 4 ** u) < 1e-12, 'a quarter of the way: eased (smoothstep), as ugo_export');
  check(same(cameraAt(keys, -1, [0, -290]), { zoom: 1, x: 0, y: -290 }) && same(cameraAt(keys, 9, [0, -290]), { zoom: 4, x: 10, y: -300 }), 'before the first key and after the last: held');
  const ck = [{ t: 0, zoom: 1 }, { t: 1, zoom: 4, x: 10, y: -300, cut: true }];
  check(same(cameraAt(ck, 0.99, [0, -290]), { zoom: 1, x: 0, y: -290 }) && same(cameraAt(ck, 1, [0, -290]), { zoom: 4, x: 10, y: -300 }), 'a cut key: held before it, its own value from its time on (no easing in)');
  const rc = readExportPreset({ ugo9ExportPreset: 1, camera: [{ t: 0, zoom: 1 }, { t: 1, zoom: 2, cut: true }, { t: 2, zoom: 3, cut: 'yes' }] });
  check(JSON.stringify(rc.preset.camera) === '[{"t":0,"zoom":1},{"t":1,"zoom":2,"cut":true}]' && rc.notes.length === 1, 'presets keep "cut": true; a cut that is not true or false is dropped with a note');
  const fit = frameSize([420, 600], 'frame:1920x1080'), fout = { w: fit.w, h: fit.h };
  const m = cameraTransform(fout, canvas, fit, [{ t: 0, zoom: 1 }], 0);
  check(close(m, [fit.s, 0, 0, fit.s, 210 * fit.s + fit.dx, 590 * fit.s + fit.dy]), 'zoom 1 with frameSize (frame:1920x1080): the same transform exportAnimation sets without the camera');
  const lf = frameSize([420, 600], 'long:300'), lm = cameraTransform({ w: lf.w, h: lf.h }, canvas, lf, [{ t: 0, zoom: 2 }], 0);
  check(close(lm, [1, 0, 0, 1, 105 + 0 * 1, 150 + 290 * 1]), `zoom 2 with frameSize long:300 (s 0.5): the middle model point 0,-290 stays in the middle (${lm.map((v) => +v.toFixed(3)).join(', ')})`);
}

// ---- ugo_export --preset ----
const exe = findExporter();
if (!exe) console.log('skip the ugo_export part: build/ugo_export not built');
else {
  const MODEL = path.join(ROOT, 'samples/basic/model.ug9');
  let n = 0;
  const run = (args) => {
    const out = path.join(OUT, `r${n++}.rgba`);
    const r = spawnSync(exe, [MODEL, ...args, '--format', 'raw', '--out', out], { encoding: 'utf8' });
    return { code: r.status, err: r.stderr, bytes: r.status === 0 ? fs.readFileSync(out) : null };
  };
  const preset = (obj) => { const f = path.join(OUT, `p${n++}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : writeExportPreset(obj)); return f; };
  const size = (args) => { // -> [w, h] of the first PNG
    const dir = path.join(OUT, `d${n++}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    execFileSync(exe, [MODEL, '--frames', '1', ...args, '--format', 'frames', '--out', dir], { stdio: 'ignore' });
    const b = fs.readFileSync(path.join(dir, 'frame_00000.png'));
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };

  const p1 = preset({ ugo9ExportPreset: 1, fps: 2, seconds: 1.5, anim: 'talk', background: '#336699', pinned: { [sp('AngleX')]: 20 }, camera: [{ t: 0, zoom: 1 }, { t: 1, zoom: 2, x: 0, y: -400 }], size: { width: 210, height: 300 }, name: 'n', formats: ['gif'], fileName: 'x', future: { a: 1 } });
  const a = run(['--preset', p1]);
  const b = run(['--anim', 'talk', '--fps', '2', '--seconds', '1.5', '--bg', '#336699', '--param', `${sp('AngleX')}=20`, '--camera', '0:1', '--camera', '1:2:0,-400', '--size', '210x300']);
  check(a.code === 0 && b.code === 0 && Buffer.compare(a.bytes, b.bytes) === 0 && a.bytes.length === 210 * 300 * 4 * 3 && !/preset:/.test(a.err),
    `--preset gives the same bytes as the same options written out (3 frames of 210×300; name, formats, fileName and unknown fields skipped quietly)`);

  const pc = preset({ ugo9ExportPreset: 1, fps: 2, seconds: 1.5, camera: [{ t: 0, zoom: 1 }, { t: 0.5, zoom: 3, cut: true }] });
  const cp = run(['--preset', pc, '--size', '105x150']), cc = run(['--fps', '2', '--seconds', '1.5', '--camera', '0:1', '--camera', '0.5:3:cut', '--size', '105x150']);
  check(cp.code === 0 && Buffer.compare(cp.bytes, cc.bytes) === 0, 'a preset\'s cut gives the same bytes as --camera T:ZOOM:cut');
  const c = run(['--preset', p1, '--fps', '4', '--camera', '0:1', '--size', '105x150']);
  check(c.code === 0 && c.bytes.length === 105 * 150 * 4 * 6, `options after --preset win (fps 4 -> 6 frames, size 105×150; ${c.bytes ? c.bytes.length / (105 * 150 * 4) : '-'} frames)`);
  const d = run(['--fps', '4', '--preset', p1]);
  check(d.code === 0 && d.bytes.length === 210 * 300 * 4 * 3, 'options before --preset: the preset wins (fps 2 -> 3 frames)');

  check(same(size(['--preset', preset({ ugo9ExportPreset: 1, size: { long: 300 } })]), [210, 300]) && same(size(['--preset', preset({ ugo9ExportPreset: 1, scale: 0.5 })]), [210, 300]) && same(size(['--preset', preset({ ugo9ExportPreset: 1, scale: 0.5, size: { long: 120 } })]), [84, 120]),
    'size { long: 300 } and scale 0.5 -> 210×300 for the 420×600 canvas; a size wins over a scale (long 120 -> 84×120)');

  const bad = run(['--frames', '1', '--preset', preset({ ugo9ExportPreset: 1, fps: 999, background: 'red', camera: [{ t: -1, zoom: 2 }], pinned: { [sp('AngleX')]: 'x' } })]);
  check(bad.code === 0 && (bad.err.match(/preset: dropped/g) || []).length === 4, `values that do not read: skipped with a line each, the export still runs (${bad.err.trim().split('\n').length} lines)`);
  const newer = run(['--frames', '1', '--preset', preset({ ugo9ExportPreset: 2, fps: 10, more: [1, { b: 'あ😀' }] })]);
  check(newer.code === 0 && /newer version/.test(newer.err), 'a newer version: read with a line on stderr (unknown fields with escapes and arrays skipped)');
  for (const [label, text] of [['not JSON', '{ "ugo9ExportPreset": 1, '], ['no version', '{ "fps": 30 }'], ['a list', '[1, 2]']]) {
    const r = run(['--frames', '1', '--preset', preset(text)]);
    check(r.code === 2 && /not an export preset/.test(r.err), `${label}: refused with exit 2 (${r.err.trim()})`);
  }
  const unicode = run(['--frames', '1', '--preset', preset('﻿{ "ugo9ExportPreset": 1, "anim": "t\\u0061lk" }')]);
  const talk = run(['--frames', '1', '--anim', 'talk']);
  check(unicode.code === 0 && Buffer.compare(unicode.bytes, talk.bytes) === 0, 'a BOM and \\u escapes in names read (anim "t\\u0061lk" is talk)');
}

// settings per animation (perAnim)
{
  const raw = { ugo9ExportPreset: 1, fps: 30, seconds: 4, seamless: false, perAnim: { idle: { loops: 3, seamless: true, later: 1 }, walk: { seconds: 2.5, holdFrames: 2, fps: 500 }, jump: { skip: true }, x: 5 } };
  const { preset, notes } = readExportPreset(raw);
  check(same(preset.perAnim, { idle: { loops: 3, seamless: true, later: 1 }, walk: { seconds: 2.5, holdFrames: 2 }, jump: { skip: true } }) && notes.length === 2 && same(readExportPreset(writeExportPreset(preset)).preset, preset),
    `perAnim read (a setting not known kept; ${notes.map((x) => x.message).join('; ')}) and written again the same`);
  const idle = presetToExportOptions(preset, 'idle', { duration: 2 }), walk = presetToExportOptions(preset, 'walk', { duration: 2 }), other = presetToExportOptions(preset, 'other', { duration: 2 });
  check(idle.anim === 'idle' && idle.seconds === 6 && idle.seamless === true && walk.seconds === 2.5 && walk.holdFrames === 2 && walk.fps === 30 && walk.seamless === false
    && presetToExportOptions(preset, 'jump') === null && other.anim === 'other' && other.seconds === 4 && presetToExportOptions(preset, 'idle').loops === 3 && !('seconds' in presetToExportOptions(preset, 'idle')),
    'presetToExportOptions(preset, anim): its own over the rest (3 loops of 2 s: 6 s), skip: null, without its length: loops passed on, another: the rest');
}
if (exe) {
  const MODEL = path.join(ROOT, 'samples/basic/model.ug9'), dir = path.join(OUT, 'per'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const p = path.join(dir, 'p.json');
  fs.writeFileSync(p, writeExportPreset({ ugo9ExportPreset: 1, fps: 10, seconds: 1, eachAnim: true, perAnim: { idle: { loops: 0.5, holdFrames: 2 }, talk: { skip: true } } }));
  const go = (args) => spawnSync(exe, [MODEL, '--size', '42x60', '--ss', '1', ...args], { encoding: 'utf8' });
  const r = go(['--preset', p, '--format', 'raw', '--out', path.join(dir, '{anim}.rgba')]);
  const flags = go(['--anim', 'idle', '--fps', '10', '--seconds', '3', '--hold', '2', '--format', 'raw', '--out', path.join(dir, 'flags.rgba')]);
  const idle = fs.existsSync(path.join(dir, 'idle.rgba')) && fs.readFileSync(path.join(dir, 'idle.rgba'));
  check(r.status === 0 && flags.status === 0 && idle && idle.equals(fs.readFileSync(path.join(dir, 'flags.rgba'))) && idle.length === 42 * 60 * 4 * 30 && !fs.existsSync(path.join(dir, 'talk.rgba')) && /talk: skipped/.test(r.stderr),
    "ugo_export with eachAnim: idle with its own (half a loop of 6 s, 2-frame holds): the same bytes as the flags; talk skipped (said)");
  const later = go(['--preset', p, '--seconds', '0.5', '--format', 'raw', '--out', path.join(dir, 'later_{anim}.rgba')]), before = go(['--seconds', '0.5', '--preset', p, '--format', 'raw', '--out', path.join(dir, 'before_{anim}.rgba')]);
  check(later.status === 0 && fs.statSync(path.join(dir, 'later_idle.rgba')).size === 42 * 60 * 4 * 5 && before.status === 0 && fs.statSync(path.join(dir, 'before_idle.rgba')).size === 42 * 60 * 4 * 30,
    '--seconds after the preset wins over its perAnim; before it, the perAnim wins');
  fs.writeFileSync(path.join(dir, 'q.json'), writeExportPreset({ ugo9ExportPreset: 1, fps: 10, anim: 'talk', perAnim: { talk: { loops: 2 } } }));
  const single = go(['--preset', path.join(dir, 'q.json'), '--format', 'raw', '--out', path.join(dir, 'single.rgba')]);
  check(single.status === 0 && fs.statSync(path.join(dir, 'single.rgba')).size === 42 * 60 * 4 * 40, 'one animation (the preset\'s anim): its own settings too (talk, 2 loops of 2 s at 10 fps: 40 frames)');
}

// the backdrop from a preset (beside the preset file; with where it lies): the same bytes as --backdrop
if (exe) {
  const { encodePng } = await import('../tools/png.mjs');
  const dir = path.join(OUT, 'bd'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const pic = new Uint8Array(8 * 8 * 4); for (let i = 0; i < 64; i++) pic.set([i * 4, 255 - i * 4, 90, 255], i * 4);
  fs.writeFileSync(path.join(dir, '背景.png'), encodePng(8, 8, pic));
  const MODEL = path.join(ROOT, 'samples/basic/model.ug9'), go = (args, name) => { const out = path.join(dir, name); const r = spawnSync(exe, [MODEL, '--frames', '1', '--size', '105x150', ...args, '--format', 'raw', '--out', out], { encoding: 'utf8' }); return r.status === 0 ? fs.readFileSync(out) : Buffer.from(r.stderr); };
  fs.writeFileSync(path.join(dir, 'p1.json'), writeExportPreset({ ugo9ExportPreset: 1, backdrop: '背景.png' }));
  fs.writeFileSync(path.join(dir, 'p2.json'), writeExportPreset({ ugo9ExportPreset: 1, backdrop: { file: '背景.png', x: -100, y: -500, width: 200, height: 260 } }));
  const a1 = go(['--preset', path.join(dir, 'p1.json')], 'a1'), b1 = go(['--backdrop', path.join(dir, '背景.png')], 'b1');
  const a2 = go(['--preset', path.join(dir, 'p2.json')], 'a2'), b2 = go(['--backdrop', `${path.join(dir, '背景.png')}:-100,-500,200,260`], 'b2');
  const later = go(['--preset', path.join(dir, 'p1.json'), '--backdrop', `${path.join(dir, '背景.png')}:-100,-500,200,260`], 'c1');
  check(a1.equals(b1) && a2.equals(b2) && !a1.equals(a2) && later.equals(b2), 'a preset\'s backdrop (the file beside the preset, with or without where it lies): the same bytes as --backdrop; --backdrop after the preset wins');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall export preset checks passed');
process.exit(failures ? 1 : 0);
