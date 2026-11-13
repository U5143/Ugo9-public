// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Aseprite files (importAseprite, tools/import_layers.mjs; 利用者の声 #14 / #54). The files are
// written here by a small writer that follows the published file format description: RGBA, grey
// and indexed (new and old palettes, the transparent index), raw and zlib cels, groups with child
// levels, blend modes, layer and cel opacity, hidden, reference and tilemap layers, more frames and
// tags. Then broken files: each stops with a code.
//   node tests/aseprite_test.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importAseprite, importAsepriteAsync, layeredKind } from '../tools/import_layers.mjs';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const node = { inflate: (b) => zlib.inflateSync(b), inflateRaw: (b) => zlib.inflateRawSync(b) };

// ---- a small writer ----
const le = (n, v) => { const b = Buffer.alloc(n); if (n === 1) b.writeUInt8(v & 255); else if (n === 2) b.writeUInt16LE(v & 0xffff); else b.writeUInt32LE(v >>> 0); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
const text = (s) => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([le(2, t.length), t]); };
const chunk = (type, data) => Buffer.concat([le(4, data.length + 6), le(2, type), data]);
const layerChunk = ({ flags = 1, type = 0, level = 0, blend = 0, opacity = 255, name, tileset }) =>
  chunk(0x2004, Buffer.concat([le(2, flags), le(2, type), le(2, level), le(2, 0), le(2, 0), le(2, blend), le(1, opacity), Buffer.alloc(3), text(name), tileset !== undefined ? le(4, tileset) : Buffer.alloc(0)]));
const celChunk = ({ layer, x = 0, y = 0, opacity = 255, type = 2, z = 0, width, height, pixels, link }) => {
  const head = Buffer.concat([le(2, layer), i16(x), i16(y), le(1, opacity), le(2, type), i16(z), Buffer.alloc(5)]);
  if (type === 1) return chunk(0x2005, Buffer.concat([head, le(2, link)]));
  const body = type === 0 ? Buffer.from(pixels) : zlib.deflateSync(Buffer.from(pixels));
  return chunk(0x2005, Buffer.concat([head, le(2, width), le(2, height), body]));
};
const paletteChunk = (colors) => chunk(0x2019, Buffer.concat([le(4, colors.length), le(4, 0), le(4, colors.length - 1), Buffer.alloc(8),
  ...colors.map((c, i) => Buffer.concat([le(2, i === 1 ? 1 : 0), Buffer.from(c), i === 1 ? text('skin') : Buffer.alloc(0)]))]));
const oldPaletteChunk = (colors) => chunk(0x0004, Buffer.concat([le(2, 1), le(1, 0), le(1, colors.length), ...colors.map((c) => Buffer.from(c.slice(0, 3)))]));
const tagsChunk = (tags) => chunk(0x2018, Buffer.concat([le(2, tags.length), Buffer.alloc(8),
  ...tags.map((t) => Buffer.concat([le(2, t.from), le(2, t.to), le(1, t.dir || 0), le(2, t.repeat || 0), Buffer.alloc(6), Buffer.from([255, 0, 0]), le(1, 0), text(t.name)]))]));
const frame = (chunks, ms = 100) => { const body = Buffer.concat(chunks); return Buffer.concat([le(4, body.length + 16), le(2, 0xf1fa), le(2, chunks.length), le(2, ms), Buffer.alloc(2), le(4, chunks.length), body]); };
function ase({ width, height, depth = 32, flags = 3, transparent = 0, pixelRatio = [1, 1], frames, durations = [] }) {
  const body = Buffer.concat(frames.map((f, i) => frame(f, durations[i] ?? 100)));
  const head = Buffer.concat([le(4, 128 + body.length), le(2, 0xa5e0), le(2, frames.length), le(2, width), le(2, height), le(2, depth), le(4, flags), le(2, 100),
    le(4, 0), le(4, 0), le(1, transparent), Buffer.alloc(3), le(2, 0), le(1, pixelRatio[0]), le(1, pixelRatio[1]), i16(0), i16(0), le(2, 16), le(2, 16), Buffer.alloc(84)]);
  if (head.length !== 128) throw new Error(`header ${head.length}`);
  return new Uint8Array(Buffer.concat([head, body]));
}
const pic = (w, h, f) => { const p = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.set(f(x, y), (y * w + x) * 4); return p; };
const at = (L, x, y) => { const lx = x - L.left, ly = y - L.top; if (lx < 0 || ly < 0 || lx >= L.width || ly >= L.height) return [0, 0, 0, 0]; const i = (ly * L.width + lx) * 4; return [...L.rgba.subarray(i, i + 4)]; };
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);

// ---- RGBA: groups, blends, opacity, raw and zlib cels, hidden / reference / tilemap layers, frames and tags ----
const back = pic(32, 24, () => [240, 230, 210, 255]);
const skin = pic(10, 8, (x, y) => [200 + x, 150 + y, 120, 255]);
const shade = pic(6, 4, (x) => [80, 60, 120, x < 3 ? 255 : 0]);
const rgbaFile = ase({
  width: 32, height: 24, frames: [
    [
      layerChunk({ name: 'back', flags: 1 | 8 }),
      layerChunk({ name: 'face', type: 1 }),
      layerChunk({ name: 'skin', level: 1, opacity: 204 }),
      layerChunk({ name: 'shade', level: 1, blend: 1 }),
      layerChunk({ name: 'fx', type: 1, blend: 2, opacity: 128 }),
      layerChunk({ name: 'glow', level: 1, blend: 16 }),
      layerChunk({ name: 'secret', flags: 0 }),
      layerChunk({ name: 'sketch', flags: 1 | 64 }),
      layerChunk({ name: 'tiles', type: 2, tileset: 0 }),
      celChunk({ layer: 0, type: 0, width: 32, height: 24, pixels: back }),
      celChunk({ layer: 2, x: 5, y: 7, opacity: 128, width: 10, height: 8, pixels: skin }),
      celChunk({ layer: 3, x: -2, y: 20, width: 6, height: 4, pixels: shade }),
      celChunk({ layer: 5, x: 20, y: 2, z: 1, width: 2, height: 2, pixels: pic(2, 2, () => [255, 255, 0, 255]) }),
      celChunk({ layer: 6, width: 2, height: 2, pixels: pic(2, 2, () => [255, 0, 0, 255]) }),
      tagsChunk([{ name: 'idle', from: 0, to: 1 }, { name: 'blink', from: 2, to: 2 }]),
    ],
    [celChunk({ layer: 2, type: 1, link: 0 })],
    [celChunk({ layer: 2, x: 6, y: 7, width: 10, height: 8, pixels: skin })],
  ],
});
{
  const r = importAseprite(rgbaFile, { ...node, keepPixels: true }), L = (n) => r.layers.find((l) => l.name === n);
  check(layeredKind(rgbaFile) === 'aseprite', 'layeredKind: aseprite (0xA5E0 at byte 4)');
  check(r.layers.map((l) => l.name).join() === 'back,skin,shade,glow,secret', `the image layers bottom first; reference and tilemap layers left out (${r.layers.map((l) => l.name).join(', ')})`);
  check(L('skin').path.join('/') === 'face/skin' && L('glow').path.join('/') === 'fx/glow' && r.groups.map((g) => g.name).join() === 'face,fx', `child levels make groups (${L('skin').path.join('/')}, ${L('glow').path.join('/')})`);
  check(same(at(L('back'), 0, 0), [240, 230, 210, 255]) && same(at(L('back'), 31, 23), [240, 230, 210, 255]), 'a raw cel (type 0): its pixels');
  check(same(at(L('skin'), 5, 7), [200, 150, 120, 128]) && same(at(L('skin'), 14, 14), [209, 157, 120, 128]) && L('skin').left === 5 && L('skin').top === 7,
    'a zlib cel at its place (5, 7), the cel\'s opacity 128 in its alpha');
  check(same(at(L('shade'), 0, 20), [80, 60, 120, 255]) && at(L('shade'), 2, 20)[3] === 0 && L('shade').left === -2, 'a cel off the left edge (x -2): its pixels where they fall')
  const part = (n) => r.model.parts.find((p) => p.id === n);
  check(Math.abs(part('skin').opacity - 0.8) < 0.01 && part('shade').blend === 'multiply' && part('glow').blend === 'add' && part('secret').opacity === 0,
    `layer opacity 204 -> 0.8, multiply, addition -> add, a hidden layer at opacity 0 (${part('skin').opacity.toFixed(3)}, ${part('shade').blend}, ${part('glow').blend})`);
  const g = r.groups.find((x) => x.name === 'fx'), face = r.groups.find((x) => x.name === 'face');
  check(g && (g.blend === 'screen' || r.notes.some((n) => n.code === 'groupBlend')) && Math.abs(g.opacity - 128 / 255) < 0.01 && face.blend === 'passThrough',
    `a group with screen at 50 % keeps them (blend ${g?.blend}, opacity ${g?.opacity?.toFixed(2)}); a plain group passes through`);
  const codes = new Map(r.notes.map((n) => [n.code, n]));
  check(codes.get('aseFrames')?.vars.frames === 3 && codes.get('aseTags')?.vars.tags.join() === 'idle,blink' && JSON.stringify(codes.get('aseTags').vars.frames) === '[[0,1],[2,2]]',
    `3 frames and 2 tags are noted (${codes.get('aseFrames')?.text}; ${codes.get('aseTags')?.text})`);
  check(codes.has('aseTilemap') && codes.get('aseReference')?.level === 'info' && codes.get('aseZIndex')?.vars.z === 1 && codes.get('aseNearest')?.level === 'info',
    'notes: a tilemap layer (skipped), a reference layer (info), a cel\'s z-index, and the advice to draw it with the nearest texel (info)');
  check(compileUgo(r.model).byteLength > 0, 'the model compiles');
}
{
  const a = await importAsepriteAsync(rgbaFile, { keepPixels: true });
  check(JSON.stringify(a.model) === JSON.stringify(importAseprite(rgbaFile, { ...node, keepPixels: true }).model), 'in the browser way (DecompressionStream): the same model');
}

// ---- indexed: the palette, the transparent index (not on the background) ----
const colors = [[0, 0, 0, 255], [230, 180, 150, 255], [40, 80, 200, 255], [255, 255, 255, 128]];
const idx = (w, h, f) => { const p = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = f(x, y); return p; };
{
  const file = ase({
    width: 8, height: 8, depth: 8, transparent: 0, frames: [[
      oldPaletteChunk(colors), paletteChunk(colors),
      layerChunk({ name: 'bg', flags: 1 | 8 }), layerChunk({ name: 'dots' }),
      celChunk({ layer: 0, width: 8, height: 8, pixels: idx(8, 8, () => 0) }),
      celChunk({ layer: 1, x: 1, y: 1, width: 4, height: 4, pixels: idx(4, 4, (x, y) => (x + y) % 4) }),
    ]],
  });
  const r = importAseprite(file, { ...node, keepPixels: true }), L = (n) => r.layers.find((l) => l.name === n);
  check(same(at(L('bg'), 3, 3), [0, 0, 0, 255]), 'indexed: on the background, index 0 is its colour (the transparent index is for the other layers)');
  check(same(at(L('dots'), 1, 1), [0, 0, 0, 0]) && same(at(L('dots'), 2, 1), [230, 180, 150, 255]) && same(at(L('dots'), 3, 1), [40, 80, 200, 255]) && same(at(L('dots'), 4, 1), [255, 255, 255, 128]),
    'indexed: index 0 is transparent on a layer; the others from the palette (with its alpha, a named entry read past)');
}
{
  const file = ase({ width: 4, height: 4, depth: 8, transparent: 3, frames: [[oldPaletteChunk(colors), layerChunk({ name: 'dots' }), celChunk({ layer: 0, width: 4, height: 1, pixels: idx(4, 1, (x) => x) })]] });
  const L = importAseprite(file, { ...node, keepPixels: true }).layers[0];
  check(same(at(L, 1, 0), [230, 180, 150, 255]) && same(at(L, 3, 0), [0, 0, 0, 0]) && same(at(L, 0, 0), [0, 0, 0, 255]), 'indexed with only the old palette chunk (0x0004): its colours, opaque; transparent index 3');
}
// ---- grey ----
{
  const g = new Uint8Array(4 * 2 * 2); for (let i = 0; i < 8; i++) { g[i * 2] = i * 30; g[i * 2 + 1] = i ? 255 : 0; }
  const file = ase({ width: 4, height: 2, depth: 16, frames: [[layerChunk({ name: 'ink' }), celChunk({ layer: 0, width: 4, height: 2, pixels: g })]] });
  const L = importAseprite(file, { ...node, keepPixels: true }).layers[0];
  check(same(at(L, 3, 1), [210, 210, 210, 255]) && same(at(L, 0, 0), [0, 0, 0, 0]), 'grey (16 bits: value, alpha)');
}
// ---- odd pixels, no opacity flag ----
{
  const file = ase({ width: 4, height: 4, flags: 0, pixelRatio: [2, 1], frames: [[layerChunk({ name: 'a', opacity: 10 }), celChunk({ layer: 0, width: 1, height: 1, pixels: [9, 9, 9, 255] })]] });
  const r = importAseprite(file, { ...node, keepPixels: true });
  check(r.model.parts[0].opacity === 1 && r.notes.some((n) => n.code === 'asePixelRatio' && n.vars.width === 2), 'without the header\'s opacity flag the layer opacity is not used; 2:1 pixels are noted');
}

// ---- frames and tags as animations (opts.frames 'animate') ----
{
  // 16×8: a grey background in every frame; a body that changes (frame 3 links to frame 1, frame 4
  // repeats frame 2's pixels in a new cel); an eye only in frames 2 and 3
  const bgPx = pic(16, 8, () => [128, 128, 128, 255]);
  const bodyA = pic(4, 4, () => [200, 40, 40, 255]), bodyB = pic(4, 4, () => [40, 200, 40, 255]);
  const eyePx = pic(2, 2, () => [20, 20, 220, 255]);
  const file = ase({
    width: 16, height: 8, durations: [100, 200, 100, 50], frames: [
      [layerChunk({ name: 'bg', flags: 1 | 8 }), layerChunk({ name: 'body' }), layerChunk({ name: 'eye' }),
        celChunk({ layer: 0, width: 16, height: 8, pixels: bgPx }), celChunk({ layer: 1, x: 1, y: 2, width: 4, height: 4, pixels: bodyA }),
        tagsChunk([{ name: 'walk', from: 0, to: 3 }, { name: 'back', from: 0, to: 1, dir: 1, repeat: 1 }, { name: 'pp', from: 1, to: 2, dir: 2 }])],
      [celChunk({ layer: 0, width: 16, height: 8, pixels: bgPx }), celChunk({ layer: 1, x: 1, y: 2, width: 4, height: 4, pixels: bodyB }), celChunk({ layer: 2, x: 10, y: 3, width: 2, height: 2, pixels: eyePx })],
      [celChunk({ layer: 0, width: 16, height: 8, pixels: bgPx }), celChunk({ layer: 1, type: 1, link: 0 }), celChunk({ layer: 2, type: 1, link: 1 })],
      [celChunk({ layer: 0, width: 16, height: 8, pixels: bgPx }), celChunk({ layer: 1, x: 1, y: 2, width: 4, height: 4, pixels: bodyB })],
    ],
  });
  const first = importAseprite(file, { ...node, keepPixels: true });
  check(first.model.parts.map((p) => p.id).join() === 'bg,body' && !first.model.animations.length && first.notes.some((n) => n.code === 'aseFrames'),
    `by default the first frame only, as before (${first.model.parts.map((p) => p.id).join(', ')})`);
  const r = importAseprite(file, { ...node, keepPixels: true, frames: 'animate' }), part = (id) => r.model.parts.find((p) => p.id === id);
  check(r.model.parts.map((p) => p.id).join() === 'bg,body#1,body#2,eye', `animate: a part per different picture; the link and the repeated pixels are not new parts (${r.model.parts.map((p) => p.id).join(', ')})`);
  const g = r.groups.find((x) => x.name === 'body');
  check(g && g.frames === true && g.parts.join() === 'body#1,body#2' && part('eye') && !r.groups.some((x) => x.name === 'eye'),
    'the frames of a layer are a group named after it (frames: true), the parts "name#frame" (the frame it first shows in, from 1); a layer with one picture stays a part');
  check(part('body#1').opacity === 1 && part('body#2').opacity === 0 && part('eye').opacity === 0 && part('bg').opacity === 1, 'the rest pose shows the first frame (body#1; body#2 and the eye at 0)');
  const walk = r.model.animations.find((a) => a.id === 'walk'), back = r.model.animations.find((a) => a.id === 'back'), pp = r.model.animations.find((a) => a.id === 'pp');
  check(walk && Math.abs(walk.duration - 0.45) < 1e-9 && walk.loop && JSON.stringify(walk.opacity['body#1']) === '[[0,1,"step"],[0.1,0,"step"],[0.3,1,"step"],[0.4,0,"step"],[0.45,0,"step"]]'
    && JSON.stringify(walk.opacity.eye) === '[[0,0,"step"],[0.1,1,"step"],[0.4,0,"step"],[0.45,0,"step"]]' && !walk.opacity.bg,
    `walk (frames 1–4, 100/200/100/50 ms): 0.45 s, body#1 in frames 1 and 3, the eye in 2 and 3, the background has no track`);
  check(back && !back.loop && JSON.stringify(back.opacity['body#1']) === '[[0,0,"step"],[0.2,1,"step"],[0.3,1,"step"]]' && Math.abs(back.duration - 0.3) < 1e-9,
    'a reverse tag played once: frame 2 then frame 1, not looping');
  check(pp && Math.abs(pp.duration - 0.3) < 1e-9 && JSON.stringify(pp.opacity['body#2']) === '[[0,1,"step"],[0.2,0,"step"],[0.3,0,"step"]]', 'a ping-pong tag of frames 2–3 (one way and back: 2, 3)');
  check(r.notes.some((n) => n.code === 'aseAnimated' && n.vars.animations.join() === 'walk,back,pp' && n.vars.parts === 4) && !r.notes.some((n) => n.code === 'aseFrames'),
    'noted as animations (aseAnimated: the tags, 4 pictures), no aseFrames');
  const grow = { first: first.atlases.reduce((s, a) => s + a.width * a.height, 0), animate: r.atlases.reduce((s, a) => s + a.width * a.height, 0) };
  console.log(`     atlas: first frame ${first.atlases.map((a) => `${a.width}x${a.height}`).join('+')} (${grow.first} px), animate ${r.atlases.map((a) => `${a.width}x${a.height}`).join('+')} (${grow.animate} px), pages ${first.atlases.length} -> ${r.atlases.length}`);
  check(compileUgo(r.model).byteLength > 0, 'the model with its animations compiles');
  // the frames as ugo_export draws them, against the frames composited here
  let exe = null;
  for (const p of ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe']) if (fs.existsSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), p))) { exe = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), p); break; }
  if (exe) {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dir = path.join(ROOT, 'build', 'aseprite_anim');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const { encodePng } = await import('../tools/png.mjs');
    r.atlases.forEach((a, i) => fs.writeFileSync(path.join(dir, r.model.textures[i]), encodePng(a.width, a.height, a.rgba)));
    fs.writeFileSync(path.join(dir, 'm.ugo'), new Uint8Array(compileUgo(r.model)));
    const want = (f) => { // frame f (0-based) composited: bg, then body, then eye
      const bodyPx = f === 1 || f === 3 ? bodyB : bodyA, eyeOn = f === 1 || f === 2;
      return (x, y) => (eyeOn && x >= 10 && x < 12 && y >= 3 && y < 5 ? [20, 20, 220] : x >= 1 && x < 5 && y >= 2 && y < 6 ? [...bodyPx.subarray(0, 3)] : [128, 128, 128]);
    };
    let worst = 0;
    [[0, 0.05], [1, 0.2], [2, 0.35], [3, 0.425]].forEach(([f, t]) => {
      const out = path.join(dir, `f${f}.rgba`);
      spawnSync(exe, [path.join(dir, 'm.ugo'), '--anim', 'walk', '--start', String(t), '--frames', '1', '--warmup', '0', '--ss', '1', '--format', 'raw', '--out', out]);
      const img = fs.readFileSync(out), w = want(f);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4, e = w(x, y); for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(img[i + k] - e[k])); }
    });
    check(worst <= 2, `ugo_export draws frames 1–4 of walk as the frames composited here (largest difference ${worst})`);
  }
  { // how the atlas grows: a 64×64 sprite, 8 frames; a 64×64 background, a 32×32 body that changes every frame, a 16×16 head with 2 pictures
    const bgBig = pic(64, 64, () => [90, 110, 130, 255]);
    const body = (f) => pic(32, 32, (x, y) => [(x * 7 + f * 31) & 255, (y * 5 + f * 17) & 255, 60, (x - 16) ** 2 + (y - 16) ** 2 < 200 ? 255 : 0]);
    const head = (k) => pic(16, 16, (x, y) => [200, 160 + k * 40, 120, (x - 8) ** 2 + (y - 8) ** 2 < 50 ? 255 : 0]);
    const frames8 = Array.from({ length: 8 }, (_, f) => [
      ...(f === 0 ? [layerChunk({ name: 'bg', flags: 1 | 8 }), layerChunk({ name: 'body' }), layerChunk({ name: 'head' })] : []),
      celChunk({ layer: 0, width: 64, height: 64, pixels: bgBig }), celChunk({ layer: 1, x: 16, y: 24, width: 32, height: 32, pixels: body(f) }),
      celChunk({ layer: 2, x: 24, y: 8, width: 16, height: 16, pixels: head(f % 4 === 3 ? 1 : 0) }),
    ]);
    const big = ase({ width: 64, height: 64, frames: frames8 });
    const a1 = importAseprite(big, node), a8 = importAseprite(big, { ...node, frames: 'animate' });
    const px = (r) => r.atlases.reduce((n, a) => n + a.width * a.height, 0);
    console.log(`     atlas growth, 64×64 sprite of 8 frames (body changes every frame, the head twice): first frame ${a1.atlases.map((a) => `${a.width}x${a.height}`).join('+')} (${px(a1)} px, ${a1.model.parts.length} parts) -> animate ${a8.atlases.map((a) => `${a.width}x${a.height}`).join('+')} (${px(a8)} px, ${a8.model.parts.length} parts), ${a1.atlases.length} -> ${a8.atlases.length} page(s)`);
    check(a8.model.parts.length === 1 + 8 + 2, `8 frames: background 1, body 8, head 2 parts (${a8.model.parts.length})`);
  }
  const few = importAseprite(file, { ...node, frames: 'animate', maxFrameParts: 3 });
  check(few.notes.some((n) => n.code === 'aseFramesTooMany' && n.vars.parts === 4 && n.vars.max === 3) && few.model.parts.map((p) => p.id).join() === 'bg,body' && !few.model.animations.length,
    'more pictures than opts.maxFrameParts: the first frame only, with aseFramesTooMany {parts, max}');
}

// ---- broken files: each stops with a code ----
const codeOf = (bytes) => { try { importAseprite(bytes, node); return 'read'; } catch (e) { return e.code || `other: ${e.message}`; } };
check(codeOf(new Uint8Array(200)) === 'aseNotAseprite', 'not an Aseprite file: aseNotAseprite');
{ const b = rgbaFile.slice(); b[12] = 24; check(codeOf(b) === 'aseDepth', 'colour depth 24: aseDepth'); }
check(codeOf(rgbaFile.slice(0, 300)) === 'aseBroken', 'cut short: aseBroken');
{
  let seed = 7, other = 0, read = 0, stopped = 0;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  const codes = new Set();
  for (let i = 0; i < 600; i++) {
    const b = rgbaFile.slice();
    const k = i % 3 === 0 ? 1 : 4;
    for (let j = 0; j < k; j++) b[128 + rnd(b.length - 128)] = rnd(256);
    const cut = i % 5 === 0 ? b.subarray(0, 128 + rnd(b.length - 128)) : b;
    const c = codeOf(cut);
    if (c === 'read') read++; else if (/^(ase|layers)/.test(c)) { stopped++; codes.add(c); } else { other++; if (other < 3) console.log('  ', c); }
  }
  check(other === 0, `600 broken copies (bytes changed, cut): ${read} still read, ${stopped} stop with a code (${[...codes].join(', ')}), nothing else thrown`);
}

// ---- the CLI ----
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dir = path.join(ROOT, 'build', 'aseprite_test');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'face.aseprite'), rgbaFile);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/import_layers.mjs'), path.join(dir, 'face.aseprite'), path.join(dir, 'out')], { encoding: 'utf8' });
  check(r.status === 0 && fs.existsSync(path.join(dir, 'out/model.ug9')) && /aseNearest|nearest texel/.test(r.stdout), `node tools/import_layers.mjs face.aseprite out: a model, and the notes printed (${r.stdout.split('\n')[0]})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall Aseprite checks passed');
process.exit(failures ? 1 : 0);
