// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Checking a PSD before making it move (tools/psd_check.mjs, 機能の比べ #21): a face drawn as docs/PSDの描き方.md asks
// (eyes in 左目 / 右目 folders with lids, whites and irises; the mouth in three; a face; bangs) has nothing to fix and the
// eyes, mouth and face are found; a careless one (both eyes on one layer, a default name, the mouth in one, no face) gets
// each said; a layer cut along the edge of the one over it (the forehead under the bangs, the neck under the chin) is
// said, one painted under it is not; the usual parts not found by name are listed.
//   node tests/psd_check_test.mjs
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPsd } from '../tools/psd_check.mjs';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const fill = (c) => () => [...c, 255];
const box = (name, left, top, width, height, c = [200, 150, 120]) => ({ name, left, top, width, height, pixel: fill(c) });
const folder = (name, kids) => [{ name: '</Layer group>', section: 3, width: 0, height: 0 }, ...kids, { name, section: 1, width: 0, height: 0 }];
const W = 300, H = 300;

// as the guide asks (records bottom first)
const good = [
  box('顔', 60, 40, 180, 200, [240, 210, 190]),
  ...folder('左目', [box('白目', 90, 110, 40, 24, [255, 255, 255]), box('瞳', 100, 112, 18, 20, [60, 40, 30]), box('上まぶた', 86, 104, 48, 8, [40, 30, 30])]),
  ...folder('右目', [box('白目', 170, 110, 40, 24, [255, 255, 255]), box('瞳', 182, 112, 18, 20, [60, 40, 30]), box('上まぶた', 166, 104, 48, 8, [40, 30, 30])]),
  box('口の中', 136, 186, 28, 10, [120, 30, 40]), box('下唇', 134, 194, 32, 6, [200, 90, 90]), box('上唇', 134, 182, 32, 6, [200, 90, 90]),
  ...folder('前髪', [box('前髪', 60, 30, 180, 60, [80, 50, 40])]),
];
const g = checkPsd(writePsd(W, H, good, { composite: () => [255, 255, 255] }), { inflate });
check(!g.items.some((x) => x.level !== 'info'), `drawn as the guide asks: nothing to fix (${g.items.map((x) => x.code).join(', ') || 'no items'})`);
check(g.found.eyes.join() === 'EyeOpenL,EyeOpenR' && g.found.mouth.join() === 'MouthOpen' && g.found.face.length === 1, `found: eyes ${g.found.eyes}, mouth ${g.found.mouth}, face ${g.found.face}`);

// careless: both eyes on one layer with a default name, the mouth in one, no face
const twoEyes = { name: '目', left: 80, top: 100, width: 140, height: 30, pixel: (x) => (x < 45 || x > 95 ? [40, 30, 30, 255] : [0, 0, 0, 0]) };
const bad = [box('レイヤー 1', 60, 40, 180, 200, [240, 210, 190]), twoEyes, box('口', 134, 182, 32, 16, [200, 90, 90])];
const b = checkPsd(writePsd(W, H, bad, { composite: () => [255, 255, 255] }), { inflate }), codes = b.items.map((x) => x.code);
check(codes.includes('checkApart') && b.items.find((x) => x.code === 'checkApart').level === 'warn' && b.items.find((x) => x.code === 'checkApart').layers[0] === '目',
  'both eyes on one layer: said (they can only move together)');
check(codes.includes('checkUnnamed') && b.items.find((x) => x.code === 'checkUnnamed').layers.includes('レイヤー 1'), 'a default name (レイヤー 1): said');
check(codes.includes('checkNoFace'), 'no face picture by name: said');
check(codes.some((c) => /^mouth/.test(c)) && codes.some((c) => /^eye/.test(c)), `the mouth in one and the eyes without lids or sides: said by the tools that make them (${codes.filter((c) => /^(mouth|eye)/.test(c)).join(', ')})`);
check(!b.items.some((x) => x.code === 'paramMissing'), 'the parameters the editor adds are not listed as things to fix');

// the parts a moving character usually has (利用者の声: パーツ分け): the good face lacks back hair, brows and a neck
const miss = g.items.find((x) => x.code === 'checkPartMissing');
check(miss?.level === 'info' && /back hair, brows, neck/.test(miss.text) && !/front hair|eye whites|irises/.test(miss.text), `parts not found by name, said once as a list (${miss?.text})`);

// a layer cut along the edge of the one over it: the forehead cut along the bangs, the neck along the chin
{
  const faceCut = { name: '顔', left: 60, top: 40, width: 180, height: 200, pixel: (x, y) => (y + 40 < 90 ? [0, 0, 0, 0] : [240, 210, 190, 255]) }; // nothing above the bangs' lower edge
  const neckCut = { name: '首', left: 120, top: 200, width: 60, height: 60, pixel: (x, y) => (y + 200 < 240 ? [0, 0, 0, 0] : [230, 200, 180, 255]) }; // starts at the chin
  const neckOk = box('首', 120, 200, 60, 60, [230, 200, 180]);
  const cutPsd = [neckCut, faceCut, ...good.slice(1)], okPsd = [neckOk, ...good];
  const c = checkPsd(writePsd(W, H, cutPsd, { composite: () => [255, 255, 255] }), { inflate }), o = checkPsd(writePsd(W, H, okPsd, { composite: () => [255, 255, 255] }), { inflate });
  const under = c.items.filter((x) => x.code === 'checkNotPaintedUnder');
  const forehead = under.find((x) => x.layers[0] === '顔' && /前髪/.test(x.layers[1])), neck = under.find((x) => x.layers[0] === '首' && x.layers[1] === '顔');
  check(forehead?.level === 'warn' && /hole/.test(forehead.text), `the forehead cut along the bangs: said (${forehead?.text})`);
  check(neck?.level === 'warn', `the neck starting at the chin, cut along the face: said (${neck?.layers.join(' under ')})`);
  check(!o.items.some((x) => x.code === 'checkNotPaintedUnder') && !o.items.some((x) => x.code === 'checkPartMissing' && /neck/.test(x.text)), 'painted under them (the face under the bangs, the neck up behind the chin): nothing said');
}

// the command line: 0 with nothing to fix, 1 with warnings
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psdcheck-'));
fs.writeFileSync(path.join(dir, 'g.psd'), writePsd(W, H, good, { composite: () => [255, 255, 255] }));
fs.writeFileSync(path.join(dir, 'b.psd'), writePsd(W, H, bad, { composite: () => [255, 255, 255] }));
const run = (f) => spawnSync(process.execPath, ['tools/psd_check.mjs', path.join(dir, f)], { encoding: 'utf8' });
const rg = run('g.psd'), rb = run('b.psd');
check(rg.status === 0 && /nothing to fix/.test(rg.stdout) && rb.status === 1 && /warn: layer 目 holds 2 pictures/.test(rb.stdout), 'command line: 0 and "nothing to fix", 1 and the list');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall PSD check checks passed');
process.exit(failures ? 1 : 0);
