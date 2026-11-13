// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A sprite sheet of several animations, for game engines without a Ugo9 runtime (GameMaker, Construct,
// GDevelop, Defold, Phaser, PixiJS...): every frame trimmed to what it shows, frames that look the same
// kept once, packed in rows, with the "JSON (Hash)" description that TexturePacker and Aseprite write
// (frames by name with their place, trimmed box and time; one frame tag per animation). Plain ES module:
// the editor's export and tools/export_sheet.mjs use it.
//
//   packSheet(anims, w, h, opts) -> { width, height, rgba, json, frames, unique }
//     anims: [{ name, fps, frames: [Uint8Array w*h*4 straight RGBA], pingpong }]
//     opts: { image ('sheet.png', named in the description), trim (true), dedupe (true), padding (1),
//             maxWidth (the sheet's width at most; it grows down. By default about square, at most 4096) }

// a frame's trimmed pixels: a hash, and whether two are the same picture (byte for byte)
function hashOf(rgba, box, w) {
  let h = 2166136261 ^ (box[2] - box[0]) ^ ((box[3] - box[1]) << 16);
  for (let y = box[1]; y < box[3]; y++) for (let i = (y * w + box[0]) * 4, e = (y * w + box[2]) * 4; i < e; i++) h = Math.imul(h ^ rgba[i], 16777619);
  return h >>> 0;
}
function samePicture(a, b, w) {
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let y = 0; y < a.h; y++) {
    const pa = ((a.box[1] + y) * w + a.box[0]) * 4, pb = ((b.box[1] + y) * w + b.box[0]) * 4;
    for (let i = 0; i < a.w * 4; i++) if (a.rgba[pa + i] !== b.rgba[pb + i]) return false;
  }
  return true;
}
// the smallest box holding every pixel that is not fully transparent: [x0, y0, x1, y1] (end exclusive); an empty frame -> 1×1 at 0, 0
function opaqueBox(rgba, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1; }
  return x1 > x0 ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}
const pad4 = (n) => String(n).padStart(4, '0');
const esc = (s) => JSON.stringify(String(s));

export function packSheet(anims, w, h, opts = {}) {
  const trim = opts.trim !== false, dedupe = opts.dedupe !== false, padding = opts.padding ?? 1;
  // the frames, trimmed, and the pictures kept once
  const frames = [], pictures = [], seen = new Map();
  for (const a of anims) {
    a.frames.forEach((rgba, i) => {
      const box = trim ? opaqueBox(rgba, w, h) : [0, 0, w, h];
      let pic = { rgba, box, w: box[2] - box[0], h: box[3] - box[1] };
      const k = dedupe ? hashOf(rgba, box, w) : null, same = k !== null ? (seen.get(k) || []).find((q) => samePicture(q, pic, w)) : null;
      if (same) pic = same;
      else { pictures.push(pic); if (k !== null) seen.set(k, [...(seen.get(k) || []), pic]); }
      frames.push({ name: `${a.name}_${pad4(i)}`, anim: a.name, pic, box, ms: Math.max(1, Math.round(1000 / (a.fps || 30))) });
    });
  }
  // rows, tallest first: each row as wide as maxWidth allows (by default about square: the pictures' area's
  // square root, a little more for the gaps; at most 4096)
  const area = pictures.reduce((sum, p) => sum + (p.w + padding) * (p.h + padding), 0), widest = Math.max(...pictures.map((p) => p.w)) + 2 * padding;
  const maxWidth = Math.max(widest, opts.maxWidth || Math.min(4096, Math.ceil(Math.sqrt(area) * 1.08)));
  const order = [...pictures].sort((p, q) => q.h - p.h || q.w - p.w);
  let x = padding, y = padding, rowH = 0, width = 0;
  for (const p of order) {
    if (x + p.w + padding > maxWidth && x > padding) { x = padding; y += rowH + padding; rowH = 0; }
    p.x = x; p.y = y; x += p.w + padding; rowH = Math.max(rowH, p.h); width = Math.max(width, x);
  }
  const height = y + rowH + padding;
  const rgba = new Uint8Array(width * height * 4);
  for (const p of pictures) for (let yy = 0; yy < p.h; yy++) {
    const from = ((p.box[1] + yy) * w + p.box[0]) * 4;
    rgba.set(p.rgba.subarray(from, from + p.w * 4), ((p.y + yy) * width + p.x) * 4);
  }
  // the description: frames in order, one frame tag per animation
  const lines = frames.map((f) => `${esc(f.name)}:{"frame":{"x":${f.pic.x},"y":${f.pic.y},"w":${f.pic.w},"h":${f.pic.h}},"rotated":false,"trimmed":${trim && (f.pic.w !== w || f.pic.h !== h)},`
    + `"spriteSourceSize":{"x":${f.box[0]},"y":${f.box[1]},"w":${f.pic.w},"h":${f.pic.h}},"sourceSize":{"w":${w},"h":${h}},"duration":${f.ms}}`);
  let at = 0;
  const tags = anims.map((a) => { const t = `{"name":${esc(a.name)},"from":${at},"to":${at + a.frames.length - 1},"direction":${esc(a.pingpong ? 'pingpong' : 'forward')}}`; at += a.frames.length; return t; });
  const json = `{"frames":{\n ${lines.join(',\n ')}},\n"meta":{"app":"Ugo9","version":"1","image":${esc(opts.image || 'sheet.png')},"format":"RGBA8888","size":{"w":${width},"h":${height}},"scale":"1",`
    + `"frameTags":[${tags.join(',')}]}}\n`;
  return { width, height, rgba, json, frames: frames.length, unique: pictures.length };
}
