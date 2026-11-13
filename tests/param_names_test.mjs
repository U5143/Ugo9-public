// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The standard parameter names (docs/パラメータの名前.md) and the names the tools really make (利用者の声 #409):
// the PSD import + the editor's "make the drafts at once" (tools/starter_rig.mjs, with the face turn and the
// sphere bake), the idle animation (tools/idle.mjs), the eye / mouth drafts without sides (tools/eye_mouth.mjs),
// the VTuber page's face tracking (web/tracking.js) and the sample character (samples/basic).
// Every name a tool makes must be in the table: a standard name, or one listed in its "today's tools" column.
// A tool that starts making a name the table does not know fails here (then the table, or the tool, is put
// right). Decided 2026-11-12 (hub): what makes new things (drafts, import, the sample) uses the standard names;
// what reads (UgoLook, face tracking, the engines' helpers) reads both. A source in ALIGNED has moved to the
// standard names and fails if it makes an older one again; the others only warn (WARN) until their owners move
// them, and are then added to ALIGNED.
//   node tests/param_names_test.mjs
import fs from 'node:fs';
import { importPsd } from '../tools/import_psd.mjs';
import { makeStarterRig } from '../tools/starter_rig.mjs';
import { makeIdle } from '../tools/idle.mjs';
import { makeEyeBlink, makeMouthOpen } from '../tools/eye_mouth.mjs';
import { FaceToParams } from '../web/tracking.js';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// ---- the table -------------------------------------------------------------------------------------------
const doc = fs.readFileSync(new URL('../docs/パラメータの名前.md', import.meta.url), 'utf8');
const standard = new Set(), older = new Map(); // older name -> the standard names it stands for
for (const line of doc.split('\n')) {
  if (!/^\| `/.test(line)) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const names = (c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const std = names(cells[0]);
  std.forEach((n) => standard.add(n));
  for (const n of names(cells[cells.length - 1])) older.set(n, [...(older.get(n) || []), ...std]);
}
check(standard.size >= 20 && standard.has('HeadTurnX') && standard.has('EyeOpenL'), `the table is read (${standard.size} standard names, ${older.size} names of today's tools)`);
const known = (n) => standard.has(n) || older.has(n);
// the sources that use the standard names only (their owner moved them)
const ALIGNED = new Set(['顔の追従（web/tracking.js）', '見本（samples/basic）']);
// names a source keeps on purpose though they are not standard (docs/パラメータの名前.md says so): the sample's
// BrowY (one parameter for both brows) and FaceColor (another range than Cheek)
const OWN = { '見本（samples/basic）': ['BrowY', 'FaceColor'] };

// ---- what the tools make ---------------------------------------------------------------------------------
const made = new Map(); // name -> where from
const add = (from, ids) => { for (const id of ids) made.set(id, [...new Set([...(made.get(id) || []), from])]); };

// a character as a PSD (the same shape as tests/starter_rig_test.mjs): face, eyes in 左目 / 右目, a mouth
const sq = (name, left, top, w, h, colour) => ({ name, left, top, width: w, height: h, pixel: () => colour });
const folder = (name, inside) => [{ name: '', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }, ...inside, { name, section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] }];
const layers = [
  sq('体', 70, 220, 60, 80, [90, 90, 200, 255]),
  ...folder('頭', [
    sq('顔', 50, 60, 100, 120, [250, 220, 200, 255]),
    ...folder('左目', [sq('白目', 65, 100, 24, 12, [255, 255, 255, 255]), sq('瞳', 72, 99, 10, 14, [60, 40, 30, 255])]),
    ...folder('右目', [sq('白目', 111, 100, 24, 12, [255, 255, 255, 255]), sq('瞳', 118, 99, 10, 14, [60, 40, 30, 255])]),
    sq('上唇', 90, 150, 20, 4, [200, 80, 80, 255]), sq('下唇', 90, 156, 20, 4, [200, 80, 80, 255]),
  ]),
];
const res = importPsd(writePsd(200, 300, layers), { groupBones: true });
add('PSD の取り込み', (res.model.parameters || []).map((p) => p.id));
const model = { ...res.model, version: '0.6', source: { psd: { layers: res.layers.map(({ rgba, ...l }) => l) } } };
const rig = makeStarterRig(model);
add('下書きをまとめて（starter_rig）', rig.params.map((p) => p[0]));
for (const mo of rig.motions) add('下書きをまとめて（starter_rig）', Object.keys(mo.at));
if (rig.animation) add('待機のアニメ（starter_rig）', Object.keys(rig.animation.tracks || {}));
add('待機のアニメ（idle）', makeIdle({ ...model, parameters: [] }).params?.map((p) => p[0]) || []);
// eyes and mouth without sides: their own fallbacks
const plain = { ...model, parts: model.parts.map((p) => ({ ...p, id: p.id.replace(/[左右]/g, '') })) };
const eyes = makeEyeBlink(plain, { parts: plain.parts.filter((p) => /瞳|白目/.test(p.id)).map((p) => p.id) });
add('目の下書き（eye_mouth）', [...eyes.params.map((p) => p[0]), ...eyes.motions.flatMap((m) => Object.keys(m.at))]);
const mouth = makeMouthOpen(plain, { parts: plain.parts.filter((p) => /唇/.test(p.id)).map((p) => p.id) });
add('口の下書き（eye_mouth）', [...mouth.params.map((p) => p[0]), ...mouth.motions.flatMap((m) => Object.keys(m.at))]);
// the VTuber page's tracking and the sample character
add('顔の追従（web/tracking.js）', Object.keys(new FaceToParams().map({ angles: { yaw: 0, pitch: 0, roll: 0 }, shapes: {} })));
const sample = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));
add('見本（samples/basic）', sample.parameters.map((p) => p.id));

check(made.size >= 8, `the tools make ${made.size} names`);
const unknown = [...made].filter(([n]) => !known(n));
check(unknown.length === 0, `every name the tools make is in the table${unknown.length ? ` — not in it: ${unknown.map(([n, w]) => `${n} (${w.join('・')})`).join(', ')}` : ''}`);
const notYet = [...made].filter(([n]) => !standard.has(n) && older.has(n));
const backslid = notYet.flatMap(([n, w]) => w.filter((src) => ALIGNED.has(src) && !(OWN[src] || []).includes(n)).map((src) => `${n} (${src})`));
check(backslid.length === 0, `the sources moved to the standard names make no older ones (${[...ALIGNED].join('・')})${backslid.length ? ` — but: ${backslid.join(', ')}` : ''}`);
console.log(`     still the older names (the table's right column), to move to the standard ones by their owners:`);
for (const [n, w] of notYet) {
  const left = w.filter((src) => !ALIGNED.has(src) || (OWN[src] || []).includes(n));
  if (left.length) console.log(`WARN   ${n.padEnd(12)} -> ${older.get(n).join(' / ').padEnd(24)} ${left.join('・')}`);
}
const fine = [...made].filter(([n]) => standard.has(n)).map(([n]) => n);
console.log(`     already standard: ${fine.join(', ')}`);
// the table's right column says what the tools make today: a name listed there that no tool makes any more is stale
const listedButUnused = [...older.keys()].filter((n) => !standard.has(n) && !made.has(n));
console.log(`     in the right column but made by none of these tools: ${listedButUnused.join(', ') || '(none)'}`);

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all parameter name checks passed');
