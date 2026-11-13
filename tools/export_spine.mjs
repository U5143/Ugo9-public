// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A Ugo9 working model as a Spine skeleton (利用者の声 #45「Spine と行き来したい」): Spine's JSON and its atlas,
// written from Esoteric Software's public descriptions of the JSON and atlas formats only. The pictures are the
// model's own atlas pages (one region per part).
//
//   exportSpine(model, opts) -> { json (object), atlas (text), notes }
//     opts: { textures: [{ width, height }] (the atlas pages' sizes, in the model's order), name, version ('4.1.00') }
//   node tools/export_spine.mjs model.json --out build/spine/hero   -> hero.json, hero.atlas (and the PNGs copied)
//
// Step 1: the skeleton in its setup pose: bones (inheritance, shear, length), one slot per part in drawing order
// (blend, opacity), a mesh attachment per part (its outline first as Spine's hull; weighted where the part has
// weights, else bound to its bone) and the atlas. What Spine has no place for is left out and said: parameters,
// deformers, warps, physics and chains, masks, glue, expressions (notes: spineLeftOut).
// Step 2: IK and transform constraints, and animations: bones' rotate / translate / scale / shear (one timeline per
// channel, Spine 4.1's), parts' opacity (slot alpha), constraints' mixes and bend; step, straight, smooth and curve
// keys (Spine's Bezier curves); each animation's length kept. Parameter tracks, draw order, morphs and colours are
// left out and said (spineAnimLeftOut).
//
// Spine's space is y up with angles counter-clockwise; Ugo9's is y down, clockwise (the Spine import flips both
// back: tools/import_spine.mjs, so a skeleton written here reads back as the same model).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseWorld, INHERIT } from './skeleton_pose.mjs';

const DEG = Math.PI / 180;
const r6 = (x) => Math.round(x * 1e6) / 1e6; // numbers in the JSON: 6 places
const inv = (M) => { const det = M[0] * M[3] - M[2] * M[1], a = M[3] / det, b = -M[1] / det, c = -M[2] / det, d = M[0] / det; return [a, b, c, d, -(a * M[4] + c * M[5]), -(b * M[4] + d * M[5])]; };
const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

// bones parents first (Spine reads them in order)
function sortBones(bones) {
  const byId = new Map(bones.map((b) => [b.id, b])), out = [], done = new Set();
  const visit = (b, trail = new Set()) => {
    if (done.has(b.id)) return;
    if (trail.has(b.id)) throw new Error(`bone ${b.id}: its parents go round in a circle`);
    trail.add(b.id);
    if (b.parent != null && byId.has(b.parent)) visit(byId.get(b.parent), trail);
    done.add(b.id); out.push(b);
  };
  bones.forEach((b) => visit(b));
  return out;
}

// a mesh's outline (edges in one triangle only) as one loop, or null where it is not one loop
function outlineLoop(triangles, n) {
  const count = new Map(), key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < triangles.length; t += 3) for (const [a, b] of [[triangles[t], triangles[t + 1]], [triangles[t + 1], triangles[t + 2]], [triangles[t + 2], triangles[t]]]) count.set(key(a, b), (count.get(key(a, b)) || 0) + 1);
  const next = new Map();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    if (!next.has(a)) next.set(a, []); if (!next.has(b)) next.set(b, []);
    next.get(a).push(b); next.get(b).push(a);
  }
  if (!next.size || [...next.values()].some((l) => l.length !== 2)) return null;
  const start = next.keys().next().value, loop = [start];
  let prev = -1, at = start;
  for (;;) { const [p, q] = next.get(at), go = p !== prev ? p : q; if (go === start) break; loop.push(go); prev = at; at = go; if (loop.length > n) return null; }
  return loop.length === next.size ? loop : null;
}

export function exportSpine(model, opts = {}) {
  const notes = [], note = (code, vars, text, level = 'warn') => notes.push({ code, vars, level, text });
  const pages = opts.textures || (model.textures || []).map(() => ({ width: 0, height: 0 }));
  if (pages.some((p) => !(p.width > 0 && p.height > 0))) throw new Error('exportSpine: the atlas pages\' sizes are needed (opts.textures)');
  // bones, in Ugo9's terms and in Spine's
  const ugoBones = sortBones(model.bones || [{ id: 'root' }]), index = new Map(ugoBones.map((b, i) => [b.id, i]));
  const cons = (model.constraints || []).filter((c) => (c.type === 'ik' || c.type === 'transform') && index.has(c.target) && c.bones?.every((b) => index.has(b)));
  // the setup pose with the constraints (Spine solves them before it places the meshes, as the import does)
  const world = poseWorld(
    ugoBones.map((b) => ({ parent: b.parent != null && index.has(b.parent) ? index.get(b.parent) : -1, inherit: INHERIT[b.inherit || 'normal'] ?? 0, length: b.length || 0 })),
    ugoBones.map((b) => [b.x || 0, b.y || 0, (b.rotation || 0) * DEG, b.scaleX ?? 1, b.scaleY ?? 1, (b.shearX || 0) * DEG, (b.shearY || 0) * DEG]),
    cons.map((c) => (c.type === 'ik'
      ? { type: 'ik', bones: c.bones.map((n) => index.get(n)), target: index.get(c.target), mix: c.mix ?? 1, bend: c.bend ?? 1, compress: !!c.compress, stretch: !!c.stretch, uniform: !!c.uniform }
      : { type: 'transform', bones: c.bones.map((n) => index.get(n)), target: index.get(c.target), local: !!c.local, relative: !!c.relative,
        offRot: (c.rotation || 0) * DEG, offX: c.x || 0, offY: c.y || 0, offSx: c.scaleX || 0, offSy: c.scaleY || 0, offShy: (c.shearY || 0) * DEG,
        mixRot: c.mixRotate ?? 1, mixX: c.mixX ?? 1, mixY: c.mixY ?? 1, mixSx: c.mixScaleX ?? 1, mixSy: c.mixScaleY ?? 1, mixShear: c.mixShearY ?? 1 })),
  );
  const inverse = world.map(inv);
  const bones = ugoBones.map((b) => {
    const o = { name: b.id };
    if (b.parent != null && index.has(b.parent)) o.parent = b.parent;
    if (b.length) o.length = r6(b.length);
    if (b.x) o.x = r6(b.x);
    if (b.y) o.y = r6(-b.y);
    if (b.rotation) o.rotation = r6(-b.rotation);
    if ((b.scaleX ?? 1) !== 1) o.scaleX = r6(b.scaleX);
    if ((b.scaleY ?? 1) !== 1) o.scaleY = r6(b.scaleY);
    if (b.shearX) o.shearX = r6(-b.shearX);
    if (b.shearY) o.shearY = r6(-b.shearY);
    if (b.inherit && b.inherit !== 'normal') o.inherit = b.inherit;
    return o;
  });
  // parts in drawing order: by their order value, then as listed
  const parts = (model.parts || []).map((p, i) => ({ p, i })).sort((a, b) => (a.p.order ?? 500) - (b.p.order ?? 500) || a.i - b.i).map((x) => x.p);
  const slots = [], attachments = {}, regions = pages.map(() => []), colors = new Map((model.colors || []).map((c) => [c.id, c]));
  const BLEND = { add: 'additive', multiply: 'multiply', screen: 'screen' };
  // a vertex of a part as Spine keeps it: in its bone's setup space (y up), or per bone with weights
  const bindVertex = (p, v, out) => {
    const x = p.vertices[2 * v], y = p.vertices[2 * v + 1], ws = p.weights?.[v];
    if (ws?.length) {
      const list = ws.filter(([b]) => index.has(b)), sum = list.reduce((acc, [, w]) => acc + w, 0) || 1;
      out.push(list.length);
      for (const [b, w] of list) { const [lx, ly] = apply(inverse[index.get(b)], x, y); out.push(index.get(b), r6(lx), r6(-ly), r6(w / sum)); }
    } else {
      const bi = index.get(p.bone) ?? index.get(model.warps?.find((g) => g.id === p.warp)?.bone) ?? 0, [lx, ly] = apply(inverse[bi], x, y);
      out.push(r6(lx), r6(-ly));
    }
  };
  const boneOf = (p) => (p.weights?.some((w) => w?.length) ? ugoBones[0].id : (p.bone && index.has(p.bone) ? p.bone : model.warps?.find((g) => g.id === p.warp)?.bone || ugoBones[0].id));
  // masks as Spine's clipping: a mask part whose users (masked by it alone, not inverted) follow each other in drawing
  // order becomes a clipping slot just before the first of them, ending at the last; a mask-only part is not drawn
  const drawn = parts.filter((p) => !p.maskOnly), clipBefore = new Map(), clipped = new Set();
  for (const m of parts) {
    const users = drawn.filter((p) => p.mask?.includes(m.id));
    if (!users.length) continue;
    const at = users.map((u) => drawn.indexOf(u)), ok = users.every((u) => u.mask.length === 1 && !u.maskInvert) && at.every((k, i) => !i || k === at[i - 1] + 1);
    const loop = ok ? outlineLoop(m.triangles, m.vertices.length / 2) : null;
    if (!ok || !loop) { note('spineMask', { part: m.id }, `mask ${m.id}: ${!ok ? 'its parts are not one run in drawing order, or are masked by more than it or inverted' : 'its outline is not one loop'}; Spine's clipping cannot do it (drawn unmasked)`); continue; }
    if (!m.solid) note('spineMaskSolid', { part: m.id }, `mask ${m.id}: Spine clips by its outline (the picture's transparent places inside it clip too)`, 'info');
    const vertices = [];
    for (const v of loop) bindVertex(m, v, vertices);
    clipBefore.set(users[0].id, { name: `${m.id}#clip`, bone: boneOf(m), att: { type: 'clipping', end: users[users.length - 1].id, vertexCount: loop.length, vertices } });
    users.forEach((u) => clipped.add(u.id));
  }
  for (const p of parts) {
    if (p.maskOnly) continue;
    const n = p.vertices.length / 2;
    if (p.warp) note('spineWarp', { part: p.id }, `part ${p.id}: in warp ${p.warp}; Spine has no warp grids: written in its setup shape on the grid's bone`);
    const clip = clipBefore.get(p.id);
    if (clip) { slots.push({ name: clip.name, bone: clip.bone, attachment: clip.name }); attachments[clip.name] = { [clip.name]: clip.att }; }
    // the hull first: the outline loop's vertices, then the rest
    const loop = outlineLoop(p.triangles, n), order = loop ? [...loop, ...Array.from({ length: n }, (_, i) => i).filter((i) => !loop.includes(i))] : Array.from({ length: n }, (_, i) => i);
    if (!loop) note('spineHull', { part: p.id }, `part ${p.id}: its outline is not one loop; written without a hull (Spine's editor may ask to fix it)`, 'info');
    const at = new Map(order.map((v, k) => [v, k]));
    // its region: the box of its UVs on its page
    const page = pages[p.texture || 0];
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) { u0 = Math.min(u0, p.uvs[2 * i]); u1 = Math.max(u1, p.uvs[2 * i]); v0 = Math.min(v0, p.uvs[2 * i + 1]); v1 = Math.max(v1, p.uvs[2 * i + 1]); }
    const rx = Math.max(0, Math.floor(u0 * page.width)), ry = Math.max(0, Math.floor(v0 * page.height));
    const rw = Math.max(1, Math.min(page.width, Math.ceil(u1 * page.width)) - rx), rh = Math.max(1, Math.min(page.height, Math.ceil(v1 * page.height)) - ry);
    regions[p.texture || 0].push({ name: p.id, x: rx, y: ry, w: rw, h: rh });
    const uvs = [], vertices = [];
    for (const v of order) {
      uvs.push(r6((p.uvs[2 * v] * page.width - rx) / rw), r6((p.uvs[2 * v + 1] * page.height - ry) / rh));
      bindVertex(p, v, vertices);
    }
    const slotBone = boneOf(p);
    const slot = { name: p.id, bone: slotBone, attachment: p.id };
    const col = p.color ? colorOf(colors.get(p.color) || {}) : null;
    if ((p.opacity ?? 1) < 1 || (col && col.light.some((v) => v !== 1))) slot.color = `${hex(col ? col.light : [1, 1, 1])}${hex2(Math.max(0, p.opacity ?? 1))}`;
    if (col?.dark) slot.dark = hex(col.dark);
    if (BLEND[p.blend]) slot.blend = BLEND[p.blend];
    slots.push(slot);
    attachments[p.id] = { [p.id]: { type: 'mesh', uvs, triangles: p.triangles.map((t) => at.get(t)), vertices, hull: loop ? loop.length : 0, width: rw, height: rh } };
  }
  if ((model.constraints || []).length > cons.length) note('spineLeftOut', { what: 'constraints', count: model.constraints.length - cons.length }, `${model.constraints.length - cons.length} constraints: not written (an unknown kind, or bones that are not there)`);
  const ik = [], transform = [];
  cons.forEach((c, order) => {
    if (c.type === 'ik') ik.push({ name: c.id, order, bones: c.bones, target: c.target, ...((c.mix ?? 1) !== 1 ? { mix: c.mix } : {}), ...(c.bend === -1 ? { bendPositive: false } : {}), ...(c.compress ? { compress: true } : {}), ...(c.stretch ? { stretch: true } : {}), ...(c.uniform ? { uniform: true } : {}) });
    else transform.push({ name: c.id, order, bones: c.bones, target: c.target, ...(c.local ? { local: true } : {}), ...(c.relative ? { relative: true } : {}),
      rotation: r6(-(c.rotation || 0)), x: r6(c.x || 0), y: r6(-(c.y || 0)), scaleX: r6(c.scaleX || 0), scaleY: r6(c.scaleY || 0), shearY: r6(-(c.shearY || 0)),
      mixRotate: c.mixRotate ?? 1, mixX: c.mixX ?? 1, mixY: c.mixY ?? 1, mixScaleX: c.mixScaleX ?? 1, mixScaleY: c.mixScaleY ?? 1, mixShearY: c.mixShearY ?? 1 });
  });
  const animations = {};
  for (const a of model.animations || []) animations[a.id] = animation(a, ugoBones, index, cons, note, parts, colors);
  for (const [key, what] of [['parameters', 'parameters'], ['deformers', 'deformers (parameter shapes)'], ['physics', 'physics'], ['chains', 'chains'], ['glue', 'glue'], ['expressions', 'expressions'], ]) {
    if (model[key]?.length) note('spineLeftOut', { what: key, count: model[key].length }, `${model[key].length} ${what}: not written (Spine has no place for them yet)`, key === 'parameters' ? 'info' : 'warn');
  }
  const json = {
    skeleton: { hash: 'ugo9', spine: opts.version || '4.1.00', x: 0, y: 0, width: r6(model.canvas?.width || 0), height: r6(model.canvas?.height || 0), images: './', audio: '' },
    bones, slots, ...(ik.length ? { ik } : {}), ...(transform.length ? { transform } : {}), skins: [{ name: 'default', attachments }], animations,
  };
  // the atlas: one page per texture, one region per part (the classic layout every runtime reads)
  const names = opts.pageNames || (model.textures || []).map((t) => path.basename(t));
  const atlas = pages.map((pg, k) => [`${names[k] || `page${k}.png`}`, `size: ${pg.width},${pg.height}`, 'format: RGBA8888', 'filter: Linear,Linear', 'repeat: none',
    ...regions[k].flatMap((r) => [r.name, '  rotate: false', `  xy: ${r.x}, ${r.y}`, `  size: ${r.w}, ${r.h}`, `  orig: ${r.w}, ${r.h}`, '  offset: 0, 0', '  index: -1'])].join('\n')).join('\n\n') + '\n';
  return { json, atlas, notes };
}

// ---- colours ----

const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const hex = (rgb) => rgb.map(hex2).join('');
// a Ugo9 colour as Spine's light and dark colours: tint / dark are Spine's own; multiply / screen (Live2D) are the
// same rule with light = multiply (1 - screen) + screen and dark = screen (docs/形式.md: rgb = C X + a Y)
function colorOf(c, at = null) {
  const v = (k, d) => (at ? at[k] : c[k]) || d;
  if (c.multiply || c.screen || at?.multiply || at?.screen) {
    const m = v('multiply', [1, 1, 1]), sc = v('screen', [0, 0, 0]);
    return { light: m.map((x, i) => x * (1 - sc[i]) + sc[i]), dark: sc.some((x) => x) ? sc : null };
  }
  const t = v('tint', [1, 1, 1]), d = v('dark', null);
  return { light: t, dark: d && d.some((x) => x) ? d : (c.dark ? [0, 0, 0] : null) };
}

// ---- animations ----

// a Ugo9 track's keys -> Spine 4.x keys { time, [field]: value, curve } through f (affine: curve handles go through it too)
function spineKeys(keys, f, field = 'value') {
  const out = [];
  keys.forEach((k, i) => {
    const o = { time: r6(k[0]), [field]: r6(f(k[1])) }, next = keys[i + 1];
    if (next && next[0] > k[0]) {
      const t0 = k[0], dt = next[0] - k[0];
      if (k[2] === 'step') o.curve = 'stepped';
      else if (k[2] === 'smooth') o.curve = [t0 + dt / 3, f(k[1]), t0 + (2 * dt) / 3, f(next[1])].map(r6);
      else if (k[2] === 'bezier') o.curve = [t0 + k[3] * dt, f(k[4]), t0 + k[5] * dt, f(k[6])].map(r6);
    } else if (next && k[2] === 'step') o.curve = 'stepped';
    if (o.time === 0) delete o.time;
    out.push(o);
  });
  return out;
}
// a track's value at t (straight lines; steps hold) for sampling several tracks at shared times
function valueAt(keys, t) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i + 1 < keys.length; i++) {
    const [t0, v0, mode] = keys[i], [t1, v1] = keys[i + 1];
    if (t < t1) return mode === 'step' || t1 <= t0 ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return keys[keys.length - 1][1];
}

function animation(a, ugoBones, index, cons, note, parts = [], colors = new Map()) {
  const out = {}, byId = new Map(ugoBones.map((b) => [b.id, b]));
  let last = 0;
  const seen = (keys) => { for (const k of keys) last = Math.max(last, k[0]); return keys; };
  // bones: one timeline per channel (Spine 4.1); y and angles turned over; scale from Ugo9's added amount to Spine's multiplier
  for (const [id, tracks] of Object.entries(a.bones || {})) {
    const b = byId.get(id);
    if (!b) { note('spineAnimLeftOut', { anim: a.id, what: `bone ${id}` }, `animation ${a.id}: bone ${id} is not there (left out)`); continue; }
    const tl = {};
    const map = {
      rotate: ['rotate', (v) => -v], x: ['translatex', (v) => v], y: ['translatey', (v) => -v],
      scaleX: ['scalex', (v) => 1 + v / (b.scaleX ?? 1)], scaleY: ['scaley', (v) => 1 + v / (b.scaleY ?? 1)],
      shearX: ['shearx', (v) => -v], shearY: ['sheary', (v) => -v],
    };
    for (const [ch, keys] of Object.entries(tracks)) {
      if (!map[ch] || !Array.isArray(keys) || !keys.length) continue;
      if ((ch === 'scaleX' && !(b.scaleX ?? 1)) || (ch === 'scaleY' && !(b.scaleY ?? 1))) { note('spineAnimLeftOut', { anim: a.id, what: `${id} ${ch}` }, `animation ${a.id}: bone ${id}'s ${ch} keys: its setup scale is 0 (left out)`); continue; }
      tl[map[ch][0]] = spineKeys(seen(keys), map[ch][1]);
    }
    if (Object.keys(tl).length) (out.bones ||= {})[id] = tl;
  }
  // parts' opacity: the slot's alpha
  for (const [id, keys] of Object.entries(a.opacity || {})) if (Array.isArray(keys) && keys.length) ((out.slots ||= {})[id] = {}).alpha = spineKeys(seen(keys), (v) => Math.max(0, Math.min(1, v)));
  // constraints: their mixes (several channels share one key list: sampled at all their times, straight between)
  for (const [id, tracks] of Object.entries(a.constraints || {})) {
    const c = cons.find((x) => x.id === id);
    if (!c) { note('spineAnimLeftOut', { anim: a.id, what: `constraint ${id}` }, `animation ${a.id}: constraint ${id} is not written (left out)`); continue; }
    const chans = c.type === 'ik' ? ['mix', 'bend'] : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
    const given = chans.filter((k) => Array.isArray(tracks[k]) && tracks[k].length);
    if (!given.length) continue;
    const times = [...new Set(given.flatMap((k) => seen(tracks[k]).map((x) => x[0])))].sort((x, y) => x - y);
    const curved = given.some((k) => tracks[k].some((x) => x[2] === 'smooth' || x[2] === 'bezier'));
    if (curved) note('spineCurveStraight', { anim: a.id, constraint: id }, `animation ${a.id}: constraint ${id}'s mix curves are written as straight lines between their keys`, 'info');
    const keys = times.map((t) => {
      const o = t ? { time: r6(t) } : {};
      for (const k of chans) {
        const v = tracks[k]?.length ? valueAt(tracks[k], t) : k === 'bend' ? (c.bend ?? 1) : (c[k] ?? 1);
        if (k === 'bend') { if (v < 0) o.bendPositive = false; } else o[k] = r6(v);
      }
      if (given.some((k) => tracks[k].find((x) => x[0] === t)?.[2] === 'step')) o.curve = 'stepped';
      return o;
    });
    (out[c.type === 'ik' ? 'ik' : 'transform'] ||= {})[id] = keys;
  }
  // colours: each part with the colour gets its slot's rgb (or rgb2 with the dark colour) keys, at all the channels' times
  for (const [cid, tracks] of Object.entries(a.colors || {})) {
    const base = colors.get(cid);
    if (!base) { note('spineAnimLeftOut', { anim: a.id, what: `colour ${cid}` }, `animation ${a.id}: colour ${cid} is not there (left out)`); continue; }
    const chans = Object.keys(tracks).filter((k) => Array.isArray(tracks[k]) && tracks[k].length);
    if (!chans.length) continue;
    const times = [...new Set(chans.flatMap((k) => seen(tracks[k]).map((x) => x[0])))].sort((x, y) => x - y);
    if (chans.some((k) => tracks[k].some((x) => x[2] === 'smooth' || x[2] === 'bezier'))) note('spineCurveStraight', { anim: a.id, color: cid }, `animation ${a.id}: colour ${cid}'s smooth keys are written as straight lines between its keys`, 'info');
    const two = colorOf(base).dark || chans.includes('dark') || chans.includes('screen');
    const keys = times.map((t) => {
      const at = Object.fromEntries(chans.map((k) => [k, [0, 1, 2].map((i) => valueAt(tracks[k].map((x) => [x[0], x[1][i], x[2]]), t))]));
      const c = colorOf(base, { ...Object.fromEntries(['tint', 'dark', 'multiply', 'screen'].map((k) => [k, base[k]])), ...at });
      const o = t ? { time: r6(t) } : {};
      if (two) { o.light = `${hex(c.light)}`; o.dark = hex(c.dark || [0, 0, 0]); } else o.color = hex(c.light);
      if (chans.some((k) => tracks[k].find((x) => x[0] === t)?.[2] === 'step')) o.curve = 'stepped';
      return o;
    });
    for (const p of parts) if (p.color === cid) ((out.slots ||= {})[p.id] ||= {})[two ? 'rgb2' : 'rgb'] = keys;
  }
  // draw order: Ugo9 draws by each part's order value (straight between keys); Spine keeps a list of slots and moves
  // them at given times. The order is worked out at every key time and wherever two values cross, and a key written
  // where it changes: each slot not in its setup place, by how far it moved (the others fill the gaps in their order)
  const orderTracks = Object.entries(a.order || {}).filter(([id, k]) => Array.isArray(k) && k.length && parts.some((p) => p.id === id));
  if (orderTracks.length) {
    const tr = new Map(orderTracks), setup = parts.map((p) => p.id), valueOf = (p, t) => (tr.has(p.id) ? valueAt(tr.get(p.id), t) : p.order ?? 500);
    const keyTimes = [...new Set(orderTracks.flatMap(([, k]) => seen(k).map((x) => x[0])))].sort((x, y) => x - y);
    const times = new Set([0, ...keyTimes]);
    // crossings: within each span between key times every value is a straight line
    for (let i = 0; i + 1 < keyTimes.length; i++) {
      const t0 = keyTimes[i], t1 = keyTimes[i + 1], e = 1e-9 * Math.max(1, t1);
      for (let x = 0; x < parts.length; x++) for (let y = x + 1; y < parts.length; y++) {
        if (!tr.has(parts[x].id) && !tr.has(parts[y].id)) continue;
        const d0 = valueOf(parts[x], t0 + e) - valueOf(parts[y], t0 + e), d1 = valueOf(parts[x], t1 - e) - valueOf(parts[y], t1 - e);
        if (d0 * d1 < 0) times.add(t0 + e + ((t1 - t0 - 2 * e) * d0) / (d0 - d1) + e);
      }
    }
    const orderAt = (t) => parts.map((p, i) => [valueOf(p, t), i, p.id]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
    const keys = [];
    let prev = setup.join('\u0000');
    for (const t of [...times].sort((x, y) => x - y)) {
      const now = orderAt(t), sig = now.join('\u0000');
      if (sig === prev) continue;
      prev = sig;
      const offsets = setup.map((id, i) => ({ slot: id, offset: now.indexOf(id) - i })).filter((o) => o.offset);
      keys.push({ ...(t ? { time: r6(t) } : {}), ...(offsets.length ? { offsets } : {}) });
    }
    if (keys.length) out.drawOrder = keys;
  }
  const left = ['tracks', 'morphs'].filter((k) => a[k] && Object.keys(a[k]).length);
  if (left.length) note('spineAnimLeftOut', { anim: a.id, what: left.join(', ') }, `animation ${a.id}: ${left.join(', ')} not written (Spine has no parameters; morphs come later)`, 'info');
  // the length: Spine's is its last key's time; a key at the end keeps a longer one
  const duration = a.duration || last;
  if (duration > last + 1e-9) {
    const root = ugoBones[0].id, tl = ((out.bones ||= {})[root] ||= {});
    if (!tl.rotate) tl.rotate = [{ value: 0 }];
    const lastKey = tl.rotate[tl.rotate.length - 1];
    tl.rotate.push({ time: r6(duration), value: lastKey.value ?? 0 });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [src, flag, out] = process.argv.slice(2);
  if (!src || flag !== '--out' || !out) { console.error('usage: node tools/export_spine.mjs model.json --out build/spine/name'); process.exit(2); }
  const model = JSON.parse(fs.readFileSync(src, 'utf8')), dir = path.dirname(src);
  const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) }); // the PNG's IHDR
  const textures = (model.textures || []).map((t) => pngSize(fs.readFileSync(path.join(dir, t))));
  const res = exportSpine(model, { textures });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(`${out}.json`, JSON.stringify(res.json, null, 1));
  fs.writeFileSync(`${out}.atlas`, res.atlas);
  for (const t of model.textures || []) fs.copyFileSync(path.join(dir, t), path.join(path.dirname(path.resolve(out)), path.basename(t)));
  for (const n of res.notes) console.log(`${n.level}: ${n.text}`);
  console.log(`${out}.json: ${res.json.bones.length} bones, ${res.json.slots.length} slots`);
}
