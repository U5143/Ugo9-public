// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The PSD and the model side by side (機能の比べ #20、利用者の声 #22): before reading a redrawn PSD again, what became of
// each part's layer. Reading again (reimportPsd) matches layers by their folder path and name; this looks closer:
//   - matched by name: 'same' (the pixels as they were), 'moved' (the same picture, dx, dy away), 'resized' (its
//     picture's box grew or shrank), 'redrawn' (the same box, other pixels: how much of it changed)
//   - not matched: a layer gone and a new one whose pictures look alike (in the same place or near) are offered as a
//     rename ('renamed', with how alike); the rest are 'removed' (the part loses its layer) and 'added'
//   - the renames applied to the earlier layers' list (`layers`), so reimportPsd then keeps those parts (and their
//     meshes, keyforms and weights)
// The old pictures come back from the model's atlas (layerPixelsFromAtlas); the new ones from the PSD.
//
//   psdLinks(psdBytes, doc, pages, opts) -> { rows: [{ part, status, from, to, dx, dy, changed, alike }], added: [path],
//     layers (doc.layers with the renames), notes }
//     doc: { canvas, parts, layers } (the model, with source.psd.layers as layers); pages: the model's atlas pages
//     [{ width, height, rgba }]; opts: importPsd's (inflate, ...), minAlike (0.9)
//   node tools/psd_links.mjs model.json new.psd [--json] [--write out.json]
//     (model.json keeps source.psd.layers, its atlas beside it; --write: the model with the renames, to open again)
// Works in the browser (no Node APIs outside the CLI block).
import { importPsd, layerPixelsFromAtlas } from './import_psd.mjs';

const ALPHA = 8;
// the opaque box of a picture placed on the canvas: [x0, y0, x1, y1] in canvas pixels, or null
function opaqueBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (p.rgba[(y * p.width + x) * 4 + 3] >= ALPHA) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  return x1 < 0 ? null : [p.left + x0, p.top + y0, p.left + x1, p.top + y1];
}
// a picture's pixel at canvas (x, y), premultiplied 0..255
function at(p, x, y) {
  const lx = x - p.left, ly = y - p.top;
  if (lx < 0 || ly < 0 || lx >= p.width || ly >= p.height) return [0, 0, 0, 0];
  const i = (ly * p.width + lx) * 4, a = p.rgba[i + 3] / 255;
  return [p.rgba[i] * a, p.rgba[i + 1] * a, p.rgba[i + 2] * a, p.rgba[i + 3]];
}
// the share of pixels (in the union of both boxes) that differ by more than 8 levels, with b shifted by (dx, dy)
function changedShare(a, b, boxA, boxB, dx = 0, dy = 0) {
  const X0 = Math.min(boxA[0], boxB[0] - dx), Y0 = Math.min(boxA[1], boxB[1] - dy), X1 = Math.max(boxA[2], boxB[2] - dx), Y1 = Math.max(boxA[3], boxB[3] - dy);
  let n = 0, diff = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const p = at(a, x, y), q = at(b, x + dx, y + dy);
    if (p[3] < ALPHA && q[3] < ALPHA) continue;
    n++;
    if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]), Math.abs(p[3] - q[3])) > 8) diff++;
  }
  return n ? diff / n : 0;
}
// how alike two pictures look (0..1): their opaque boxes made 16 × 16 (area means, premultiplied), compared
function thumb(p, box) {
  const S = 16, out = new Float32Array(S * S * 4), w = box[2] - box[0], h = box[3] - box[1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = at(p, box[0] + x, box[1] + y), o = (Math.floor((y * S) / h) * S + Math.floor((x * S) / w)) * 4;
    for (let k = 0; k < 4; k++) out[o + k] += q[k] / ((w * h) / (S * S));
  }
  return out;
}
function alike(a, b, boxA, boxB) {
  const ta = thumb(a, boxA), tb = thumb(b, boxB);
  let d = 0;
  for (let i = 0; i < ta.length; i++) d += Math.abs(ta[i] - tb[i]);
  const look = 1 - d / (ta.length * 255);
  const wa = boxA[2] - boxA[0], ha = boxA[3] - boxA[1], wb = boxB[2] - boxB[0], hb = boxB[3] - boxB[1];
  const size = Math.min(wa / wb, wb / wa) * Math.min(ha / hb, hb / ha); // 1 when the same size
  return look * Math.sqrt(size);
}

/** What became of each part's layer in a redrawn PSD. */
export function psdLinks(psdBytes, doc, pages, opts = {}) {
  const res = importPsd(psdBytes, { ...opts, keepPixels: true });
  const minAlike = opts.minAlike ?? 0.9, notes = [];
  const key = (l) => JSON.stringify(l.path || [l.name]);
  const old = (doc.layers || []).filter((l) => (doc.parts || []).some((p) => p.id === l.part));
  const pic = (l) => { try { return layerPixelsFromAtlas(l, pages[l.atlas?.page || 0], { scale: opts.scale ?? 1 }); } catch { return null; } };
  const oldPics = new Map(old.map((l) => [l, pic(l)]));
  const newPics = new Map(res.layers.map((l) => [l, { left: l.left, top: l.top, width: l.width, height: l.height, rgba: l.rgba }]));
  // by name, as reimportPsd does (the n-th of the same path with the n-th)
  const byKey = new Map();
  for (const l of res.layers) { const k = key(l); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(l); }
  const used = new Set(), rows = [], gone = [];
  const seen = new Map();
  for (const l of old) {
    const k = key(l), n = seen.get(k) || 0, nl = (byKey.get(k) || [])[n];
    seen.set(k, n + 1);
    if (!nl) { gone.push(l); continue; }
    used.add(nl);
    rows.push({ part: l.part, ...compare(oldPics.get(l), newPics.get(nl)), from: l.path, to: nl.path });
  }
  // renames: a layer gone and a new one that look alike, the most alike first
  const fresh = res.layers.filter((l) => !used.has(l));
  const pairs = [];
  for (const g of gone) for (const f of fresh) {
    const a = oldPics.get(g), b = newPics.get(f), ba = a && opaqueBox(a), bb = b && opaqueBox(b);
    if (!ba || !bb) continue;
    const near = Math.hypot((ba[0] + ba[2] - bb[0] - bb[2]) / 2, (ba[1] + ba[3] - bb[1] - bb[3]) / 2) / Math.max(1, Math.hypot(res.model.canvas.width, res.model.canvas.height));
    const score = alike(a, b, ba, bb) * (1 - Math.min(0.5, near)); // far apart: less likely the same
    if (score >= minAlike) pairs.push([score, g, f]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const renamed = new Map();
  for (const [score, g, f] of pairs) {
    if (renamed.has(g) || used.has(f)) continue;
    renamed.set(g, f); used.add(f);
    rows.push({ part: g.part, ...compare(oldPics.get(g), newPics.get(f)), status: 'renamed', from: g.path, to: f.path, alike: +score.toFixed(3) });
    notes.push({ code: 'psdLinkRenamed', vars: { part: g.part, from: g.path.join('/'), to: f.path.join('/') }, text: `part ${g.part}: its layer ${g.path.join('/')} looks like the new ${f.path.join('/')} (renamed?)` });
  }
  for (const g of gone) if (!renamed.has(g)) {
    rows.push({ part: g.part, status: 'removed', from: g.path, to: null });
    notes.push({ code: 'psdLinkRemoved', vars: { part: g.part, layer: g.path.join('/') }, text: `part ${g.part}: its layer ${g.path.join('/')} is not in the PSD` });
  }
  const added = res.layers.filter((l) => !used.has(l)).map((l) => l.path);
  for (const p of added) notes.push({ code: 'psdLinkAdded', vars: { layer: p.join('/') }, text: `a new layer ${p.join('/')}`, level: 'info' });
  // the earlier layers' list with the renames, for reimportPsd
  const layers = (doc.layers || []).map((l) => { const f = renamed.get(l); return f ? { ...l, name: f.name, path: f.path } : l; });
  const order = { removed: 0, renamed: 1, redrawn: 2, resized: 3, moved: 4, same: 5 };
  rows.sort((a, b) => order[a.status] - order[b.status] || String(a.part).localeCompare(String(b.part)));
  return { rows, added, layers, notes };
}

// one layer before and after: same, moved (dx, dy), resized, or redrawn (the share of pixels that changed)
function compare(a, b) {
  const ba = a && opaqueBox(a), bb = b && opaqueBox(b);
  if (!ba || !bb) return { status: ba === bb ? 'same' : 'redrawn', changed: ba === bb ? 0 : 1 };
  const dx = bb[0] - ba[0], dy = bb[1] - ba[1], sameSize = bb[2] - bb[0] === ba[2] - ba[0] && bb[3] - bb[1] === ba[3] - ba[1];
  if (sameSize) {
    const here = changedShare(a, b, ba, bb, 0, 0);
    if (!dx && !dy) return here === 0 ? { status: 'same', changed: 0 } : { status: 'redrawn', changed: +here.toFixed(3) };
    const shifted = changedShare(a, b, ba, bb, dx, dy);
    if (shifted === 0) return { status: 'moved', dx, dy, changed: 0 };
    return { status: 'redrawn', dx, dy, changed: +shifted.toFixed(3) };
  }
  return { status: 'resized', dx, dy, size: [[ba[2] - ba[0], ba[3] - ba[1]], [bb[2] - bb[0], bb[3] - bb[1]]], changed: +changedShare(a, b, ba, bb).toFixed(3) };
}

/** The rows as a table (text). */
export function formatLinks(r) {
  const L = [];
  const path = (p) => (p ? p.join('/') : '—');
  for (const row of r.rows) {
    const what = row.status === 'moved' ? `moved ${row.dx},${row.dy}` : row.status === 'resized' ? `resized ${row.size[0].join('×')} → ${row.size[1].join('×')}`
      : row.status === 'redrawn' ? `redrawn (${Math.round(row.changed * 100)}% of its pixels${row.dx || row.dy ? `, moved ${row.dx},${row.dy}` : ''})`
        : row.status === 'renamed' ? `renamed? → ${path(row.to)} (alike ${row.alike})` : row.status;
    L.push(`${String(row.part).padEnd(16)} ${path(row.from).padEnd(28)} ${what}`);
  }
  for (const p of r.added) L.push(`${'(new)'.padEnd(16)} ${path(p).padEnd(28)} added`);
  return L.join('\n');
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), path = await import('node:path'), zlib = await import('node:zlib');
  const { decodePng } = await import('./png.mjs');
  const args = process.argv.slice(2), files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--write');
  if (files.length !== 2) { console.error('usage: node tools/psd_links.mjs model.json new.psd [--json] [--write out.json]'); process.exit(2); }
  const model = JSON.parse(fs.readFileSync(files[0], 'utf8')), dir = path.dirname(files[0]);
  if (!model.source?.psd?.layers) { console.error(`${files[0]} keeps no PSD layers (source.psd.layers): it was not made from a PSD in the editor`); process.exit(2); }
  const pages = (model.textures || []).map((t) => decodePng(fs.readFileSync(path.join(dir, t))));
  const r = psdLinks(fs.readFileSync(files[1]), { canvas: model.canvas, parts: model.parts, layers: model.source.psd.layers }, pages,
    { inflate: (b) => zlib.inflateSync(b), scale: model.source.psd.scale ?? 1, atlasAnyAngle: !!model.source.psd.atlasAnyAngle });
  console.log(args.includes('--json') ? JSON.stringify({ rows: r.rows, added: r.added, notes: r.notes }, null, 1) : formatLinks(r));
  if (args.includes('--write')) {
    const out = args[args.indexOf('--write') + 1];
    fs.writeFileSync(out, JSON.stringify({ ...model, source: { ...model.source, psd: { ...model.source.psd, layers: r.layers } } }, null, 1));
    console.log(`${out}: the model with the renames (open it, then read the PSD again)`);
  }
}
