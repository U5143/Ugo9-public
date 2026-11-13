// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Spine -> Ugo9: reads a Spine skeleton export (.json, or a 3.8 binary .skel /
// .skel.bytes) and its texture atlas (.atlas / .atlas.txt + page images) and
// writes an Ugo9 authoring file and a compiled .ug9.
//
//   node tools/import_spine.mjs skeleton.json skeleton.atlas outDir [--scale 1] [--skin name]
//   importSpine(skel, atlasText, { scale, skin }) -> { model, warnings, pages, version, skins: { names, shown, hidden: { skin: [part ids] } } }
//   skin: the one shown (over the default skin, as Spine looks attachments up); the others' attachments come as hidden
//   parts named slot/attachment@skin, in their slot's place in the drawing order
//
// Written from Esoteric Software's published format descriptions
// (esotericsoftware.com/spine-json-format, spine-binary-format,
// spine-atlas-format) without using or reading the Spine Runtimes. Reads
// Spine 3.8 and 4.x key names.
//
// Supported: bones (with shear and transform inheritance), IK and transform
// constraints, slots in draw order, region / mesh (weighted or not) / linked
// mesh attachments of the default skin, attachment switching, slot alpha, and
// rotate / translate / scale / shear / deform timelines (Bezier curves are
// resampled into linear keys). Everything else is reported as a warning.

import fs from 'node:fs';
import path from 'node:path';
import { compileUgo } from './compile.mjs';
import { readSpineBinary, isSpineBinary } from './spine_binary.mjs';
import { poseWorld, INHERIT } from './skeleton_pose.mjs';

const DEG = Math.PI / 180;

// ---- atlas (libGDX text format, Spine 3.x and 4.x) ----------------------------------
export function parseAtlas(text) {
  const pages = [];
  let page = null, region = null, expectPage = true;
  const nums = (v) => v.split(',').map((x) => Number(x.trim()));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { expectPage = true; region = null; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) {
      if (expectPage || !page) {
        page = { name: line, width: 0, height: 0, regions: new Map(), pma: false };
        pages.push(page);
        expectPage = false;
      } else {
        region = { name: line, page, x: 0, y: 0, w: 0, h: 0, origW: 0, origH: 0, offX: 0, offY: 0, rotate: 0 };
        page.regions.set(line, region);
      }
      continue;
    }
    const key = line.slice(0, colon).trim(), val = line.slice(colon + 1).trim();
    if (!region) {
      if (key === 'size') [page.width, page.height] = nums(val);
      if (key === 'pma') page.pma = val === 'true';
      continue;
    }
    if (key === 'bounds') [region.x, region.y, region.w, region.h] = nums(val);   // 4.x
    else if (key === 'offsets') [region.offX, region.offY, region.origW, region.origH] = nums(val);
    else if (key === 'xy') [region.x, region.y] = nums(val);                     // 3.x
    else if (key === 'size') [region.w, region.h] = nums(val);
    else if (key === 'orig') [region.origW, region.origH] = nums(val);
    else if (key === 'offset') [region.offX, region.offY] = nums(val);
    else if (key === 'rotate') region.rotate = val === 'true' ? 90 : val === 'false' ? 0 : Number(val) || 0;
  }
  for (const p of pages) for (const r of p.regions.values()) {
    if (!r.origW) r.origW = r.w;
    if (!r.origH) r.origH = r.h;
  }
  return pages;
}

// ---- small 2D affine helpers (Ugo9 space: y down, angles clockwise on screen) -------------
const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const applyLinear = (M, x, y) => [M[0] * x + M[2] * y, M[1] * x + M[3] * y];

// ---- curves -----------------------------------------------------------------------------
function bezierAt(p0, p1, p2, p3, s) {
  const u = 1 - s;
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
}
/** Value at time t on a cubic Bezier from (t0,v0) to (t1,v1) with absolute control points. */
function bezierValue(t0, v0, cx1, cy1, cx2, cy2, t1, v1, t) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bezierAt(t0, cx1, cx2, t1, m) < t) lo = m; else hi = m; }
  return bezierAt(v0, cy1, cy2, v1, (lo + hi) / 2);
}

/**
 * Turns Spine keys into Ugo9 keys [time, value, interp] for one channel.
 * raw(key) reads the channel's value as Spine stores it; the curve is
 * evaluated in Spine's own values and map() converts every output value
 * (sign flips, scaling) afterwards. channel picks the 4 curve numbers of that
 * channel (Spine 4.x keeps 4 per channel; 3.8 one set for all). In 4.x the
 * control points are absolute time and value, except where the value is a
 * mix fraction (deform: fractionY). Bezier segments become 'bezier' keys
 * (format 1.1), or with bake straight pieces at 120 a second.
 */
function convertKeys(keys, raw, channel, v4, { map = (v) => v, fractionY = false, bake = false } = {}) {
  const out = [];
  const list = keys.map((k) => ({ t: k.time || 0, v: raw(k), curve: k.curve, k }));
  for (let i = 0; i < list.length; i++) {
    const a = list[i], b = list[i + 1];
    if (!b) { out.push([a.t, map(a.v), 'linear']); break; }
    if (a.curve === 'stepped') { out.push([a.t, map(a.v), 'step']); continue; }
    let c = null;
    if (Array.isArray(a.curve)) {
      const q = v4 ? a.curve.slice(channel * 4, channel * 4 + 4) : a.curve.slice(0, 4);
      if (q.length === 4) {
        const tx = (x) => (v4 ? x : a.t + x * (b.t - a.t));
        const vy = (y) => (v4 && !fractionY ? y : a.v + y * (b.v - a.v));
        c = [tx(q[0]), vy(q[1]), tx(q[2]), vy(q[3])];
      }
    } else if (typeof a.curve === 'number') { // 3.8: curve, c2, c3, c4 (normalized)
      const q = [a.curve, a.k.c2 ?? 0, a.k.c3 ?? 1, a.k.c4 ?? 1];
      c = [a.t + q[0] * (b.t - a.t), a.v + q[1] * (b.v - a.v), a.t + q[2] * (b.t - a.t), a.v + q[3] * (b.v - a.v)];
    }
    if (c && b.t > a.t && !bake) {
      // format 1.1: the curve as it is (cx: the fraction of the segment's time, cy: values; map is affine)
      out.push([a.t, map(a.v), 'bezier', (c[0] - a.t) / (b.t - a.t), map(c[1]), (c[2] - a.t) / (b.t - a.t), map(c[3])]);
      continue;
    }
    out.push([a.t, map(a.v), 'linear']);
    if (c && b.t > a.t) {
      // 120 samples a second keep the straight pieces within a few hundredths of a pixel
      const steps = Math.min(256, Math.max(4, Math.ceil((b.t - a.t) * 120)));
      for (let s = 1; s < steps; s++) {
        const t = a.t + ((b.t - a.t) * s) / steps;
        out.push([t, map(bezierValue(a.t, a.v, c[0], c[1], c[2], c[3], b.t, b.v, t)), 'linear']);
      }
    }
  }
  return out;
}

// a simple polygon (model space) -> triangles by cutting off ears (either winding)
function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n]; area += x0 * y1 - x1 * y0; }
  const sign = Math.sign(area) || 1, idx = Array.from({ length: n }, (_, i) => i), out = [];
  const cross = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
  const inside = (p, a, b, c) => sign * cross(a, b, p) >= 0 && sign * cross(b, c, p) >= 0 && sign * cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10 * n * n) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (sign * cross(a, b, c) <= 0) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      out.push(a, b, c); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(...idx);
  return out;
}

// ---- import -------------------------------------------------------------------------------
export function importSpine(skel, atlasText, { scale = 1, textureName, skin: shownSkin = 'default' } = {}) {
  const warnings = new Set();
  const warn = (w) => warnings.add(w);
  let rotateWrapped = 0, rotateWide = 0; // rotation keys more than 180° from the one before (3.x: turned the short way; 4.x: kept)
  const version = String(skel.skeleton?.spine || skel.skeleton?.version || '');
  const v4 = Number(version.split('.')[0]) >= 4;
  const pages = parseAtlas(atlasText);
  if (!pages.length) throw new Error('the atlas has no pages');
  if (pages.length > 1) warn(`the atlas has ${pages.length} pages; parts on pages after the first need multi-texture drawing (not in the Web renderer yet)`);
  const regionOf = (name) => {
    for (const p of pages) if (p.regions.has(name)) return p.regions.get(name);
    return null;
  };

  // bones (Spine is y up with counter-clockwise angles; Ugo9 is y down)
  const bones = (skel.bones || []).map((b) => {
    const mode = b.inherit || b.transform || 'normal';
    if (!(mode in INHERIT)) warn(`bone ${b.name}: unknown inherit mode "${mode}" (treated as normal)`);
    return {
      name: b.name, parent: b.parent ?? null,
      x: (b.x || 0) * scale, y: -(b.y || 0) * scale, rot: -(b.rotation || 0) * DEG,
      sx: b.scaleX ?? 1, sy: b.scaleY ?? 1, shx: -(b.shearX || 0) * DEG, shy: -(b.shearY || 0) * DEG,
      inherit: mode in INHERIT ? mode : 'normal', length: (b.length || 0) * scale,
    };
  });
  if (!bones.length) throw new Error('no bones');
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
  bones.forEach((b, i) => {
    if (b.parent != null && !(boneIndex.get(b.parent) < i)) throw new Error(`bone ${b.name}: unknown parent ${b.parent}`);
  });
  const B = (name, where) => {
    if (!boneIndex.has(name)) throw new Error(`${where}: unknown bone ${name}`);
    return boneIndex.get(name);
  };

  // constraints, in Spine's order; a mix that Spine leaves out is 1
  const constraints = [];
  for (const c of skel.ik || []) {
    if ((c.softness || 0) > 0) warn(`IK ${c.name}: softness is not supported yet (treated as 0)`);
    constraints.push({ order: c.order || 0, id: c.name, type: 'ik', bones: c.bones, target: c.target,
      mix: c.mix ?? 1, bend: c.bendPositive === false ? -1 : 1, compress: !!c.compress, stretch: !!c.stretch, uniform: !!c.uniform });
  }
  for (const c of skel.transform || []) {
    const mixX = c.mixX ?? c.translateMix ?? 1, mixSx = c.mixScaleX ?? c.scaleMix ?? 1;
    constraints.push({ order: c.order || 0, id: c.name, type: 'transform', bones: c.bones, target: c.target,
      local: !!c.local, relative: !!c.relative,
      rotation: -(c.rotation || 0), x: (c.x || 0) * scale, y: -(c.y || 0) * scale,
      scaleX: c.scaleX || 0, scaleY: c.scaleY || 0, shearY: -(c.shearY || 0),
      mixRotate: c.mixRotate ?? c.rotateMix ?? 1, mixX, mixY: c.mixY ?? mixX,
      mixScaleX: mixSx, mixScaleY: c.mixScaleY ?? mixSx, mixShearY: c.mixShearY ?? c.shearMix ?? 1 });
  }
  constraints.sort((a, b) => a.order - b.order);
  const constraintIds = new Map(constraints.map((c) => [c.id, c]));
  for (const c of constraints) { c.bones.forEach((n) => B(n, `constraint ${c.id}`)); B(c.target, `constraint ${c.id}`); }
  // path and physics constraints are not read (their workings are not in Spine's published format
  // description): say which bones each one would move, so the places that differ can be found
  const list = (names) => (names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', '));
  for (const c of skel.path || []) {
    const moved = c.bones || [];
    warn(`path constraint ${c.name}: not read; it moves bone${moved.length === 1 ? '' : 's'} ${list(moved)} along the path in slot ${c.target ?? '?'}, so ${moved.length === 1 ? 'it stays' : 'they stay'} in their own pose and the animations differ there`);
  }
  for (const c of skel.physics || []) {
    const moved = c.bones || (c.bone != null ? [c.bone] : []);
    warn(`physics constraint ${c.name}: not read; ${moved.length === 1 ? `bone ${moved[0]} does` : `bones ${list(moved) || '?'} do`} not sway (a chain can be added in the editor instead)`);
  }

  // the setup pose with inheritance and constraints (Spine binds meshes in this pose)
  const D = Math.PI / 180;
  const world = poseWorld(
    bones.map((b) => ({ parent: b.parent == null ? -1 : boneIndex.get(b.parent), inherit: INHERIT[b.inherit], length: b.length })),
    bones.map((b) => [b.x, b.y, b.rot, b.sx, b.sy, b.shx, b.shy]),
    constraints.map((c) => (c.type === 'ik'
      ? { type: 'ik', bones: c.bones.map((n) => boneIndex.get(n)), target: boneIndex.get(c.target), mix: c.mix, bend: c.bend, compress: c.compress, stretch: c.stretch, uniform: c.uniform }
      : { type: 'transform', bones: c.bones.map((n) => boneIndex.get(n)), target: boneIndex.get(c.target), local: c.local, relative: c.relative,
        offRot: c.rotation * D, offX: c.x, offY: c.y, offSx: c.scaleX, offSy: c.scaleY, offShy: c.shearY * D,
        mixRot: c.mixRotate, mixX: c.mixX, mixY: c.mixY, mixSx: c.mixScaleX, mixSy: c.mixScaleY, mixShear: c.mixShearY })),
  );
  // a point given in a bone's Spine-local space (y up) -> Ugo9 model space
  const toModel = (bi, x, y) => apply(world[bi], x * scale, -y * scale);
  const toModelDelta = (bi, dx, dy) => applyLinear(world[bi], dx * scale, -dy * scale);

  // skins (2026-11-10): the shown skin (opts.skin, the default skin by default) over the default skin, as Spine
  // looks an attachment up; every other skin's attachments come too, as hidden parts named slot/attachment@skin
  // (shown by opacity keys: there are no skins in Ugo9), in their slot's place in the drawing order
  const skins = Array.isArray(skel.skins) ? skel.skins.map((x) => ({ name: x.name, attachments: x.attachments || {} }))
    : Object.entries(skel.skins || {}).map(([name, attachments]) => ({ name, attachments: attachments || {} }));
  const skinOf = (name) => skins.find((x) => x.name === name)?.attachments || null;
  if (shownSkin !== 'default' && !skinOf(shownSkin)) throw new Error(`no skin named ${shownSkin} (the skeleton has ${skins.map((x) => x.name).join(', ') || 'none'})`);
  const skin = {}; // slot -> attachment -> the shown attachment
  for (const name of ['default', shownSkin]) for (const [slot, atts] of Object.entries(skinOf(name) || {})) Object.assign(skin[slot] ||= {}, atts);
  const otherSkins = skins.filter((x) => x.name !== 'default' && x.name !== shownSkin);
  if (otherSkins.length) warn(`skin ${shownSkin} shown; the other skins (${otherSkins.map((x) => x.name).join(', ')}) come as hidden parts named slot/attachment@skin (show them with opacity keys)`);

  // ---- draw order --------------------------------------------------------------------
  // Ugo9 draws every part in one fixed order. Each draw order an animation uses is
  // made from one sequence of slot copies: a slot that moves gets a copy at each
  // place it is drawn, and opacity tracks show the copy for the current order.
  const slotList = skel.slots || [];
  const slotIndex = new Map(slotList.map((sl, i) => [sl.name, i]));
  const orders = [slotList.map((_, i) => i)];
  const orderIds = new Map([[orders[0].join(','), 0]]);
  const animOrders = new Map(); // animation -> [{ t, id }]
  for (const [name, a] of Object.entries(skel.animations || {})) {
    const keys = a.drawOrder || a.draworder;
    if (!keys || !keys.length) continue;
    animOrders.set(name, keys.map((k) => {
      const order = drawOrderOf(k.offsets || [], slotIndex, slotList.length, (w) => warn(`animation ${name}: ${w}`));
      const key = order.join(',');
      if (!orderIds.has(key)) { orderIds.set(key, orders.length); orders.push(order); }
      return { t: k.time || 0, id: orderIds.get(key) };
    }));
  }
  const sequence = slotList.map((_, i) => ({ slot: i, copy: 0 }));
  const copies = slotList.map(() => 1);
  const orderCopy = [slotList.map(() => 0)]; // order -> slot -> copy drawn
  for (let o = 1; o < orders.length; o++) {
    const use = new Array(slotList.length).fill(0);
    let p = 0;
    for (const si of orders[o]) { // greedy: take the next copy of the slot, or insert one here
      let j = p;
      while (j < sequence.length && sequence[j].slot !== si) j++;
      if (j === sequence.length) { j = p; sequence.splice(j, 0, { slot: si, copy: copies[si]++ }); }
      use[si] = sequence[j].copy;
      p = j + 1;
    }
    orderCopy.push(use);
  }
  const extraCopies = sequence.length - slotList.length;
  if (extraCopies) warn(`draw order changes: ${extraCopies} slot copies added so every order can be drawn in one pass`);

  // slots -> parts (one part per attachment and slot copy, in draw order)
  // slot colours (2026-11-10): a slot whose colour is not white, has a dark colour, or has colour keys in an
  // animation gets a Ugo9 colour (tint / dark: the same rule as Spine's two-colour tint), shared by its parts
  const hexRgb = (h, d = 'ffffff') => { const x = String(h || d); return [0, 2, 4].map((k) => parseInt(x.slice(k, k + 2) || 'ff', 16) / 255); };
  const COLOR_TL = ['rgba', 'color', 'rgb', 'rgba2', 'rgb2', 'twoColor'];
  const slotColor = new Map(); // slot name -> colour id
  const colorList = [];
  for (const slot of slotList) {
    const tinted = String(slot.color || 'ffffffff').slice(0, 6).toLowerCase() !== 'ffffff', animated = Object.values(skel.animations || {}).some((a) => COLOR_TL.some((k) => {
      const tl = a.slots?.[slot.name]?.[k];
      return tl?.some((key) => String(key.color || key.light || 'ffffff').slice(0, 6).toLowerCase() !== 'ffffff' || key.dark);
    }));
    if (!tinted && !slot.dark && !animated) continue;
    slotColor.set(slot.name, slot.name);
    colorList.push({ id: slot.name, tint: hexRgb(slot.color), ...(slot.dark ? { dark: hexRgb(slot.dark, '000000') } : {}) });
  }
  const parts = [], clips = [];
  const partsBySlot = new Map();   // slot name -> { list: [{ key, partIndex, alpha, copy }], slotAlpha, setup, copies }
  const meshInfo = new Map();      // `${slot}/${key}` -> { partIndex, copies: [partIndex], influences, bone, vertexCount }
  for (const { slot: si, copy } of sequence) {
    const slot = slotList[si];
    if (!boneIndex.has(slot.bone)) throw new Error(`slot ${slot.name}: unknown bone ${slot.bone}`);
    const sb = boneIndex.get(slot.bone);
    const color = slot.color || 'ffffffff';
    const slotAlpha = parseInt(color.slice(6, 8) || 'ff', 16) / 255;
    // the slot's blend: Spine's additive, multiply and screen are Ugo9's add, multiply and screen
    const blend = { additive: 'add', multiply: 'multiply', screen: 'screen' }[slot.blend] || null;
    if (slot.blend && slot.blend !== 'normal' && !blend) warn(`slot ${slot.name}: blend mode "${slot.blend}" is not supported (drawn as normal)`);
    const atts = skin[slot.name] || {};
    const list = [];
    if (copy > 0) { /* a copy repeats the slot's parts without new warnings */ }
    // the shown attachments, then the other skins' (hidden, not switched by the animations)
    const entries = [...Object.entries(atts).map(([k, a]) => [k, a, null]),
      ...otherSkins.flatMap((sk) => Object.entries(sk.attachments[slot.name] || {}).map(([k, a]) => [k, a, sk.name]))];
    for (const [key, att0, otherSkin] of entries) {
      let att = att0;
      const type = att.type || 'region';
      if (type === 'linkedmesh') { // its parent in the skin it names (else where it is)
        const home = att.skin ? skinOf(att.skin)?.[slot.name] : otherSkin ? skinOf(otherSkin)[slot.name] : atts;
        const parent = home?.[att.parent] || atts[att.parent];
        if (!parent) { warn(`slot ${slot.name}: linked mesh ${key} points to ${att.parent}${att.skin ? ` in skin ${att.skin}` : ''}, which is not there (skipped)`); continue; }
        att = { ...parent, path: att.path || att.name || key, color: att.color || parent.color };
      } else if (type === 'clipping' && otherSkin) {
        warn(`slot ${slot.name}: clipping ${key} of skin ${otherSkin} (only the shown skin's clipping is used)`); continue;
      } else if (type === 'clipping') {
        // a clipping polygon (2026-11-10): a part that only masks (solid: the whole polygon), over the slots after this one
        // up to its end slot. Only the setup attachment clips (Ugo9's masks do not switch on and off)
        if (copy > 0) continue;
        if ((slot.attachment ?? null) !== key) { warn(`slot ${slot.name}: clipping ${key} is not the setup attachment (not used)`); continue; }
        const n = att.vertexCount || (att.vertices || []).length / 2, verts = att.vertices || [], pts = [], weights = [];
        if (verts.length === 2 * n) for (let i = 0; i < n; i++) pts.push(toModel(sb, verts[2 * i], verts[2 * i + 1]));
        else {
          let o = 0;
          for (let i = 0; i < n; i++) {
            const count = verts[o++], w = [];
            let px = 0, py = 0;
            for (let j = 0; j < count; j++, o += 4) { const [mx, my] = toModel(verts[o], verts[o + 1], verts[o + 2]); px += verts[o + 3] * mx; py += verts[o + 3] * my; w.push([bones[verts[o]].name, verts[o + 3]]); }
            pts.push([px, py]); weights.push(w);
          }
        }
        const triangles = triangulate(pts);
        if (!triangles.length) { warn(`slot ${slot.name}: clipping ${key} has no area (not used)`); continue; }
        const part = { id: `${slot.name}/${key}`, texture: 0, opacity: 1, maskOnly: true, solid: true, vertices: pts.flat(), uvs: new Array(2 * n).fill(0), triangles, ...(weights.length ? { weights } : { bone: slot.bone }) };
        clips.push({ partIndex: parts.length, from: si, end: att.end ?? null, where: `${slot.name}/${key}` });
        parts.push(part);
        continue;
      } else if (type !== 'region' && type !== 'mesh') {
        warn(`slot ${slot.name}: ${type} attachment "${key}" is not supported (skipped)`);
        continue;
      }
      const regionName = att.path || att.name || key;
      const reg = regionOf(regionName);
      if (!reg) { warn(`slot ${slot.name}: atlas region "${regionName}" not found (skipped)`); continue; }
      const pw = reg.page.width, ph = reg.page.height;
      // original (unstripped) image coordinates (y down, 0..1) -> page UV. A rotated
      // region was turned counter-clockwise by `rotate` degrees when packed; its
      // size (w, h) is the unrotated size (checked against real 3.8 atlases).
      const rot = ((reg.rotate % 360) + 360) % 360;
      if (rot % 90) warn(`atlas region "${regionName}" is rotated by ${reg.rotate} degrees; only multiples of 90 are supported`);
      const uvOf = (u, v) => {
        const px = u * reg.origW - reg.offX, py = v * reg.origH - (reg.origH - reg.offY - reg.h);
        const [qx, qy] = rot === 90 ? [py, reg.w - px] : rot === 180 ? [reg.w - px, reg.h - py] : rot === 270 ? [reg.h - py, px] : [px, py];
        return [(reg.x + qx) / pw, (reg.y + qy) / ph];
      };
      const attColor = att.color || 'ffffffff';
      const alpha = slotAlpha * (parseInt(attColor.slice(6, 8) || 'ff', 16) / 255);
      const visible = !otherSkin && (slot.attachment ?? null) === key && copy === 0;
      const part = { id: `${slot.name}${copy ? '~' + copy : ''}/${key}${otherSkin ? '@' + otherSkin : ''}`, texture: pages.indexOf(reg.page), opacity: visible ? alpha : 0, vertices: [], uvs: [], triangles: [], ...(blend ? { blend } : {}), ...(slotColor.has(slot.name) ? { color: slotColor.get(slot.name) } : {}) };
      let influences = null;
      if (type === 'region') {
        // quad of the stripped area inside the attachment's rectangle
        const w = att.width || reg.origW, h = att.height || reg.origH;
        const fx0 = reg.offX / reg.origW, fx1 = (reg.offX + reg.w) / reg.origW;
        const fy0 = reg.offY / reg.origH, fy1 = (reg.offY + reg.h) / reg.origH; // from the bottom, y up
        const r = (att.rotation || 0) * DEG, c = Math.cos(r), s = Math.sin(r);
        const sx = att.scaleX ?? 1, sy = att.scaleY ?? 1;
        const corner = (fx, fy) => { // y up, in the bone's space
          const lx = (fx - 0.5) * w * sx, ly = (fy - 0.5) * h * sy;
          return toModel(sb, (att.x || 0) + c * lx - s * ly, (att.y || 0) + s * lx + c * ly);
        };
        const corners = [[fx0, fy1], [fx1, fy1], [fx1, fy0], [fx0, fy0]]; // top-left, top-right, bottom-right, bottom-left
        for (const [fx, fy] of corners) {
          part.vertices.push(...corner(fx, fy));
          part.uvs.push(...uvOf(fx, 1 - fy));
        }
        part.triangles.push(0, 1, 2, 0, 2, 3);
        part.bone = slot.bone;
      } else {
        const uvs = att.uvs || [], verts = att.vertices || [], n = uvs.length / 2;
        for (let i = 0; i < n; i++) part.uvs.push(...uvOf(uvs[2 * i], uvs[2 * i + 1]));
        part.triangles = [...(att.triangles || [])];
        if (verts.length === uvs.length) { // unweighted: x, y in the slot bone's space
          for (let i = 0; i < n; i++) part.vertices.push(...toModel(sb, verts[2 * i], verts[2 * i + 1]));
          part.bone = slot.bone;
        } else { // weighted: count, then (bone, x, y, weight) per influence
          influences = [];
          part.weights = [];
          let o = 0;
          for (let i = 0; i < n; i++) {
            const count = verts[o++];
            let px = 0, py = 0;
            const inf = [];
            for (let j = 0; j < count; j++) {
              const bi = verts[o], x = verts[o + 1], y = verts[o + 2], wgt = verts[o + 3];
              o += 4;
              if (bi >= bones.length) throw new Error(`mesh ${key}: bone index ${bi} out of range`);
              const [mx, my] = toModel(bi, x, y);
              px += wgt * mx; py += wgt * my;
              inf.push([bi, wgt]);
            }
            influences.push(inf);
            part.vertices.push(px, py);
            part.weights.push(inf.map(([bi, wgt]) => [bones[bi].name, wgt]));
          }
        }
      }
      const mk = `${slot.name}/${key}${otherSkin ? '@' + otherSkin : ''}`;
      if (!meshInfo.has(mk)) meshInfo.set(mk, { partIndex: parts.length, copies: [], influences, bone: sb, vertexCount: part.vertices.length / 2 });
      meshInfo.get(mk).copies.push(parts.length);
      if (!otherSkin) list.push({ key, partIndex: parts.length, alpha: att.color ? parseInt(attColor.slice(6, 8) || 'ff', 16) / 255 : 1, copy });
      parts.push(part);
    }
    if (!partsBySlot.has(slot.name)) partsBySlot.set(slot.name, { list: [], slotAlpha, setup: slot.attachment ?? null, copies: copies[si], index: si });
    partsBySlot.get(slot.name).list.push(...list);
  }

  // clipping: each part of the slots after the clipping slot, up to its end slot, is masked by the polygon
  for (const c of clips) {
    const endIndex = c.end != null ? slotList.findIndex((x) => x.name === c.end) : slotList.length - 1;
    if (endIndex < 0) warn(`clipping ${c.where}: its end slot ${c.end} is not there (clips to the last slot)`);
    const last = endIndex < 0 ? slotList.length - 1 : endIndex;
    for (let si = c.from + 1; si <= last; si++) for (const e of partsBySlot.get(slotList[si].name)?.list || []) {
      const p = parts[e.partIndex];
      if (p.mask) warn(`part ${p.id}: inside two clippings (only the first is kept)`);
      else p.mask = [parts[c.partIndex].id];
    }
  }
  if (clips.length && Object.values(skel.animations || {}).some((a) => a.drawOrder || a.draworder)) warn('clipping with a draw order timeline: the clipping follows the setup order only');

  // ---- animations ------------------------------------------------------------------------
  const deformers = [];
  const animations = [];
  for (const [name, a] of Object.entries(skel.animations || {})) {
    const out = { id: name, loop: true, bones: {}, opacity: {}, morphs: {}, constraints: {} };
    let duration = 0;
    const seen = (keys) => { for (const k of keys) duration = Math.max(duration, k[0]); return keys; };
    for (const kind of ['path', 'physics']) {
      const keyed = Object.keys(a[kind] || {});
      if (keyed.length) warn(`animation ${name}: keys of the ${kind} constraint${keyed.length === 1 ? '' : 's'} ${keyed.join(', ')} are not read`);
    }

    for (const [bname, tl] of Object.entries(a.bones || {})) {
      if (!boneIndex.has(bname)) { warn(`animation ${name}: unknown bone ${bname}`); continue; }
      const b = bones[boneIndex.get(bname)];
      const tracks = out.bones[bname] = {};
      for (const [type, keys] of Object.entries(tl)) {
        // Spine: rotate (degrees, counter-clockwise, y up) and translate are added to the
        // setup pose, scale multiplies it. Ugo9 tracks are offsets in y-down space.
        const flipY = { map: (v) => -v * scale }, sx = { map: (v) => b.sx * (v - 1) }, sy = { map: (v) => b.sy * (v - 1) };
        if (type === 'rotate') {
          // 3.x turns between two keys the short way (the data's turns of more than 180° between
          // neighbouring keys are nearly all a few degrees the other way, at the speed of the rest):
          // each key is moved by whole turns to within 180° of the one before (3.x curves are fractions
          // of the change, so they follow). 4.x keeps the values as they are, with a word of how many
          const angle = new Map();
          let prev = null;
          for (const k of keys) {
            const raw = k.value ?? k.angle ?? 0;
            let v = raw;
            if (prev !== null && Math.abs(raw - prev) > 180) {
              if (v4) rotateWide++;
              else { v = prev + ((((raw - prev) % 360) + 540) % 360) - 180; rotateWrapped++; }
            }
            angle.set(k, v);
            prev = v;
          }
          tracks.rotate = seen(convertKeys(keys, (k) => angle.get(k), 0, v4, { map: (v) => -v }));
        }
        else if (type === 'translate') {
          tracks.x = seen(convertKeys(keys, (k) => k.x ?? 0, 0, v4, { map: (v) => v * scale }));
          tracks.y = seen(convertKeys(keys, (k) => k.y ?? 0, 1, v4, flipY));
        } else if (type === 'translatex') tracks.x = seen(convertKeys(keys, (k) => k.value ?? 0, 0, v4, { map: (v) => v * scale }));
        else if (type === 'translatey') tracks.y = seen(convertKeys(keys, (k) => k.value ?? 0, 0, v4, flipY));
        else if (type === 'scale') {
          tracks.scaleX = seen(convertKeys(keys, (k) => k.x ?? 1, 0, v4, sx));
          tracks.scaleY = seen(convertKeys(keys, (k) => k.y ?? 1, 1, v4, sy));
        } else if (type === 'scalex') tracks.scaleX = seen(convertKeys(keys, (k) => k.value ?? 1, 0, v4, sx));
        else if (type === 'scaley') tracks.scaleY = seen(convertKeys(keys, (k) => k.value ?? 1, 0, v4, sy));
        else if (type === 'shear') {
          // degrees added to the setup shear; negated like rotation
          tracks.shearX = seen(convertKeys(keys, (k) => k.x ?? 0, 0, v4, { map: (v) => -v }));
          tracks.shearY = seen(convertKeys(keys, (k) => k.y ?? 0, 1, v4, { map: (v) => -v }));
        } else if (type === 'shearx') tracks.shearX = seen(convertKeys(keys, (k) => k.value ?? 0, 0, v4, { map: (v) => -v }));
        else if (type === 'sheary') tracks.shearY = seen(convertKeys(keys, (k) => k.value ?? 0, 0, v4, { map: (v) => -v }));
        else warn(`animation ${name}: bone ${type} timelines are not supported`);
      }
    }

    // slots: attachment switching, alpha and draw order -> one opacity track per part
    const doKeys = animOrders.get(name) || null;
    const slotNamesHere = new Set(Object.keys(a.slots || {}));
    if (doKeys) for (const [sname, info] of partsBySlot) if (info.copies > 1) slotNamesHere.add(sname);
    for (const sname of slotNamesHere) {
      const info = partsBySlot.get(sname);
      if (!info) continue;
      const tl = (a.slots || {})[sname] || {};
      const attKeys = tl.attachment || null;
      let alphaKeys = null;
      if (tl.alpha) alphaKeys = convertKeys(tl.alpha, (k) => k.value ?? 1, 0, v4);
      const colorTl = tl.rgba || tl.color;
      const twoTl = tl.rgba2 || tl.twoColor; // two colours: the light one's alpha is the slot's
      if (!colorTl && twoTl) alphaKeys = convertKeys(twoTl, (k) => parseInt(String(k.light || 'ffffffff').slice(6, 8) || 'ff', 16) / 255, 3, v4);
      if (colorTl) {
        alphaKeys = convertKeys(colorTl, (k) => parseInt(String(k.color || 'ffffffff').slice(6, 8) || 'ff', 16) / 255, 3, v4);
      }
      if (slotColor.has(sname)) {
        // colour keys: each channel as its own curve (sampled into straight keys: colours have no curve keys), then joined
        const ch = (keys, field, off, n = 3) => {
          const per = [0, 1, 2].map((c) => convertKeys(keys, (k) => hexRgb(k[field], field === 'dark' ? '000000' : 'ffffff')[c], off + c, v4, { bake: true }));
          return per[0].map((k, i) => [k[0], [0, 1, 2].map((c) => per[c][i]?.[1] ?? per[c].at(-1)[1]), k[2] === 'step' ? 'step' : 'linear']);
        };
        const two = tl.rgba2 || tl.rgb2 || tl.twoColor, one = tl.rgba || tl.color || tl.rgb, c = {};
        if (two) { c.tint = ch(two, 'light', 0); c.dark = ch(two, 'dark', tl.rgb2 ? 3 : 4); }
        else if (one) c.tint = ch(one, 'color', 0);
        if (c.tint) (out.colors ||= {})[slotColor.get(sname)] = c;
      }
      const moves = doKeys && info.copies > 1;
      if (!attKeys && !alphaKeys && !moves) continue;
      const attachmentAt = (t) => {
        if (!attKeys) return info.setup;
        let cur = info.setup;
        for (const k of attKeys) if ((k.time || 0) <= t) cur = k.name ?? null;
        return cur;
      };
      const copyAt = (t) => {
        if (!moves) return 0;
        let id = 0;
        for (const k of doKeys) if (k.t <= t) id = k.id;
        return orderCopy[id][info.index];
      };
      // the alpha keys' segments: [t0, v0, t1, v1, mode, curve handles (format 1.1) or null]
      const segs = [];
      if (alphaKeys) for (let i = 0; i + 1 < alphaKeys.length; i++) {
        const [t0, v0, mode, cx1, cy1, cx2, cy2] = alphaKeys[i], [t1, v1] = alphaKeys[i + 1];
        segs.push({ t0, v0, t1, v1, mode, c: mode === 'bezier' ? [t0 + cx1 * (t1 - t0), cy1, t0 + cx2 * (t1 - t0), cy2] : null });
      }
      const segAt = (t) => { let g = null; for (const x of segs) { if (x.t0 <= t && t < x.t1) g = x; } return g; };
      const valueIn = (g, t) => (g.mode === 'step' || t <= g.t0 ? g.v0 : g.c ? bezierValue(g.t0, g.v0, g.c[0], g.c[1], g.c[2], g.c[3], g.t1, g.v1, t) : g.v0 + ((g.v1 - g.v0) * (t - g.t0)) / (g.t1 - g.t0));
      // alpha at t, and just before t (where a step or a jump ends)
      const alphaAt = (t) => {
        if (!alphaKeys) return info.slotAlpha;
        if (t < alphaKeys[0][0]) return alphaKeys[0][1];
        const g = segAt(t);
        return g ? valueIn(g, t) : alphaKeys[alphaKeys.length - 1][1];
      };
      const alphaBefore = (t) => {
        if (!alphaKeys) return info.slotAlpha;
        let g = null;
        for (const x of segs) if (x.t0 < t && t <= x.t1) g = x;
        return g ? (t === g.t1 && g.mode !== 'step' ? g.v1 : valueIn(g, t)) : alphaAt(t);
      };
      const times = new Set([0]);
      for (const k of attKeys || []) times.add(k.time || 0);
      for (const k of alphaKeys || []) times.add(k[0]);
      if (moves) for (const k of doKeys) times.add(k.t);
      // a curve cut by another key (an attachment or draw order change inside it): straight pieces there
      for (const g of segs) if (g.c && [...times].some((t) => t > g.t0 && t < g.t1)) {
        g.cut = true;
        const steps = Math.min(256, Math.max(4, Math.ceil((g.t1 - g.t0) * 120)));
        for (let k = 1; k < steps; k++) times.add(g.t0 + ((g.t1 - g.t0) * k) / steps);
      }
      // the curve (handles in opacity: times as fractions, values times the part's alpha) of a piece t0..t1 that is a whole uncut alpha curve
      const curveFrom = (t0, t1, scale) => {
        const g = segs.find((x) => x.t0 === t0 && x.t1 === t1 && x.c && !x.cut);
        return g ? ['bezier', (g.c[0] - t0) / (t1 - t0), g.c[1] * scale, (g.c[2] - t0) / (t1 - t0), g.c[3] * scale] : null;
      };
      const sorted = [...times].sort((x, y) => x - y);
      for (const { key, partIndex, alpha, copy } of info.list) {
        if (copy > 0 && !moves) continue; // stays hidden (its rest opacity is 0)
        out.opacity[parts[partIndex].id] = seen(opacityKeys(sorted, (t) => attachmentAt(t) === key && copyAt(t) === copy, alphaAt, alphaBefore, curveFrom, alpha));
      }
    }

    // constraint mixes over time
    for (const [cname, keys] of Object.entries(a.ik || {})) {
      if (!constraintIds.has(cname)) { warn(`animation ${name}: unknown IK ${cname}`); continue; }
      const tracks = (out.constraints[cname] = {});
      tracks.mix = seen(convertKeys(keys, (k) => k.mix ?? 1, 0, v4));
      if (keys.some((k) => k.bendPositive === false) !== keys.every((k) => k.bendPositive === false)) {
        tracks.bend = seen(keys.map((k) => [k.time || 0, k.bendPositive === false ? -1 : 1, 'step']));
      } else if (keys.length && (keys[0].bendPositive === false ? -1 : 1) !== constraintIds.get(cname).bend) {
        tracks.bend = seen([[0, keys[0].bendPositive === false ? -1 : 1, 'step']]);
      }
      if (keys.some((k) => (k.softness || 0) > 0)) warn(`animation ${name}: IK softness keys are not supported yet`);
    }
    for (const [cname, keys] of Object.entries(a.transform || {})) {
      if (!constraintIds.has(cname)) { warn(`animation ${name}: unknown transform constraint ${cname}`); continue; }
      const tracks = (out.constraints[cname] = {});
      if (v4) {
        tracks.mixRotate = seen(convertKeys(keys, (k) => k.mixRotate ?? 1, 0, v4, { fractionY: false }));
        tracks.mixX = seen(convertKeys(keys, (k) => k.mixX ?? 1, 1, v4));
        tracks.mixY = seen(convertKeys(keys, (k) => k.mixY ?? k.mixX ?? 1, 2, v4));
        tracks.mixScaleX = seen(convertKeys(keys, (k) => k.mixScaleX ?? 1, 3, v4));
        tracks.mixScaleY = seen(convertKeys(keys, (k) => k.mixScaleY ?? k.mixScaleX ?? 1, 4, v4));
        tracks.mixShearY = seen(convertKeys(keys, (k) => k.mixShearY ?? 1, 5, v4));
      } else {
        tracks.mixRotate = seen(convertKeys(keys, (k) => k.rotateMix ?? 1, 0, v4));
        tracks.mixX = seen(convertKeys(keys, (k) => k.translateMix ?? 1, 0, v4));
        tracks.mixY = tracks.mixX;
        tracks.mixScaleX = seen(convertKeys(keys, (k) => k.scaleMix ?? 1, 0, v4));
        tracks.mixScaleY = tracks.mixScaleX;
        tracks.mixShearY = seen(convertKeys(keys, (k) => k.shearMix ?? 1, 0, v4));
      }
    }
    if (a.events && a.events.length) warn('events are not imported (they do not change the picture)');

    // deform: one morph per key, weights cross-fade between neighbouring keys
    const deformRoot = a.deform || null;
    const attRoot = a.attachments || null; // 4.1+: attachments/<skin>/<slot>/<attachment>/deform
    const deformEntries = [];
    if (deformRoot) for (const [sk, slots] of Object.entries(deformRoot)) for (const [sname, atts] of Object.entries(slots)) for (const [aname, keys] of Object.entries(atts)) deformEntries.push([sk, sname, aname, keys]);
    if (attRoot) for (const [sk, slots] of Object.entries(attRoot)) for (const [sname, atts] of Object.entries(slots)) for (const [aname, tls] of Object.entries(atts)) {
      if (tls.deform) deformEntries.push([sk, sname, aname, tls.deform]);
      if (tls.sequence) warn(`animation ${name}: sequence timelines are not supported`);
    }
    for (const [sk, sname, aname, keys] of deformEntries) {
      if (sk !== 'default' && sk !== shownSkin) { warn(`animation ${name}: deform keys for skin "${sk}" skipped (not the shown skin)`); continue; }
      const mi = meshInfo.get(`${sname}/${aname}`);
      if (!mi) { warn(`animation ${name}: deform for unknown mesh ${sname}/${aname}`); continue; }
      const morphIds = keys.map((k, ki) => {
        const id = `${name}/${sname}/${aname}#${ki}`;
        const flat = new Array(2 * mi.vertexCount).fill(0);
        const vals = k.vertices || [];
        const off = k.offset || 0;
        if (!mi.influences) { // unweighted: x, y offsets per vertex in the bone's space
          for (let i = 0; i + 1 < vals.length; i += 2) {
            const vi = (off + i) / 2;
            const [dx, dy] = toModelDelta(mi.bone, vals[i], vals[i + 1]);
            flat[2 * vi] = dx; flat[2 * vi + 1] = dy;
          }
        } else { // weighted: x, y offsets per influence, in that influence's bone space
          const full = new Array(off).fill(0).concat(vals);
          let o = 0;
          mi.influences.forEach((inf, vi) => {
            let dx = 0, dy = 0;
            for (const [bi, wgt] of inf) {
              const [ex, ey] = toModelDelta(bi, full[o] || 0, full[o + 1] || 0);
              dx += wgt * ex; dy += wgt * ey;
              o += 2;
            }
            flat[2 * vi] = dx; flat[2 * vi + 1] = dy;
          });
        }
        const dense = flat.map((v) => +v.toFixed(4));
        deformers.push({ id, morphs: Object.fromEntries(mi.copies.map((pi) => [parts[pi].id, { dense }])) });
        return id;
      });
      morphIds.forEach((id, ki) => {
        const ks = convertKeys(keys.map((k, kj) => ({ ...k, w: kj === ki ? 1 : 0 })), (k) => k.w, 0, v4, { fractionY: true });
        out.morphs[id] = seen(ks);
      });
    }

    for (const kind of ['path', 'physics']) {
      if (a[kind] && Object.keys(a[kind]).length) warn(`animation ${name}: ${kind} timelines are not supported`);
    }
    out.duration = duration;
    animations.push(out);
  }

  // canvas from the setup-pose bounds (y up, bottom-left) with a margin
  const sk = skel.skeleton || {};
  const margin = 16;
  let canvas;
  if (sk.width && sk.height && sk.x !== undefined && sk.y !== undefined) { // 3.8+ write the bounds' corner too
    canvas = { width: sk.width * scale + 2 * margin, height: sk.height * scale + 2 * margin, originX: -(sk.x || 0) * scale + margin, originY: ((sk.y || 0) + sk.height) * scale + margin };
  } else {
    const shown = parts.filter((p) => p.opacity > 0);
    const src = shown.length ? shown : parts;
    const xs = src.flatMap((p) => p.vertices.filter((_, i) => i % 2 === 0)), ys = src.flatMap((p) => p.vertices.filter((_, i) => i % 2 === 1));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    canvas = { width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin, originX: -minX + margin, originY: -minY + margin };
  }

  // how far each bone reaches: the farthest vertex it moves (its own, its children's), from its
  // setup origin. Its keys are thinned so that what is dropped moves those vertices at most
  // PIXEL px (a rotation of a bone that reaches 500 px may drop 0.006°; one that reaches 20 px, 0.05°)
  const reach = new Float64Array(bones.length), origin = bones.map((_, i) => toModel(i, 0, 0));
  const parentOf = bones.map((b) => (b.parent == null ? -1 : boneIndex.get(b.parent)));
  for (const part of parts) {
    const v = part.vertices;
    for (let i = 0; i < v.length / 2; i++) {
      const own = part.weights ? part.weights[i].map(([n]) => boneIndex.get(n)) : [boneIndex.get(part.bone)];
      for (const b0 of own) for (let b = b0; b >= 0 && b !== undefined; b = parentOf[b]) {
        const d = Math.hypot(v[2 * i] - origin[b][0], v[2 * i + 1] - origin[b][1]);
        if (d > reach[b]) reach[b] = d;
      }
    }
  }
  // a move of 1 in a bone's x / y is a move of `stretch` px on screen (its parent's scale)
  const stretch = parentOf.map((p) => (p < 0 ? scale : Math.max(Math.hypot(...toModelDelta(p, 1, 0)), Math.hypot(...toModelDelta(p, 0, 1)))));
  // the bones a constraint reads or bends (its target, its bones, and their parents up to the
  // root) keep the fine tolerance: an IK chain near straight swings far for a small move of its
  // target or of the bone it hangs from
  const fine = new Set(constraints.flatMap((c) => [c.target, ...c.bones]));
  for (const n of [...fine]) for (let b = boneIndex.get(n); b !== undefined && b >= 0; b = parentOf[b]) fine.add(bones[b].name);
  const tolerance = new Map(bones.map((b, i) => [b.name, fine.has(b.name) ? FINE : boneTolerance(reach[i], stretch[i])]));

  const model = {
    format: 'ugo9', version: '0.2',
    canvas,
    textures: pages.map((p, i) => (i === 0 && textureName ? textureName : p.name)),
    parameters: [],
    bones: bones.map((b) => {
      const o = { id: b.name, parent: b.parent, x: b.x, y: b.y, rotation: b.rot / DEG, scaleX: b.sx, scaleY: b.sy };
      if (b.shx) o.shearX = b.shx / DEG;
      if (b.shy) o.shearY = b.shy / DEG;
      if (b.inherit !== 'normal') o.inherit = b.inherit;
      if (b.length) o.length = b.length;
      return o;
    }),
    constraints: constraints.map(({ order, ...c }) => c),
    ...(colorList.length ? { colors: colorList } : {}),
    parts,
    deformers,
    animations: animations.map((a) => {
      const clean = { id: a.id, duration: a.duration, loop: a.loop };
      if (Object.keys(a.bones).length) clean.bones = Object.fromEntries(Object.entries(a.bones).filter(([, v]) => Object.keys(v).length));
      if (Object.keys(a.opacity).length) clean.opacity = a.opacity;
      if (Object.keys(a.morphs).length) clean.morphs = a.morphs;
      if (Object.keys(a.constraints).length) clean.constraints = a.constraints;
      if (a.colors && Object.keys(a.colors).length) clean.colors = a.colors;
      simplifyAnimation(clean, tolerance);
      return clean;
    }),
  };
  if (rotateWrapped) warn(`${rotateWrapped} rotation key(s) more than 180° from the key before: turned the short way, as Spine 3.x does`);
  if (rotateWide) warn(`${rotateWide} rotation key(s) more than 180° from the key before: kept as they are (Spine 4.x)`);
  // the skins: their names, the one shown, and each other skin's hidden parts
  const skinParts = Object.fromEntries(otherSkins.map((sk) => [sk.name, parts.filter((p) => p.id.endsWith('@' + sk.name)).map((p) => p.id)]));
  return { model, warnings: [...warnings], pages, version, skins: { names: skins.map((x) => x.name), shown: shownSkin, hidden: skinParts } };
}

// Opacity keys for one part, jumping instantly where it becomes shown or hidden
// (attachment switches and draw order changes).
function opacityKeys(times, visibleAt, alphaAt, alphaBefore, curveFrom, alpha) {
  const out = [];
  let prevVis = null;
  for (let i = 0; i < times.length; i++) {
    const t = times[i], vis = visibleAt(t);
    const v = (vis ? 1 : 0) * alphaAt(t) * alpha;
    if (prevVis !== null) {
      // the value just before t (the old visibility, the alpha coming in), then the new one at t
      const before = (prevVis ? 1 : 0) * alphaBefore(t) * alpha;
      if (before !== v) out.push([t, before, 'linear']);
    }
    // a whole alpha curve while the part shows: kept as a curve (format 1.1)
    const c = vis && i + 1 < times.length ? curveFrom(t, times[i + 1], alpha) : null;
    out.push(c ? [t, v, ...c] : [t, v, 'linear']);
    prevVis = vis;
  }
  return out;
}

// Spine draw order key -> slot indices in drawing order. Listed slots move by
// their offset from the setup order; the others keep their order in the gaps.
function drawOrderOf(offsets, slotIndex, n, warn) {
  const order = new Array(n).fill(-1);
  const moved = new Set();
  for (const { slot, offset } of offsets) {
    const si = slotIndex.get(slot);
    const to = si + (offset || 0);
    if (si === undefined || to < 0 || to >= n || order[to] !== -1) { warn(`bad draw order offset for slot ${slot} (ignored)`); continue; }
    order[to] = si;
    moved.add(si);
  }
  let k = 0;
  for (let si = 0; si < n; si++) {
    if (moved.has(si)) continue;
    while (order[k] !== -1) k++;
    order[k] = si;
  }
  return order;
}

// Drops keys that the straight line through their neighbours already gives
// (resampled curves produce many), keeping step keys and instant jumps.
// How much a thinned key may be off: at most PIXEL px at the farthest vertex the bone moves, and
// never more than TOLERANCE (degrees for rotate / shear, units of the parent's space for x / y)
const TOLERANCE = { rotate: 0.05, x: 0.05, y: 0.05, scaleX: 1e-4, scaleY: 1e-4, shearX: 0.05, shearY: 0.05 };
const PIXEL = 0.05;
const FINE = { rotate: 0.005, x: 0.005, y: 0.005, scaleX: 1e-5, scaleY: 1e-5, shearX: 0.005, shearY: 0.005 }; // the tolerance before 0.7
function boneTolerance(reach, stretch) {
  const t = { ...TOLERANCE };
  if (stretch > 0) t.x = t.y = Math.min(TOLERANCE.x, PIXEL / stretch);
  if (reach > 0) {
    const deg = Math.min(TOLERANCE.rotate, (PIXEL / reach) * (180 / Math.PI)), sc = Math.min(TOLERANCE.scaleX, PIXEL / reach);
    Object.assign(t, { rotate: deg, shearX: deg, shearY: deg, scaleX: sc, scaleY: sc });
  }
  return t;
}
export function simplifyKeys(keys, tol) {
  // a curve (format 1.1) that leaves its keys' value is kept; one that stays flat is a straight line
  const bends = (k) => k[2] === 'bezier' && (Math.abs(k[4] - k[1]) > tol || Math.abs(k[6] - k[1]) > tol);
  keys = keys.map((k, i) => (k[2] === 'bezier' && !bends(k) && keys[i + 1] && Math.abs(keys[i + 1][1] - k[1]) <= tol ? [k[0], k[1], 'linear'] : k));
  if (keys.length <= 2) {
    if (keys.length === 2 && keys[0][1] === keys[1][1] && keys[0][2] !== 'step' && !bends(keys[0])) return [keys[0]];
    return keys;
  }
  if (keys.every((k) => Math.abs(k[1] - keys[0][1]) <= tol && !bends(k))) return [[keys[0][0], keys[0][1], 'linear']];
  const out = [keys[0]];
  let a = 0;
  while (a < keys.length - 1) {
    let best = a + 1;
    if (keys[a][2] !== 'step' && keys[a][2] !== 'bezier') {
      for (let i = a + 2; i < keys.length; i++) {
        const [ta, va] = keys[a], [ti, vi] = keys[i];
        if (!(ti > ta) || keys[i - 1][2] === 'step' || keys[i - 1][2] === 'bezier') break;
        let ok = true;
        for (let j = a + 1; j < i && ok; j++) {
          const [tj, vj] = keys[j];
          ok = Math.abs(va + ((vi - va) * (tj - ta)) / (ti - ta) - vj) <= tol;
        }
        if (!ok) break;
        best = i;
      }
    }
    out.push(keys[best]);
    a = best;
  }
  return out;
}

function simplifyAnimation(a, tolerance) {
  for (const [bone, tracks] of Object.entries(a.bones || {})) {
    const tol = tolerance.get(bone) || TOLERANCE;
    for (const [k, keys] of Object.entries(tracks)) tracks[k] = simplifyKeys(keys, tol[k] ?? 1e-4);
  }
  for (const [k, keys] of Object.entries(a.opacity || {})) a.opacity[k] = simplifyKeys(keys, 1e-3);
  for (const [k, keys] of Object.entries(a.morphs || {})) a.morphs[k] = simplifyKeys(keys, 1e-3);
  for (const tracks of Object.values(a.constraints || {})) for (const [k, keys] of Object.entries(tracks)) tracks[k] = simplifyKeys(keys, 1e-4);
}

/** Skeleton data from the bytes of a Spine JSON or binary export. */
export function loadSkeleton(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return isSpineBinary(b) ? readSpineBinary(b) : JSON.parse(new TextDecoder('utf-8').decode(b));
}

// ---- CLI --------------------------------------------------------------------------------------
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const [jsonPath, atlasPath, outDir = 'build/spine'] = files;
  if (!jsonPath || !atlasPath) {
    console.error('usage: node tools/import_spine.mjs skeleton.json skeleton.atlas outDir [--scale 1] [--skin name]');
    process.exit(2);
  }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const { model, warnings, pages, version } = importSpine(loadSkeleton(fs.readFileSync(jsonPath)), fs.readFileSync(atlasPath, 'utf8'), { scale: opt('--scale', 1), skin: args.includes('--skin') ? args[args.indexOf('--skin') + 1] : 'default' });
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of pages) {
    const src = path.join(path.dirname(atlasPath), p.name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, path.basename(p.name)));
    else console.warn(`warning: atlas page image not found: ${src}`);
  }
  model.textures = pages.map((p) => path.basename(p.name));
  fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
  const bin = compileUgo(model);
  fs.writeFileSync(path.join(outDir, 'model.ug9'), new Uint8Array(bin));
  console.log(`Spine ${version || '(version unknown)'} -> ${outDir}/model.ug9: ${model.parts.length} parts, ${model.bones.length} bones, ${model.deformers.length} deform keys, ${model.animations.length} animations, ${bin.byteLength} bytes`);
  for (const w of warnings) console.log(`warning: ${w}`);
}
