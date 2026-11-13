// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Spine -> Ugo9 import test with our own test rig (tests/spine/rig.*).
//   node tests/spine_test.mjs
// Expected positions are computed here, directly from the Spine JSON format's
// rules (bone hierarchy, weighted vertices, timelines relative to the setup
// pose), and compared with the imported model running in the Ugo9 core.
import fs from 'node:fs';
import { importSpine, parseAtlas } from '../tools/import_spine.mjs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const dir = new URL('./spine/', import.meta.url);
const skel = JSON.parse(fs.readFileSync(new URL('rig.json', dir), 'utf8'));
const atlasText = fs.readFileSync(new URL('rig.atlas', dir), 'utf8');

const { model, warnings } = importSpine(skel, atlasText);
console.log(`     warnings: ${warnings.length ? warnings.join(' / ') : 'none'}`);
check(warnings.length === 0, 'the test rig imports without warnings');

const wasm = fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url));
const rt = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const m = rt.loadModel(compileUgo(model));
const inst = m.createInstance();
const scratch = rt.alloc(8 * m.vertexCount);
const partOf = (id) => model.parts.findIndex((p) => p.id === id);
const firstVert = (pi) => model.parts.slice(0, pi).reduce((s, p) => s + p.vertices.length / 2, 0);
const pose = (t) => {
  inst.reset();
  if (t !== null) inst.play('wave', t);
  inst.update(0);
  rt.ex.ugo_deform_cpu(inst.ptr, scratch);
  const pos = Array.from(rt.f32(scratch, 2 * m.vertexCount));
  const op = Array.from(inst.frame().subarray(m.opacityOffset, m.opacityOffset + m.partCount));
  return { pos, op };
};

// ---- reference: Spine rules, y up --------------------------------------------------------
const D = Math.PI / 180;
const bezier = (p0, p1, p2, p3, s) => { const u = 1 - s; return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3; };
const bezierAtTime = (t0, v0, c, t1, v1, t) => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (bezier(t0, c[0], c[2], t1, mid) < t) lo = mid; else hi = mid; }
  return bezier(v0, c[1], c[3], v1, (lo + hi) / 2);
};
function spinePose(t) {
  const anim = skel.animations.wave;
  const bones = skel.bones.map((b) => ({ ...b, x: b.x || 0, y: b.y || 0, rotation: b.rotation || 0, scaleX: b.scaleX ?? 1, scaleY: b.scaleY ?? 1 }));
  if (t !== null) {
    const arm1 = bones[2], arm2 = bones[3];
    const rk = anim.bones.arm1.rotate;
    arm1.rotation += bezierAtTime(0, 0, rk[0].curve, 1, 90, t);
    arm2.x += 10 * Math.min(1, t); arm2.y += 5 * Math.min(1, t);
    const sx = t < 0.75 ? 1 : 2, sy = t < 0.75 ? 1 : 0.5;
    arm2.scaleX *= sx; arm2.scaleY *= sy;
  }
  const world = [];
  bones.forEach((b, i) => {
    const c = Math.cos(b.rotation * D), s = Math.sin(b.rotation * D);
    const L = [c * b.scaleX, s * b.scaleX, -s * b.scaleY, c * b.scaleY, b.x, b.y];
    const P = b.parent ? world[bones.findIndex((q) => q.name === b.parent)] : null;
    world[i] = P ? [P[0] * L[0] + P[2] * L[1], P[1] * L[0] + P[3] * L[1], P[0] * L[2] + P[2] * L[3], P[1] * L[2] + P[3] * L[3],
      P[0] * L[4] + P[2] * L[5] + P[4], P[1] * L[4] + P[3] * L[5] + P[5]] : L;
  });
  const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const att = skel.skins[0].attachments;
  // torso region (top-left, top-right, bottom-right, bottom-left of the image)
  const tr = att.torso.torso, rc = Math.cos(tr.rotation * D), rs = Math.sin(tr.rotation * D);
  const torso = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]].map(([fx, fy]) => {
    const lx = fx * tr.width * tr.scaleX, ly = fy * tr.height;
    return ap(world[1], tr.x + rc * lx - rs * ly, tr.y + rs * lx + rc * ly);
  });
  // weighted arm
  const v = att.arm.arm.vertices, arm = [];
  for (let o = 0; o < v.length;) {
    const n = v[o++];
    let x = 0, y = 0;
    for (let j = 0; j < n; j++, o += 4) { const [wx, wy] = ap(world[v[o]], v[o + 1], v[o + 2]); x += v[o + 3] * wx; y += v[o + 3] * wy; }
    arm.push([x, y]);
  }
  // flag with deform (offsets in the body bone's space, offset 2 = skip vertex 0)
  const fv = att.flag.flag.vertices, k = t === null ? 0 : Math.min(1, t);
  const d = [0, 0, 10, 0, 10, 5, 0, 5];
  const flag = [0, 1, 2, 3].map((i) => ap(world[1], fv[2 * i] + d[2 * i] * k, fv[2 * i + 1] + d[2 * i + 1] * k));
  const eyeClosed = t !== null && t >= 0.5 && t < 0.8;
  const flagAlpha = t === null ? 0.8 : 0.8 + (0.2 - 0.8) * Math.min(1, t);
  return { torso, arm, flag, eyeClosed, flagAlpha };
}

// ---- compare -------------------------------------------------------------------------------
function compare(t, label) {
  const got = pose(t), ref = spinePose(t);
  let max = 0;
  for (const [name, pts] of [['torso/torso', ref.torso], ['arm/arm', ref.arm], ['flag/flag', ref.flag]]) {
    const fvx = firstVert(partOf(name));
    pts.forEach(([x, y], i) => {
      // Ugo9 is y down
      max = Math.max(max, Math.abs(got.pos[2 * (fvx + i)] - x), Math.abs(got.pos[2 * (fvx + i) + 1] + y));
    });
  }
  // curves become straight pieces at 120 per second, and keys are thinned while each bone stays
  // within 0.05 px at its farthest vertex (a chain of bones can add up), so allow 0.1 px while animating
  const tol = t === null || t === 0 ? 0.01 : 0.1;
  check(max < tol, `${label}: vertex positions match the Spine rules (max error ${max.toExponential(1)} px)`);
  const eo = got.op[partOf('eye/eye-open')], ec = got.op[partOf('eye/eye-closed')];
  check(ref.eyeClosed ? eo === 0 && ec === 1 : eo === 1 && ec === 0, `${label}: eye attachment (${ref.eyeClosed ? 'closed' : 'open'})`);
  const fa = got.op[partOf('flag/flag')];
  check(Math.abs(fa - ref.flagAlpha) < 1e-3, `${label}: flag alpha ${fa.toFixed(3)} (expected ${ref.flagAlpha.toFixed(3)})`);
}
compare(null, 'setup pose');
// the animation loops, so its last moment is just before t = 1
for (const t of [0, 0.25, 0.5, 0.6, 0.75, 0.9, 0.999]) compare(t, `t = ${t}`);

// ---- atlas: stripped whitespace maps mesh UVs outside the packed rectangle --------------------
const pages = parseAtlas(atlasText);
const flagRegion = pages[0].regions.get('flag');
check(flagRegion.offX === 2 && flagRegion.offY === 3 && flagRegion.origW === 44 && flagRegion.origH === 36, 'atlas offsets parsed (4.x format)');
const flagPart = model.parts[partOf('flag/flag')];
// vertex 3 has uv (0, 0): the original image's top-left = page (186 - 2, 4 - (36 - 3 - 30))
check(Math.abs(flagPart.uvs[6] - 184 / 256) < 1e-6 && Math.abs(flagPart.uvs[7] - 1 / 128) < 1e-6, `stripped region UV (${(flagPart.uvs[6] * 256).toFixed(2)}, ${(flagPart.uvs[7] * 128).toFixed(2)}) px`);
const old = parseAtlas('rig.png\nsize: 256,128\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\narm\n  rotate: false\n  xy: 40, 0\n  size: 120, 20\n  orig: 120, 20\n  offset: 0, 0\n  index: -1\n');
const ar = old[0].regions.get('arm');
check(ar && ar.x === 40 && ar.w === 120 && ar.origW === 120, 'atlas in the 3.x format parsed');

// path and physics constraints are not read: the warnings name them and the bones they move
{
  const more = structuredClone(skel);
  more.path = [{ name: 'tail', bones: ['arm1', 'arm2'], target: 'flag' }];
  more.physics = [{ name: 'sway', bone: 'body' }];
  more.animations.wave.path = { tail: { position: [{ time: 0, position: 0.2 }] } };
  const w = importSpine(more, atlasText).warnings.join(' / ');
  check(/path constraint tail: not read; it moves bones arm1, arm2 along the path in slot flag/.test(w) && /physics constraint sway: not read; bone body does not sway/.test(w) && /animation wave: keys of the path constraint tail are not read/.test(w),
    'path and physics constraints: the warnings name each one and the bones it would move');
}

// a slot's alpha: a stepped key holds its value, a curve stays a curve (format 1.1) unless an attachment change cuts it
{
  const more = structuredClone(skel), sname = more.slots.find((s) => s.attachment).name;
  more.animations = { fade: { slots: { [sname]: { alpha: [{ time: 0, value: 1, curve: 'stepped' }, { time: 1, value: 0.2, curve: [1.2, 1, 1.8, 0.2] }, { time: 2, value: 0.6, curve: [2.1, 1, 2.9, 1] }, { time: 3, value: 1 }],
    attachment: [{ time: 2.5, name: null }] } } } };
  const mm = importSpine(more, atlasText).model, ks = Object.values(mm.animations[0].opacity)[0];
  const at = (t) => ks.filter((k) => k[0] === t);
  check(at(1).length === 2 && at(1)[0][1] === 1 && at(1)[1][1] === 0.2, `stepped alpha: held at 1 up to 1 s, then 0.2 (${JSON.stringify(at(1).map((k) => k[1]))})`);
  check(at(1)[1][2] === 'bezier' && Math.abs(at(1)[1][3] - 0.2) < 1e-9 && at(1)[1][4] === 1 && Math.abs(at(1)[1][5] - 0.8) < 1e-9 && at(1)[1][6] === 0.2, 'an alpha curve: a bezier key with its handles');
  check(!ks.some((k) => k[0] >= 2 && k[2] === 'bezier') && ks.filter((k) => k[0] > 2 && k[0] < 2.5).length > 10, 'an alpha curve cut by an attachment change: straight pieces');
}

// rotation keys more than 180° apart: 3.x turns the short way (keys moved by whole turns), 4.x keeps them
for (const ver of ['3.8.95', '4.1.00']) {
  const more = structuredClone(skel), bone = more.bones[1].name;
  more.skeleton = { ...(more.skeleton || {}), spine: ver };
  more.animations = { spin: { bones: { [bone]: { rotate: [{ time: 0, [ver[0] === '3' ? 'angle' : 'value']: 170 }, { time: 0.5, [ver[0] === '3' ? 'angle' : 'value']: -170 }, { time: 1, [ver[0] === '3' ? 'angle' : 'value']: 175 }] } } } };
  const r = importSpine(more, atlasText), ks = r.model.animations[0].bones[bone].rotate.map((k) => -k[1]);
  const w = r.warnings.join(' / ');
  if (ver[0] === '3') check(ks.join() === '170,190,175' && /1 rotation key\(s\) more than 180° from the key before: turned the short way/.test(w), `Spine ${ver}: 170 → -170 → 175 turns the short way (${ks.join(', ')})`);
  else check(ks.join() === '170,-170,175' && /2 rotation key\(s\) more than 180° from the key before: kept as they are/.test(w), `Spine ${ver}: the keys kept as they are, with a word (${ks.join(', ')})`);
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all Spine import checks passed');
