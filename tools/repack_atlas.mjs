// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Atlas pages packed by the pictures' shapes (機能の比べ #16 の残り、利用者の声 #56): each part's footprint on its page is
// what its triangles sample (the triangles' pixels, grown by the padding so blending at the edges reads the picture's own
// rim); the footprints, not their boxes, are packed, so an L-shaped arm can sit in the hollow of a curved body. Pixels
// are copied as they are (moved, or turned a quarter: nothing resampled) and the UVs follow, so the parts look the same.
//
//   repackAtlas(model, pages, opts) -> { model, pages: [{ width, height, rgba }], before, after, placed }
//     model: the working JSON; pages: its textures' pixels in model.textures' order
//     opts: padding (px around each footprint, default 2), maxSize (4096), cell (the packing grid in px, default 4; 2 packs a little tighter, several times slower),
//     turn (true: a footprint may lie turned 90°, its pixels moved as they are; false: never; 'always': every one, for tests),
//     names (the new pages' file names; default the old ones, then atlas_N.png)
//     before / after: the pages' pixels in all (width × height summed); kept: true when packing by shape was not smaller
//     (the model and pages as they were; opts.always: the repacked ones anyway)
//   node tools/repack_atlas.mjs model.json --out folder [--padding 2] [--cell 4]
// Works in the browser (no Node APIs outside the CLI block).

// a part's footprint in its page's pixels: the pixels its triangles reach, grown by r (a square around each)
function footprint(part, page, r) {
  const W = page.width, H = page.height, uv = part.uvs, t = part.triangles;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < uv.length; i += 2) { const x = uv[i] * W, y = uv[i + 1] * H; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const bx = Math.max(0, Math.floor(x0) - r), by = Math.max(0, Math.floor(y0) - r), bw = Math.min(W, Math.ceil(x1) + r) - bx, bh = Math.min(H, Math.ceil(y1) + r) - by;
  if (bw <= 0 || bh <= 0) return null;
  const core = new Uint8Array(bw * bh);
  for (let k = 0; k < t.length; k += 3) { // the pixels whose square meets the triangle (centres tested against it grown by half a pixel's diagonal)
    const P = [t[k], t[k + 1], t[k + 2]].map((v) => [uv[2 * v] * W - bx, uv[2 * v + 1] * H - by]);
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(area) < 1e-12) continue;
    const s = Math.sign(area);
    const edges = [0, 1, 2].map((e) => { const [a, b] = [P[e], P[(e + 1) % 3]], nx = (b[1] - a[1]) * s, ny = -(b[0] - a[0]) * s, len = Math.hypot(nx, ny); return [nx / len, ny / len, a]; });
    const minX = Math.max(0, Math.floor(Math.min(...P.map((p) => p[0])) - 1)), maxX = Math.min(bw - 1, Math.ceil(Math.max(...P.map((p) => p[0])) + 1));
    const minY = Math.max(0, Math.floor(Math.min(...P.map((p) => p[1])) - 1)), maxY = Math.min(bh - 1, Math.ceil(Math.max(...P.map((p) => p[1])) + 1));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (edges.every(([nx, ny, a]) => (cx - a[0]) * nx + (cy - a[1]) * ny <= 0.7072)) core[y * bw + x] = 1;
    }
  }
  // grown by r: rows then columns
  const tmp = new Uint8Array(bw * bh), mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (core[y * bw + x]) for (let d = Math.max(0, x - r); d <= Math.min(bw - 1, x + r); d++) tmp[y * bw + d] = 1;
  for (let x = 0; x < bw; x++) for (let y = 0; y < bh; y++) if (tmp[y * bw + x]) for (let d = Math.max(0, y - r); d <= Math.min(bh - 1, y + r); d++) mask[d * bw + x] = 1;
  return { x: bx, y: by, w: bw, h: bh, mask };
}

// the footprint turned 90° clockwise: pixel (x, y) of the w × h box goes to (h - 1 - y, x) of the h × w box
function turned(fp) {
  const mask = new Uint8Array(fp.w * fp.h);
  for (let y = 0; y < fp.h; y++) for (let x = 0; x < fp.w; x++) if (fp.mask[y * fp.w + x]) mask[x * fp.h + (fp.h - 1 - y)] = 1;
  return { ...fp, w: fp.h, h: fp.w, mask };
}

// the footprint on a grid of cell × cell px (a cell is taken when any of its pixels is)
function cellsOf(fp, cell) {
  const cw = Math.ceil(fp.w / cell), ch = Math.ceil(fp.h / cell), rows = [];
  for (let cy = 0; cy < ch; cy++) {
    const row = new Uint8Array(cw);
    for (let y = cy * cell; y < Math.min(fp.h, (cy + 1) * cell); y++) for (let x = 0; x < fp.w; x++) if (fp.mask[y * fp.w + x]) row[Math.floor(x / cell)] = 1;
    rows.push(row);
  }
  // each row as [from, to) runs, to test quickly
  return { cw, ch, runs: rows.map((row) => { const out = []; for (let x = 0; x < cw;) { if (!row[x]) { x++; continue; } let e = x; while (e < cw && row[e]) e++; out.push([x, e]); x = e; } return out; }) };
}

// first fit on a page of gw cells across, growing down: the lowest, then leftmost place where the shape meets nothing
function packPage(shapes, gw, gmax) {
  const grid = []; // rows of Uint8Array(gw)
  const rowAt = (y) => { while (grid.length <= y) grid.push(new Uint8Array(gw)); return grid[y]; };
  const fits = (s, X, Y) => {
    for (let r = 0; r < s.ch; r++) {
      if (Y + r >= grid.length) return true;
      const row = grid[Y + r];
      for (const [a, b] of s.runs[r]) for (let x = a; x < b; x++) if (row[X + x]) return false;
    }
    return true;
  };
  const placed = [], rest = [];
  for (const shape of shapes) { // each way it may lie (upright, turned): the place whose bottom is highest, then leftmost
    let best = null;
    for (const v of shape.ways) {
      if (v.cw > gw || v.ch > gmax) continue;
      let at = null;
      for (let Y = 0; Y + v.ch <= gmax && !at && !(best && Y + v.ch > best.at[1] + best.v.ch); Y++) for (let X = 0; X + v.cw <= gw; X++) if (fits(v, X, Y)) { at = [X, Y]; break; }
      if (at && (!best || at[1] + v.ch < best.at[1] + best.v.ch || (at[1] + v.ch === best.at[1] + best.v.ch && at[0] < best.at[0]))) best = { v, at };
    }
    if (!best) { rest.push(shape); continue; }
    const { v, at } = best;
    for (let r = 0; r < v.ch; r++) { const row = rowAt(at[1] + r); for (const [a, b] of v.runs[r]) row.fill(1, at[0] + a, at[0] + b); }
    placed.push({ s: shape, v, at });
  }
  return { placed, rest, height: grid.length };
}

/** The pages packed again by the parts' footprints. */
export function repackAtlas(model, pages, opts = {}) {
  const pad = opts.padding ?? 2, cell = opts.cell || 4, maxSize = opts.maxSize || 4096;
  const out = structuredClone(model);
  // a footprint per picture (parts with the same UVs on the same page share one: copies drawn in several places)
  const groups = new Map();
  out.parts.forEach((p, i) => {
    if (!p.uvs?.length || !p.triangles?.length) return;
    const key = `${p.texture || 0}|${p.uvs.map((v) => v.toFixed(6)).join(',')}`;
    if (!groups.has(key)) groups.set(key, { page: p.texture || 0, parts: [], fp: null });
    groups.get(key).parts.push(i);
  });
  const shapes = [];
  for (const g of groups.values()) {
    g.fp = footprint(out.parts[g.parts[0]], pages[g.page], pad + 1); // +1: the pixel a bilinear sample at the edge also reads
    if (!g.fp) continue;
    const up = { turn: false, fp: g.fp, ...cellsOf(g.fp, cell) }, ways = opts.turn === 'always' ? [] : [up];
    if (opts.turn !== false && (g.fp.w !== g.fp.h || opts.turn === 'always')) { const t = turned(g.fp); ways.push({ turn: true, fp: t, ...cellsOf(t, cell) }); }
    shapes.push({ g, ways, cw: up.cw, ch: up.ch });
  }
  shapes.sort((a, b) => b.ch * b.cw - a.ch * a.cw || Math.max(b.ch, b.cw) - Math.max(a.ch, a.cw));
  // the page width: the one (of a few) that gives the fewest pages, then the least area
  const widest = Math.max(1, ...shapes.map((s) => Math.min(s.cw, s.ch) * cell));
  const widths = [];
  for (let w = 64; w < maxSize; w *= 2) if (w >= widest) widths.push(w);
  widths.push(maxSize);
  let best = null;
  for (const W of widths) {
    const gw = Math.floor(W / cell), gmax = Math.floor(maxSize / cell), result = [];
    let left = shapes;
    while (left.length) {
      const { placed, rest, height } = packPage(left, gw, gmax);
      if (!placed.length) throw new Error('a picture is larger than a page');
      result.push({ placed, width: W, height: height * cell });
      left = rest;
    }
    const area = result.reduce((s, p) => s + p.width * p.height, 0);
    if (!best || result.length < best.result.length || (result.length === best.result.length && area < best.area)) best = { result, area };
  }
  // the new pages: each footprint's pixels copied as they are, the UVs shifted
  const newPages = best.result.map((p) => ({ width: p.width, height: p.height, rgba: new Uint8Array(p.width * p.height * 4) }));
  const names = opts.names || [];
  best.result.forEach((p, pi) => {
    const dst = newPages[pi];
    for (const { s, v, at } of p.placed) {
      const { g } = s, fp = g.fp, src = pages[g.page], ox = at[0] * cell, oy = at[1] * cell;
      // a point of the old page -> the new page: shifted, or turned 90° clockwise about the box ((x, y) -> (h - y, x))
      const map = (px, py) => { const lx = px - fp.x, ly = py - fp.y; return v.turn ? [ox + fp.h - ly, oy + lx] : [ox + lx, oy + ly]; };
      for (let y = 0; y < fp.h; y++) for (let x = 0; x < fp.w; x++) {
        if (!fp.mask[y * fp.w + x]) continue;
        const [tx, ty] = v.turn ? [ox + fp.h - 1 - y, oy + x] : [ox + x, oy + y];
        const si = ((fp.y + y) * src.width + fp.x + x) * 4, di = (ty * dst.width + tx) * 4;
        dst.rgba[di] = src.rgba[si]; dst.rgba[di + 1] = src.rgba[si + 1]; dst.rgba[di + 2] = src.rgba[si + 2]; dst.rgba[di + 3] = src.rgba[si + 3];
      }
      for (const i of g.parts) {
        const part = out.parts[i], uv = [];
        for (let k = 0; k < part.uvs.length; k += 2) { const [nx, ny] = map(part.uvs[k] * src.width, part.uvs[k + 1] * src.height); uv.push(nx / dst.width, ny / dst.height); }
        part.uvs = uv;
        if (pi) part.texture = pi; else delete part.texture;
      }
    }
  });
  out.textures = newPages.map((_, i) => names[i] || (model.textures?.[i] ?? `atlas_${i + 1}.png`));
  const before = pages.reduce((s, p) => s + p.width * p.height, 0);
  // not smaller (pictures that are near rectangles, already packed tightly): the model as it was
  if (best.area >= before && opts.always !== true) return { model: structuredClone(model), pages, before, after: before, placed: shapes.length, kept: true };
  return { model: out, pages: newPages, before, after: best.area, placed: shapes.length, kept: false };
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), path = await import('node:path');
  const { decodePng, encodePng } = await import('./png.mjs');
  const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
  const src = args.find((a, i) => !a.startsWith('--') && !['--out', '--padding', '--cell', '--max'].includes(args[i - 1])), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (!src || !out) { console.error('usage: node tools/repack_atlas.mjs model.json --out folder [--padding 2] [--cell 4] [--max 4096]'); process.exit(2); }
  const model = JSON.parse(fs.readFileSync(src, 'utf8')), dir = path.dirname(src);
  const pages = model.textures.map((t) => decodePng(fs.readFileSync(path.join(dir, t))));
  const t0 = Date.now(), r = repackAtlas(model, pages, { padding: opt('--padding', 2), cell: opt('--cell', 4), maxSize: opt('--max', 4096) });
  fs.mkdirSync(out, { recursive: true });
  r.pages.forEach((p, i) => fs.writeFileSync(path.join(out, r.model.textures[i]), encodePng(p.width, p.height, p.rgba)));
  fs.writeFileSync(path.join(out, path.basename(src)), JSON.stringify(r.model, null, 1));
  console.log(`${out}: ${r.kept ? 'not smaller packed by shape: kept as it was' : `${r.pages.map((p) => `${p.width}x${p.height}`).join(' + ')} (${r.after} px, was ${r.before}: ${Math.round((100 * r.after) / r.before)}%)`}, ${r.placed} pictures, ${Date.now() - t0} ms`);
}
