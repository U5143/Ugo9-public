// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A Ugo9 model written as a Spine skeleton (tools/export_spine.mjs, step 1: the setup pose), read back with the
// Spine import (tools/import_spine.mjs): every part comes back with the same vertices in model space, the same
// pictures (its UVs on the atlas page, in pixels) and the same triangles; weighted parts with the same weights;
// bones with shear, inheritance and length; blend and opacity; the outline first as Spine's hull; what Spine
// has no place for said. Also a made-up model: sheared, rotated and scaled bones, a weighted part.
//   node tests/export_spine_test.mjs
import fs from 'node:fs';
import { exportSpine } from '../tools/export_spine.mjs';
import { importSpine } from '../tools/import_spine.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// a part's vertices as [x, y, u, v] (u, v in atlas pixels): compared as sets, whatever the vertex order
const points = (p, page) => Array.from({ length: p.vertices.length / 2 }, (_, i) => [p.vertices[2 * i], p.vertices[2 * i + 1], p.uvs[2 * i] * page.width, p.uvs[2 * i + 1] * page.height]);
const close = (A, B, tol) => { // each point matched to the one nearest in the picture, all numbers within tol
  if (A.length !== B.length) return false;
  return A.every((p) => { let best = null, d = Infinity; for (const q of B) { const e = Math.hypot(p[2] - q[2], p[3] - q[3]); if (e < d) { d = e; best = q; } } return p.every((v, k) => Math.abs(v - best[k]) <= tol); });
};

function roundTrip(model, pages) {
  const res = exportSpine(model, { textures: pages, pageNames: pages.map((_, i) => `p${i}.png`) });
  const back = importSpine(JSON.parse(JSON.stringify(res.json)), res.atlas, {});
  return { res, back: back.model, warnings: back.warnings };
}

{
  const model = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));
  const pages = [{ width: 1024, height: 1024 }];
  const { res, back } = roundTrip(model, pages);
  let same = 0, bad = [];
  for (const p of model.parts) {
    const q = back.parts.find((x) => x.id === `${p.id}/${p.id}`);
    if (q && close(points(p, pages[0]), points(q, pages[0]), 0.01) && q.triangles.length === p.triangles.length) same++; else bad.push(p.id);
  }
  check(same === model.parts.length, `the sample: all ${model.parts.length} parts back with the same vertices (model space), pictures and triangles (${same}${bad.length ? `; not: ${bad.join(', ')}` : ''})`);
  check(back.bones.length === model.bones.length && res.json.slots.map((s) => s.name).filter((n) => !n.endsWith('#clip')).join() === model.parts.map((p) => p.id).join(), `${back.bones.length} bones, one slot per part in drawing order`);
  const hulls = Object.values(res.json.skins[0].attachments).map((a) => Object.values(a)[0]).filter((a) => a.hull > 2).length;
  check(hulls === model.parts.length, `every part's outline written first as its hull (${hulls} of ${model.parts.length})`);
  const said = new Set(res.notes.map((n) => `${n.code}:${n.vars.what || ''}`));
  const masked = model.parts.filter((p) => p.mask?.length), backMasks = masked.map((p) => back.parts.find((x) => x.id === `${p.id}/${p.id}`)?.mask?.[0]);
  check(masked.length > 0 && backMasks.every((m, i) => m === `${masked[i].mask[0]}#clip/${masked[i].mask[0]}#clip`) && back.parts.find((x) => x.id === backMasks[0]).maskOnly,
    `masked parts (${masked.map((p) => p.id).join(', ')}): written as Spine clipping, read back masked by the clipping polygon (${backMasks.join(', ')})`);
  check(said.has('spineLeftOut:parameters') && said.has('spineLeftOut:deformers') && said.has('spineLeftOut:physics') && said.has('spineMaskSolid:'), `what Spine has no place for (yet) is said: ${[...said].join(', ')}`);
}
{ // made up: rotated, scaled, sheared and inheriting bones; a weighted part over two bones; add blend, half opacity
  const quad = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
  const model = {
    canvas: { width: 200, height: 200, originX: 100, originY: 150 }, textures: ['p0.png'],
    bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 10, y: -40, rotation: 30, scaleX: 1.5, shearY: 10, length: 50 }, { id: 'hand', parent: 'arm', x: 50, rotation: -45, inherit: 'noScale', length: 20 }],
    parts: [
      { id: 'sleeve', texture: 0, vertices: [...quad(0, -60, 60, 20), 30, -50], uvs: [0, 0, 0.5, 0, 0.5, 0.25, 0, 0.25, 0.25, 0.125], triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
        weights: [[['arm', 1]], [['arm', 0.5], ['hand', 0.5]], [['hand', 1]], [['arm', 1]], [['arm', 0.7], ['hand', 0.3]]] },
      { id: 'glow', texture: 0, bone: 'hand', blend: 'add', opacity: 0.5, vertices: quad(50, -70, 20, 20), uvs: [0.5, 0.5, 0.75, 0.5, 0.75, 0.75, 0.5, 0.75], triangles: [0, 1, 2, 0, 2, 3] },
    ],
  };
  const pages = [{ width: 256, height: 256 }];
  const { res, back, warnings } = roundTrip(model, pages);
  const ok = model.parts.map((p) => { const q = back.parts.find((x) => x.id === `${p.id}/${p.id}`); return q && close(points(p, pages[0]), points(q, pages[0]), 0.01); });
  check(ok.every(Boolean), `bones rotated, scaled, sheared and not inheriting scale: the weighted and the bound part back in place (${ok.join(', ')}; warnings: ${warnings.join(' / ') || 'none'})`);
  const sleeve = back.parts.find((x) => x.id === 'sleeve/sleeve'), w = (sleeve.weights || []).map((v) => v.map(([b, x]) => `${b}:${x.toFixed(2)}`).sort().join('+')).sort();
  check(w.join(' ') === ['arm:0.50+hand:0.50', 'arm:0.70+hand:0.30', 'arm:1.00', 'arm:1.00', 'hand:1.00'].sort().join(' '), `the weights back (${w.join(' ')})`);
  const b = (id) => back.bones.find((x) => x.id === id), glow = back.parts.find((x) => x.id === 'glow/glow');
  check(Math.abs(b('arm').shearY - 10) < 1e-6 && b('hand').inherit === 'noScale' && Math.abs(b('arm').rotation - 30) < 1e-6 && glow.blend === 'add' && Math.abs(glow.opacity - 0.5) < 0.01,
    'the bones\' shear, rotation and inheritance, the add blend and half opacity back');
  check(res.json.skeleton.spine === '4.1.00' && /p0\.png\nsize: 256,256/.test(res.atlas), 'Spine 4.1 JSON and the atlas page');
}

// step 2: constraints and animations, through the core: the original and the read-back model posed at the same times
{
  const quad = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
  const model = {
    format: 'ugo9', canvas: { width: 300, height: 300, originX: 150, originY: 250 }, textures: ['p0.png'],
    bones: [{ id: 'root' }, { id: 'upper', parent: 'root', x: 0, y: -100, rotation: -60, length: 60 }, { id: 'lower', parent: 'upper', x: 60, length: 60 }, { id: 'goal', parent: 'root', x: 70, y: -60 },
      { id: 'follow', parent: 'root', x: -50, y: -50, scaleX: 2 }],
    constraints: [{ id: 'reach', type: 'ik', bones: ['upper', 'lower'], target: 'goal', mix: 1, bend: -1 }, { id: 'copy', type: 'transform', bones: ['follow'], target: 'lower', x: 5, y: 10, rotation: 15, mixRotate: 0.5, mixX: 0.2, mixY: 0.2, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 }],
    parts: [
      { id: 'arm', texture: 0, vertices: [...quad(0, -110, 120, 20), 60, -100], uvs: [0, 0, 0.5, 0, 0.5, 0.25, 0, 0.25, 0.25, 0.125], triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
        weights: [[['upper', 1]], [['lower', 1]], [['lower', 1]], [['upper', 1]], [['upper', 0.5], ['lower', 0.5]]] },
      { id: 'tag', texture: 0, bone: 'follow', opacity: 0.8, vertices: quad(-60, -60, 20, 20), uvs: [0.5, 0.5, 0.75, 0.5, 0.75, 0.75, 0.5, 0.75], triangles: [0, 1, 2, 0, 2, 3] },
    ],
    animations: [{ id: 'go', duration: 2.5, loop: true,
      bones: { goal: { x: [[0, 0, 'bezier', 0.2, 30, 0.6, -10], [1, 20, 'smooth'], [2, -15]], y: [[0, 0], [1.5, 25]] }, follow: { scaleX: [[0, 0], [1, 1]], shearY: [[0, 0, 'step'], [0.8, 20]] }, upper: { rotate: [[0, 0], [2, 40]] } },
      opacity: { tag: [[0, 0.8], [0.5, 0.2, 'step'], [1.5, 1]] },
      constraints: { reach: { mix: [[0, 1], [2, 0.3]] }, copy: { mixRotate: [[0, 0.5], [1, 1]], mixX: [[0.5, 0.2], [2, 0]] } },
      tracks: {} }],
  };
  const pages = [{ width: 256, height: 256 }];
  const res = exportSpine(model, { textures: pages, pageNames: ['p0.png'] });
  const back = importSpine(JSON.parse(JSON.stringify(res.json)), res.atlas, {}).model;
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const pose = (m, anim, t) => {
    const mod = rt.loadModel(compileUgo(m)), inst = mod.createInstance(), scratch = rt.alloc(8 * mod.vertexCount);
    inst.reset(); inst.play(anim, t); inst.update(0);
    rt.ex.ugo_deform_cpu(inst.ptr, scratch);
    const pos = Array.from(rt.f32(scratch, 2 * mod.vertexCount)), op = Array.from(inst.frame().subarray(mod.opacityOffset, mod.opacityOffset + mod.partCount));
    const out = {};
    let at = 0;
    m.parts.forEach((p, pi) => { const n = p.vertices.length / 2; out[p.id] = { pts: Array.from({ length: n }, (_, i) => [pos[2 * (at + i)], pos[2 * (at + i) + 1], p.uvs[2 * i] * 256, p.uvs[2 * i + 1] * 256]), opacity: op[pi] }; at += n; });
    return out;
  };
  let worst = 0, worstOp = 0;
  const animBack = Object.keys(res.json.animations)[0];
  for (const t of [0, 0.3, 0.55, 0.9, 1.25, 1.7, 2.2]) {
    const A = pose(model, 'go', t), B = pose(back, animBack, t);
    for (const p of model.parts) {
      const a = A[p.id], b = B[`${p.id}/${p.id}`];
      for (const q of a.pts) { let best = null, d = Infinity; for (const r of b.pts) { const e = Math.hypot(q[2] - r[2], q[3] - r[3]); if (e < d) { d = e; best = r; } } worst = Math.max(worst, Math.hypot(q[0] - best[0], q[1] - best[1])); }
      worstOp = Math.max(worstOp, Math.abs(a.opacity - b.opacity));
    }
  }
  check(worst < 0.2 && worstOp < 0.01, `IK, a transform constraint and an animation (curve, smooth, step and straight keys; rotate, move, scale, shear; opacity; the constraints' mixes) read back pose the same at 7 times (worst ${worst.toFixed(3)} px, opacity ${worstOp.toFixed(4)})`);
  const go = res.json.animations.go;
  check(res.json.ik?.[0]?.bendPositive === false && res.json.transform?.[0]?.mixRotate === 0.5 && go.bones.goal.translatex[0].curve.length === 4 && go.bones.follow.sheary[0].curve === 'stepped' && go.bones.root.rotate.at(-1).time === 2.5,
    'the IK bends the other way; the transform\'s mixes; a curve key as Spine\'s Bezier, a step as stepped; the length 2.5 s kept by a key at the end');
}

// step 3: colours. The core draws rgb = C X + a Y (docs/形式.md); Spine's light and dark must give the same X and Y
// for a tint / dark colour and a multiply / screen (Live2D) one, in the setup pose and in an animation's keys
{
  const quad = (x) => [x, -20, x + 10, -20, x + 10, -10, x, -10];
  const tri = [0, 1, 2, 0, 2, 3], uv = [0, 0, 0.25, 0, 0.25, 0.25, 0, 0.25];
  const model = { format: 'ugo9', canvas: { width: 100, height: 100, originX: 50, originY: 80 }, textures: ['p0.png'], bones: [{ id: 'root' }],
    colors: [{ id: 'cape', tint: [1, 0.8, 0.6], dark: [0.2, 0.1, 0] }, { id: 'skin', multiply: [1, 0.9, 0.8], screen: [0.1, 0, 0.2] }, { id: 'plain', tint: [0.5, 1, 1] }],
    parts: [{ id: 'a', texture: 0, bone: 'root', color: 'cape', vertices: quad(0), uvs: uv, triangles: tri }, { id: 'b', texture: 0, bone: 'root', color: 'skin', opacity: 0.5, vertices: quad(20), uvs: uv, triangles: tri }, { id: 'c', texture: 0, bone: 'root', color: 'plain', vertices: quad(40), uvs: uv, triangles: tri }],
    animations: [{ id: 'flash', duration: 1, colors: { cape: { tint: [[0, [1, 0.8, 0.6]], [1, [0, 1, 0]]] }, skin: { screen: [[0, [0.1, 0, 0.2]], [0.5, [1, 1, 1], 'step'], [1, [0, 0, 0]]] } } }] };
  const res = exportSpine(model, { textures: [{ width: 64, height: 64 }], pageNames: ['p0.png'] }), back = importSpine(JSON.parse(JSON.stringify(res.json)), res.atlas, {}).model;
  const XY = (c) => (c.multiply || c.screen ? { X: (c.multiply || [1, 1, 1]).map((m, i) => m * (1 - (c.screen || [0, 0, 0])[i])), Y: c.screen || [0, 0, 0] } : { X: (c.tint || [1, 1, 1]).map((t, i) => t - (c.dark || [0, 0, 0])[i]), Y: c.dark || [0, 0, 0] });
  const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) < 0.006); // 8-bit colours in Spine's JSON
  const same = model.parts.map((p) => { const a = XY(model.colors.find((c) => c.id === p.color)), q = back.parts.find((x) => x.id === `${p.id}/${p.id}`), b = XY(back.colors.find((c) => c.id === q.color)); return near(a.X, b.X) && near(a.Y, b.Y); });
  check(same.every(Boolean) && Math.abs(back.parts.find((x) => x.id === 'b/b').opacity - 0.5) < 0.01, `setup colours back with the same X and Y: tint / dark, multiply / screen (as light and dark), a tint alone (${same.join(', ')}); the opacity kept apart`);
  const fl = back.animations[0].colors, at = (keys, t) => { let k = keys[0]; for (const x of keys) if (x[0] <= t + 1e-9) k = x; return k[1]; };
  const capeEnd = at(fl.a.tint, 1), skinMid = XY({ tint: at(fl.b.tint, 0.5), dark: at(fl.b.dark, 0.5) });
  check(near(capeEnd, [0, 1, 0]) && near(at(fl.a.dark, 1), [0.2, 0.1, 0]) && near(skinMid.Y, [1, 1, 1]) && near(skinMid.X, [0, 0, 0]) && res.json.animations.flash.slots.b.rgb2[1].curve === 'stepped',
    'the colour keys back: the cape\'s tint 0, 1, 0 at 1 s with its dark colour 0.2, 0.1, 0 kept; the skin\'s screen 1 at 0.5 s as a step (X 0, Y 1)');
}

// step 3: draw order. Spine's rule (its JSON format's description): the listed slots move by their offset from
// their setup place, the others fill the places left in their setup order. Applied to each key, it must give the
// order Ugo9 draws in (by order value; the same value: as listed) at times between the keys and the crossings
{
  const quad = (x) => [x, -20, x + 10, -20, x + 10, -10, x, -10];
  const tri = [0, 1, 2, 0, 2, 3], uv = [0, 0, 0.25, 0, 0.25, 0.25, 0, 0.25];
  const part = (id, x, order) => ({ id, texture: 0, bone: 'root', vertices: quad(x), uvs: uv, triangles: tri, ...(order !== undefined ? { order } : {}) });
  const model = { format: 'ugo9', canvas: { width: 100, height: 100, originX: 50, originY: 80 }, textures: ['p0.png'], bones: [{ id: 'root' }],
    parts: [part('back', 0, 300), part('body', 10), part('arm', 20), part('front', 30, 700)],
    animations: [{ id: 'swing', duration: 2, order: { arm: [[0, 400], [1, 800]], back: [[0, 300, 'step'], [1.5, 900]] } }] };
  const res = exportSpine(model, { textures: [{ width: 64, height: 64 }], pageNames: ['p0.png'] }), keys = res.json.animations.swing.drawOrder || [];
  const setup = res.json.slots.map((x) => x.name);
  const spineOrder = (k) => { // the description's rule
    const out = new Array(setup.length).fill(null), moved = new Set();
    for (const { slot, offset } of k.offsets || []) { out[setup.indexOf(slot) + offset] = slot; moved.add(slot); }
    const rest = setup.filter((x) => !moved.has(x));
    for (let i = 0; i < out.length; i++) if (out[i] === null) out[i] = rest.shift();
    return out;
  };
  const spineAt = (t) => { let o = setup; for (const k of keys) if ((k.time || 0) <= t + 1e-9) o = spineOrder(k); return o.join(' '); };
  const ugoAt = (t) => { // by value, ties as listed
    const v = (p) => { const k = model.animations[0].order[p.id]; if (!k) return p.order ?? 500; let [t0, v0, m] = k[0]; if (t <= t0) return v0; for (let i = 0; i + 1 < k.length; i++) { const [a0, b0, mm] = k[i], [a1, b1] = k[i + 1]; if (t < a1) return mm === 'step' ? b0 : b0 + ((b1 - b0) * (t - a0)) / (a1 - a0); } return k.at(-1)[1]; };
    return model.parts.map((p, i) => [v(p), i, p.id]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]).join(' ');
  };
  const times = [0, 0.1, 0.24, 0.26, 0.6, 0.74, 0.76, 1.2, 1.49, 1.51, 2];
  const bad = times.filter((t) => spineAt(t) !== ugoAt(t));
  check(bad.length === 0 && keys.length === 4, `draw order: ${keys.length} keys (at 0 s the arm's value 400 puts it behind the body; it passes body at 0.25 s and front at 0.75 s; back jumps to the front at 1.5 s); Spine's order is Ugo9's at ${times.length - bad.length} of ${times.length} times${bad.length ? ` (not at ${bad.join(', ')}: ${bad.map((t) => spineAt(t) + ' / ' + ugoAt(t)).join('; ')})` : ''}`);
}

// step 3: masks as clipping. The polygon is the mask's outline (in model space after reading back); a mask-only part
// is not drawn; a mask whose parts are not one run in drawing order is said and left out
{
  const quad = (x, y, w, h) => [x, y, x + w, y, x + w, y + h, x, y + h];
  const tri = [0, 1, 2, 0, 2, 3], uv = [0, 0, 0.25, 0, 0.25, 0.25, 0, 0.25];
  const part = (id, v, more = {}) => ({ id, texture: 0, bone: 'root', vertices: v, uvs: uv, triangles: tri, ...more });
  const model = { format: 'ugo9', canvas: { width: 100, height: 100, originX: 50, originY: 80 }, textures: ['p0.png'], bones: [{ id: 'root' }, { id: 'head', parent: 'root', y: -40, rotation: 20 }],
    parts: [part('hole', quad(0, -30, 30, 20), { maskOnly: true, solid: true, bone: 'head' }), part('pupil', quad(5, -25, 10, 10), { mask: ['hole'] }), part('shine', quad(8, -22, 3, 3), { mask: ['hole'] }),
      part('frame', quad(40, -30, 20, 20)), part('in1', quad(42, -28, 5, 5), { mask: ['frame'] }), part('gap', quad(60, -30, 5, 5)), part('in2', quad(50, -28, 5, 5), { mask: ['frame'] })] };
  const res = exportSpine(model, { textures: [{ width: 64, height: 64 }], pageNames: ['p0.png'] }), back = importSpine(JSON.parse(JSON.stringify(res.json)), res.atlas, {}).model;
  const clip = back.parts.find((x) => x.id === 'hole#clip/hole#clip'), want = model.parts[0].vertices;
  const onOutline = clip && Array.from({ length: clip.vertices.length / 2 }, (_, i) => [clip.vertices[2 * i], clip.vertices[2 * i + 1]]).every(([x, y]) => Array.from({ length: 4 }, (_, k) => Math.hypot(x - want[2 * k], y - want[2 * k + 1])).some((d) => d < 0.01));
  check(onOutline && clip.vertices.length === 8 && back.parts.find((x) => x.id === 'pupil/pupil').mask?.[0] === clip.id && back.parts.find((x) => x.id === 'shine/shine').mask?.[0] === clip.id,
    'a mask-only part on a turned bone: its outline is the clipping polygon (in place after reading back), and both its parts are clipped by it');
  check(!res.json.slots.some((x) => x.name === 'hole') && res.json.slots.findIndex((x) => x.name === 'hole#clip') === res.json.slots.findIndex((x) => x.name === 'pupil') - 1, 'the mask-only part is not drawn; the clipping slot comes just before the first part it clips');
  check(res.notes.some((n) => n.code === 'spineMask' && n.vars.part === 'frame') && !res.json.slots.some((x) => x.name === 'frame#clip'), 'a mask whose parts are not one run in drawing order (a part between them): said, left out');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall Spine export checks passed');
process.exit(failures ? 1 : 0);
