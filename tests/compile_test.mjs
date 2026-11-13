// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The compiler's error messages say where in the authoring JSON the problem
// is (error.path, and "[path]" at the start of the message), so an editor
// can point at the field.
//   node tests/compile_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime, UgoExpressionMixer } from '../web/ugo.js';
import { readPreset, makePreset, missingParams, applyExpression } from '../tools/expressions.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rig = JSON.parse(fs.readFileSync(new URL('./pose/rig.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(rig));
const pathOf = (src) => { try { compileUgo(src); return null; } catch (e) { return [e.path, e.message, e.code, e.vars]; } };

const cases = [
  ['a bad delta in a morph', (m) => { m.deformers[0].morphs.innerPart.vertices[0] = 999; }, 'deformers[0].morphs.innerPart', 'vertexOutOfRange'],
  ['an unknown parameter in a region', (m) => { m.deformers[1].region = { Nope: [0, 1, 1] }; }, 'deformers[1].region', 'unknownParam'],
  ['a warp delta of the wrong length', (m) => { m.deformers[0].warps.grid.dense.pop(); }, 'deformers[0].warps.grid', 'warpDeltaCount'],
  ['an unknown bone in a part', (m) => { m.parts[0].weights[0] = [['nope', 1]]; }, 'parts[0]', 'unknownBone'],
  ['an unknown mask part', (m) => { m.parts.find((p) => p.mask).mask = ['nope']; }, `parts[${rig.parts.findIndex((p) => p.mask)}].mask`, 'unknownPart'],
  ['unsorted animation keys', (m) => { m.animations[0].tracks.Bend.reverse(); }, 'animations[0].tracks.Bend', 'keysNotSorted'],
  ['an unknown bone track', (m) => { const b = Object.keys(m.animations[0].bones)[0]; m.animations[0].bones[b].wobble = [[0, 1]]; }, `animations[0].bones.${Object.keys(rig.animations[0].bones)[0]}.wobble`, 'unknownTrack'],
  ['a warp with no cells', (m) => { m.warps[1].cols = 0; }, 'warps[1]', 'warpSize'],
  ['a constraint on an unknown bone', (m) => { m.constraints[0].target = 'nope'; }, 'constraints[0]', 'unknownBone'],
  ['a bad parameter range', (m) => { m.parameters[0].default = 5; }, 'parameters[0]', 'paramRange'],
  ['a colour with a bad value', (m) => { m.colors[0].tint = [1, 'x', 0]; }, 'colors[0]', 'notFinite'],
  ['a bone in a grid with a parent', (m) => { m.bones.find((b) => b.id === 'rot').parent = 'a'; }, `bones[${rig.bones.findIndex((b) => b.id === 'rot')}]`, 'warpBoneParent'],
  ['a list that is not a list', (m) => { m.deformers = 3; }, 'deformers', 'notList'],
  ['data of the wrong shape', (m) => { m.parts[0].triangles = 5; }, 'parts[0]', 'malformed'],
];
for (const [label, edit, want, code] of cases) {
  const m = clone(); edit(m);
  const r = pathOf(m);
  check(r && r[0] === want && r[1].includes(`[${want}]`) && r[2] === code && r[3] && typeof r[3] === 'object',
    `${label}: ${r ? `${r[0]} — ${r[2]} ${JSON.stringify(r[3])} — ${r[1]}` : 'compiled (should fail)'}`);
}
check(pathOf(clone()) === null, 'the rig itself compiles');
{ // the editor's own fields ("editor" at the top, "baked" marks on deformers) are passed over
  const plain = new Uint8Array(compileUgo(clone()));
  const m = clone(); m.editor = { shapes: [{ id: 'head', type: 'sphere', center: [0, 0], radius: 50 }], depth: { [m.parts[0].id]: 2 } };
  m.deformers.forEach((d) => { d.baked = 'head'; });
  const w = [], marked = new Uint8Array(compileUgo(m, { warnings: w }));
  check(marked.length === plain.length && marked.every((x, i) => x === plain[i]) && !w.length, 'the "editor" field and "baked" marks change nothing in the .ug9');
}
{ // checkOnly: the same errors and warnings, no .ug9
  const m = clone(); m.parameters.push({ id: 'Idle', min: 0, max: 1 });
  const w1 = [], w2 = [];
  compileUgo(m, { warnings: w1 });
  check(compileUgo(m, { warnings: w2, checkOnly: true }) === null && JSON.stringify(w1) === JSON.stringify(w2), 'checkOnly returns null with the same warnings');
  const bad = clone(); bad.deformers[1].region = { Nope: [0, 1, 1] };
  let e1, e2;
  try { compileUgo(bad); } catch (e) { e1 = e; }
  try { compileUgo(bad, { checkOnly: true }); } catch (e) { e2 = e; }
  check(e1 && e2 && e1.message === e2.message && e1.code === e2.code, 'checkOnly throws the same error');
}

// warnings: things that compile but look wrong, with where they are
{
  const warnings = (edit) => { const m = clone(); edit(m); const w = []; compileUgo(m, { warnings: w }); return w; };
  const has = (w, path, code) => w.some((x) => x.path === path && x.code === code && x.message && x.vars);
  const basic = JSON.parse(fs.readFileSync(new URL('../samples/basic/model.json', import.meta.url), 'utf8'));
  const w0 = []; compileUgo(basic, { warnings: w0 }); compileUgo(clone(), { warnings: w0 });
  check(w0.length === 0, `no warnings for the sample and the rig (${JSON.stringify(w0)})`);
  const warpedAt = rig.parts.findIndex((q) => q.id === 'warped');
  const cases = [
    ['an unused parameter', (m) => { m.parameters.push({ id: 'Idle', min: 0, max: 1 }); }, `parameters[${rig.parameters.length}]`, 'paramUnused'],
    ['a region outside the parameter range', (m) => { m.deformers[1].region = { Bend: [2, 3, 4] }; }, 'deformers[1].region', 'regionOutOfRange'],
    ['a deformer that changes nothing', (m) => { m.deformers.push({ region: { Bend: [0, 1, 1] } }); }, `deformers[${rig.deformers.length}]`, 'deformerEmpty'],
    ['a part without triangles', (m) => { m.parts[0].triangles = []; }, 'parts[0]', 'partNoTriangles'],
    ['a part in its own mask', (m) => { const p = m.parts.find((q) => q.mask); p.mask = [...p.mask, p.id]; }, `parts[${rig.parts.findIndex((q) => q.mask)}].mask`, 'partInOwnMask'],
    ['a part mostly outside its warp grid', (m) => { const p = m.parts[warpedAt]; p.vertices = p.vertices.map((v, k) => (k % 2 ? v : v + 200)); }, `parts[${warpedAt}]`, 'partOutsideWarp'],
    ['a chain whose last bone has no length', (m) => { m.bones.find((b) => b.id === 'sway2').length = 0; }, 'chains[0]', 'chainTipNoLength'],
    ['an animation key outside the parameter range', (m) => { m.animations[0].tracks = { ...m.animations[0].tracks, Bend: [[0, 0], [1, 5]] }; }, `animations[0].tracks.Bend`, 'keyOutOfRange'],
    ['a maskOnly part no mask uses', (m) => { m.parts.push({ ...m.parts[0], id: 'lonely', maskOnly: true, mask: undefined }); }, `parts[${rig.parts.length}]`, 'maskPartHiddenOnly'],
    ['a texture no part uses', (m) => { m.textures.push('spare.png'); }, `textures[${rig.textures.length}]`, 'textureUnused'],
    ['an empty warp grid', (m) => { m.warps.push({ id: 'spare', cols: 1, rows: 1, rect: [0, 0, 10, 10] }); }, `warps[${rig.warps.length}]`, 'warpEmpty'],
    ['a morph whose deltas are all 0', (m) => { const d = m.deformers.find((q) => q.morphs); const [pid, md] = Object.entries(d.morphs)[0];
      d.morphs[pid] = md.dense ? { dense: md.dense.map(() => 0) } : { vertices: md.vertices, deltas: md.deltas.map(() => 0) }; },
    `deformers[${rig.deformers.findIndex((q) => q.morphs)}].morphs.${Object.keys(rig.deformers.find((q) => q.morphs).morphs)[0]}`, 'morphZero'],
    ['a bone nothing uses (info)', (m) => { m.bones.push({ id: 'spareTip', parent: 'root' }); }, `bones[${rig.bones.length}]`, 'boneUnused'],
    // a constraint's mix written in a deformer (meant to follow a parameter): nothing reads it there
    ['constraints written in a deformer', (m) => { m.deformers[1].constraints = { arm: { mix: 0.2 } }; }, 'deformers[1].constraints', 'deformerConstraints'],
  ];
  for (const [label, edit, path, code] of cases) {
    const w = warnings(edit);
    check(has(w, path, code), `warning ${code} for ${label} at ${path} (${JSON.stringify(w)})`);
  }
  { // it names the constraints and where their mix does move; a deformer with only them is not also "empty"; the file is the same
    const w = warnings((m) => { m.deformers.push({ region: { Bend: [0, 1, 1] }, constraints: { arm: { mix: 0.2 }, follow: { mixRotate: 0.5 } } }); });
    const c = w.find((x) => x.code === 'deformerConstraints');
    check(c && c.vars.constraints === 'arm, follow' && /animations\[\]\.constraints/.test(c.message) && !w.some((x) => x.code === 'deformerEmpty'),
      `constraints in a deformer: named, and the message says to key the mix in an animation (${c?.message})`);
    const a = clone(), b = clone();
    b.deformers[1].constraints = { arm: { mix: 0.2 } };
    check(Buffer.compare(Buffer.from(compileUgo(a)), Buffer.from(compileUgo(b))) === 0, 'the file is the same with or without them (a warning: it still compiles)');
  }
  const wi = warnings((m) => { m.bones.push({ id: 'spareTip', parent: 'root' }); });
  check(wi.length === 1 && wi[0].level === 'info' && wi[0].vars.bone === 'spareTip', 'an unused bone is only an info');
}

// glue: the seam between an upper and a lower arm; the pairs share the rest position
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const arm = (glue) => ({
    format: 'ugo9', version: '0.6', canvas: { width: 200, height: 200, originX: 100, originY: 100 },
    parameters: [{ id: 'Bend', min: -1, default: 0, max: 1 }, { id: 'Puff', min: 0, default: 0, max: 1 }],
    bones: [{ id: 'root' }, { id: 'upper', parent: 'root', length: 40 }, { id: 'lower', parent: 'upper', x: 40, length: 40 }],
    parts: [
      { id: 'up', bone: 'upper', vertices: [0, -5, 40, -5, 40, 5, 0, 5], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] },
      { id: 'lo', bone: 'lower', vertices: [40, -5, 80, -5, 80, 5, 40, 5], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] },
    ],
    deformers: [
      { region: { Bend: [0, 1, 1] }, bones: { lower: { rotation: 70 } } },
      { region: { Puff: [0, 1, 1] }, morphs: { up: { vertices: [1, 2], deltas: [3, -4, 3, 4] } } }, // only the upper part bulges
    ],
    glue,
  });
  const seam = (glue, bend, puff) => {
    const m = rt.loadModel(compileUgo(arm(glue))), inst = m.createInstance();
    inst.reset(); inst.set('Bend', bend); inst.set('Puff', puff); inst.update(0);
    const p = inst.deformedPositions();
    return { a: [[p[2], p[3]], [p[4], p[5]]], b: [[p[8], p[9]], [p[14], p[15]]] }; // up 1, 2 and lo 0, 3
  };
  const gap = (r) => Math.max(...[0, 1].map((k) => Math.hypot(r.a[k][0] - r.b[k][0], r.a[k][1] - r.b[k][1])));
  const glue = (extra) => [{ parts: ['up', 'lo'], pairs: [[1, 0], [2, 3]], ...extra }];
  const open = gap(seam(undefined, 1, 1));
  check(open > 5, `without glue the seam opens when the arm bends and bulges (${open.toFixed(1)} px)`);
  let worst = 0;
  for (const [bend, puff] of [[1, 0], [-1, 1], [0.4, 0.6], [1, 1]]) worst = Math.max(worst, gap(seam(glue({}), bend, puff)));
  check(worst < 1e-3, `glued (strength 1) the seam stays closed in every pose (${worst.toExponential(1)} px)`);
  const toB = seam(glue({ bias: 1 }), 1, 1), plainB = seam(undefined, 1, 1);
  check(gap(toB) < 1e-3 && Math.hypot(toB.b[0][0] - plainB.b[0][0], toB.b[0][1] - plainB.b[0][1]) < 1e-3, 'bias 1: the upper arm follows the lower arm, which keeps its own motion');
  check(Math.abs(gap(seam(glue({ strength: 0 }), 1, 1)) - open) < 1e-3, 'strength 0: no glue');
  const half = gap(seam(glue({ strength: 0.5 }), 1, 1));
  check(half > 1e-3 && half < open, `strength 0.5 narrows the seam (${half.toFixed(1)} of ${open.toFixed(1)} px)`);
  const wg = []; compileUgo(arm([{ parts: ['up', 'lo'], pairs: [[1, 0], [0, 3]] }]), { warnings: wg });
  check(wg.some((x) => x.path === 'glue[0].pairs[1]' && x.code === 'glueApart' && x.vars.distance > 1), `warning for glued points apart in the rest pose at glue[0].pairs[1] (${JSON.stringify(wg)})`);
  const bad = (g) => { try { compileUgo(arm(g)); return null; } catch (e) { return e.path; } };
  check(bad([{ parts: ['up', 'lo'], pairs: [[9, 0]] }]) === 'glue[0]', 'a glue pair out of range is refused (glue[0])');
}

// format 0.7: keys are 16-bit (time in ticks of the animation, value in the track's range, straight lines),
// tracks that never change keep their value, chains have names, and an older file says so
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const keyed = [[0, -20, 'linear'], [0.25, 37.5, 'smooth'], [1.1, 3.25, 'step'], [2.6, 30, 'linear'], [8, -30]];
  const src = {
    format: 'ugo9', version: '0.7', canvas: { width: 10, height: 10 },
    parameters: [{ id: 'A', min: -30, default: 0, max: 30 }, { id: 'B', min: -30, default: 0, max: 30 }],
    bones: [{ id: 'root' }, { id: 'h1', parent: 'root', length: 10 }, { id: 'h2', parent: 'h1', y: 10, length: 10 }],
    chains: [{ id: 'hair', bones: ['h1', 'h2'] }],
    parts: [],
    deformers: [{ region: { A: [0, 30, 30] }, bones: { root: { rotation: 1 } } }, { region: { B: [0, 30, 30] }, bones: { root: { x: 1 } } }],
    animations: [{ id: 'a', duration: 8, loop: false, tracks: { A: keyed, B: [[0, 7.5], [3, 7.5], [8, 7.5]] } }],
  };
  const m = rt.loadModel(compileUgo(src)), inst = m.createInstance();
  const tick = 8 / 65535, range = 37.5 - -30;
  const valueAt = (t) => { // the authoring keys, as the runtime interpolates them
    let i = 0; while (i + 1 < keyed.length && keyed[i + 1][0] <= t) i++;
    const [t0, v0, mode] = keyed[i], k1 = keyed[i + 1];
    if (!k1 || mode === 'step') return v0;
    let f = (t - t0) / (k1[0] - t0); if (mode === 'smooth') f = f * f * (3 - 2 * f);
    return v0 + (k1[1] - v0) * f;
  };
  inst.reset(); inst.play('a', 1.8); // inside the step from 1.1 to 2.6: only the value's rounding shows
  const held = Math.abs(inst.get('A') - 3.25);
  check(held <= range / 65535 / 2 + 1e-6, `a key's value comes back within half a step of its 16-bit range (${held.toExponential(2)}, step ${(range / 65535).toExponential(2)})`);
  let worstMid = 0;
  for (let t = 0.01; t < 8; t += 0.137) { inst.reset(); inst.play('a', t); worstMid = Math.max(worstMid, Math.abs(inst.get('A') - valueAt(t))); }
  check(worstMid < 0.05, `between keys the value follows the authoring keys (worst ${worstMid.toFixed(4)}; times move by at most half a tick, ${(tick * 500).toFixed(3)} ms)`);
  inst.reset(); inst.play('a', 5.5);
  check(inst.get('B') === 7.5, 'a track that never changes keeps its exact value (no 16-bit rounding)');
  const v7 = new Uint8Array(compileUgo(src)), dv = new DataView(v7.buffer);
  const keyCount = (bytes) => new DataView(bytes.buffer || bytes).getUint32(32 + 4 * 16, true);
  const onlyA = JSON.parse(JSON.stringify(src)); delete onlyA.animations[0].tracks.B;
  check(keyCount(v7) === keyCount(compileUgo(onlyA)), `the track that never changes adds no keys (${keyCount(v7)} keys, all of track A)`);
  // a step is a held value up to the next key; a smooth piece is eased (as the editor shows them)
  inst.reset(); inst.play('a', 1.099);
  check(Math.abs(inst.get('A') - valueAt(1.099)) < 0.01, `a smooth piece stays on its eased curve (${inst.get('A').toFixed(4)} vs ${valueAt(1.099).toFixed(4)})`);
  inst.reset(); inst.play('a', 2.599);
  check(Math.abs(inst.get('A') - 3.25) < range / 65535, `a step holds its value up to the next key (${inst.get('A').toFixed(4)})`);
  inst.reset(); inst.play('a', 2.6 + 2 * tick);
  check(Math.abs(inst.get('A') - valueAt(2.6 + 2 * tick)) < 0.01, `and the next key takes over at its time (${inst.get('A').toFixed(4)})`);
  check(m.chains.length === 1 && m.chains[0].name === 'hair', `a chain keeps its id as its name (${JSON.stringify(m.chains.map((c) => c.name))})`);
  const old = new Uint8Array(v7); old[4] = 0; old[6] = 7; // the same file, marked 0.7 (the format before 1.0)
  let msg = '';
  try { rt.loadModel(old); } catch (e) { msg = `${e.code}: ${e.message}`; }
  check(msg.startsWith('ugoVersion') && msg.includes('0.7') && msg.includes('1.x') && msg.includes('compile it again'), `an older .ug9 (0.x) is refused with a version message (${msg})`);
}

// format 0.8: a warp grid may be turned (angle), and parts have a draw order that parameters and animations change
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const quad = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
  const mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
  const turned = (angle, inner = -15) => ({
    format: 'ugo9', version: '1.0', canvas: { width: 200, height: 200, originX: 100, originY: 100 },
    parameters: [{ id: 'Puff', min: 0, default: 0, max: 1 }, { id: 'Pull', min: 0, default: 0, max: 1 }],
    bones: [{ id: 'root' }, { id: 'pin', warp: 'g', x: 10, y: 5 }],
    warps: [
      { id: 'g', cols: 2, rows: 2, rect: [-50, -30, 100, 60], ...(angle === undefined ? {} : { angle }), bone: 'root' },
      { id: 'inner', cols: 1, rows: 1, rect: [-10, -10, 20, 20], angle: inner, parent: 'g' },
    ],
    parts: [
      { id: 'sq', warp: 'g', vertices: [-30, -10, 20, -15, 25, 20, -20, 15], ...mesh },
      { id: 'in', warp: 'inner', vertices: quad(-5, -5, 5, 5), ...mesh },
      { id: 'arm', bone: 'pin', vertices: quad(10, 5, 40, 10), ...mesh },
    ],
    deformers: [
      { region: { Puff: [0, 1, 1] }, morphs: { sq: { vertices: [0], deltas: [3, -4] } } },
      { region: { Pull: [0, 1, 1] }, warps: { g: { points: [4], deltas: [6, 2] } } },
    ],
  });
  const src = turned(30), m = rt.loadModel(compileUgo(src)), inst = m.createInstance();
  const authored = src.parts.flatMap((p) => p.vertices);
  const worst = (p, q) => Math.max(...p.map((x, i) => Math.abs(x - q[i])));
  inst.reset(); inst.update(0);
  check(worst(Array.from(inst.deformedPositions()), authored) < 1e-3, `a turned grid (30°, and a grid turned -15° inside it) keeps every vertex where it was drawn (${worst(Array.from(inst.deformedPositions()), authored).toExponential(1)} px), bones in it too`);
  check(Math.abs(m.warps[0].angle - 30) < 1e-4 && Math.abs(m.warps[1].angle + 15) < 1e-4 && worst(m.warps[0].rect, [-50, -30, 100, 60]) < 1e-3,
    `the player reads the grid's angle and rect back (${m.warps.map((w) => w.angle.toFixed(3)).join(', ')}; ${m.warps[0].rect.map((x) => x.toFixed(2)).join(', ')})`);
  const e = inst.warpEval(0, 12, -7);
  check(Math.hypot(e[0] - 12, e[1] + 7) < 1e-3, `warpEval of a turned grid at rest gives the point back (${e.map((x) => x.toFixed(4)).join(', ')})`);
  inst.reset(); inst.set('Puff', 1); inst.update(0);
  const pf = inst.deformedPositions();
  check(Math.hypot(pf[0] - (-30 + 3), pf[1] - (-10 - 4)) < 1e-3, `a morph in a turned grid moves by its model-space px (${pf[0].toFixed(3)}, ${pf[1].toFixed(3)})`);
  inst.reset(); inst.update(0);
  const p0 = inst.warpPoints(0);
  inst.reset(); inst.set('Pull', 1); inst.update(0);
  const pts = inst.warpPoints(0);
  check(Math.hypot(pts[8] - p0[8] - 6, pts[9] - p0[9] - 2) < 1e-3, `a grid point's delta in a turned grid is model-space px (${(pts[8] - p0[8]).toFixed(3)}, ${(pts[9] - p0[9]).toFixed(3)})`);
  const plain = new Uint8Array(compileUgo(turned(undefined, 0))), zero = new Uint8Array(compileUgo(turned(0, 0)));
  check(plain.length === zero.length && plain.every((x, i) => x === zero[i]), 'angle 0 writes the same bytes as no angle');
  let bad = null;
  try { compileUgo(turned('x')); } catch (er) { bad = er; }
  check(bad && bad.code === 'notFinite' && bad.path === 'warps[0]', `a bad angle is refused at warps[0] (${bad && bad.message})`);

  // draw order: three parts on top of each other, b sent to the back by a parameter, c to the front by an animation
  const stack = (extra = {}) => ({
    format: 'ugo9', version: '1.0', canvas: { width: 100, height: 100, originX: 50, originY: 50 },
    parameters: [{ id: 'Sw', min: 0, default: 0, max: 1 }],
    bones: [{ id: 'root' }],
    parts: ['a', 'b', 'c'].map((id, i) => ({ id, bone: 'root', vertices: quad(-10 + i, -10, 10 + i, 10), ...mesh, ...(extra[id] || {}) })),
    deformers: extra.deformers ?? [{ region: { Sw: [0, 1, 1] }, order: { b: 0 } }],
    animations: extra.animations ?? [{ id: 'front', duration: 1, order: { c: [[0, 100], [1, 100]] } }],
  });
  const sm = rt.loadModel(compileUgo(stack())), si = sm.createInstance();
  const at2 = (sw, anim, w = 1) => { si.reset(); if (anim) si.play(anim, 0, w); si.set('Sw', sw); si.update(0); return [Array.from(si.drawOrder()).join(''), si.drawOrderKey()]; };
  const [l0, k0] = at2(0), [l1, k1] = at2(0.25), [l2, k2] = at2(1);
  check(sm.hasDrawOrder && l0 === '012' && k0 === 0, `the stored order while nothing changes it (${l0}, key ${k0})`);
  check(l1 === '102' && k1 !== 0 && l2 === '102' && k2 === k1, `a parameter sends b back as soon as its value passes a's (${l1} at 0.25, ${l2} at 1; keys ${k1} ${k2})`);
  const [l3] = at2(0, 'front'), [l4] = at2(0.5, 'front', 0.5);
  check(l3 === '201', `an animation key replaces c's value (${l3})`);
  check(l4 === '120', `blended at weight 0.5 (c 300) and with b at 250 from the parameter (${l4})`);
  const st = rt.loadModel(compileUgo(stack({ a: { order: 600 }, c: { order: 400 }, deformers: [], animations: [] }))), sti = st.createInstance();
  sti.update(0);
  check(st.hasDrawOrder && Array.from(sti.drawOrder()).join('') === '210', `parts' own values without any change (${Array.from(sti.drawOrder()).join('')})`);
  const none = rt.loadModel(compileUgo(stack({ deformers: [], animations: [] })));
  check(!none.hasDrawOrder, 'no draw order table when every part has the default and nothing changes it');
  // many parts moving at once (sorted by merging, not from last frame's order): the same answer as sorting by value, then part
  const many = {
    format: 'ugo9', canvas: { width: 100, height: 100 }, parameters: [{ id: 'Sw', min: 0, default: 0, max: 1 }], bones: [{ id: 'root' }],
    parts: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, bone: 'root', vertices: quad(0, 0, 1, 1), ...mesh })),
    deformers: [{ region: { Sw: [0, 1, 1] }, order: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, 1000 - 10 * (i >> 1)])) }],
  };
  const mi = rt.loadModel(compileUgo(many)).createInstance();
  let manyOk = true;
  for (const sw of [1, 0, 0.3, 1, 0.01, 0]) {
    mi.reset(); mi.set('Sw', sw); mi.update(0);
    const val = (i) => Math.fround(500 + Math.fround(sw * (1000 - 10 * (i >> 1) - 500)));
    const want = Array.from({ length: 40 }, (_, i) => i).sort((x, y) => val(x) - val(y) || x - y).join();
    if (Array.from(mi.drawOrder()).join() !== want) manyOk = false;
  }
  check(manyOk, 'when many parts move at once the order is still by value, then by part (equal values keep the parts\' order)');
  // tests/order/model.ug9 (a turned grid with a bone in it, draw order tables) is one of the core's corrupted-file runs
  const ord = JSON.parse(fs.readFileSync(new URL('./order/model.json', import.meta.url), 'utf8'));
  check(Buffer.compare(fs.readFileSync(new URL('./order/model.ug9', import.meta.url)), Buffer.from(compileUgo(ord))) === 0, 'tests/order/model.ug9 is up to date (node tools/compile.mjs tests/order/model.json)');
  const err = (edit) => { try { compileUgo(edit(stack())); return null; } catch (er) { return [er.path, er.code]; } };
  const e1 = err((x) => { x.parts[0].order = 2e6; return x; }), e2 = err((x) => { x.deformers[0].region = undefined; return x; });
  const e3 = err((x) => { x.animations[0].order.c[0][1] = -3e6; return x; });
  check(e1 && e1[1] === 'orderRange', `a value out of range is refused (${e1})`);
  check(e2 && e2[1] === 'needsRegion', `draw order changes need a region (${e2})`);
  check(e3 && e3[1] === 'orderRange' && e3[0] === 'animations[0].order.c', `an animation key out of range is refused (${e3})`);
}

// format 0.8: expressions (parameters by name; the model's own, and presets for any model)
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const quad = [-5, -5, 5, -5, 5, 5, -5, 5], mesh = { uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
  const face = (params, expressions) => ({
    format: 'ugo9', canvas: { width: 50, height: 50 }, bones: [{ id: 'root' }],
    parameters: params.map(([id, min, def, max]) => ({ id, min, default: def, max })),
    parts: [{ id: 'p', bone: 'root', vertices: quad, ...mesh }],
    deformers: params.map(([id]) => ({ region: { [id]: [0, 1, 1] }, bones: { root: { x: 1 } } })),
    expressions,
  });
  const exprs = [
    { id: 'smile', fadeIn: 0.4, fadeOut: 0.2, params: { MouthShape: ['set', 0.5], EyeOpenL: ['multiply', 0.5], BrowHeightL: ['add', 0.25] } },
    { id: 'angry', params: { MouthShape: ['add', -0.5] } },
  ];
  const P = [['MouthShape', -1, 0, 1], ['EyeOpenL', 0, 1, 1], ['BrowHeightL', -1, 0, 1]];
  const m = rt.loadModel(compileUgo(face(P, exprs))), inst = m.createInstance();
  const vals = () => P.map(([id]) => +inst.get(id).toFixed(5)).join(',');
  check(m.expressions.length === 2 && m.expressions[0].name === 'smile' && Math.abs(m.expressions[0].fadeIn - 0.4) < 1e-6 && Math.abs(m.expressions[1].fadeOut - 0.5) < 1e-6,
    `a model keeps its expressions, their fade times (default 0.5 s) and items (${JSON.stringify(m.expressions.map((e) => [e.name, e.items.length]))})`);
  inst.reset(); inst.expression('smile', 1);
  check(vals() === '0.5,0.5,0.25', `set, multiply and add at weight 1 (${vals()})`);
  inst.reset(); inst.expression('smile', 0.5);
  check(vals() === '0.25,0.75,0.125', `and at weight 0.5 (${vals()})`);
  inst.reset(); inst.expression('smile', 1); inst.expression('angry', 1);
  check(vals() === '0,0.5,0.25', `expressions stack in the order they are applied (${vals()})`);
  inst.reset(); inst.set('BrowHeightL', 0.9); inst.expression('smile', 1); inst.update(0);
  check(inst.get('BrowHeightL') === 1, 'the parameter range still holds after an expression (update clamps it)');
  // the same math in tools/expressions.mjs (for tools without the core)
  const tidy = readPreset(m.exportExpressions());
  const js = applyExpression({ MouthShape: 0, EyeOpenL: 1, BrowHeightL: 0 }, tidy[0], 0.5);
  check(JSON.stringify(js) === JSON.stringify({ MouthShape: 0.25, EyeOpenL: 0.75, BrowHeightL: 0.125 }), 'tools/expressions.mjs computes the same');
  // a preset to another model: names that match are used, the rest are skipped and listed
  const preset = m.exportExpressions();
  check(preset.format === 'ugo9-expressions' && JSON.stringify(preset.expressions[0].params) === JSON.stringify(exprs[0].params), 'a model\'s expressions export as a preset, written by parameter names');
  const other = rt.loadModel(compileUgo(face([['Extra', 0, 0, 1], ['EyeOpenL', 0, 1, 1], ['MouthShape', -1, 0, 1]], []))), oi = other.createInstance();
  const loaded = other.loadExpressions(preset);
  check(JSON.stringify(loaded.missing) === '["BrowHeightL"]' && JSON.stringify(loaded.expressions[0].missing) === '["BrowHeightL"]', `loading it into a model without BrowHeightL lists that name (${JSON.stringify(loaded.missing)})`);
  oi.reset(); oi.expression(loaded.expressions[0], 1);
  check(oi.get('MouthShape') === 0.5 && oi.get('EyeOpenL') === 0.5 && oi.get('Extra') === 0, `and applies the rest by name, whatever the parameters' numbers (${['Extra', 'EyeOpenL', 'MouthShape'].map((k) => oi.get(k)).join(',')})`);
  check(JSON.stringify(missingParams(preset.expressions, ['Extra', 'EyeOpenL', 'MouthShape'])) === '["BrowHeightL"]', 'tools/expressions.mjs lists the missing names too (for the editor)');
  let wrong = '';
  try { inst.expression(loaded.expressions[0], 1); } catch (e) { wrong = e.message; }
  check(/another model/.test(wrong), 'an expression loaded for one model is refused by another model\'s instance');
  check(JSON.stringify(makePreset(readPreset(preset))) === JSON.stringify(preset), 'a preset reads and writes back the same');
  // fading
  const mix = new UgoExpressionMixer(m);
  mix.show('smile').update(0.2);
  const w1 = mix.weights()[0][1];
  mix.hide('smile').update(0.05);
  const w2 = mix.weights()[0][1];
  mix.update(0.2);
  check(Math.abs(w1 - 0.5) < 1e-6 && Math.abs(w2 - 0.25) < 1e-6 && mix.weights().length === 0, `the mixer fades in and out by the expression's times (${w1}, then ${w2}, then gone)`);
  mix.show('smile').show('angry').update(10); inst.reset(); mix.apply(inst);
  check(vals() === '0,0.5,0.25', `and applies what is shown in the order shown (${vals()})`);
  // errors
  const err = (e) => { try { compileUgo(face(P, e)); return null; } catch (x) { return [x.path, x.code]; } };
  const e1 = err([{ id: 'x', params: { Nope: ['set', 1] } }]), e2 = err([{ id: 'x', params: { MouthShape: ['scale', 1] } }]), e3 = err([{ id: 'x' }, { id: 'x' }]);
  check(e1 && e1[0] === 'expressions[0].params.Nope' && e1[1] === 'unknownParam', `an unknown parameter is refused where it is (${e1})`);
  check(e2 && e2[0] === 'expressions[0].params.MouthShape' && e2[1] === 'expressionItem', `an unknown op is refused (${e2})`);
  check(e3 && e3[0] === 'expressions[1]' && e3[1] === 'duplicateId', `two expressions with one id are refused (${e3})`);
  check(rt.loadModel(compileUgo(face(P))).expressions.length === 0, 'a model without expressions has none');
}

// format 1.0: a core reads every 1.x file. Unknown tables are skipped (or the file refused, as each table's flag
// says), unknown header fields skipped, unknown track kinds skipped; a broken table of contents is refused.
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const src = JSON.parse(fs.readFileSync(new URL('./order/model.json', import.meta.url), 'utf8'));
  const base = rt.loadModel(compileUgo(src));
  // the same poses in two models: parameters, an animation, the draw order and every vertex
  const pose = (m) => {
    const inst = m.createInstance(), out = [];
    for (const [t, sw, pull] of [[0, 0, 0], [0.7, 0.5, 1], [1.3, 1, 0.3]]) {
      inst.reset(); inst.play('swap', t); inst.set('Sw', sw); inst.set('Pull', pull); inst.expression('puffed', 0.5); inst.update(0);
      out.push(...inst.deformedPositions(), ...inst.drawOrder(), ...m.params.map((_, i) => inst.get(i)));
    }
    return out;
  };
  const want = pose(base);
  const same = (m) => { const got = pose(m); return got.length === want.length && got.every((x, i) => x === want[i]); };
  const later = (future) => compileUgo(src, { future });
  const load = (bytes) => { try { return { m: rt.loadModel(bytes) }; } catch (e) { return { e }; } };
  const t0 = load(later({ minor: 3, headerExtra: 8, tables: [{ kind: 200, flag: 0, count: 3, recSize: 8 }] }));
  check(t0.m && t0.m.warnings === 0 && t0.m.format.major === 1 && t0.m.format.minor === 3 && same(t0.m),
    `a 1.3 file with a longer header and a table this core does not know (flag 0) is read, without a warning, and moves the same (${t0.e?.message ?? `warnings ${t0.m.warnings}, ${t0.m.format.major}.${t0.m.format.minor}`})`);
  const t1 = load(later({ minor: 3, tables: [{ kind: 201, flag: 1, count: 2, recSize: 12 }] }));
  check(t1.m && t1.m.warnings === 1 && same(t1.m), `a table marked "changes the picture" (flag 1) is skipped with a warning (${t1.e?.message ?? t1.m.warnings})`);
  const t2 = load(later({ minor: 3, tables: [{ kind: 202, flag: 2, count: 0, recSize: 4 }] }));
  check(t2.e && t2.e.code === 'ugoNewer' && /update the player/.test(t2.e.message), `a feature marked "needs a newer core" (flag 2, no records) is refused with its own message (${t2.e?.message})`);
  const tk = load(later({ minor: 3, tracks: [{ kind: 99, index: 0, value: 5 }] }));
  check(tk.m && tk.m.warnings === 2 && same(tk.m), `a track of a kind this core does not know is skipped, with a warning, and the rest plays the same (${tk.e?.message ?? tk.m.warnings})`);
  const both = load(later({ minor: 3, tables: [{ kind: 203, flag: 1, count: 1, recSize: 4 }], tracks: [{ kind: 120, index: 7, value: 1 }] }));
  check(both.m && both.m.warnings === 3, `both warnings at once (${both.m?.warnings})`);

  // the table of contents, edited: each of these must be refused (and none may crash)
  const good = new Uint8Array(compileUgo(src)), dv0 = new DataView(good.buffer);
  const hs = dv0.getUint32(12, true), n = dv0.getUint32(32, true);
  const entry = (k) => hs + 16 * k;
  const findKind = (kind) => { for (let k = 0; k < n; k++) if (dv0.getUint32(entry(k), true) === kind) return k; return -1; };
  const edits = [
    ['two entries of one kind', (d) => d.setUint32(entry(1), d.getUint32(entry(0), true), true)],
    ['two tables sharing bytes', (d) => d.setUint32(entry(1) + 4, d.getUint32(entry(0) + 4, true), true)],
    ['a table past the end of the file', (d) => d.setUint32(entry(0) + 8, 0x10000000, true)],
    ['a table not on 4 bytes', (d) => d.setUint32(entry(0) + 4, d.getUint32(entry(0) + 4, true) + 2, true)],
    ['a table inside the table of contents', (d) => d.setUint32(entry(0) + 4, hs, true)],
    ['kind 0', (d) => d.setUint32(entry(0), 0, true)],
    ['a known table with another record size', (d) => d.setUint16(entry(findKind(4)) + 12, 52, true)],
    ['the vertex tables disagreeing', (d) => d.setUint32(entry(findKind(7)) + 8, d.getUint32(entry(findKind(7)) + 8, true) - 1, true)],
    ['a header size past the file', (d) => d.setUint32(12, 1 << 30, true)],
    ['a header size not on 4 bytes', (d) => d.setUint32(12, hs + 2, true)],
    ['too many contents entries', (d) => d.setUint32(32, 100000, true)],
    ['major 2', (d) => d.setUint16(4, 2, true)],
  ];
  const refused = edits.filter(([, f]) => { const b = good.slice(); f(new DataView(b.buffer)); return !!load(b).e; }).length;
  check(refused === edits.length, `a broken table of contents is refused (${refused} of ${edits.length}: ${edits.filter(([, f]) => { const b = good.slice(); f(new DataView(b.buffer)); return !load(b).e; }).map(([l]) => l).join(', ') || 'all'})`);
  const reordered = (() => { // the same tables listed in another order: still the same model
    const b = good.slice(), d = new DataView(b.buffer), rows = [];
    for (let k = 0; k < n; k++) rows.push(b.slice(entry(k), entry(k) + 16));
    rows.reverse().forEach((r, k) => b.set(r, entry(k)));
    return load(b);
  })();
  check(reordered.m && same(reordered.m), 'the table of contents may list the tables in any order');
  // tests/future/model.ug9 (a later 1.x as above) is one of the core's corrupted-file runs
  const fut = await import('./future/make_model.mjs');
  check(Buffer.compare(fs.readFileSync(new URL('./future/model.ug9', import.meta.url)), Buffer.from(fut.build())) === 0, 'tests/future/model.ug9 is up to date (node tests/future/make_model.mjs)');
}

// nearest sampling (pixel art): the C renderer takes each texture's nearest texel instead of blending four
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports), ex = rt.ex;
  const m = rt.loadModel(compileUgo({
    format: 'ugo9', canvas: { width: 8, height: 8 }, textures: ['t.png'], bones: [{ id: 'root' }],
    parts: [{ id: 'p', bone: 'root', vertices: [0, 0, 8, 0, 8, 8, 0, 8], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] }],
  }));
  const inst = m.createInstance(); inst.update(0);
  const texels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]]; // a 2 x 2 checker, drawn 4x
  const draw = (flags) => {
    const img = rt.alloc(12), px = rt.alloc(16), target = rt.alloc(4 * 4 * 64), out = rt.alloc(4 * 64);
    const view = rt.alloc(24), scratch = rt.alloc(8 * (m.vertexCount + 1));
    rt.u8(px, 16).set(texels.flat());
    rt.u32(img, 3).set([px, 2, 2]);
    rt.f32(view, 6).set([1, 0, 0, 1, 0, 0]);
    ex.ugo_raster_clear(target, 8, 8, 0, 0, 0, 0);
    ex.ugo_raster_instance_ex(inst.ptr, img, 1, target, 8, 8, view, scratch, 0, flags);
    ex.ugo_raster_resolve(target, 8, 8, 1, out);
    const rgba = rt.u8(out, 4 * 64), colours = new Set();
    for (let i = 0; i < 64; i++) colours.add(rgba.slice(4 * i, 4 * i + 4).join(','));
    return colours;
  };
  const near = draw(1), smooth = draw(0);
  const want = new Set(texels.map((t) => t.join(',')));
  check(near.size === 4 && [...near].every((c) => want.has(c)), `nearest sampling: only the texture's own colours (${[...near].join(' | ')})`);
  check(smooth.size > 4, `without it the texels blend (${smooth.size} colours)`);
}

// sharing mask channels (more than 16 masks): masks whose areas in the rest pose overlap need channels of their
// own; the areas are boxes in model coordinates, also for parts in a warp grid (which the compiler holds in the
// grid's cell coordinates)
{
  const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
  const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
  const quad = (x, y, w, h) => ({ vertices: [x, y, x + w, y, x + w, y + h, x, y + h], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] });
  // 17 masks with their masked parts; place(i) gives each mask's spot; inWarp(i) puts mask i and its part in the grid
  const model = (place, inWarp = () => false) => {
    const parts = [];
    for (let i = 0; i < 17; i++) {
      const [x, y] = place(i), w = inWarp(i) ? { warp: 'grid' } : {};
      parts.push({ id: `m${i}`, maskOnly: true, solid: true, ...w, ...quad(x, y, 40, 40) });
      parts.push({ id: `p${i}`, mask: [`m${i}`], ...w, ...quad(x + 5, y + 5, 30, 30) });
    }
    return { format: 'ugo9', canvas: { width: 2000, height: 2000 }, textures: ['a.png'], bones: [{ id: 'root' }],
      warps: [{ id: 'grid', cols: 2, rows: 2, rect: [0, 0, 2000, 2000], bone: 'root' }], parts };
  };
  const err = (m) => { try { compileUgo(m); return null; } catch (e) { return e.code; } };
  const same = () => [100, 100];
  check(err(model(same)) === 'tooManyMasks', '17 masks in the same place, all on bones: tooManyMasks');
  check(err(model(same, (i) => i === 16)) === 'tooManyMasks', '17 masks in the same place, the 17th in a warp grid: tooManyMasks too (its area is its box in the model, not in the grid\'s cells)');
  check(err(model(same, () => true)) === 'tooManyMasks', '17 masks in the same place, all in a warp grid: tooManyMasks');
  // apart (a 5 x 4 field 400 px apart): they share one channel, on bones or in the grid alike
  const apart = (i) => [100 + 400 * (i % 5), 100 + 400 * Math.floor(i / 5)];
  const channels = (m) => rt.loadModel(compileUgo(m)).partData().masks.map((k) => k.channel);
  const onBones = channels(model(apart)), inGrid = channels(model(apart, (i) => i % 2 === 0));
  check(onBones.length === 17 && onBones.every((c) => c === 0) && inGrid.every((c) => c === 0),
    `17 masks far apart share a channel, on bones (${onBones.join('')}) and in a grid (${inGrid.join('')})`);
  // two overlapping groups apart from each other: channels as the boxes in the model say
  const groups = (i) => (i < 9 ? [100, 100] : [1500, 1500]);
  const g = channels(model(groups, (i) => i >= 9));
  check(g.slice(0, 9).join() === '0,1,2,3,4,5,6,7,8' && g.slice(9).join() === '0,1,2,3,4,5,6,7',
    `two groups (9 on bones, 8 in the grid) far apart: each group has channels of its own, the groups share them (${g.join(',')})`);
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all compile checks passed');
