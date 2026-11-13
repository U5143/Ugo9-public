// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animations onto a model whose parameter ids differ (the users' request sheet, 11/10; tools/param_map.mjs and
// copy_animation's paramMap): the suggestions find the same id, the standard and older names (EyeBallX → PupilX),
// "Param" in front (ParamAngleX → AngleX → HeadTurnX), the same letters (mouth_open → MouthOpen) and a near spelling
// (MouthOpne), leave the rest unmatched, and give each target once; copied with a map, a track goes to its new id with
// its values carried from one range to the other (-30..30 → -45..45: 10 becomes 15, the curve's handles with it);
// null leaves one out quietly; 'auto' is the same as the suggestions; two tracks onto one id: the first kept, said;
// the command line takes --map, --map-file and --auto-map. The editor imports both files in the browser: nothing
// they load imports node: at the top (the command line reads node:fs only when it runs).
//   node tests/param_map_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { suggestParamMap } from '../tools/param_map.mjs';
import { copyAnimations } from '../tools/copy_animation.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const P = (id, min = -1, max = 1, def = 0) => ({ id, min, max, default: def });
const from = {
  canvas: { width: 400, height: 600 },
  parameters: [P('ParamAngleX', -30, 30), P('EyeBallX'), P('mouth_open', 0, 1), P('BrowY'), P('MouthOpne', 0, 1), P('Tail')],
  bones: [{ id: 'root' }],
  animations: [{ id: 'nod', duration: 1, tracks: { ParamAngleX: [[0, 0, 'bezier', 0.3, 5, 0.7, 10], [1, 10]], EyeBallX: [[0, 0], [1, 1]], mouth_open: [[0, 0], [1, 1]], BrowY: [[0, 0], [1, 0.5]], Tail: [[0, 0], [1, 1]] } }],
};
const to = { canvas: { width: 400, height: 600 }, parameters: [P('HeadTurnX', -45, 45), P('PupilX'), P('MouthOpen', 0, 1), P('BrowY'), P('Mouth0pen', 0, 1)], bones: [{ id: 'root' }], animations: [] };

const s = suggestParamMap(from, to);
check(s.map.ParamAngleX === 'HeadTurnX' && s.how.ParamAngleX === 'prefix' && s.map.EyeBallX === 'PupilX' && s.how.EyeBallX === 'standard' && s.map.mouth_open === 'MouthOpen' && s.how.mouth_open === 'similar' && s.map.BrowY === 'BrowY' && s.how.BrowY === 'same',
  `suggested: ${Object.entries(s.map).map(([a, b]) => `${a}→${b} (${s.how[a]})`).join(', ')}`);
const typo = suggestParamMap({ parameters: [P('MouthOpne')] }, { parameters: [P('MouthOpen'), P('PupilX')] }, { only: ['MouthOpne'] });
check(typo.map.MouthOpne === 'MouthOpen' && typo.how.MouthOpne === 'similar' && s.unmatched.includes('Tail'), `a near spelling (MouthOpne → MouthOpen); nothing near: unmatched (${s.unmatched.join(', ')})`);
check(new Set(Object.values(s.map)).size === Object.values(s.map).length, 'each target given once');

// copied with a map
const r = copyAnimations(from, to, { paramMap: { ParamAngleX: 'HeadTurnX', EyeBallX: 'PupilX', mouth_open: 'MouthOpen', Tail: null } });
const t = r.model.animations[0].tracks;
check(JSON.stringify(t.HeadTurnX) === JSON.stringify([[0, 0, 'bezier', 0.3, 7.5, 0.7, 15], [1, 15]]) && !('ParamAngleX' in t) && t.PupilX && t.MouthOpen && t.BrowY,
  `a track goes to its new id, its values carried -30..30 → -45..45 with the curve's handles (${JSON.stringify(t.HeadTurnX)})`);
check(r.notes.some((n) => n.code === 'copyParamMapped' && /ParamAngleX→HeadTurnX/.test(n.vars.pairs)) && !r.notes.some((n) => n.code === 'copyMissing' && /Tail/.test(n.vars.id)) && !('Tail' in t),
  'the pairs said; Tail mapped to nothing: left out quietly');
const auto = copyAnimations(from, to, { paramMap: 'auto' }), withSuggested = copyAnimations(from, to, { paramMap: s.map });
check(JSON.stringify(auto.model.animations) === JSON.stringify(withSuggested.model.animations) && auto.notes.some((n) => n.code === 'copyMissing' && n.vars.id === 'Tail'),
  "'auto': the same as the suggestions; the unmatched one is said as missing");
const twice = copyAnimations(from, to, { paramMap: { ParamAngleX: 'HeadTurnX', EyeBallX: 'HeadTurnX' } });
check(twice.notes.some((n) => n.code === 'copyParamTwice' && n.vars.id === 'HeadTurnX') && JSON.stringify(twice.model.animations[0].tracks.HeadTurnX[1]) === '[1,15]', 'two tracks onto one id: the first kept, said');
const plain = copyAnimations(from, to);
check(!plain.model.animations[0].tracks.HeadTurnX && plain.notes.filter((n) => n.code === 'copyMissing').length === 4, 'without a map: as before (the ids that differ are left out and said)');

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmap-')), at = (f) => path.join(dir, f);
fs.writeFileSync(at('from.json'), JSON.stringify(from)); fs.writeFileSync(at('to.json'), JSON.stringify(to)); fs.writeFileSync(at('map.json'), JSON.stringify({ EyeBallX: 'PupilX' }));
const cli = (...a) => spawnSync(process.execPath, ['tools/copy_animation.mjs', at('from.json'), at('to.json'), ...a], { encoding: 'utf8' });
const read = (f) => JSON.parse(fs.readFileSync(at(f), 'utf8')).animations[0].tracks;
const c1 = cli('--out', at('a.json'), '--map', 'ParamAngleX=HeadTurnX,Tail='), c2 = cli('--out', at('b.json'), '--map-file', at('map.json')), c3 = cli('--out', at('c.json'), '--auto-map');
check(c1.status === 0 && read('a.json').HeadTurnX && !read('a.json').PupilX && c2.status === 0 && read('b.json').PupilX && c3.status === 0 && read('c.json').MouthOpen && read('c.json').HeadTurnX,
  'command line: --map a=b (a= to leave one out), --map-file, --auto-map');
fs.rmSync(dir, { recursive: true, force: true });

// for the browser: no file that copy_animation.mjs or param_map.mjs loads imports node: at the top
const seen = new Set(), nodeTop = [];
const walk = (f) => {
  if (seen.has(f)) return; seen.add(f);
  for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(/^import\b[^;]*?from\s+'([^']+)'/gm)) {
    if (spec.startsWith('node:')) nodeTop.push(`${path.relative('.', f)}: ${spec}`);
    else if (spec.startsWith('.')) walk(path.resolve(path.dirname(f), spec));
  }
};
walk(path.resolve('tools/copy_animation.mjs')); walk(path.resolve('tools/param_map.mjs'));
check(nodeTop.length === 0 && seen.size > 3, `for the browser: ${seen.size} files loaded, none imports node: at the top${nodeTop.length ? ` (${nodeTop.join(', ')})` : ''}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall parameter map checks passed');
process.exit(failures ? 1 : 0);
