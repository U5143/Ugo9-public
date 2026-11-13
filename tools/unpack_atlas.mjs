// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// An atlas back to one picture per part (機能の比べ #18): each part's mesh is drawn in its setup pose at the canvas's
// pixels, taking its colours from the atlas through its UVs, so a picture packed turned or at an angle comes back
// upright where it sits on the canvas. With the pictures, a list in drawing order (like a PSD's layers, the first at
// the back): the part, its file, place, size, opacity and blend.
//
//   unpackAtlas(model, pages, opts) -> [{ part, left, top, width, height, rgba, order, opacity, blend, folders? }]
//     folders: the PSD folders the part's layer was in, outermost first (source.psd.layers)
//     model: the working JSON; pages: [{ width, height, rgba }] in model.textures' order; opts.sampling 'nearest'
//     (default: the atlas pixel the point falls in) or 'linear'; opts.scale (1)
//   node tools/unpack_atlas.mjs model.json --out build/parts   -> one PNG per part and layers.json
// Parts in warps and with weights come back in their setup shape (the mesh as written in the model).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

function sample(page, u, v, linear) {
  const W = page.width, H = page.height;
  if (!linear) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(H - 1, Math.max(0, Math.floor(v * H))), i = (y * W + x) * 4;
    return [page.rgba[i], page.rgba[i + 1], page.rgba[i + 2], page.rgba[i + 3]];
  }
  const fx = u * W - 0.5, fy = v * H - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, out = [0, 0, 0, 0];
  for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const x = Math.min(W - 1, Math.max(0, x0 + dx)), y = Math.min(H - 1, Math.max(0, y0 + dy)), i = (y * W + x) * 4, a = page.rgba[i + 3] * w;
    for (let k = 0; k < 3; k++) out[k] += page.rgba[i + k] * a; // premultiplied while mixing
    out[3] += a;
  }
  return out[3] > 0 ? [out[0] / out[3], out[1] / out[3], out[2] / out[3], out[3]].map(Math.round) : [0, 0, 0, 0];
}

export function unpackAtlas(model, pages, opts = {}) {
  const k = opts.scale || 1, linear = opts.sampling === 'linear';
  const ox = model.canvas?.originX || 0, oy = model.canvas?.originY || 0;
  const order = (model.parts || []).map((p, i) => ({ p, i })).sort((a, b) => (a.p.order ?? 500) - (b.p.order ?? 500) || a.i - b.i);
  // each part's PSD folders (outermost first), kept by the editor in source.psd.layers
  const groupOf = new Map();
  for (const l of model.source?.psd?.layers || []) if (l.part && (l.path || []).length > 1) groupOf.set(l.part, l.path.slice(0, -1));
  return order.map(({ p }, n) => {
    const page = pages[p.texture || 0], X = (i) => (p.vertices[2 * i] + ox) * k, Y = (i) => (p.vertices[2 * i + 1] + oy) * k;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.vertices.length / 2; i++) { x0 = Math.min(x0, X(i)); y0 = Math.min(y0, Y(i)); x1 = Math.max(x1, X(i)); y1 = Math.max(y1, Y(i)); }
    const left = Math.floor(x0), top = Math.floor(y0), width = Math.max(1, Math.ceil(x1) - left), height = Math.max(1, Math.ceil(y1) - top);
    const rgba = new Uint8Array(width * height * 4);
    for (let t = 0; t < p.triangles.length; t += 3) {
      const [a, b, c] = [p.triangles[t], p.triangles[t + 1], p.triangles[t + 2]];
      const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), cx = X(c), cy = Y(c), d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const px0 = Math.max(left, Math.floor(Math.min(ax, bx, cx))), px1 = Math.min(left + width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const py0 = Math.max(top, Math.floor(Math.min(ay, by, cy))), py1 = Math.min(top + height - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
        const sx = px + 0.5, sy = py + 0.5; // the pixel's centre
        const l1 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) / d, l2 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) / d, l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const o = ((py - top) * width + (px - left)) * 4;
        if (rgba[o + 3]) continue; // a pixel on two triangles' edge: the first
        const u = l1 * p.uvs[2 * a] + l2 * p.uvs[2 * b] + l3 * p.uvs[2 * c], v = l1 * p.uvs[2 * a + 1] + l2 * p.uvs[2 * b + 1] + l3 * p.uvs[2 * c + 1];
        rgba.set(sample(page, u, v, linear), o);
      }
    }
    return { part: p.id, left: left - Math.round(ox * k), top: top - Math.round(oy * k), canvasLeft: left, canvasTop: top, width, height, rgba, order: n, opacity: p.opacity ?? 1, blend: p.blend || 'normal', ...(p.maskOnly ? { maskOnly: true } : {}), ...(groupOf.has(p.id) ? { folders: groupOf.get(p.id) } : {}) };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), src = args.find((a) => !a.startsWith('--')), out = args[args.indexOf('--out') + 1];
  if (!src || !args.includes('--out') || !out) { console.error('usage: node tools/unpack_atlas.mjs model.json --out folder [--linear] [--scale K]'); process.exit(2); }
  const model = JSON.parse(fs.readFileSync(src, 'utf8')), dir = path.dirname(src);
  const pages = (model.textures || []).map((t) => decodePng(fs.readFileSync(path.join(dir, t))));
  const scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) : 1;
  const parts = unpackAtlas(model, pages, { sampling: args.includes('--linear') ? 'linear' : 'nearest', scale });
  fs.mkdirSync(out, { recursive: true });
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
  const list = parts.map((p) => { const file = `${String(p.order).padStart(3, '0')}_${safe(p.part)}.png`; fs.writeFileSync(path.join(out, file), encodePng(p.width, p.height, p.rgba)); const { rgba, ...rest } = p; return { ...rest, file }; });
  fs.writeFileSync(path.join(out, 'layers.json'), JSON.stringify({ canvas: { width: Math.round((model.canvas?.width || 0) * scale), height: Math.round((model.canvas?.height || 0) * scale) }, layers: list }, null, 1));
  console.log(`${out}: ${list.length} pictures and layers.json (drawing order, the first at the back)`);
}
