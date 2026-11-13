// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// One id renamed everywhere the working JSON names it (docs/形式.md): for tools that rename without the editor
// (tools/names_csv.mjs). The editor renames the same way (tests/names_csv_test.mjs checks the two give the same JSON).
//
//   renameId(model, kind, from, to) -> true if something changed (the model is changed in place)
//     kind: 'part' | 'bone' | 'param' | 'color' | 'warp' | 'chain'
// What follows the id: the list's own entry; for a part, masks, deformers' morphs and opacity, animations' opacity,
// glue; for a bone, parents, parts' bone and weights, constraints, deformers' and animations' bones, chains; for a
// parameter, deformers' regions, physics' outputs and inputs, animations' tracks; for a colour, parts, deformers and
// animations; for a warp grid, parents, parts, bones inside it, deformers; the PSD layers' list (source.psd.layers);
// and the editor's own settings kept with the model (the "editor" field) that name it.
// Plain ES module, no Node APIs.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// an object's key renamed where it stands (the other keys keep their order)
function moveKey(obj, from, to) {
  if (!isObj(obj) || !(from in obj)) return false;
  const entries = Object.entries(obj);
  for (const k of Object.keys(obj)) delete obj[k];
  for (const [k, v] of entries) obj[k === from ? to : k] = v;
  return true;
}
const swapIn = (list, from, to) => { // a list of ids: each from becomes to
  if (!Array.isArray(list) || !list.includes(from)) return false;
  for (let i = 0; i < list.length; i++) if (list[i] === from) list[i] = to;
  return true;
};
const setIf = (o, key, from, to) => { if (o && o[key] === from) { o[key] = to; return true; } return false; };
const each = (model, list, fn) => { let n = false; for (const x of model[list] || []) if (x && fn(x)) n = true; return n; };

// kind -> what names it in the format
const FORMAT = {
  part: (m, f, t) => [
    each(m, 'parts', (p) => setIf(p, 'id', f, t) | swapIn(p.mask, f, t)),
    each(m, 'deformers', (d) => moveKey(d.morphs, f, t) | moveKey(d.opacity, f, t)),
    each(m, 'animations', (a) => moveKey(a.opacity, f, t)),
    each(m, 'glue', (g) => swapIn(g.parts, f, t)),
  ],
  bone: (m, f, t) => [
    each(m, 'bones', (b) => setIf(b, 'id', f, t) | setIf(b, 'parent', f, t)),
    each(m, 'parts', (p) => {
      let n = setIf(p, 'bone', f, t);
      for (const vw of p.weights || []) for (const w of vw) if (w[0] === f) { w[0] = t; n = true; }
      return n;
    }),
    each(m, 'constraints', (c) => swapIn(c.bones, f, t) | setIf(c, 'target', f, t)),
    each(m, 'deformers', (d) => moveKey(d.bones, f, t)),
    each(m, 'animations', (a) => moveKey(a.bones, f, t)),
    each(m, 'chains', (c) => swapIn(c.bones, f, t)),
  ],
  chain: (m, f, t) => [each(m, 'chains', (c) => setIf(c, 'id', f, t))],
  color: (m, f, t) => [
    each(m, 'colors', (c) => setIf(c, 'id', f, t)),
    each(m, 'parts', (p) => setIf(p, 'color', f, t)),
    each(m, 'deformers', (d) => moveKey(d.colors, f, t)),
    each(m, 'animations', (a) => moveKey(a.colors, f, t)),
  ],
  warp: (m, f, t) => [
    each(m, 'warps', (w) => setIf(w, 'id', f, t) | setIf(w, 'parent', f, t)),
    each(m, 'parts', (p) => setIf(p, 'warp', f, t)),
    each(m, 'bones', (b) => setIf(b, 'warp', f, t)),
    each(m, 'deformers', (d) => moveKey(d.warps, f, t)),
  ],
  param: (m, f, t) => [
    each(m, 'parameters', (p) => setIf(p, 'id', f, t)),
    each(m, 'deformers', (d) => moveKey(d.region, f, t)),
    each(m, 'physics', (p) => setIf(p, 'output', f, t) | moveKey(p.inputs, f, t)),
    each(m, 'animations', (a) => moveKey(a.tracks, f, t)),
  ],
};

// the editor's settings kept with the model that name an id (they go with it when it is renamed)
function editorSettings(ed, kind, f, t) {
  if (!isObj(ed)) return false;
  let n = false;
  if (kind === 'part') {
    n = swapIn(ed.touched, f, t) || n; // parts to write back to the PSD
    n = moveKey(ed.exportGroups, f, t) || n; // the export's part groups
    if (isObj(ed.maskFolders)) { // masks kept with a PSD folder
      n = moveKey(ed.maskFolders, f, t) || n;
      for (const ls of Object.values(ed.maskFolders)) for (const l of ls || []) n = swapIn(l?.parts, f, t) || n;
    }
    if (isObj(ed.depth) && f in ed.depth) { const v = ed.depth[f]; delete ed.depth[f]; ed.depth[t] = v; n = true; } // its depth goes to the end
  }
  for (const sh of ed.shapes || []) { // spheres and cylinders
    if (kind === 'part') n = swapIn(sh?.target?.parts, f, t) || n;
    if (kind === 'warp') n = setIf(sh?.target, 'warp', f, t) || n;
    if (kind === 'param' && isObj(sh?.params)) for (const k of Object.keys(sh.params)) if (sh.params[k] === f) { sh.params[k] = t; n = true; }
  }
  for (const p of ed.paths || []) { // lines that carry something, or run by a parameter
    if (!p) continue;
    if (kind === 'param') { if (setIf(p, 'param', f, t)) { setIf(p.baked, 'param', f, t); n = true; } continue; }
    const carried = p.carry?.kind === kind && p.carry.id === f, own = (kind === 'bone' && p.bone === f) || (kind === 'part' && p.part === f);
    if (!carried && !own) continue; // what it was baked with follows only on a line that names the id
    if (carried) p.carry.id = t;
    if (kind === 'bone') { setIf(p, 'bone', f, t); setIf(p.baked, 'bone', f, t); }
    if (kind === 'part') { setIf(p, 'part', f, t); setIf(p.baked, 'part', f, t); }
    n = true;
  }
  const key = { part: 'parts', bone: 'bones', warp: 'warps' }[kind];
  if (key) for (const st of ed.sets || []) n = swapIn(st?.[key], f, t) || n; // selection sets
  if (kind === 'param') {
    for (const pr of ed.paramPairs || []) n = swapIn(pr, f, t) || n;
    for (const g of ed.paramGroups || []) n = swapIn(g?.params, f, t) || n;
    n = swapIn(ed.paramOrder, f, t) || n;
  }
  return n;
}

/** Renames one id everywhere the model names it (in place). -> true if something changed */
export function renameId(model, kind, from, to) {
  if (!FORMAT[kind]) throw new Error(`renameId: unknown kind ${kind}`);
  if (from === to) return false;
  let n = FORMAT[kind](model, from, to).some(Boolean);
  if (kind === 'part') for (const l of model.source?.psd?.layers || []) if (setIf(l, 'part', from, to)) n = true; // to read the PSD again
  if (editorSettings(model.editor, kind, from, to)) n = true;
  return n;
}
