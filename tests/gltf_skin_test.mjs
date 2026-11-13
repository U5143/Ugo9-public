// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Checks the skeleton written by tools/export_gltf.mjs without a 3D engine: the .glb is
// evaluated here by the glTF rules (node TRS hierarchy, animation keys, joint matrix =
// joint world x inverse bind matrix, morph targets before skinning) and every vertex is
// compared with the Ugo9 core's own deformation at the same time.
// Allowed: 0.05 px (the exporter drops keys that interpolation reproduces within ~0.002 px
// and ~0.001 degrees; the error grows a little down long bone chains); 0.5 px for vertices
// in warp grids, which glTF can only approximate with morph targets.
//   node tests/gltf_skin_test.mjs                 (our rig with IK, transform constraints, shear, inheritance)
//   node tests/gltf_skin_test.mjs model.ugo ...   (any models; the .glb is written to build/gltf_skin/)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UgoRuntime } from '../web/ugo.js';
import { encodePng } from '../tools/png.mjs';
import { compileUgo } from '../tools/compile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'gltf_skin');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// ---- glb reading ----------------------------------------------------------------------
function readGlb(file) {
  const b = fs.readFileSync(file);
  const jsonLen = b.readUInt32LE(12), json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen + 8, bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jsonLen));
  const COMP = { 5126: [Float32Array, 4], 5125: [Uint32Array, 4], 5123: [Uint16Array, 2], 5121: [Uint8Array, 1] };
  const N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const typed = (viewIndex, offset, comp, count) => {
    const v = json.bufferViews[viewIndex], [T, size] = COMP[comp];
    const start = (v.byteOffset || 0) + (offset || 0);
    return new T(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + count * size));
  };
  const read = (i) => {
    const a = json.accessors[i], n = N[a.type];
    const out = a.bufferView !== undefined ? Array.from(typed(a.bufferView, a.byteOffset, a.componentType, a.count * n)) : new Array(a.count * n).fill(0);
    if (a.sparse) {
      const idx = typed(a.sparse.indices.bufferView, a.sparse.indices.byteOffset, a.sparse.indices.componentType, a.sparse.count);
      const val = typed(a.sparse.values.bufferView, a.sparse.values.byteOffset, a.componentType, a.sparse.count * n);
      idx.forEach((k, j) => { for (let c = 0; c < n; c++) out[k * n + c] = val[j * n + c]; });
    }
    return out;
  };
  return { json, read };
}

// column-major 4x4
const mmul = (A, B) => { const C = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) C[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return C; };
const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const [x, y, z, w] = q;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  return [R[0] * s[0], R[1] * s[0], R[2] * s[0], 0, R[3] * s[1], R[4] * s[1], R[5] * s[1], 0, R[6] * s[2], R[7] * s[2], R[8] * s[2], 0, t[0], t[1], t[2], 1];
};

const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d = Math.min(1, d * s);
  if (d > 0.9995) { const r = a.map((v, i) => v + (s * b[i] - v) * t), l = Math.hypot(...r); return r.map((v) => v / l); }
  const th = Math.acos(d), k0 = Math.sin((1 - t) * th) / Math.sin(th), k1 = (s * Math.sin(t * th)) / Math.sin(th);
  return a.map((v, i) => k0 * v + k1 * b[i]);
};
// a sampler's value at time t (glTF: LINEAR = lerp, slerp for rotations; STEP holds the earlier key)
function sample(times, out, n, interp, t, quat) {
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= t + 1e-6) i++;
  const a = out.slice(i * n, i * n + n);
  if (interp === 'STEP' || i + 1 >= times.length || t <= times[i]) return a;
  const u = (t - times[i]) / (times[i + 1] - times[i]), b = out.slice((i + 1) * n, (i + 1) * n + n);
  return quat ? slerp(a, b, u) : a.map((v, c) => v + (b[c] - v) * u);
}

function evaluate(g, animIndex, key, fps = 30) {
  const { json, read } = g, nodes = json.nodes.map((n) => ({ t: n.translation, r: n.rotation, s: n.scale, w: null }));
  let morph = json.meshes[0].weights ? [...json.meshes[0].weights] : [];
  if (animIndex >= 0) for (const ch of json.animations[animIndex].channels) {
    const smp = json.animations[animIndex].samplers[ch.sampler], out = g.cache(smp.output), p = ch.target.path;
    const n = p === 'rotation' ? 4 : p === 'weights' ? morph.length : 3;
    const v = sample(g.cache(smp.input), out, n, smp.interpolation || 'LINEAR', key / fps, p === 'rotation');
    if (p === 'weights') morph = v; else nodes[ch.target.node][p === 'translation' ? 't' : p === 'rotation' ? 'r' : 's'] = v;
  }
  const worldOf = new Array(nodes.length);
  const walk = (i, parent) => { worldOf[i] = mmul(parent, trs(nodes[i].t, nodes[i].r, nodes[i].s)); for (const c of json.nodes[i].children || []) walk(c, worldOf[i]); };
  for (const r of json.scenes[0].nodes) walk(r, trs());
  const skin = json.skins[0], ibm = g.cache(skin.inverseBindMatrices);
  const joints = skin.joints.map((j, k) => mmul(worldOf[j], ibm.slice(16 * k, 16 * k + 16)));
  const prim = json.meshes[0].primitives[0], pos = g.cache(prim.attributes.POSITION);
  const sets = Object.keys(prim.attributes).filter((k) => k.startsWith('JOINTS_')).map((k) => [g.cache(prim.attributes[k]), g.cache(prim.attributes[k.replace('JOINTS', 'WEIGHTS')])]);
  const targets = (prim.targets || []).map((t) => g.cache(t.POSITION));
  const nv = pos.length / 3, out = new Float64Array(2 * nv), scale = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    let x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
    targets.forEach((t, m) => { if (morph[m]) { x += morph[m] * t[3 * v]; y += morph[m] * t[3 * v + 1]; } });
    let px = 0, py = 0, det = 0;
    for (const [J, Wt] of sets) for (let k = 0; k < 4; k++) { // JOINTS_0 / WEIGHTS_0, _1 ...
      const w = Wt[4 * v + k];
      if (!w) continue;
      const M = joints[J[4 * v + k]];
      px += w * (M[0] * x + M[4] * y + M[8] * z + M[12]); py += w * (M[1] * x + M[5] * y + M[9] * z + M[13]);
      det += w * Math.abs(M[0] * M[5] - M[1] * M[4]);
    }
    out[2 * v] = px; out[2 * v + 1] = py; scale[v] = det;
  }
  return { pos: out, scale };
}

// ---- compare with the core ------------------------------------------------------------
const wasm = fs.readFileSync(path.join(ROOT, 'web/ugo.wasm'));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);

function run(ugo, glb, label) {
  const g = readGlb(glb), memo = new Map();
  g.cache = (i) => { if (!memo.has(i)) memo.set(i, g.read(i)); return memo.get(i); };
  const m = rt.loadModel(fs.readFileSync(ugo)), inst = m.createInstance(), ex = rt.ex;
  const unit = g.json.nodes.find((n) => n.extras?.ugo9).extras.ugo9.metresPerPixel, fps = 30;
  const scratch = rt.alloc(8 * m.vertexCount), parts = new Uint32Array(m.meshData().parts);
  const flat = g.json.nodes.find((n) => n.extras?.ugo9).extras.ugo9.flatSkeleton;
  let worst = 0, where = '', frames = 0, warpWorst = 0;
  const warpCount = new Set(), inWarp = Array.from({ length: m.partCount }, (_, i) => ex.ugo_part_warp(m.ptr, i) >= 0);
  const visWrong = new Set(), names = Array.from({ length: m.partCount }, (_, i) => rt.str(ex.ugo_part_name(m.ptr, i)));
  const compare = (ai, f) => { // the core steps on as export_gltf did (physics runs frame after frame)
    inst.reset();
    if (ai >= 0) inst.play(ai, f / fps);
    inst.update(ai >= 0 ? 1 / fps : 0);
    ex.ugo_deform_cpu(inst.ptr, scratch);
    const want = rt.f32(scratch, 2 * m.vertexCount), op = inst.frame().subarray(m.opacityOffset, m.opacityOffset + m.partCount);
    const got = evaluate(g, ai, f);
    for (let v = 0; v < m.vertexCount; v++) {
      // hidden parts (opacity < 0.5) must be collapsed in the glTF, shown ones not
      const hidden = op[parts[v]] < 0.5, collapsedHere = got.scale[v] < 1e-3;
      if (hidden !== collapsedHere) { visWrong.add(`${names[parts[v]]} (${hidden ? 'should hide' : 'should show'}, ${ai >= 0 ? m.animations[ai].name : 'rest'} frame ${f})`); continue; }
      if (hidden) continue;
      const d = Math.hypot(got.pos[2 * v] / unit - want[2 * v], -got.pos[2 * v + 1] / unit - want[2 * v + 1]);
      if (inWarp[parts[v]]) { warpWorst = Math.max(warpWorst, d); warpCount.add(v); continue; }
      if (d > worst) { worst = d; where = `${ai >= 0 ? m.animations[ai].name : 'rest'} frame ${f}, vertex ${v}`; }
    }
    frames++;
  };
  inst.resetPhysics();
  compare(-1, 0);
  m.animations.forEach((a, ai) => {
    inst.reset(); inst.resetPhysics();
    for (let t = -a.duration; t < -1e-9; t += 1 / fps) { inst.reset(); inst.play(ai, t); inst.update(1 / fps); } // settle physics, as the export does
    const n = Math.max(2, Math.round(a.duration * fps) + 1);
    for (let f = 0; f < n; f++) compare(ai, f);
  });
  check(visWrong.size === 0, `${label}: parts shown and hidden as in the core${visWrong.size ? `: ${visWrong.size} wrong, e.g. ${[...visWrong].slice(0, 3).join('; ')}` : ''}`);
  if (warpCount.size) check(warpWorst < 0.5, `${label}: ${warpCount.size} vertices in warp grids (morph targets, weights fitted each frame): largest difference ${warpWorst.toFixed(3)} px (allowed 0.5)`);
  check(worst < 0.05, `${label}: ${flat ? 'flat' : 'nested'} skeleton, ${frames} poses, ${m.vertexCount} vertices: largest difference from the core ${worst.toFixed(5)} px${worst >= 0.05 ? ` (${where})` : ''}`);
}

const exportGlb = (ugo, glb, extra = []) => execFileSync(process.execPath, [path.join(ROOT, 'tools/export_gltf.mjs'), ugo, glb, ...extra], { stdio: 'ignore' });
const given = process.argv.slice(2);
if (given.length) {
  for (const ugo of given) { const glb = path.join(OUT, path.basename(path.dirname(path.resolve(ugo))) + '.glb'); exportGlb(ugo, glb); run(ugo, glb, ugo); }
} else {
  // our rig with IK (1 and 2 bones), transform constraints, shear and every inheritance mode
  fs.copyFileSync(path.join(ROOT, 'tests/pose/rig.ug9'), path.join(OUT, 'rig.ugo'));
  for (const t of ['none.png', 'second.png']) fs.writeFileSync(path.join(OUT, t), encodePng(1, 1, new Uint8Array([255, 255, 255, 255]))); // the rig's two pages (white)
  exportGlb(path.join(OUT, 'rig.ugo'), path.join(OUT, 'rig.glb'));
  run(path.join(OUT, 'rig.ugo'), path.join(OUT, 'rig.glb'), 'tests/pose/rig');
  // format 0.5: nested warp grids on a bone, a bone in a grid, a 2-axis corner region, an animation
  exportGlb(path.join(ROOT, 'tests/warp/model.ug9'), path.join(OUT, 'warp.glb'));
  run(path.join(ROOT, 'tests/warp/model.ug9'), path.join(OUT, 'warp.glb'), 'tests/warp');
  // the sample character: simple skeleton (nested nodes), and the same written flat
  exportGlb(path.join(ROOT, 'samples/basic/model.ug9'), path.join(OUT, 'basic.glb'));
  run(path.join(ROOT, 'samples/basic/model.ug9'), path.join(OUT, 'basic.glb'), 'samples/basic');
  exportGlb(path.join(ROOT, 'samples/basic/model.ug9'), path.join(OUT, 'basic_flat.glb'), ['--flat']);
  run(path.join(ROOT, 'samples/basic/model.ug9'), path.join(OUT, 'basic_flat.glb'), 'samples/basic --flat');
  // more than four bones per vertex (format 0.4): the side hair weighted to 7 bones -> JOINTS_1 / WEIGHTS_1
  const many = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/basic/model.json'), 'utf8'));
  const seven = ['hairL1', 'hairL2', 'hairR1', 'hairR2', 'head', 'neck', 'hairBackB'];
  for (const p of many.parts.filter((q) => q.weights)) p.weights = p.weights.map((_, i) => seven.map((b, k) => [b, 1 + ((i + 2 * k) % 5)]));
  fs.mkdirSync(path.join(OUT, 'many'), { recursive: true });
  for (const t of many.textures) fs.copyFileSync(path.join(ROOT, 'samples/basic', t), path.join(OUT, 'many', t));
  fs.writeFileSync(path.join(OUT, 'many', 'model.ugo'), new Uint8Array(compileUgo(many)));
  exportGlb(path.join(OUT, 'many', 'model.ugo'), path.join(OUT, 'many.glb'));
  const sets = readGlb(path.join(OUT, 'many.glb')).json.meshes[0].primitives[0].attributes;
  check('JOINTS_1' in sets && 'WEIGHTS_1' in sets, 'seven bones per vertex: JOINTS_1 / WEIGHTS_1 written');
  run(path.join(OUT, 'many', 'model.ugo'), path.join(OUT, 'many.glb'), 'samples/basic with 7 bones per vertex');
}
// ---- the draw order (format 0.8): triangles in the rest order, a warning where it changes ------------
{
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'order', 'model.json'), 'utf8'));
  const dir = path.join(OUT, 'order');
  fs.mkdirSync(dir, { recursive: true });
  m.textures = ['atlas.png'];
  fs.writeFileSync(path.join(dir, 'atlas.png'), encodePng(1, 1, new Uint8Array([255, 255, 255, 255])));
  fs.writeFileSync(path.join(dir, 'model.ugo'), new Uint8Array(compileUgo(m)));
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'web', 'ugo.wasm')), {})).instance.exports);
  const model = rt.loadModel(fs.readFileSync(path.join(dir, 'model.ugo'))), inst = model.createInstance();
  inst.reset(); inst.update(0);
  const rest = Array.from(inst.drawOrder()), pd = model.partData().parts, mesh = model.meshData();
  const want = rest.flatMap((k) => Array.from(mesh.indices.subarray(pd[k].firstIndex, pd[k].firstIndex + pd[k].indexCount)));
  const r = spawnSync('node', [path.join(ROOT, 'tools', 'export_gltf.mjs'), path.join(dir, 'model.ugo'), path.join(OUT, 'order.glb')], { encoding: 'utf8' });
  const g = readGlb(path.join(OUT, 'order.glb')), idx = g.read(g.json.meshes[0].primitives[0].indices);
  check(rest.join() !== pd.map((_, k) => k).join() && idx.join() === want.join(), `the triangles in the rest draw order (${rest.map((k) => pd[k].name).join(', ')}), not the stored one`);
  check(/change the draw order/.test(r.stderr), 'a warning: parameters or animations change the draw order (glTF keeps the rest one)');
}

// ---- atlas pages and maskOnly parts: a primitive and a material per page, mask-only parts not drawn ----
{
  const { importPsd } = await import('../tools/import_psd.mjs');
  const zlib = await import('node:zlib');
  const res = importPsd(fs.readFileSync(path.join(ROOT, 'tests', 'psd', 'face.psd')), { inflate: (b) => zlib.inflateSync(b), maxAtlasSize: 256 });
  const m = { ...res.model, version: '0.7' };
  m.bones = [...m.bones, { id: 'head', parent: 'root' }, { id: 'body', parent: 'root' }]; // for VRM's humanoid
  // a mask-only part: a copy of the face that the eyes are clipped to
  const face = m.parts.find((p) => p.id === 'face');
  m.parts.push({ ...structuredClone(face), id: 'faceMask', maskOnly: true });
  for (const p of m.parts) if (p.id.startsWith('eye')) p.mask = ['faceMask'];
  const dir = path.join(OUT, 'pages');
  fs.mkdirSync(dir, { recursive: true });
  res.atlases.forEach((a, i) => fs.writeFileSync(path.join(dir, m.textures[i]), encodePng(a.width, a.height, a.rgba)));
  fs.writeFileSync(path.join(dir, 'model.ugo'), new Uint8Array(compileUgo(m)));
  const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'web', 'ugo.wasm')), {})).instance.exports);
  const model = rt.loadModel(fs.readFileSync(path.join(dir, 'model.ugo'))), pd = model.partData().parts, mesh = model.meshData();
  const vertexPart = mesh.parts, maskOnly = pd.findIndex((p) => p.name === 'faceMask');
  for (const [tool, file] of [['export_gltf', 'pages.glb'], ['export_vrm', 'pages.vrm']]) {
    execFileSync('node', [path.join(ROOT, 'tools', `${tool}.mjs`), path.join(dir, 'model.ugo'), path.join(OUT, file)], { stdio: 'ignore' });
    const g = readGlb(path.join(OUT, file)), prims = g.json.meshes[0].primitives;
    let wrongPage = 0, maskDrawn = 0, drawn = 0;
    for (const pr of prims) for (const v of g.read(pr.indices)) { drawn++; const k = vertexPart[v]; if (pd[k].texture !== pr.material) wrongPage++; if (k === maskOnly) maskDrawn++; }
    const want = pd.filter((p, k) => k !== maskOnly).reduce((n, p) => n + p.indexCount, 0);
    check(res.atlases.length > 1 && g.json.images.length === res.atlases.length && g.json.materials.length === res.atlases.length && new Set(prims.map((p) => p.material)).size === res.atlases.length && wrongPage === 0,
      `${tool}: ${res.atlases.length} atlas pages -> ${g.json.images.length} images and materials, ${prims.length} primitives, every triangle on its own page's material`);
    check(maskDrawn === 0 && drawn === want, `${tool}: the mask-only part is not drawn (${drawn} indices, all of the other parts)`);
  }
}

// ---- the file names: .ug9 (the runtime's file since 2026-11-07) and .ugo (its name before) ----------------
{
  const dir = path.join(OUT, 'names');
  fs.mkdirSync(dir, { recursive: true });
  // the sample is model.ug9; a copy under the old name (model.ugo) stands for a file of before the rename
  fs.copyFileSync(path.join(ROOT, 'samples', 'basic', 'atlas.png'), path.join(dir, 'atlas.png'));
  fs.copyFileSync(path.join(ROOT, 'samples', 'basic', 'model.ug9'), path.join(dir, 'new.ug9'));
  fs.copyFileSync(path.join(dir, 'new.ug9'), path.join(dir, 'model.ugo'));
  for (const f of ['model.glb', 'new.glb', 'new.vrm']) if (fs.existsSync(path.join(dir, f))) fs.unlinkSync(path.join(dir, f));
  execFileSync('node', [path.join(ROOT, 'tools', 'export_gltf.mjs'), path.join(dir, 'new.ug9')], { stdio: 'ignore' });
  execFileSync('node', [path.join(ROOT, 'tools', 'export_gltf.mjs'), path.join(dir, 'model.ugo')], { stdio: 'ignore' });
  execFileSync('node', [path.join(ROOT, 'tools', 'export_vrm.mjs'), path.join(dir, 'new.ug9')], { stdio: 'ignore' });
  const same = Buffer.compare(fs.readFileSync(path.join(dir, 'new.glb')), fs.readFileSync(path.join(dir, 'model.glb'))) === 0;
  check(same && fs.existsSync(path.join(dir, 'new.vrm')), 'a .ug9 is read and its default output is name.glb / name.vrm; a .ugo still works, with the same bytes');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall glTF skeleton checks passed');
process.exit(failures ? 1 : 0);
