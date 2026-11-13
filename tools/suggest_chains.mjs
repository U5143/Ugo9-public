// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Candidates for swinging things (bone chains, format 0.6) by name: hair, ribbons, skirts, tails...
// Plain ES module: the editor shows them as "make the candidates into chains".
//
//   import { suggestChains } from '../tools/suggest_chains.mjs';
//   suggestChains(model)  // -> [{ root: 'hairL', bones: ['hairL', 'hairL2'], reason: 'name: hair' }, ...]
//
// A candidate starts at a bone whose name (or the names of all the parts on it) says it swings
// and none of whose child bones is steady; it follows single children as far as they go (a chain is one line of
// bones); below where the line splits, each branch that swings is a candidate of its own. Bones
// already in a chain, in a warp grid, or driven by a constraint are left out.

const SWING = [
  ['hair', /hair|髪|前髪|後ろ髪|横髪|もみあげ|アホ毛|あほ毛|ahoge|bang|ponytail|ポニー|ツインテ|おさげ|braid|三つ編み/i],
  ['ribbon', /ribbon|リボン|bow(?![a-z])|紐|ひも|string|tie|ネクタイ|タイ/i],
  ['skirt', /skirt|スカート|裾|すそ|hem/i],
  ['tail', /tail|しっぽ|尻尾|シッポ/i],
  ['ear', /(?:^|[^a-z])ear|耳|みみ/i],
  ['cloth', /cape|マント|scarf|マフラー|cloak|sleeve|袖|frill|フリル|coat|コート|cloth|布|veil|ベール/i],
  ['accessory', /earring|イヤリング|ピアス|pendant|ペンダント|charm|chain|鎖|feather|羽|tassel|房/i],
];

/** model: working JSON -> [{ root, bones, reason, reasonNote, warning?, note? }] (reasonNote, note: the reason and the
 *  warning as { code, vars, level, text }, for the editor to word) (parents before children) */
export function suggestChains(model) {
  const bones = model.bones || [], byId = new Map(bones.map((b) => [b.id, b]));
  const children = new Map();
  for (const b of bones) if (b.parent != null) { if (!children.has(b.parent)) children.set(b.parent, []); children.get(b.parent).push(b.id); }
  const taken = new Set((model.chains || []).flatMap((c) => c.bones || []));
  for (const c of model.constraints || []) for (const k of ['bone', 'bone2', 'bones']) [].concat(c[k] ?? []).forEach((id) => taken.add(id));
  for (const b of bones) if (b.warp != null) taken.add(b.id);
  // the parts on each bone (bound to it, or weighted to it most)
  const partsOn = new Map();
  for (const p of model.parts || []) {
    const ids = p.bone != null ? [p.bone] : [...new Set((p.weights || []).flatMap((w) => w.map(([id]) => id)))];
    for (const id of ids) { if (!partsOn.has(id)) partsOn.set(id, []); partsOn.get(id).push(p); }
  }
  const why = (id) => {
    const b = byId.get(id);
    const names = [`${b.id} ${b.name ?? ''}`];
    const hit = (s) => SWING.find(([, re]) => re.test(s));
    let h = hit(names[0]);
    if (h) return { code: 'chainName', vars: { kind: h[0] }, level: 'info', text: `name: ${h[0]}` };
    const ps = partsOn.get(id) || [];
    // by the parts only when every part on the bone swings (bangs on the head bone don't make the head swing)
    const hits = ps.map((p) => hit(`${p.id} ${p.name ?? ''}`));
    if (ps.length && hits.every(Boolean)) return { code: 'chainParts', vars: { kind: hits[0][0], parts: ps.map((p) => p.id) }, level: 'info', text: `part${ps.length > 1 ? 's' : ''} ${ps.map((p) => p.id).join(', ')}: ${hits[0][0]}` };
    return null;
  };
  // the bone's direction on the screen (rotations added up the parents; y is down)
  const angle = (id) => { let a = 0; for (let b = byId.get(id); b; b = byId.get(b.parent)) a += b.rotation || 0; return a; };
  const out = [], used = new Set();
  const visit = (id) => {
    const b = byId.get(id);
    // a bone with a child bone that doesn't swing (the head with the neck's or the eyes' bones) is left out
    const steady = (children.get(id) || []).some((k) => !why(k));
    const reason = b.parent != null && !taken.has(id) && !used.has(id) && !steady ? why(id) : null;
    if (reason) { // a chain's root stays put, so the top bone never starts one
      const line = [id];
      for (let k = children.get(id); k && k.length === 1 && !taken.has(k[0]); k = children.get(k[0])) line.push(k[0]);
      line.forEach((x) => used.add(x));
      const c = { root: id, bones: line, reason: reason.text, reasonNote: reason };
      if (Math.sin((angle(id) * Math.PI) / 180) < -0.5) {
        c.warning = 'the bone points up: a chain hangs from its root, so point it down from where the thing is fixed';
        c.note = { code: 'chainPointsUp', vars: { bone: id }, level: 'warn', text: c.warning };
      }
      out.push(c);
    }
    for (const k of children.get(id) || []) visit(k);
  };
  for (const b of bones) if (b.parent == null || !byId.has(b.parent)) visit(b.id);
  return out;
}
