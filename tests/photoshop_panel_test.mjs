// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Photoshop panel (plugins/photoshop/, 機能の比べ #21). Here, without Photoshop: its name patterns are the automatic
// tools' (tools/eye_mouth.mjs) to the letter; its rules find nothing to fix in a face drawn as docs/PSDの描き方.md asks
// and say each thing in a careless one; main.js, run against a stand-in for Photoshop's API (require('photoshop')),
// lists the lines, selects a layer by its id through batchPlay, and adds the underpaint layer under the selected one in
// one modal step. Photoshop itself: docs/PC確認.md.
//   node tests/photoshop_panel_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const R = createRequire(import.meta.url)('../plugins/photoshop/rules.js');

// the patterns: the same text as tools/eye_mouth.mjs
const src = fs.readFileSync('tools/eye_mouth.mjs', 'utf8'), mine = fs.readFileSync('plugins/photoshop/rules.js', 'utf8');
const grab = (text, name) => { const m = text.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`)); return m && m[1].replace(/\s+/g, ' ').trim(); };
const names = ['BROW', 'EYE', 'EYE_ROLES', 'MOUTH', 'MOUTH_ROLES'];
check(names.every((n) => grab(src, n) && grab(src, n) === grab(mine, n)), `the name patterns are the automatic tools' to the letter (${names.join(', ')})`);
const sideA = src.slice(src.indexOf('const sideIn'), src.indexOf('};', src.indexOf('const sideIn'))).replace(/\s+/g, ' ');
const sideB = mine.slice(mine.indexOf('const sideIn'), mine.indexOf('};', mine.indexOf('const sideIn'))).replace(/\s+/g, ' ');
check(sideA === sideB, 'and the sides (sideIn) the same');

// the rules
const pic = (id, name) => ({ id, name, kind: 'pixel', visible: true });
const group = (id, name, children) => ({ id, name, kind: 'group', visible: true, children });
const good = [ // top first, as Photoshop lists them
  group(1, '前髪', [pic(2, '前髪')]),
  pic(3, '上唇'), pic(4, '下唇'), pic(5, '口の中'),
  group(6, '右目', [pic(7, '上まぶた'), pic(8, '瞳'), pic(9, '白目')]),
  group(10, '左目', [pic(11, '上まぶた'), pic(12, '瞳'), pic(13, '白目')]),
  pic(14, '顔'),
];
const g = R.checkTree(good);
check(!g.some((x) => x.level === 'warn'), `drawn as the guide asks: nothing to fix (${g.map((x) => x.code).join(', ') || 'no lines'})`);
const bad = [pic(1, 'レイヤー 3'), pic(2, '目'), pic(3, '口'), { id: 4, name: 'トーンカーブ 1', kind: 'curves', visible: true }, pic(5, '前髪')];
const b = R.checkTree(bad), codes = b.map((x) => x.code);
check(['panelDefaultName', 'panelEyeNoSide', 'panelMouthSplit', 'panelAdjustment', 'panelNoFace'].every((c) => codes.includes(c)), `a careless one: ${codes.join(', ')}`);
check(b.find((x) => x.code === 'panelEyeNoSide').layerId === 2 && b.find((x) => x.code === 'panelAdjustment').layerId === 4, 'each line names its layer (to select it)');
check(R.checkTree([group(1, 'left eye', [pic(2, 'white')]), group(3, 'eye_R', [pic(4, 'lid')])]).every((x) => x.code !== 'panelEyeNoSide'), 'sides from the folders (left eye, eye_R)');
check(R.underpaintName('前髪') === '前髪 下塗り', 'the underpaint layer\'s name');

// main.js against a stand-in for Photoshop's API
{
  const calls = [], made = [];
  const sel = { id: 2, name: '前髪', kind: 'pixel' };
  const doc = {
    layers: [{ ...sel }, { id: 3, name: 'レイヤー 1', kind: 'pixel', visible: true }],
    activeLayers: [sel],
    async createPixelLayer(o) { const l = { id: 99, name: o.name, move(target, where) { calls.push(['move', target.id, where]); } }; made.push(l); return l; },
  };
  const ps = {
    app: { activeDocument: doc },
    core: { async executeAsModal(fn, o) { calls.push(['modal', o.commandName]); return fn({}); } },
    action: { async batchPlay(d) { calls.push(['batchPlay', d]); return []; }, addNotificationListener(ev) { calls.push(['listen', ev]); } },
    constants: { ElementPlacement: { PLACEAFTER: 'placeAfter', PLACEBEFORE: 'placeBefore' } },
  };
  const el = () => ({ textContent: '', className: '', title: '', children: [], classList: { add() {} }, listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, appendChild(c) { this.children.push(c); } });
  const els = { refresh: el(), underpaint: el(), status: el(), items: el() };
  const docEvents = {};
  const ctx = vm.createContext({
    require: (m) => (m === 'photoshop' ? ps : null), console, setTimeout, clearTimeout,
    document: { getElementById: (id) => els[id], createElement: () => el(), addEventListener: (k, f) => { docEvents[k] = f; } },
  });
  vm.runInContext(fs.readFileSync('plugins/photoshop/rules.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync('plugins/photoshop/main.js', 'utf8'), ctx);
  docEvents.DOMContentLoaded();
  await new Promise((r) => setTimeout(r, 20));
  const lines = els.items.children.map((c) => c.textContent);
  check(lines.some((t) => /レイヤー 1: a default name/.test(t)) && /直す所 \d+ 件/.test(els.status.textContent) && calls.some((c) => c[0] === 'listen'),
    `the lines listed (${lines.length}), the count in the status, the document watched for changes`);
  const linked = els.items.children.find((c) => /レイヤー 1/.test(c.textContent));
  await linked.listeners.click();
  const sp = calls.find((c) => c[0] === 'batchPlay');
  check(sp && sp[1][0]._obj === 'select' && sp[1][0]._target[0]._ref === 'layer' && sp[1][0]._target[0]._id === 3 && calls.some((c) => c[0] === 'modal'), 'a line clicked: its layer selected by id (batchPlay select, in a modal step)');
  await els.underpaint.listeners.click();
  await new Promise((r) => setTimeout(r, 20));
  check(made.length === 1 && made[0].name === '前髪 下塗り' && calls.some((c) => c[0] === 'move' && c[1] === 2 && c[2] === 'placeAfter') && calls.filter((c) => c[0] === 'modal' && /underpaint/.test(c[1])).length === 1,
    '下塗りを足す: one modal step that makes 「前髪 下塗り」 and puts it under the selected layer');
}

// the manifest
const m = JSON.parse(fs.readFileSync('plugins/photoshop/manifest.json', 'utf8'));
check(m.manifestVersion === 5 && m.host.app === 'PS' && m.main === 'index.html' && m.entrypoints[0].type === 'panel' && fs.readFileSync('plugins/photoshop/index.html', 'utf8').includes('rules.js'),
  'the manifest: version 5, Photoshop, a panel, index.html (which loads rules.js and main.js)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall Photoshop panel checks passed');
process.exit(failures ? 1 : 0);
