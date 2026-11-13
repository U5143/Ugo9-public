// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Physics from one model onto another, added to what it has (利用者の声 #26「物理を読み込むと、今のグループが全部上書き
// される」): the swaying parameters (physics) and the swaying bone chains (chains) of the working JSON are brought over
// one by one; the other model's own are kept unless asked to replace them.
//   - a physics entry goes by its output parameter: one whose output the other already sways is kept as it was
//     (opts.existing 'replace': the brought one takes its place). Its inputs and output go by id, or through
//     opts.paramMap ({ fromId: toId | null } or 'auto': tools/param_map.mjs suggestParamMap), as copy_animation's.
//     An input the other lacks is left out (said); with no input left, or no output, the entry is not brought
//   - values are carried from one range to the other (opts.remapParams, default on): an input's weight by the ranges'
//     spans (-30..30 → -45..45: the weight × 2/3, so the same turn sways the same), the gain by the output's spans,
//     min and max as copy_animation carries values (piecewise about the defaults)
//   - a chain goes by its id and needs all its bones on the other model, none already in another chain; its gravity
//     is scaled by the canvases' heights (opts.scaleMoves, default on), like copy_animation's moves
//
//   copyPhysics(from, to, opts) -> { model (a copy of `to`), notes, physics: [output ids brought], chains: [chain ids] }
//     opts: { only: [output parameter ids or chain ids] (all by default), existing: 'keep' | 'replace',
//             physics (true), chains (true), paramMap, remapParams (true), scaleMoves (true) }
//   node tools/copy_physics.mjs from.json to.json --out out.json [--only HairSideSway,hairL] [--replace]
//                               [--no-physics] [--no-chains] [--no-remap] [--no-scale]
//                               [--map from=to,...] [--map-file map.json] [--auto-map]
//   (a .ug9 is read as its working JSON, tools/import_ug9.mjs.) Plain ES module: the editor can import it.
import { suggestParamMap } from './param_map.mjs';

export function copyPhysics(from, to, opts = {}) {
  const model = structuredClone(to), notes = [], brought = { physics: [], chains: [] };
  const note = (code, vars, text, level = 'warning') => notes.push({ code, vars, level, text });
  const params = new Map((model.parameters || []).map((p) => [p.id, p])), srcParams = new Map((from.parameters || []).map((p) => [p.id, p]));
  const bones = new Set((model.bones || []).map((b) => b.id));
  const only = opts.only ? new Set(opts.only) : null, replace = opts.existing === 'replace', remap = opts.remapParams !== false;
  const span = (p) => (p && p.max > p.min ? p.max - p.min : 1);
  const value = (a, b) => { // a value from a's range to b's (piecewise about the defaults, as copy_animation)
    if (!remap || !a || !b) return (v) => v;
    const ad = a.default ?? a.min ?? 0, bd = b.default ?? b.min ?? 0;
    return (v) => (v >= ad ? (a.max > ad ? bd + ((v - ad) / (a.max - ad)) * ((b.max ?? bd) - bd) : bd) : ad > a.min ? bd - ((ad - v) / (ad - a.min)) * (bd - (b.min ?? bd)) : bd);
  };

  // the ids on the other model (the same unless mapped; null: left out quietly)
  const involved = [...new Set((from.physics || []).flatMap((ph) => [ph.output, ...Object.keys(ph.inputs || {})]))];
  const pmap = opts.paramMap === 'auto' ? suggestParamMap(from, to, { only: involved }).map : opts.paramMap || {};
  const idOf = (id) => (id in pmap ? pmap[id] : id);
  const mapped = involved.filter((id) => pmap[id] && pmap[id] !== id);
  if (opts.physics !== false && mapped.length) note('copyParamMapped', { pairs: mapped.map((a) => `${a}→${pmap[a]}`).join(', ') }, `parameters carried to other ids: ${mapped.map((a) => `${a} → ${pmap[a]}`).join(', ')}`, 'info');

  const took = (list, at, entry, id) => {
    if (at < 0) { list.push(entry); return true; }
    if (!replace) { note('copyPhysicsKept', { id }, `${id}: the other model already has its own (kept, not brought)`, 'info'); return false; }
    list[at] = entry; note('copyPhysicsReplaced', { id }, `${id}: replaced the other model's own`, 'info'); return true;
  };

  if (opts.physics !== false) {
    model.physics = model.physics || [];
    for (const ph of from.physics || []) {
      if (only && !only.has(ph.output)) continue;
      const out = idOf(ph.output);
      if (out === null) continue;
      if (!params.has(out)) { note('copyPhysicsMissing', { id: ph.output, kind: 'parameter', missing: out }, `${ph.output}: the other model has no parameter ${out} to sway (not brought)`); continue; }
      const a = srcParams.get(ph.output), b = params.get(out), inputs = {};
      for (const [inId, w] of Object.entries(ph.inputs || {})) {
        const to2 = idOf(inId);
        if (to2 === null) continue;
        if (!params.has(to2)) { note('copyPhysicsInputLeft', { id: ph.output, input: to2 }, `${ph.output}: the other model has no parameter ${to2} (that input left out)`); continue; }
        const ia = srcParams.get(inId), ib = params.get(to2);
        inputs[to2] = (inputs[to2] || 0) + (remap && ia && ib ? w * (span(ia) / span(ib)) : w); // two onto one id: they add
      }
      if (!Object.keys(inputs).length) { note('copyPhysicsMissing', { id: ph.output, kind: 'input', missing: Object.keys(ph.inputs || {}).map(idOf).filter(Boolean).join(', ') }, `${ph.output}: none of its inputs is on the other model (not brought)`); continue; }
      const entry = { ...structuredClone(ph), output: out, inputs };
      if (remap && a && b) {
        entry.gain = (ph.gain ?? 0.1) * (span(b) / span(a));
        const v = value(a, b);
        if (ph.min !== undefined) entry.min = v(ph.min);
        if (ph.max !== undefined) entry.max = v(ph.max);
      }
      if (took(model.physics, model.physics.findIndex((p) => p.output === out), entry, out)) brought.physics.push(out);
    }
    if (!model.physics.length) delete model.physics;
  }

  if (opts.chains !== false) {
    model.chains = model.chains || [];
    const ratio = opts.scaleMoves !== false ? (to.canvas?.height || 1) / (from.canvas?.height || 1) : 1;
    for (const c of from.chains || []) {
      if (only && !only.has(c.id)) continue;
      const lacking = (c.bones || []).filter((id) => !bones.has(id));
      if (lacking.length) { note('copyPhysicsMissing', { id: c.id, kind: 'bone', missing: lacking.join(', ') }, `chain ${c.id}: the other model has no bone ${lacking.join(', ')} (not brought)`); continue; }
      const at = model.chains.findIndex((x) => x.id === c.id);
      const other = model.chains.find((x, i) => i !== at && (x.bones || []).some((id) => c.bones.includes(id)));
      if (other) {
        const bone = other.bones.find((id) => c.bones.includes(id));
        note('copyPhysicsBoneTaken', { id: c.id, bone, chain: other.id }, `chain ${c.id}: bone ${bone} already sways in chain ${other.id} (not brought; a bone is in one chain only)`);
        continue;
      }
      const entry = structuredClone(c);
      if (Array.isArray(c.gravity) && ratio !== 1) entry.gravity = c.gravity.map((g) => g * ratio);
      if (took(model.chains, at, entry, c.id)) brought.chains.push(c.id);
    }
    if (!model.chains.length) delete model.chains;
  }
  return { model, notes, ...brought };
}

// the command line (node:fs read only here, so the editor can import this file in the browser)
const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const fs = (await import('node:fs')).default;
  const { importUg9 } = await import('./import_ug9.mjs');
  const args = process.argv.slice(2), opts = {}, files = [];
  const load = (f) => (/\.ug9$/i.test(f) ? importUg9(fs.readFileSync(f)).json : JSON.parse(fs.readFileSync(f, 'utf8')));
  const addMap = (m) => { opts.paramMap = { ...(typeof opts.paramMap === 'object' ? opts.paramMap : {}), ...m }; };
  let out = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => args[++i];
    if (a === '--out') out = v();
    else if (a === '--only') opts.only = v().split(',');
    else if (a === '--replace') opts.existing = 'replace';
    else if (a === '--no-physics') opts.physics = false;
    else if (a === '--no-chains') opts.chains = false;
    else if (a === '--no-remap') opts.remapParams = false;
    else if (a === '--no-scale') opts.scaleMoves = false;
    else if (a === '--auto-map') opts.paramMap = 'auto';
    else if (a === '--map') addMap(Object.fromEntries(v().split(',').map((p) => { const [x, y] = p.split('='); return [x, y || null]; })));
    else if (a === '--map-file') addMap(JSON.parse(fs.readFileSync(v(), 'utf8')));
    else files.push(a);
  }
  if (files.length !== 2 || !out) {
    console.error('usage: node tools/copy_physics.mjs from.json to.json --out out.json [--only a,b] [--replace] [--no-physics] [--no-chains] [--no-remap] [--no-scale] [--map a=b,...] [--map-file map.json] [--auto-map]');
    process.exit(2);
  }
  const res = copyPhysics(load(files[0]), load(files[1]), opts);
  for (const n of res.notes) console.error(`${n.level === 'info' ? 'info' : 'warning'}: ${n.text}`);
  fs.writeFileSync(out, JSON.stringify(res.model, null, 2));
  console.log(`${out}: physics ${res.physics.join(', ') || '(none)'}; chains ${res.chains.join(', ') || '(none)'}`);
}
