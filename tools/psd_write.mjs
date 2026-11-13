// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A layered PSD from pictures (used by tools/export_pose_psd.mjs and the editor's export window). Plain ES module, no
// Node API: works in the browser. 8-bit RGB, each layer's channels PackBits (RLE), names in the Pascal name ('?' for
// what is not ASCII) and in a 'luni' block (Unicode), folders as Photoshop writes them (an end marker, the layers,
// then the folder's own record with an 'lsct' block, pass through). Written from Adobe's published "Photoshop File
// Formats Specification".
//
//   writeLayeredPsd(width, height, items, merged) -> Uint8Array (the .psd)
//     width, height: the canvas in pixels
//     items: bottom first (the first is at the back), each one of
//       a layer:  { name, left, top, width, height, rgba, opacity, hidden, blend }
//         name     text (any characters)
//         left, top: where its top-left pixel sits on the canvas (may be outside it)
//         width, height, rgba: its pixels, width × height × 4 bytes, straight (not premultiplied) alpha;
//                  width or height 0 (or left out) for an empty layer
//         opacity  0..1 (default 1); hidden: true to hide it (default false)
//         blend    'normal' (default) | 'multiply' | 'screen' | 'add' (Photoshop's linear dodge)
//       a folder: { folder: name, hidden, children: [items, bottom first] }  (folders nest)
//     merged: { rgba } the canvas's picture (width × height × 4, straight alpha), written as the file's merged
//       picture over white, for apps that read only that; null for white
//   trimLayer(rgba, width, height) -> { left, top, width, height, rgba } | null: a canvas-sized picture cut to what shows
import { packBits, BLENDS } from './psd_add_layer.mjs';

const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const i32 = (n) => u32(n >>> 0);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
function pascal(name) { // the name's length and characters (not ASCII as '?'), padded to 4
  const b = [...name].slice(0, 255).map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));
  const out = [b.length, ...b];
  while (out.length % 4) out.push(0);
  return out;
}
function block(key, body) { const b = [...body]; while (b.length % 4) b.push(0); return [...ascii('8BIM'), ...ascii(key), ...u32(b.length), ...b]; }
function luni(name) { const cs = [...name].flatMap((c) => { const out = []; for (let i = 0; i < c.length; i++) out.push(...u16(c.charCodeAt(i))); return out; }); return block('luni', [...u32(cs.length / 2), ...cs]); }

// pieces (arrays of bytes or Uint8Arrays) into one Uint8Array
function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// channels, PackBits: [compression 1, every row's byte count (channel after channel), the rows]
function rleChannels(planes, w, h) {
  const rows = planes.flatMap((plane) => Array.from({ length: h }, (_, y) => packBits(plane.subarray(y * w, y * w + w))));
  return cat([u16(1), cat(rows.map((r) => u16(r.length))), ...rows]);
}

/** A layered 8-bit RGB PSD. items (bottom first) are layers or folders; merged: { rgba } the canvas's picture (drawn over white). */
export function writeLayeredPsd(width, height, items, merged) {
  const recs = [], datas = [];
  let count = 0;
  const layer = (L) => {
    const w = L.width || 0, h = L.height || 0, chans = [];
    if (w && h) {
      for (const c of [3, 0, 1, 2]) { const plane = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) plane[i] = L.rgba[i * 4 + c]; chans.push(rleChannels([plane], w, h)); }
    } else for (let k = 0; k < 4; k++) chans.push(u16(0));
    const extra = [...u32(0), ...u32(0), ...pascal(L.name), ...luni(L.name), ...(L.section ? block('lsct', [...u32(L.section), ...ascii('8BIM'), ...ascii('pass')]) : [])];
    recs.push(...i32(L.top || 0), ...i32(L.left || 0), ...i32((L.top || 0) + h), ...i32((L.left || 0) + w), ...u16(4));
    [-1, 0, 1, 2].forEach((id, k) => recs.push(...u16(id & 0xffff), ...u32(chans[k].length)));
    recs.push(...ascii('8BIM'), ...ascii(L.section ? 'norm' : (BLENDS[L.blend] || 'norm')), Math.round(255 * Math.max(0, Math.min(1, L.opacity ?? 1))), 0,
      0x08 | (L.hidden ? 0x02 : 0) | (L.section ? 0x10 : 0), 0, ...u32(extra.length), ...extra);
    for (const c of chans) datas.push(c);
    count++;
  };
  const walk = (list) => {
    for (const it of list) {
      if (it.folder !== undefined) { // the folder's end marker, its layers, then the folder itself
        layer({ name: '</Layer group>', section: 3 });
        walk(it.children);
        layer({ name: it.folder, section: 1, hidden: it.hidden });
      } else layer(it);
    }
  };
  walk(items);
  let info = cat([u16(count), recs, ...datas]);
  if (info.length % 2) info = cat([info, [0]]);
  const lm = cat([u32(info.length), info, u32(0)]);
  // the merged picture: the first frame over white, PackBits
  const N = width * height, planes = [0, 1, 2].map(() => new Uint8Array(N));
  for (let i = 0; i < N; i++) {
    const a = merged ? merged.rgba[i * 4 + 3] / 255 : 0;
    for (let c = 0; c < 3; c++) planes[c][i] = Math.round((merged ? merged.rgba[i * 4 + c] : 0) * a + 255 * (1 - a));
  }
  const head = [...ascii('8BPS'), ...u16(1), 0, 0, 0, 0, 0, 0, ...u16(3), ...u32(height), ...u32(width), ...u16(8), ...u16(3), ...u32(0), ...u32(0), ...u32(lm.length)];
  return cat([head, lm, rleChannels(planes, width, height)]);
}

/** The box of what is not transparent in a W×H picture, and those pixels: { left, top, width, height, rgba }, or null when nothing shows. */
export function trimLayer(rgba, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4), y * w * 4);
  return { left: x0, top: y0, width: w, height: h, rgba: out };
}
