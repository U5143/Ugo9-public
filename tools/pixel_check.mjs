// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Pixel art kept on the pixel grid (機能の比べ #19). A picture's dots stay sharp only when every texel lands on whole
// output pixels: the part drawn at a whole-number size (1×, 2×, ...), not turned (or turned a quarter), and with its
// texel corners on pixel corners. This finds the parts that are not, in the rest pose and through each animation, and
// moves the rest pose onto the grid where it is only a little off.
//
//   pixelCheck(ug9Bytes, { wasm | runtime, textureSizes, scale = 1, fps = 12, animations, tolerance = 0.02 })
//     -> { parts: [{ part, rest: issue|null, moving: [{ animation, time, issue }] }], clean }
//     issue: { kind: 'scaled' | 'turned' | 'offset', size, angle, offset }: kind is the worst found ('turned' over
//     'scaled' over 'offset'); size: px per texel; angle: degrees off the nearest quarter turn; offset: px the texel
//     corners sit off the pixel corners. scale: output px per model px (ugo_export --size gives it). textureSizes:
//     [[width, height]] by texture page, in the .ug9's order, or a function (texture name) -> [width, height].
//   pixelSnap(json, { textureSizes, scale = 1, near = 0.1, bent = 0.5 }) -> { model, moved: [part], skipped: [{ part, why }] }
//     The working JSON with each part's rest vertices put exactly on the grid: the size rounded to whole pixels and
//     the corners onto pixel corners (a part a little off: its size within `near` of a whole number, not turned, its
//     mesh not bent more than `bent` px at rest). Morphs, bones and animations are as they were.
//   formatCheck(result) -> text
//
//   node tools/pixel_check.mjs model.ug9 [--scale 2] [--fps 12] [--json]
//   node tools/pixel_check.mjs model.json --snap --out fixed.json [--scale 2]
// Moving between whole pixels in an animation is for the drawing to snap (the renderer); this says where it happens.

const ISSUE_ORDER = { offset: 1, scaled: 2, turned: 3 };

/** How one triangle's texels land on the output: from 3 texel points and 3 output points. */
function affine(t, s) {
  const [u0, v0, u1, v1, u2, v2] = t, [x0, y0, x1, y1, x2, y2] = s;
  const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0, det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = x1 - x0, dy1 = y1 - y0, dx2 = x2 - x0, dy2 = y2 - y0;
  const a = (dx1 * dv2 - dx2 * dv1) / det, b = (dx2 * du1 - dx1 * du2) / det; // x = a u + b v + tx
  const c = (dy1 * dv2 - dy2 * dv1) / det, d = (dy2 * du1 - dy1 * du2) / det; // y = c u + d v + ty
  return { a, b, c, d, tx: x0 - a * u0 - b * v0, ty: y0 - c * u0 - d * v0 };
}

const frac = (x) => Math.abs(x - Math.round(x));

/** What is off in one affine map (null: on the grid). */
function judge(m, tol) {
  const sx = Math.hypot(m.a, m.c), sy = Math.hypot(m.b, m.d);
  const ang = (Math.atan2(m.c, m.a) * 180) / Math.PI, off = Math.abs(((ang % 90) + 135) % 90 - 45); // degrees off a quarter turn
  const skew = Math.abs(m.a * m.b + m.c * m.d) / (sx * sy || 1);
  const issue = { size: +((sx + sy) / 2).toFixed(3), angle: +off.toFixed(2), offset: +Math.max(frac(m.tx), frac(m.ty)).toFixed(3) };
  if (off > 0.05 || skew > 0.001) return { kind: 'turned', ...issue };
  if (frac(sx) > tol || frac(sy) > tol || Math.round(sx) < 1 || Math.round(sy) < 1) return { kind: 'scaled', ...issue };
  if (issue.offset > tol) return { kind: 'offset', ...issue };
  return null;
}

const worse = (a, b) => (!a ? b : !b ? a : ISSUE_ORDER[b.kind] > ISSUE_ORDER[a.kind] || (b.kind === a.kind && b.offset + Math.abs(b.size - Math.round(b.size)) + b.angle > a.offset + Math.abs(a.size - Math.round(a.size)) + a.angle) ? b : a);

/** Finds the parts drawn off the pixel grid. */
export async function pixelCheck(ug9Bytes, opts = {}) {
  let rt = opts.runtime;
  if (!rt) {
    const { UgoRuntime } = await import('../web/ugo.js');
    rt = new UgoRuntime((await WebAssembly.instantiate(opts.wasm, {})).instance.exports);
  }
  const model = rt.loadModel(ug9Bytes), inst = model.createInstance();
  const { parts } = model.partData(), mesh = model.meshData();
  const sizes = typeof opts.textureSizes === 'function' ? model.textures.map(opts.textureSizes) : opts.textureSizes || [];
  const scale = opts.scale ?? 1, tol = opts.tolerance ?? 0.02, fps = opts.fps ?? 12;
  const visible = (i) => !(parts[i].flags & 2); // (a part only used as a mask is not drawn)
  const look = (pos) => parts.map((p, i) => {
    if (!visible(i) || !p.indexCount) return null;
    const [tw, th] = sizes[p.texture] || [0, 0];
    if (!tw || !th) return null;
    let found = null;
    for (let k = p.firstIndex; k < p.firstIndex + p.indexCount; k += 3) {
      const ix = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]];
      const t = ix.flatMap((v) => [mesh.uvs[2 * v] * tw, mesh.uvs[2 * v + 1] * th]), s = ix.flatMap((v) => [pos[2 * v] * scale, pos[2 * v + 1] * scale]);
      const m = affine(t, s);
      if (m) found = worse(found, judge(m, tol));
    }
    return found;
  });
  inst.reset(); inst.update(0);
  const rest = look(inst.deformedPositions());
  const moving = parts.map(() => []);
  for (const [ai, a] of model.animations.entries()) {
    if (opts.animations && !opts.animations.includes(a.name)) continue;
    const n = Math.max(1, Math.round(a.duration * fps));
    const worst = parts.map(() => null);
    for (let f = 0; f <= n; f++) {
      const time = Math.min(a.duration, f / fps);
      inst.reset(); inst.play(ai, time); inst.update(0);
      look(inst.deformedPositions()).forEach((x, i) => { if (x && worse(worst[i]?.issue, x) === x && worst[i]?.issue !== x) worst[i] = { animation: a.name, time: +time.toFixed(3), issue: x }; });
    }
    worst.forEach((w, i) => { if (w && !(rest[i] && rest[i].kind === w.issue.kind)) moving[i].push(w); });
  }
  const out = parts.map((p, i) => ({ part: p.name, rest: rest[i], moving: moving[i] })).filter((p) => p.rest || p.moving.length);
  return { parts: out, clean: !out.length, partCount: parts.length };
}

/** Puts each part's rest vertices on the pixel grid where it is only a little off. */
export function pixelSnap(json, opts = {}) {
  const sizes = opts.textureSizes || [], scale = opts.scale ?? 1, near = opts.near ?? 0.1, bentMax = opts.bent ?? 0.5;
  const model = structuredClone(json), moved = [], skipped = [];
  for (const p of model.parts || []) {
    const v = p.vertices || [], uv = p.uvs || [], tri = p.triangles || [];
    const [tw, th] = sizes[p.texture || 0] || [0, 0];
    if (!tw || !th || v.length < 6 || !tri.length) continue;
    // one map for the whole part: from its first triangle that is not flat, checked against every vertex
    let m = null;
    for (let k = 0; k < tri.length && !m; k += 3) {
      const ix = [tri[k], tri[k + 1], tri[k + 2]];
      m = affine(ix.flatMap((i) => [uv[2 * i] * tw, uv[2 * i + 1] * th]), ix.flatMap((i) => [v[2 * i] * scale, v[2 * i + 1] * scale]));
    }
    if (!m || !judge(m, 0.001)) continue; // already on the grid
    let bent = 0;
    for (let i = 0; i < v.length / 2; i++) {
      const u = uv[2 * i] * tw, w = uv[2 * i + 1] * th;
      bent = Math.max(bent, Math.hypot(m.a * u + m.b * w + m.tx - v[2 * i] * scale, m.c * u + m.d * w + m.ty - v[2 * i + 1] * scale));
    }
    const j = judge(m, near);
    if (bent > bentMax) { skipped.push({ part: p.id, why: 'bent', by: +bent.toFixed(2) }); continue; }
    if (j && j.kind !== 'offset') { skipped.push({ part: p.id, why: j.kind, size: j.size, angle: j.angle }); continue; }
    // the size rounded to whole pixels (keeping flips and quarter turns), the corners on pixel corners
    const r = (x) => Math.round(x), n = { a: r(m.a), b: r(m.b), c: r(m.c), d: r(m.d), tx: r(m.tx), ty: r(m.ty) };
    for (let i = 0; i < v.length / 2; i++) {
      const u = uv[2 * i] * tw, w = uv[2 * i + 1] * th;
      v[2 * i] = (n.a * u + n.b * w + n.tx) / scale;
      v[2 * i + 1] = (n.c * u + n.d * w + n.ty) / scale;
    }
    moved.push(p.id);
  }
  return { model, moved, skipped };
}

const KIND_TEXT = { offset: 'off the pixel corners', scaled: 'not a whole-number size', turned: 'turned' };
const say = (x) => `${KIND_TEXT[x.kind]} (size ${x.size} px per texel, ${x.angle}° off a quarter turn, corners ${x.offset} px off)`;

/** The result as text. */
export function formatCheck(r) {
  if (r.clean) return `all ${r.partCount} part(s) on the pixel grid, at rest and in every animation`;
  const lines = [`${r.parts.length} of ${r.partCount} part(s) off the pixel grid:`];
  for (const p of r.parts) {
    if (p.rest) lines.push(`  ${p.part}: at rest ${say(p.rest)}`);
    for (const m of p.moving) lines.push(`  ${p.part}: in ${m.animation} at ${m.time}s ${say(m.issue)}`);
  }
  if (r.parts.some((p) => p.rest && p.rest.kind === 'offset')) lines.push('  (parts only off the corners at rest: --snap moves them onto the grid)');
  return lines.join('\n');
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), path = await import('node:path');
  const args = process.argv.slice(2), file = args.find((a, i) => !a.startsWith('--') && !['--scale', '--fps', '--out'].includes(args[i - 1]));
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  if (!file) { console.error('usage: node tools/pixel_check.mjs model.ug9|model.json [--scale N] [--fps N] [--json]\n       node tools/pixel_check.mjs model.json --snap --out fixed.json [--scale N]'); process.exit(2); }
  const raw = fs.readFileSync(file), isUg9 = raw[0] === 0x55 && raw[1] === 0x47, scale = Number(opt('--scale', 1));
  const pngSize = (t) => { try { const b = fs.readFileSync(path.join(path.dirname(file), t)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; } catch { return [0, 0]; } };
  if (args.includes('--snap')) {
    if (isUg9 || !opt('--out')) { console.error('--snap: give the working model.json and --out'); process.exit(2); }
    const json = JSON.parse(raw.toString('utf8'));
    const s = pixelSnap(json, { textureSizes: (json.textures || []).map(pngSize), scale });
    fs.writeFileSync(opt('--out'), JSON.stringify(s.model, null, 2));
    console.log(`moved onto the grid: ${s.moved.length ? s.moved.join(', ') : 'none'}`);
    for (const k of s.skipped) console.log(`  left: ${k.part} (${k.why === 'bent' ? `its mesh is bent ${k.by} px at rest` : k.why === 'turned' ? `turned ${k.angle}°` : `size ${k.size} px per texel`})`);
    process.exit(0);
  }
  let bytes = raw;
  if (!isUg9) {
    const { compileUgo } = await import('./compile.mjs');
    bytes = new Uint8Array(compileUgo(JSON.parse(raw.toString('utf8')), { warnings: [] }));
  }
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const r = await pixelCheck(bytes, { wasm, textureSizes: pngSize, scale, fps: Number(opt('--fps', 12)) });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatCheck(r));
  process.exit(r.clean ? 0 : 1);
}
