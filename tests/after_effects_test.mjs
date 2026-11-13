// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The After Effects script put with PNG frames (afterEffectsScript, web/encoders.js). After Effects
// itself is not here: the script runs against a stand-in for the parts of its scripting objects it
// uses (as Adobe's After Effects Scripting Guide describes them), and it must say what it does:
// import the frames as one sequence, straight alpha, the frame rate, a comp of the size, rate and
// length with them in it. Where the acorn parser is installed, the script also has to be ES3, the
// JavaScript ExtendScript runs (no let / const / arrows / template strings).
//   node tests/after_effects_test.mjs
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { afterEffectsScript, afterEffectsLayersScript, fcpXml, createWriter } from '../web/encoders.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

function run(src, opts = {}) {
  const { framesThere = true } = opts;
  const calls = [], alerts = [];
  class FileStub { constructor(p) { this.fsName = p; this.exists = framesThere || !p.endsWith('.png'); this.parent = { fsName: '/work/export' }; } }
  const footage = { name: '', mainSource: {} }, made = [];
  const comp = { layers: { add: (f) => { calls.push(['layers.add', f === footage || made.includes(f)]); const l = { source: f, name: '', blendingMode: null, transform: { opacity: { setValue: (v) => { l.opacity = v; } } } }; comp.stack.unshift(l); return l; },
    addNull: () => { const effects = [], l = { name: '', effects, property: (n) => (n === 'ADBE Effect Parade' ? { addProperty: (kind) => { const e = { kind, name: '', keys: null, property: (pn) => ({ setValuesAtTimes: (t, v) => { e.keys = { prop: pn, t, v }; } }) }; effects.push(e); return e; } } : null) }; calls.push(['addNull']); comp.nulls.push(l); return l; } },
    stack: [], nulls: [], openInViewer: () => calls.push(['openInViewer']) };
  const sandbox = {
    $: { fileName: '/work/export/import_to_after_effects.jsx' },
    File: function (p) { return new FileStub(p); },
    ImportOptions: function (file) { this.file = file; calls.push(['ImportOptions', file.fsName]); },
    AlphaMode: { STRAIGHT: 'STRAIGHT', PREMULTIPLIED: 'PREMULTIPLIED', IGNORE: 'IGNORE' },
    BlendingMode: Object.fromEntries(['NORMAL', 'MULTIPLY', 'SCREEN', 'ADD', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DARKEN', 'LIGHTEN', 'DIFFERENCE', 'COLOR_DODGE', 'COLOR_BURN', 'EXCLUSION', 'SUBTRACT'].map((k) => [k, `BM_${k}`])),
    alert: (m) => alerts.push(m),
    app: {
      beginUndoGroup: (n) => calls.push(['beginUndoGroup', n]), endUndoGroup: () => calls.push(['endUndoGroup']),
      project: {
        importFile: (io) => { calls.push(['importFile', io.sequence, io.forceAlphabetical, io.file.fsName]); if (!made.length && !opts.many) return footage; const f = { name: '', mainSource: {} }; made.push(f); return f; },
        items: { addComp: (...a) => { calls.push(['addComp', ...a]); return comp; }, addFolder: (n) => { calls.push(['addFolder', n]); return { name: n }; } },
      },
    },
  };
  sandbox.File.prototype = FileStub.prototype;
  vm.runInNewContext(src, sandbox);
  return { calls, alerts, footage, comp, made };
}

const src = afterEffectsScript({ name: 'mira_wave', width: 1920, height: 1080, fps: 29.97, frames: 90 });
{
  const { calls, alerts, footage } = run(src), find = (k) => calls.find((c) => c[0] === k);
  check(!alerts.length && find('ImportOptions')?.[1] === '/work/export/frame_00000.png' && find('importFile')?.[1] === true && find('importFile')?.[2] === true,
    'the frames next to the script are imported as one sequence (in name order)');
  check(footage.mainSource.alphaMode === 'STRAIGHT' && footage.mainSource.conformFrameRate === 29.97 && footage.name === 'mira_wave (frames)', 'straight alpha (as PNG keeps it), the frame rate 29.97');
  const add = find('addComp');
  check(add && add[1] === 'mira_wave' && add[2] === 1920 && add[3] === 1080 && add[4] === 1 && Math.abs(add[5] - 90 / 29.97) < 1e-9 && add[6] === 29.97 && find('layers.add')?.[1] === true,
    `a comp of the size, square pixels, 90 frames long at 29.97 fps, the frames in it (${add?.slice(1).join(', ')})`);
  check(calls[0][0] === 'beginUndoGroup' && calls.at(-1)[0] === 'endUndoGroup', 'one undo step');
}
{
  const { calls, alerts } = run(src, { framesThere: false });
  check(alerts.length === 1 && /next to this script/.test(alerts[0]) && !calls.some((c) => c[0] === 'importFile'), `no frames next to it: it says so and does nothing ("${alerts[0]}")`);
}
{
  const odd = afterEffectsScript({ name: 'a "quoted" \\ name\n', width: 10, height: 10, fps: 24, frames: 1 });
  const { calls } = run(odd);
  check(calls.find((c) => c[0] === 'addComp')?.[1] === 'a "quoted" \\ name\n', 'a name with quotes, a backslash and a new line stays as it is');
}
{
  const ja = afterEffectsScript({ name: '揺れる髪', width: 10, height: 10, fps: 24, frames: 1 });
  check(/^[\x00-\x7f]*$/.test(ja) && run(ja).calls.find((c) => c[0] === 'addComp')?.[1] === '揺れる髪', 'a Japanese name: the script is ASCII only (\\u escapes) and the comp gets the name as it is');
}
// part groups as layers: one comp, a layer per group in drawing order, blend modes and opacity
const groups = [{ name: '体' }, { name: '影', blend: 'multiply', opacity: 0.6 }, { name: '光', blend: 'screen' }, { name: 'メモ', blend: 'pinLight' }];
const layered = afterEffectsLayersScript({ name: 'mira', width: 800, height: 600, fps: 30, frames: 60, layers: groups });
{
  const { calls, alerts, comp, made } = run(layered, { many: true });
  const imports = calls.filter((c) => c[0] === 'importFile');
  check(!alerts.length && imports.length === 4 && imports.every((c) => c[1] === true) && imports[0][3] === '/work/export/01_体/frame_00000.png',
    `each group's folder imported as a sequence (${imports.map((c) => c[3].split('/').slice(-2, -1)[0]).join(', ')})`);
  check(comp.stack.map((l) => l.name).join() === 'メモ,光,影,体' && made.every((f) => f.mainSource.alphaMode === 'STRAIGHT' && f.mainSource.conformFrameRate === 30),
    `in the comp the first group is at the bottom (top to bottom: ${comp.stack.map((l) => l.name).join(', ')}), straight alpha, 30 fps`);
  const by = (n) => comp.stack.find((l) => l.name === n);
  check(by('影').blendingMode === 'BM_MULTIPLY' && by('影').opacity === 60 && by('光').blendingMode === 'BM_SCREEN' && by('体').opacity === 100 && by('メモ').blendingMode === 'BM_NORMAL',
    'blend modes (multiply, screen; one After Effects lacks: normal) and opacity 60 %');
  check(by('影').preserveTransparency === true && by('光').preserveTransparency === true && !by('体').preserveTransparency && !by('メモ').preserveTransparency,
    'multiply and screen keep the transparency below (as Ugo9 draws them: they add no alpha); normal layers do not');
  const lowest = run(afterEffectsLayersScript({ name: 'm', width: 8, height: 8, fps: 24, frames: 2, layers: [{ name: 'glow', blend: 'add' }, { name: 'body' }] }), { many: true }).comp;
  check(!lowest.stack.find((l) => l.name === 'glow').preserveTransparency && lowest.stack.find((l) => l.name === 'glow').blendingMode === 'BM_ADD', 'a blend on the lowest layer: no keep-transparency (nothing below it to keep)');
  const movies = run(afterEffectsLayersScript({ name: 'm', width: 8, height: 8, fps: 24, frames: 2, layers: groups, movies: true }), { many: true }).calls.filter((c) => c[0] === 'importFile');
  check(movies.every((c) => c[1] !== true) && movies[0][3] === '/work/export/01_体.mov', 'with movies: each group\'s .mov, not a sequence');
}
// Final Cut Pro 7 XML for Premiere and DaVinci Resolve: well-formed, a track per group, bottom first
{
  const xml = fcpXml({ name: 'mira & co', width: 800, height: 600, fps: 29.97, frames: 60, layers: groups });
  let parsed = null;
  try {
    parsed = JSON.parse(execFileSync('python3', ['-c', `import sys, json, xml.etree.ElementTree as E
r = E.fromstring(sys.stdin.read())
s = r.find('sequence')
print(json.dumps({ 'v': r.get('version'), 'name': s.findtext('name'), 'ntsc': s.findtext('rate/ntsc'), 'tb': s.findtext('rate/timebase'), 'w': s.findtext('media/video/format/samplecharacteristics/width'),
  'tracks': [[t.findtext('clipitem/name'), t.findtext('clipitem/compositemode'), t.findtext('clipitem/file/pathurl'), t.findtext('clipitem/filter/effect/parameter/value')] for t in s.findall('media/video/track')] }))`], { input: xml, encoding: 'utf8' }));
  } catch (e) { console.log(`     (python3 could not read it: ${String(e).split('\n')[0]})`); }
  check(parsed && parsed.v === '4' && parsed.name === 'mira & co' && parsed.ntsc === 'TRUE' && parsed.tb === '30' && parsed.w === '800' && parsed.tracks.map((t) => t[0]).join() === '体,影,光,メモ'
    && parsed.tracks[1][1] === 'multiply' && parsed.tracks[1][3] === '60' && parsed.tracks[0][2] === '01_%E4%BD%93/frame_00000.png',
    `FCP 7 XML: well-formed, 29.97 as 30 NTSC, a track per group bottom first, multiply and opacity 60 on 影 (${parsed?.tracks.map((t) => t.join(':')).join(' / ')})`);
}
// the motion (利用者の声 #17): a null layer with a slider per parameter and a point per point, keyed on every frame
const moving = afterEffectsScript({ name: 'mira', width: 100, height: 100, fps: 4, frames: 3, motion: { params: [{ name: 'MouthOpen', values: [0, 0.123456, 1] }, { name: '口', values: [1, 2, 3] }], points: [{ name: 'handR', values: [[10, 20], [11.5, 21], [12, 22]] }] } });
{
  const { comp, alerts } = run(moving), n = comp.nulls[0], fx = n?.effects || [];
  const slider = fx.find((e) => e.name === 'MouthOpen'), ja = fx.find((e) => e.name === '口'), point = fx.find((e) => e.name === 'handR');
  check(!alerts.length && n.name === 'Ugo9 motion' && slider?.kind === 'ADBE Slider Control' && slider.keys.prop === 'ADBE Slider Control-0001' && JSON.stringify(slider.keys.t) === '[0,0.25,0.5]' && JSON.stringify(slider.keys.v) === '[0,0.1235,1]',
    `the motion: a null layer "Ugo9 motion", a slider MouthOpen keyed at 0, 0.25, 0.5 s with 0, 0.1235, 1 (4 places)`);
  check(ja?.kind === 'ADBE Slider Control' && point?.kind === 'ADBE Point Control' && point.keys.prop === 'ADBE Point Control-0001' && JSON.stringify(point.keys.v) === '[[10,20],[11.5,21],[12,22]]' && /^[\x00-\x7f]*$/.test(moving),
    'a Japanese name (the script stays ASCII), a point control for handR with its places');
  check(run(src).comp.nulls.length === 0, 'without motion: no null layer (as before)');
}
// the png-zip writer: add(rgba, motion) gathers each frame's values; a frame without one keeps the one before
{
  const w = await createWriter('png-zip', 4, 4, 10, { name: 'x' });
  await w.add(new Uint8Array(64), { params: { A: 0.5 }, points: { p: [1, 2] } });
  await w.add(new Uint8Array(64));
  await w.add(new Uint8Array(64), { params: { A: 1 } });
  const txt = new TextDecoder('latin1').decode(new Uint8Array(await (await w.finish()).arrayBuffer()));
  check(/\["A", \[0\.5,0\.5,1\]\]/.test(txt) && /\["p", \[\[1,2\],\[1,2\],\[1,2\]\]\]/.test(txt), 'the PNG ZIP writer: each frame\'s values with add(rgba, motion) into the script; a frame without one keeps the one before');
}

let acorn = null;
try { acorn = createRequire('/opt/node-tools/node_modules/')('acorn'); } catch { try { acorn = createRequire(import.meta.url)('acorn'); } catch { /* not installed */ } }
if (acorn) {
  let err = '';
  try { acorn.parse(src, { ecmaVersion: 3 }); acorn.parse(layered, { ecmaVersion: 3 }); acorn.parse(moving, { ecmaVersion: 3 }); } catch (e) { err = e.message; }
  check(!err, `ES3, as ExtendScript runs it${err ? ` (${err})` : ''}`);
} else console.log('     (acorn is not installed: the ES3 check is skipped)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall After Effects script checks passed');
process.exit(failures ? 1 : 0);
