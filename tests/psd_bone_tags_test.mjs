// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Bones from layer and folder names in a PSD (the user's choice, 2026-11-10): 「腕 [骨]」「前腕 [骨 親=腕]」, in
// Japanese or English ([bone parent=… root=…]), full-width ［］＝ and spaces, any letter case. The tag leaves the
// names; a tagged layer is bound to its bone, a tagged folder's layers to the folder's bone (a tagged layer in it
// is a child bone); the bone starts where 根元 / root says and points across the picture; brackets that are not a
// bone tag stay in the name; unknown words, missing parents and circles are said. The bones move their parts: a
// turned arm moves the forearm with it (through the compiler and the core).
//   node tests/psd_bone_tags_test.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { importPsd, boneTag } from '../tools/import_psd.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { writePsd } from './psd/make_big.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const inflate = (x) => zlib.inflateSync(x);
const be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const block = (key, data) => Buffer.concat([Buffer.from('8BIM' + key, 'latin1'), be(data.length), data, Buffer.alloc(data.length % 2)]);

// the words
{
  const t = (s) => JSON.stringify(boneTag(s));
  const a = boneTag('腕 [骨]'), b = boneTag('前腕 [骨 親=腕 根元=左]'), c = boneTag('Hair [BONE Root=Top Parent=head]'), d = boneTag('髪　［骨　親＝頭　根元＝中］');
  check(a.name === '腕' && a.tag.root === 'top' && !a.tag.parent && b.name === '前腕' && b.tag.parent === '腕' && b.tag.root === 'left', `「腕 [骨]」「前腕 [骨 親=腕 根元=左]」: ${t('前腕 [骨 親=腕 根元=左]')}`);
  check(c.name === 'Hair' && c.tag.parent === 'head' && c.tag.root === 'top' && d.name === '髪' && d.tag.parent === '頭' && d.tag.root === 'center', 'English words in any case; full-width ［］＝ and spaces');
  check(boneTag('eye [copy]').tag === null && boneTag('eye [copy]').name === 'eye [copy]' && boneTag('no tag').tag === null, 'brackets that are not a bone tag stay in the name');
  check(JSON.stringify(boneTag('x [骨 色=赤]').tag.unknown) === '["色=赤"]', 'an unknown word is kept to be said');
}

// a PSD: body (folder, tagged) with an upper arm (tagged), a forearm (tagged, parent named), a hand (in a tagged folder), hair (English tag, root at the top)
const W = 200, H = 200, solid = (c) => () => c;
const L = (name, left, top, width, height, extra = {}) => ({ name, left, top, width, height, pixel: solid([200, 100, 50, 255]), ...extra });
const layers = [
  { name: '</Layer group>', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
  L('胴', 80, 80, 40, 80),
  L('上腕 [骨 根元=左]', 120, 90, 40, 10),
  L('前腕 [骨 親=上腕 根元=左]', 160, 90, 30, 10),
  { name: '</Layer group>', section: 3, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
  L('手', 188, 86, 10, 18),
  { name: 'Hand [Bone parent=前腕 root=Left]', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
  L('Hair [BONE]', 85, 40, 30, 40),
  L('顔 [copy]', 85, 50, 30, 30),
  { name: '体［骨　根元＝下］', section: 1, width: 0, height: 0, pixel: () => [0, 0, 0, 0] },
];
const res = importPsd(writePsd(W, H, layers, { composite: () => [255, 255, 255] }), { inflate });
const m = res.model, bone = (id) => m.bones.find((b) => b.id === id), part = (id) => m.parts.find((p) => p.id === id);
check(['体', '上腕', '前腕', 'Hand', 'Hair'].every((id) => bone(id)) && m.bones.length === 6 && part('上腕') && part('顔 [copy]') && res.groups.some((g) => g.id === '体'),
  `bones 体, 上腕, 前腕, Hand, Hair (+ root); the names without the tags (parts 上腕…, a folder 体); 「顔 [copy]」 kept as it is (${m.bones.map((b) => b.id).join(', ')})`);
check(bone('上腕').parent === '体' && bone('前腕').parent === '上腕' && bone('Hand').parent === '前腕' && bone('Hair').parent === '体' && bone('体').parent === 'root',
  'parents: the folder\'s bone around them, or the one named (前腕 → 上腕, Hand → 前腕)');
check(part('胴').bone === '体' && part('上腕').bone === '上腕' && part('前腕').bone === '前腕' && part('手').bone === 'Hand' && part('Hair').bone === 'Hair' && part('顔 [copy]').bone === '体',
  'binding: a tagged layer to its bone, the others to their tagged folder\'s');
check(res.notes.some((n) => n.code === 'psdBones' && n.vars.count === 5), 'said: 5 bones from the tags (info)');

// where they start and point: 上腕 at its left end pointing right, 40 long; Hair from its top pointing down
const world = (() => { // the bones' rest places in model space (turn and move only)
  const out = new Map();
  const get = (id) => { if (out.has(id)) return out.get(id); const b = bone(id); if (!b.parent) { out.set(id, [0, 0, 0]); return out.get(id); } const [px, py, pa] = get(b.parent), r = pa * Math.PI / 180;
    const w = [px + b.x * Math.cos(r) - b.y * Math.sin(r), py + b.x * Math.sin(r) + b.y * Math.cos(r), pa + (b.rotation || 0)]; out.set(id, w); return w; };
  for (const b of m.bones) get(b.id);
  return out;
})();
const ox = m.canvas.originX, oy = m.canvas.originY, at = (id) => { const [x, y, a] = world.get(id); return [Math.round(x + ox), Math.round(y + oy), Math.round(((a % 360) + 360) % 360)]; };
check(JSON.stringify(at('上腕')) === '[120,95,0]' && bone('上腕').length === 40 && JSON.stringify(at('Hair')) === '[100,40,90]' && bone('Hair').length === 40 && at('体')[1] === 160 && at('体')[2] === 270,
  `上腕 starts at its left end (120, 95) pointing right, 40 long; Hair at its top (100, 40) pointing down; 体 at its bottom pointing up (${JSON.stringify([at('上腕'), at('Hair'), at('体')])})`);

// the words said: an unknown word, a missing parent, a circle
{
  const r = importPsd(writePsd(W, H, [L('a [骨 親=b 色=赤]', 10, 10, 10, 10), L('b [骨 親=a]', 30, 10, 10, 10), L('c [bone parent=nobody]', 50, 10, 10, 10)], { composite: () => [255, 255, 255] }), { inflate });
  const codes = r.notes.map((n) => n.code);
  check(codes.includes('psdBoneTagWord') && codes.includes('psdBoneParentMissing') && codes.includes('psdBoneParentCircle') && r.model.bones.find((b) => b.id === 'c').parent === 'root',
    `said: an unknown word, a parent that is not there (under root), a circle (${codes.filter((c) => c.startsWith('psdBone')).join(', ')})`);
  const off = importPsd(writePsd(W, H, [L('a [骨]', 10, 10, 10, 10)], { composite: () => [255, 255, 255] }), { inflate, boneTags: false });
  check(off.model.bones.length === 1 && off.model.parts[0].id === 'a', 'boneTags false: no bones (the tag still leaves the name)');
}

// the bones move their parts: the upper arm turned 90° takes the forearm and the hand with it
{
  const mm = structuredClone(m);
  mm.animations = [{ id: 'lift', duration: 1, bones: { 上腕: { rotate: [[0, 90]] } } }];
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const mod = rt.loadModel(compileUgo(mm)), inst = mod.createInstance(), scratch = rt.alloc(8 * mod.vertexCount);
  inst.reset(); inst.play('lift', 0); inst.update(0);
  rt.ex.ugo_deform_cpu(inst.ptr, scratch);
  const pos = rt.f32(scratch, 2 * mod.vertexCount);
  let first = 0; for (const p of mm.parts) { if (p.id === '前腕') break; first += p.vertices.length / 2; }
  const fa = mm.parts.find((p) => p.id === '前腕'), n = fa.vertices.length / 2;
  let x = 0, y = 0; for (let i = 0; i < n; i++) { x += pos[2 * (first + i)]; y += pos[2 * (first + i) + 1]; }
  const cx = x / n + ox, cy = y / n + oy; // was about (175, 95): turned 90° about (120, 95), it is about (120, 150)
  check(Math.abs(cx - 120) < 3 && Math.abs(cy - 150) < 3, `turning 上腕 by 90° carries 前腕 down with it (its middle at ${cx.toFixed(1)}, ${cy.toFixed(1)}; was about 175, 95)`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall PSD bone tag checks passed');
process.exit(failures ? 1 : 0);
