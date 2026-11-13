// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Animations from one model onto another (利用者の声 #23「リグと動きを別のキャラに使い回したい」): the
// working JSON's animations are matched by name (parameters, bones, parts, morphs, colours, constraints)
// and fitted to the other model:
//   - a parameter's values are carried from its range to the other's: below the default as a fraction of
//     default - min, above it of max - default (AngleX -30..30 to -45..45: 10 becomes 15)
//   - a bone's moves (x, y) by the size of the two (the bone's length where both have one, else the canvas's
//     height); angles, scales, opacity, draw order, colours and mixes as they are
//   - curve keys' value handles go with their values (format 1.1)
// What the other model does not have is left out and said by name (notes), or brought along (機能の比べ #79):
//   - opts.addBones: a bone the animations move that the other lacks comes with them, and its parents up to one
//     the other has (by id; else at the top). Its place and length are scaled as the moves are. No part follows it
//     until it is given weights (a note says so)
//   - opts.addParams: a parameter the animations drive that the other lacks comes with its range
// A parameter whose id differs on the other model (the users' request sheet, 11/10): opts.paramMap { fromId: toId } carries
// its tracks to that id (its values from the one's range to the other's, as above); null leaves it out quietly;
// 'auto' takes tools/param_map.mjs suggestParamMap (the same id, the standard and older names, "Param" in front,
// similar names). The pairs used are said (copyParamMapped, info).
// An animation the other already has (by id) is replaced, kept, or added under a new name (opts.existing:
// 'rename' (default), 'replace', 'skip').
// A template (機能の比べ #81): a set of animations saved by themselves, to put on other models later. It is a working
// JSON with only the animations and the parameters and bones they use (and the canvas, for the size), so it is
// read like any other model (by copyAnimations, the editor, ...).
//
//   copyAnimations(from, to, opts) -> { model (a copy of `to` with the animations), notes, copied, addedBones, addedParams }
//     opts: { anims: [ids] (all by default), existing, remapParams (true), scaleMoves (true), addBones, addParams,
//             paramMap ({ fromId: toId | null } or 'auto') }
//   makeTemplate(model, { anims }) -> the template (a working JSON)
//   node tools/copy_animation.mjs from.json to.json --out out.json [--anims idle,walk] [--existing replace] [--add-bones] [--add-params]
//                                [--map from=to,...] [--map-file map.json] [--auto-map]   (map.json: { "fromId": "toId" })
//   node tools/copy_animation.mjs --template model.json --out walk.anim.json [--anims walk,run]
//   (a .ug9 is read as its working JSON, tools/import_ug9.mjs)
import { importUg9 } from './import_ug9.mjs';
import { suggestParamMap } from './param_map.mjs';

// every id the model gives a morph (差分) or a deformer: anywhere under deformers
function morphIds(model) {
  const out = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (typeof x.id === 'string') out.add(x.id); Object.values(x).forEach(walk); } };
  walk(model.deformers || []);
  for (const p of model.parts || []) walk(p.morphs || []);
  return out;
}
const ids = (list) => new Set((list || []).map((x) => x.id));

/** a key's value and its curve's value handles through f (a key: [t, v, interp, cx1, cy1, cx2, cy2]) */
const mapKey = (k, f) => (k[2] === 'bezier' ? [k[0], f(k[1]), 'bezier', k[3], f(k[4]), k[5], f(k[6]), ...k.slice(7)] : [k[0], f(k[1]), ...k.slice(2)]);
const mapKeys = (keys, f) => (Array.isArray(keys) ? keys.map((k) => (Array.isArray(k) ? mapKey(k, f) : k)) : keys);

export function copyAnimations(from, to, opts = {}) {
  const model = structuredClone(to), notes = [], copied = [];
  const note = (code, vars, text, level = 'warning') => notes.push({ code, vars, level, text });
  const params = new Map((model.parameters || []).map((p) => [p.id, p])), srcParams = new Map((from.parameters || []).map((p) => [p.id, p]));
  const bones = new Map((model.bones || []).map((b) => [b.id, b])), srcBones = new Map((from.bones || []).map((b) => [b.id, b]));
  const parts = ids(model.parts), colors = ids(model.colors), cons = ids(model.constraints), morphs = morphIds(model);
  const canvasRatio = (to.canvas?.height || 1) / (from.canvas?.height || 1);
  const remap = opts.remapParams !== false, scaleMoves = opts.scaleMoves !== false, existing = opts.existing || 'rename';
  // a parameter's value from its range to the other's (piecewise about the defaults)
  const paramMap = (id, to = id) => {
    const a = srcParams.get(id), b = params.get(to);
    if (!remap || !a || !b) return (v) => v;
    const ad = a.default ?? a.min ?? 0, bd = b.default ?? b.min ?? 0;
    return (v) => (v >= ad ? (a.max > ad ? bd + ((v - ad) / (a.max - ad)) * ((b.max ?? bd) - bd) : bd) : ad > a.min ? bd - ((ad - v) / (ad - a.min)) * (bd - (b.min ?? bd)) : bd);
  };
  const boneRatio = (id) => {
    const a = srcBones.get(id), b = bones.get(id);
    return a?.length > 0 && b?.length > 0 ? b.length / a.length : canvasRatio;
  };
  const wanted = opts.anims ? new Set(opts.anims) : null;
  model.animations = model.animations || [];
  // the ids the tracks go to on the other model (the same id unless mapped)
  const pmap = opts.paramMap === 'auto' ? suggestParamMap(from, to).map : opts.paramMap || {};
  const mapped = Object.entries(pmap).filter(([a, b]) => b && a !== b);
  if (mapped.length) note('copyParamMapped', { pairs: mapped.map(([a, b]) => `${a}→${b}`).join(', ') }, `parameters carried to other ids: ${mapped.map(([a, b]) => `${a} → ${b}`).join(', ')}`, 'info');
  const targetOf = (id) => (id in pmap ? pmap[id] : id);
  // what the animations need that the other lacks, brought along first (so their tracks are kept)
  const addedBones = [], addedParams = [];
  const chosen = (from.animations || []).filter((a) => !wanted || wanted.has(a.id));
  if (opts.addParams) {
    for (const id of new Set(chosen.flatMap((a) => Object.keys(a.tracks || {})))) {
      if (targetOf(id) !== id || params.has(id) || !srcParams.has(id)) continue; // (a mapped one goes to its target)
      const p = structuredClone(srcParams.get(id));
      (model.parameters = model.parameters || []).push(p); params.set(id, p); addedParams.push(id);
      note('copyParamAdded', { id }, `parameter ${id}: brought along from the other model (${p.min}..${p.max})`, 'info');
    }
  }
  if (opts.addBones) {
    const r = scaleMoves ? canvasRatio : 1, need = [];
    const want = (id) => { // the bone, after its missing parents
      if (bones.has(id) || need.includes(id) || !srcBones.has(id)) return;
      const b = srcBones.get(id);
      if (b.parent) want(b.parent);
      need.push(id);
    };
    for (const id of new Set(chosen.flatMap((a) => Object.keys(a.bones || {})))) want(id);
    for (const id of need) {
      const b = structuredClone(srcBones.get(id));
      if (b.warp && !morphs.has(b.warp)) { note('copyBoneNoWarp', { id, warp: b.warp }, `bone ${id}: it sits in warp ${b.warp}, which the other model does not have (not brought)`); continue; }
      if (b.parent && !bones.has(b.parent)) delete b.parent; // its parent was not brought (in a warp the other lacks)
      for (const f of ['x', 'y', 'length']) if (typeof b[f] === 'number') b[f] *= r;
      (model.bones = model.bones || []).push(b); bones.set(id, b); addedBones.push(id);
    }
    if (addedBones.length) note('copyBonesAdded', { bones: addedBones.join(', ') }, `bones brought along: ${addedBones.join(', ')} (no part follows them until they are given weights)`, 'info');
  }
  for (const anim of from.animations || []) {
    if (wanted && !wanted.has(anim.id)) continue;
    const out = structuredClone(anim), where = anim.id;
    const drop = (kind, id) => note('copyMissing', { anim: where, kind, id }, `animation ${where}: the other model has no ${kind} ${id} (left out)`);
    if (out.tracks) {
      const tracks = {};
      for (const [id, keys] of Object.entries(out.tracks)) {
        const to2 = targetOf(id);
        if (!to2) continue; // mapped to nothing: left out on purpose
        if (!params.has(to2)) { drop('parameter', to2 === id ? id : `${to2} (for ${id})`); continue; }
        if (to2 in tracks) { note('copyParamTwice', { anim: where, id: to2 }, `animation ${where}: two tracks go to parameter ${to2} (the first kept)`); continue; }
        tracks[to2] = mapKeys(keys, paramMap(id, to2));
      }
      out.tracks = tracks;
    }
    if (out.bones) for (const id of Object.keys(out.bones)) {
      if (!bones.has(id)) { drop('bone', id); delete out.bones[id]; continue; }
      const r = scaleMoves ? boneRatio(id) : 1;
      for (const f of ['x', 'y']) if (out.bones[id][f] && r !== 1) out.bones[id][f] = mapKeys(out.bones[id][f], (v) => v * r);
    }
    for (const [field, known, kind] of [['opacity', parts, 'part'], ['order', parts, 'part'], ['morphs', morphs, 'morph'], ['colors', colors, 'colour'], ['constraints', cons, 'constraint']]) {
      if (out[field]) for (const id of Object.keys(out[field])) if (!known.has(id)) { drop(kind, id); delete out[field][id]; }
    }
    const at = model.animations.findIndex((a) => a.id === anim.id);
    if (at >= 0 && existing === 'skip') { note('copyKept', { anim: where }, `animation ${where}: the other model has one by that name (kept, not copied)`, 'info'); continue; }
    if (at >= 0 && existing === 'replace') { model.animations[at] = out; note('copyReplaced', { anim: where }, `animation ${where}: replaced the other model's`, 'info'); }
    else {
      if (at >= 0) { let k = 2; while (model.animations.some((a) => a.id === `${anim.id}_${k}`)) k++; out.id = `${anim.id}_${k}`; note('copyRenamed', { anim: where, id: out.id }, `animation ${where}: the other model has one by that name (copied as ${out.id})`, 'info'); }
      model.animations.push(out);
    }
    copied.push(out.id);
  }
  return { model, notes, copied, addedBones, addedParams };
}

/** A set of animations by themselves (a working JSON: the canvas, the parameters and bones they use, the animations). */
export function makeTemplate(model, opts = {}) {
  const wanted = opts.anims ? new Set(opts.anims) : null;
  const anims = (model.animations || []).filter((a) => !wanted || wanted.has(a.id));
  if (wanted) for (const id of wanted) if (!anims.some((a) => a.id === id)) throw new Error(`no animation named ${id}`);
  const usedParams = new Set(anims.flatMap((a) => Object.keys(a.tracks || {}))), byId = new Map((model.bones || []).map((b) => [b.id, b])), usedBones = new Set();
  const up = (id) => { if (!id || usedBones.has(id) || !byId.has(id)) return; usedBones.add(id); up(byId.get(id).parent); };
  for (const a of anims) for (const id of Object.keys(a.bones || {})) up(id);
  return {
    format: model.format, version: model.version, canvas: structuredClone(model.canvas),
    parameters: (model.parameters || []).filter((p) => usedParams.has(p.id)).map((p) => structuredClone(p)),
    bones: (model.bones || []).filter((b) => usedBones.has(b.id)).map((b) => { const c = structuredClone(b); delete c.warp; return c; }),
    parts: [], animations: structuredClone(anims),
  };
}

// the command line (node:fs read only here, so the editor can import this file in the browser)
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const fs = (await import('node:fs')).default;
  const args = process.argv.slice(2), opts = {}, files = [];
  const load = (f) => (/\.ug9$/i.test(f) ? importUg9(fs.readFileSync(f)).json : JSON.parse(fs.readFileSync(f, 'utf8')));
  let out = null, template = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => args[++i];
    if (a === '--out') out = v();
    else if (a === '--anims') opts.anims = v().split(',').filter(Boolean);
    else if (a === '--existing') opts.existing = v();
    else if (a === '--no-remap') opts.remapParams = false;
    else if (a === '--no-scale') opts.scaleMoves = false;
    else if (a === '--add-bones') opts.addBones = true;
    else if (a === '--add-params') opts.addParams = true;
    else if (a === '--map') { const m = (opts.paramMap = opts.paramMap === 'auto' ? {} : opts.paramMap || {}); for (const pair of v().split(',')) { const [x, y] = pair.split('='); if (x) m[x] = y || null; } }
    else if (a === '--map-file') opts.paramMap = { ...(typeof opts.paramMap === 'object' ? opts.paramMap : {}), ...JSON.parse(fs.readFileSync(v(), 'utf8')) };
    else if (a === '--auto-map') opts.paramMap = 'auto';
    else if (a === '--template') template = v();
    else files.push(a);
  }
  if (template && out && !files.length) {
    const t = makeTemplate(load(template), opts);
    fs.writeFileSync(out, JSON.stringify(t, null, 2));
    console.log(`${out}: a template of ${t.animations.map((a) => a.id).join(', ')} (${t.parameters.length} parameters, ${t.bones.length} bones)`);
    process.exit(0);
  }
  if (files.length !== 2 || !out) {
    console.error('usage: node tools/copy_animation.mjs from.json to.json --out out.json [--anims a,b] [--existing rename|replace|skip] [--no-remap] [--no-scale] [--add-bones] [--add-params] [--map a=b,...] [--map-file map.json] [--auto-map]');
    console.error('       node tools/copy_animation.mjs --template model.json --out name.anim.json [--anims a,b]');
    process.exit(2);
  }
  const [from, to] = files.map(load);
  const res = copyAnimations(from, to, opts);
  fs.writeFileSync(out, JSON.stringify(res.model, null, 2));
  for (const n of res.notes) console.log(`${n.level}: ${n.text}`);
  console.log(`${out}: copied ${res.copied.join(', ') || 'nothing'}`);
}
