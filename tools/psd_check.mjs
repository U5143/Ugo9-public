// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Checking a PSD before making it move (機能の比べ #21、利用者の声 #8): the list of what to fix in the drawing app, made
// by reading the PSD as the editor does and running the automatic tools on it (eyes and mouth: tools/eye_mouth.mjs,
// sway candidates: tools/suggest_chains.mjs), so what it says is what those tools will find. With it:
//   - what the reading said (layer effects and adjustment layers to rasterize, blend modes drawn as normal, a big canvas, ...)
//   - layers without a name ('layer'), names given twice (read as _2, _3)
//   - a layer holding pictures far apart (both eyes on one layer: they can only move together)
//   - no face picture found by name (顔・輪郭・face), for the face angles
//   - a layer that stops right at the edge of a layer drawn over it (利用者の声: パーツ分け): the forehead cut along the
//     bangs, the neck along the chin. When the one on top moves, a hole shows there: paint a little under it
//   - the parts a moving character usually has, not found by name (front and back hair, brows, eye whites apart from
//     the irises, the neck): said once, as a list
// The names it looks for are in docs/PSDの描き方.md.
//
//   checkPsd(bytes, opts) -> { items: [{ code, level: 'error' | 'warn' | 'info', text, layers? }], found: { eyes: [parameters], mouth: [parameters], face: [parts], chains: count } }
//     opts: importPsd's (inflate, ...)
//   node tools/psd_check.mjs picture.psd [--json]   (exit 0 with nothing to fix, 1 with warnings)
// Works in the browser (no Node APIs outside the CLI block).
import { importPsd } from './import_psd.mjs';
import { makeEyeBlink, makeMouthOpen } from './eye_mouth.mjs';
import { suggestChains } from './suggest_chains.mjs';

const FACE = /顔|輪郭|face/i, HAIR = /髪|hair|bang/i;
const CELL = 4; // the grid the pictures are looked at in (px)

// the separate pictures in a layer: groups of opaque cells (8 neighbours), each with its box and cell count
function blobs(L) {
  const gw = Math.ceil(L.width / CELL), gh = Math.ceil(L.height / CELL), on = new Uint8Array(gw * gh);
  for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) if (L.rgba[(y * L.width + x) * 4 + 3] >= 32) on[Math.floor(y / CELL) * gw + Math.floor(x / CELL)] = 1;
  const seen = new Uint8Array(gw * gh), out = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const stack = [i]; seen[i] = 1;
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    while (stack.length) {
      const k = stack.pop(), x = k % gw, y = (k - x) / gw;
      n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, j = Y * gw + X;
        if (X >= 0 && Y >= 0 && X < gw && Y < gh && on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ n, box: [x0, y0, x1 + 1, y1 + 1] });
  }
  return out;
}

// layers that move over others (their edge shows what is under them when they move)
const MOVING = /髪|hair|bang|まぶた|lid|まつ毛|lash|唇|lip|顔|face|輪郭|頭|head|腕|arm|手|hand|耳|ear/i;
// the parts a moving character usually has: [role, how it is named]
const USUAL = [['front hair', /前髪|bang|front.?hair|hair.?front/i], ['back hair', /後ろ髪|後髪|back.?hair|hair.?back/i], ['brows', /眉|brow/i],
  ['eye whites', /白目|white|sclera/i], ['irises', /瞳|黒目|iris|pupil/i], ['neck', /首|neck/i]];

/**
 * Where layer B (below) stops right at the edge of layer F (above): F's outline walked pixel by pixel; where B is drawn
 * just outside F but not just inside, B was cut along F — unless a layer between them covers that spot (no hole shows
 * there when F moves). -> { touch, cut } (outline pixels where B meets F's edge, and those where B ends there)
 */
const opaqueAt = (L, x, y) => { const u = x - L.left, v = y - L.top; return u >= 0 && v >= 0 && u < L.width && v < L.height && L.rgba[(v * L.width + u) * 4 + 3] >= 128; };
// a layer's outline once: [x, y, dx, dy] for each opaque pixel with a clear neighbour (dx, dy) (canvas pixels)
function outline(F) {
  const out = [];
  for (let y = F.top; y < F.top + F.height; y++) for (let x = F.left; x < F.left + F.width; x++) {
    if (!opaqueAt(F, x, y)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!opaqueAt(F, x + dx, y + dy)) { out.push([x, y, dx, dy]); break; }
  }
  return out;
}
function cutUnder(B, edge, between = []) {
  let touch = 0, cut = 0;
  for (const [x, y, dx, dy] of edge) {
    if (x < B.left - 1 || y < B.top - 1 || x > B.left + B.width || y > B.top + B.height || !opaqueAt(B, x + dx, y + dy)) continue; // no B just outside F's edge
    touch++;
    if (!opaqueAt(B, x, y) && !opaqueAt(B, x - dx, y - dy) && !between.some((L) => opaqueAt(L, x, y))) cut++; // B is not under F's edge (nor anything between): cut along it
  }
  return { touch, cut };
}

/** What to fix in a PSD before making it move. */
export function checkPsd(bytes, opts = {}) {
  const res = importPsd(bytes, { ...opts, keepPixels: true, groupBones: true });
  const items = [], add = (code, level, text, layers) => items.push({ code, level, text, ...(layers ? { layers } : {}) });
  for (const n of res.notes) if (n.level !== 'info') add(n.code, n.level === 'error' ? 'error' : 'warn', n.text);
  const path = (l) => (l.path || [l.name]).join('/');
  // names
  const unnamed = res.layers.filter((l) => !l.name || /^layer$/i.test(l.name.trim()) || /^(レイヤー|layer)\s*\d+$/i.test(l.name.trim()));
  if (unnamed.length) add('checkUnnamed', 'warn', `${unnamed.length} layer(s) keep a default name (the automatic tools find parts by name): ${unnamed.map(path).slice(0, 8).join(', ')}`, unnamed.map(path));
  const byPath = new Map();
  for (const l of res.layers) { const k = path(l); byPath.set(k, (byPath.get(k) || 0) + 1); }
  const twice = [...byPath].filter(([, n]) => n > 1).map(([k]) => k);
  if (twice.length) add('checkSameName', 'info', `names given more than once (read as name_2, name_3): ${twice.slice(0, 8).join(', ')}`, twice);
  // pictures far apart on one layer
  for (const l of res.layers) {
    if (!l.rgba || !l.width) continue;
    const big = blobs(l).filter((b) => b.n * CELL * CELL >= Math.max(64, (l.width * l.height) / 50)); // leave out specks
    if (big.length < 2) continue;
    const gap = (a, b) => Math.max(0, Math.max(a.box[0], b.box[0]) - Math.min(a.box[2], b.box[2]), Math.max(a.box[1], b.box[1]) - Math.min(a.box[3], b.box[3])) * CELL;
    const far = big.some((a, i) => big.some((b, j) => j > i && gap(a, b) >= 16));
    if (far) add('checkApart', /目|eye|眉|brow|耳|ear|手|hand/i.test(l.name) ? 'warn' : 'info',
      `layer ${path(l)} holds ${big.length} pictures apart from each other: they can only move together (split it if they should move apart, such as the two eyes)`, [path(l)]);
  }
  // a layer cut along the edge of one drawn over it (the hole shows when the one on top moves)
  const shown = res.layers.filter((l) => l.rgba && l.width && l.visible !== false && !l.clipping);
  const edges = new Map();
  for (let j = 1; j < shown.length; j++) for (let i = 0; i < j; i++) {
    const B = shown[i], F = shown[j];
    if (B.left > F.left + F.width || F.left > B.left + B.width || B.top > F.top + F.height || F.top > B.top + B.height) continue; // (touching counts: B may start right at F's edge)
    if (!edges.has(F)) edges.set(F, outline(F));
    const { touch, cut } = cutUnder(B, edges.get(F), shown.slice(i + 1, j));
    if (cut >= 24 && cut >= 0.6 * touch) add('checkNotPaintedUnder', MOVING.test(F.name) ? 'warn' : 'info',
      `layer ${path(B)} stops right at the edge of ${path(F)} (${cut} px of its edge): when ${path(F)} moves, a hole shows there; paint ${path(B)} a little further under it`, [path(B), path(F)]);
  }
  // the parts a moving character usually has (only for a character: one with a face)
  const names = res.layers.map((l) => `${path(l)} ${l.name}`);
  const isCharacter = names.some((n) => FACE.test(n));
  const missing = USUAL.filter(([, re]) => !names.some((n) => re.test(n))).map(([role]) => role);
  if (isCharacter && missing.length) add('checkPartMissing', 'info', `not found by name: ${missing.join(', ')} (a moving character usually has them as layers of their own; docs/PSDの描き方.md)`);

  // what the automatic tools find
  const model = res.model, src = { layers: res.layers }; // the PSD folders (左目 ...) give the sides
  const eye = makeEyeBlink(model, src), mouth = makeMouthOpen(model, src);
  // (the parameters they name are added by the editor: not a thing to fix in the drawing)
  for (const n of [...eye.notes, ...mouth.notes]) if (n.level !== 'info' && n.code !== 'paramMissing') add(n.code, 'warn', n.text);
  const face = model.parts.filter((p) => FACE.test(p.id) && !HAIR.test(p.id)).map((p) => p.id);
  if (!face.length) add('checkNoFace', 'warn', 'no face picture found by name (顔 / 輪郭 / face): the face angles need it');
  const chains = suggestChains(model);
  const driven = (r) => [...new Set(r.motions.flatMap((m) => Object.keys(m.at || {})))];
  return { items, found: { eyes: driven(eye), mouth: driven(mouth), face, chains: chains.length } };
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), zlib = await import('node:zlib');
  const args = process.argv.slice(2), file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/psd_check.mjs picture.psd [--json]'); process.exit(2); }
  const r = checkPsd(fs.readFileSync(file), { inflate: (b) => zlib.inflateSync(b) });
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else {
    for (const it of r.items) console.log(`${it.level}: ${it.text}`);
    console.log(`found: eyes ${r.found.eyes.join(', ') || '—'}; mouth ${r.found.mouth.join(', ') || '—'}; face ${r.found.face.join(', ') || '—'}; sway candidates ${r.found.chains}`);
    if (!r.items.some((x) => x.level !== 'info')) console.log('nothing to fix');
  }
  process.exit(r.items.some((x) => x.level !== 'info') ? 1 : 0);
}
