// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Which parameter of one model stands for which of another (the users' request sheet, 11/10: when animations come from
// a model whose parameter ids differ, say which id goes to which). The editor shows these as the choices to confirm;
// tools/copy_animation.mjs takes the result as opts.paramMap. Plain ES module (no Node APIs): the editor imports it.
//
//   suggestParamMap(from, to, { only }) -> { map: { fromId: toId }, how: { fromId: 'same' | 'standard' | 'prefix' | 'similar' },
//     unmatched: [fromId] }
//     from, to: working JSONs (their parameters); only: the from ids to look at (default: those the animations drive,
//     else all). Tried in this order, each target taken once: the same id; the standard name and the older one
//     (tools/lib/paramnames.js: HeadTurnX and AngleX ...); with or without "Param" in front (ParamAngleX and AngleX,
//     and then the standard / older name of that); the same letters ignoring case, "_", "-" and "Param"; a name a
//     letter or two away (only when one is closest and the names are 5 letters or more).
import { namesOf } from './lib/paramnames.js';

const bare = (id) => id.replace(/^param/i, '');
const norm = (id) => bare(id).toLowerCase().replace(/[^a-z0-9]/g, '');
function distance(a, b) { // letters to change, add or take away (Levenshtein)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The parameters of `from` matched to those of `to`, with how each was found. */
export function suggestParamMap(from, to, opts = {}) {
  const targets = (to.parameters || []).map((p) => p.id), has = new Set(targets), taken = new Set();
  const driven = [...new Set((from.animations || []).flatMap((a) => Object.keys(a.tracks || {})))];
  const ids = opts.only || (driven.length ? driven : (from.parameters || []).map((p) => p.id));
  const map = {}, how = {}, unmatched = [];
  const take = (id, t, kind) => { map[id] = t; how[id] = kind; taken.add(t); };
  const free = (t) => has.has(t) && !taken.has(t);
  // the same id first, for every one (so a later guess never takes a target another one has by name)
  for (const id of ids) if (has.has(id)) take(id, id, 'same');
  for (const id of ids) {
    if (id in map) continue;
    const std = namesOf(id).find((n) => n !== id && free(n));
    if (std) { take(id, std, 'standard'); continue; }
    const pre = [/^param/i.test(id) ? bare(id) : `Param${id}`].flatMap((n) => [n, ...namesOf(n)]).find(free);
    if (pre) { take(id, pre, 'prefix'); continue; }
    const same = targets.filter((t) => free(t) && norm(t) === norm(id));
    if (same.length === 1) { take(id, same[0], 'similar'); continue; }
    if (norm(id).length >= 5) {
      const scored = targets.filter(free).map((t) => [t, distance(norm(id), norm(t))]).filter(([, d]) => d <= 2).sort((a, b) => a[1] - b[1]);
      if (scored.length && (scored.length === 1 || scored[0][1] < scored[1][1])) { take(id, scored[0][0], 'similar'); continue; }
    }
    unmatched.push(id);
  }
  return { map, how, unmatched };
}
