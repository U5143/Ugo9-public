// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// How heavy a model is (機能の比べ #8、利用者の声 #11・#18): the counts and bytes the runtime gives (web/ugo.js
// model.stats(): parameters, bones, parts, vertices, triangles, morphs, keys, ... and the memory) and, worked out here
// from the working JSON:
//   - draws: how many times the parts' drawing must start again in drawing order (another texture page, another blend,
//     a mask: an estimate of draw calls for engines that batch the rest)
//   - texture memory: the atlas pages' pixels (4 bytes each), and with mipmaps (× 4/3)
//   - drawn area: the parts' triangles in the rest pose, against the canvas (above 1: pixels drawn more than once)
//   - the heaviest: the parts with the most vertices, and those with the most morph entries (points moved, summed over
//     the deformers)
//
//   modelInfo(ug9Bytes, json, opts) -> { stats, draws, breaks: { texture, blend, mask }, textures: [{ name, width, height,
//     bytes }], textureBytes, mipmapBytes, area: { drawn, canvas, ratio }, heaviest: { vertices: [[part, n]], morphs: [[part, n]] } }
//     json: the working JSON (tools/import_ug9.mjs gives it back from a .ug9); opts.runtime: a UgoRuntime (made here in
//     Node when left out); opts.textureSizes: [[width, height]] by page (else read from the PNG files by the CLI)
//   formatInfo(info) -> text
//   node tools/model_info.mjs model.ug9|model.json [--json]
import { UgoRuntime } from '../web/ugo.js';
import { readUg9Tables } from './import_ug9.mjs';

/** How heavy the model is. */
export async function modelInfo(ug9Bytes, json, opts = {}) {
  const rt = opts.runtime || new UgoRuntime((await WebAssembly.instantiate(opts.wasm, {})).instance.exports);
  const stats = rt.loadModel(ug9Bytes).stats();
  const parts = (json.parts || []).map((p, i) => ({ p, i })).filter(({ p }) => !p.maskOnly)
    .sort((a, b) => (a.p.order ?? 500) - (b.p.order ?? 500) || a.i - b.i).map(({ p }) => p);
  // drawing order: a new draw where the texture page or the blend changes, and around each masked part
  const breaks = { texture: 0, blend: 0, mask: 0 };
  let draws = 0, prev = null;
  for (const p of parts) {
    const masked = !!(p.mask && (Array.isArray(p.mask) ? p.mask.length : true));
    if (!prev) draws = 1;
    else if (masked || prev.masked) { draws++; breaks.mask++; }
    else if ((p.texture || 0) !== prev.texture) { draws++; breaks.texture++; }
    else if ((p.blend || 'normal') !== prev.blend) { draws++; breaks.blend++; }
    prev = { texture: p.texture || 0, blend: p.blend || 'normal', masked };
  }
  // the textures
  const sizes = opts.textureSizes || [];
  const textures = (json.textures || []).map((name, i) => { const [w, h] = sizes[i] || [0, 0]; return { name, width: w, height: h, bytes: w * h * 4 }; });
  const textureBytes = textures.reduce((s, t) => s + t.bytes, 0);
  // the drawn area in the rest pose
  let drawn = 0;
  for (const p of parts) {
    const v = p.vertices || [], t = p.triangles || [];
    for (let k = 0; k < t.length; k += 3) {
      const [a, b, c] = [t[k], t[k + 1], t[k + 2]];
      drawn += Math.abs((v[2 * b] - v[2 * a]) * (v[2 * c + 1] - v[2 * a + 1]) - (v[2 * c] - v[2 * a]) * (v[2 * b + 1] - v[2 * a + 1])) / 2;
    }
  }
  const canvas = (json.canvas?.width || 0) * (json.canvas?.height || 0);
  // the heaviest parts: vertices, and their morph entries (the .ug9's: each vertex's entries in every deformer, so the
  // same from a .ug9 and from its working JSON)
  const T = readUg9Tables(ug9Bytes), moved = new Map();
  for (let v = 0; v < T.vparts.length; v++) {
    const part = json.parts?.[T.vparts[v]]?.id, n = T.deltaStart[v + 1] - T.deltaStart[v];
    if (part !== undefined && n) moved.set(part, (moved.get(part) || 0) + n);
  }
  const top = (pairs) => pairs.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, opts.top || 5);
  return {
    stats, draws, breaks, textures, textureBytes, mipmapBytes: Math.round((textureBytes * 4) / 3),
    area: { drawn: Math.round(drawn), canvas, ratio: canvas ? +(drawn / canvas).toFixed(2) : 0 },
    heaviest: { vertices: top((json.parts || []).map((p) => [p.id, (p.vertices || []).length / 2])), morphs: top([...moved]) },
  };
}

const kb = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
/** The info as text. */
export function formatInfo(r) {
  const s = r.stats, L = [];
  L.push(`parts ${s.parts}, vertices ${s.vertices}, triangles ${s.triangles}, bones ${s.bones}, parameters ${s.parameters}`);
  L.push(`morphs ${s.morphs ?? '—'}, warps ${s.warps ?? '—'}, masks ${s.masks ?? '—'}, physics ${s.physics ?? '—'}, chains ${s.chains ?? '—'}, animations ${s.animations}, keys ${s.keys ?? '—'}`);
  if (s.bytes) L.push(`memory: file ${kb(s.bytes.file)}, model ${kb(s.bytes.model)} beside the file's bytes, each character ${kb(s.bytes.instance)}, each frame's data ${kb(s.bytes.frame)}`);
  L.push(`draws (estimated): ${r.draws} (new texture page ${r.breaks.texture}, new blend ${r.breaks.blend}, masks ${r.breaks.mask})`);
  if (r.textures.some((t) => t.width)) L.push(`textures: ${r.textures.map((t) => `${t.name} ${t.width}×${t.height}`).join(', ')}: ${kb(r.textureBytes)} on the GPU (${kb(r.mipmapBytes)} with mipmaps)`);
  L.push(`drawn area in the rest pose: ${r.area.ratio} × the canvas${r.area.ratio > 2 ? ' (much drawn over: hidden parts still cost)' : ''}`);
  if (r.heaviest.vertices.length) L.push(`most vertices: ${r.heaviest.vertices.map(([p, n]) => `${p} ${n}`).join(', ')}`);
  if (r.heaviest.morphs.length) L.push(`most morph entries: ${r.heaviest.morphs.map(([p, n]) => `${p} ${n}`).join(', ')}`);
  return L.join('\n');
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const fs = await import('node:fs'), path = await import('node:path');
  const { compileUgo } = await import('./compile.mjs');
  const { importUg9 } = await import('./import_ug9.mjs');
  const args = process.argv.slice(2), file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/model_info.mjs model.ug9|model.json [--json]'); process.exit(2); }
  const raw = fs.readFileSync(file), isUg9 = raw[0] === 0x55 && raw[1] === 0x47;
  const json = isUg9 ? importUg9(raw).json : JSON.parse(raw.toString('utf8')), bytes = isUg9 ? raw : new Uint8Array(compileUgo(json, { warnings: [] }));
  // the pages' sizes from their PNG headers (IHDR: width and height at bytes 16 and 20)
  const textureSizes = (json.textures || []).map((t) => { try { const b = fs.readFileSync(path.join(path.dirname(file), t)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; } catch { return [0, 0]; } });
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const r = await modelInfo(bytes, json, { wasm, textureSizes });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 1) : formatInfo(r));
}
