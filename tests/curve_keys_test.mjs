// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Format 1.1 curve keys (tables 41-43): the core expands them at load into the same keys as
// tools/curve_keys.mjs, plays them along the Bezier curve, needs the memory ugo_model_mem_size_for
// says, reads a 1.1 file without curves as its 1.0 twin, and refuses broken tables.
//   node tests/curve_keys_test.mjs
import fs from 'node:fs';
import { UgoRuntime } from '../web/ugo.js';
import { build, SOURCE } from './v11/make_model.mjs';
import { curveAt, curveError, curvePieces, curvePoints, expandTracks, readCurveTracks, readTables, toCurveFile, writeTables } from '../tools/curve_keys.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);
const ex = rt.ex;

const { v10, v11 } = build();
const stored = fs.readFileSync(new URL('./v11/model.ug9', import.meta.url));
check(Buffer.compare(Buffer.from(v11), stored) === 0, 'tests/v11/model.ug9 is what tests/v11/make_model.mjs makes (run it again after changing either)');

// ---- loading: memory, version ----
const put = (bytes) => { const p = rt.alloc(bytes.byteLength); rt.u8(p, bytes.byteLength).set(new Uint8Array(bytes)); return p; };
{
  const d = put(v11), need = ex.ugo_model_mem_size_for(d, v11.byteLength), base = ex.ugo_model_mem_size();
  check(need > base && need % 16 === 0, `a 1.1 file with curves needs more than ugo_model_mem_size (${need} bytes, ${base} for a 1.0 file)`);
  check(!ex.ugo_model_init(rt.alloc(base), d, v11.byteLength) && ex.ugo_last_error() === 1, 'ugo_model_init (the 1.0 size) refuses it with UGO_ERR_SIZE');
  check(ex.ugo_model_init_sized(rt.alloc(need), need, d, v11.byteLength) !== 0, 'ugo_model_init_sized with that much reads it');
  // ugo_model_mem_size_for also has room for the animations' track runs (optional: less plays them one by one);
  // the expanded tracks and keys are not optional: 16 bytes short of the least that loads is refused
  let least = base;
  const mem = rt.alloc(need);
  while (least < need && !ex.ugo_model_init_sized(mem, least, d, v11.byteLength)) least += 16;
  check(least > base && least < need && !ex.ugo_model_init_sized(mem, least - 16, d, v11.byteLength) && ex.ugo_last_error() === 1,
    `the expanded tracks and keys must fit (${least - 16} bytes refused, ${least} read), the track runs may not (${need} with them)`);
  const d10 = put(v10), need10 = ex.ugo_model_mem_size_for(d10, v10.byteLength);
  check(need10 >= base && ex.ugo_model_init(rt.alloc(base), d10, v10.byteLength) !== 0, `a 1.0 file loads with just ugo_model_mem_size (${base}; ${need10} with the track runs)`);
  check(ex.ugo_model_mem_size_for(d10, v10.byteLength - 4) === 0 && ex.ugo_last_error() === 1, 'ugo_model_mem_size_for is 0 for a broken file (and says why)');
  check(ex.ugo_version() === 0x10001, 'the core reads 1.1');
}
const m11 = rt.loadModel(v11), m10 = rt.loadModel(v10);
check(m11.format.major === 1 && m11.format.minor === 1 && m11.warnings === 0, `the file is 1.1 and nothing was skipped (${m11.format.major}.${m11.format.minor})`);
{
  const t = readTables(v11);
  check([41, 42, 43].every((k) => t.tables.has(k) && (t.tables.get(k).flags & 3) === 2) && !t.tables.has(21) && !t.tables.has(22),
    'tables 41-43 are marked 2 (a 1.0 core refuses the file, and asks for a newer player) and 21-22 are gone');
}

// ---- playing: the core's keys are the JS expansion's ----
const exp = readCurveTracks(v11);
const tables = readTables(v11), adv = new DataView(tables.tables.get(20).bytes.buffer);
const anims = Array.from({ length: tables.tables.get(20).count }, (_, i) => ({ firstTrack: adv.getUint32(24 * i + 12, true), trackCount: adv.getUint32(24 * i + 16, true), tick: adv.getFloat32(24 * i + 20, true) }));
const sample = ([target, k0, n, base, step], ticks) => { // sample_track in core/src/ugo.c
  if (n === 1) return base;
  const ks = exp.keys.slice(k0, k0 + n), val = (k) => base + k[1] * step;
  if (ticks >= ks[n - 1][0]) return val(ks[n - 1]);
  if (ks[0][0] > Math.floor(ticks)) return val(ks[0]);
  let i = 0;
  while (i < n - 2 && ks[i + 1][0] <= Math.floor(ticks)) i++;
  const span = ks[i + 1][0] - ks[i][0];
  if (span <= 0) return val(ks[i]);
  let f = (ticks - ks[i][0]) / span;
  if (target >>> 31) f = f * f * (3 - 2 * f);
  return val(ks[i]) + (val(ks[i + 1]) - val(ks[i])) * f;
};
const paramIds = SOURCE.parameters.map((p) => p.id);
{
  let worst = 0, worst10 = 0, count = 0;
  for (const [ai, a] of anims.entries()) {
    const dur = SOURCE.animations[ai].duration;
    for (let s = 0; s < dur; s += dur / 997) {
      const i11 = m11.createInstance(), i10 = m10.createInstance();
      i11.play(ai, s); i10.play(ai, s);
      for (let ti = a.firstTrack; ti < a.firstTrack + a.trackCount; ti++) {
        const tr = exp.tracks[ti], kind = (tr[0] >>> 24) & 0x7f, idx = tr[0] & 0xffffff;
        if (kind !== 0) continue;
        const p = SOURCE.parameters[idx], want = Math.min(p.max, Math.max(p.min, sample(tr, s / a.tick)));
        worst = Math.max(worst, Math.abs(i11.get(idx) - want) / (p.max - p.min));
        count++;
      }
      if (ai === 1) for (const id of paramIds) worst10 = Math.max(worst10, Math.abs(i11.get(id) - i10.get(id)));
    }
  }
  check(worst < 2e-6, `the core plays the keys tools/curve_keys.mjs expands (${count} samples, worst ${worst.toExponential(2)} of the range)`);
  check(worst10 === 0, `an animation without curves plays exactly as in its 1.0 file (worst ${worst10})`);
}
{ // the curves themselves: A's first segment eases in and out along its Bezier, within the pieces' error
  const i11 = m11.createInstance(), i10 = m10.createInstance();
  const c = { n: 16, cx1: 27525, cy1: 0, cx2: 38010, cy2: 65535 }, a = [0, 0], b = [32767.5, 65535];
  let worst = 0, apart = 0;
  for (let k = 1; k < 200; k++) {
    const [t, v] = curveAt(a, b, c, k / 200), sec = t / 65535 * 2;
    i11.play('wave', sec); i10.play('wave', sec);
    worst = Math.max(worst, Math.abs(i11.get('A') - v / 65535));
    apart = Math.max(apart, Math.abs(i10.get('A') - v / 65535));
  }
  const err = curveError([0, 0], [32768, 65535], c) / 65535;
  check(worst < err + 2e-4 && apart > 0.05, `parameter A follows its curve (worst ${worst.toFixed(5)}, the pieces' own error ${err.toFixed(5)}; the 1.0 file's straight line is ${apart.toFixed(3)} off)`);
  // the arm's 256 pieces
  i11.play('wave', 1.5); i11.update(0);
  const w = i11.boneWorld(1), rot = Math.atan2(w[1], w[0]) * 180 / Math.PI;
  const tr = exp.tracks.find((t) => t[0] === 0x1000001), want = sample(tr, 1.5 / anims[0].tick) * 180 / Math.PI;
  check(Math.abs(rot - want) < 1e-3, `a bone's rotation plays its curve of 256 pieces (${rot.toFixed(4)}°, expected ${want.toFixed(4)}°)`);
}

// ---- the expansion itself ----
{
  const pts = curvePoints([0, 0], [100, 65535], { n: 4, cx1: 21845, cy1: 21845, cx2: 43690, cy2: 43690 });
  check(JSON.stringify(pts) === JSON.stringify([[25, 16384], [50, 32768], [75, 49151]]), `a straight Bezier gives evenly spaced points, rounded half up (${JSON.stringify(pts)})`);
  const close = curvePoints([0, 0], [3, 65535], { n: 16, cx1: 0, cy1: 0, cx2: 65535, cy2: 65535 });
  check(close.length === 2 && close.every(([t], i) => t > (close[i - 1]?.[0] ?? 0) && t < 3), `points on the same tick as the one before, or on the segment's end, are dropped (${close.length} of 15 kept)`);
  check(curvePieces([0, 0], [1000, 65535], { cx1: 21845, cy1: 21845, cx2: 43690, cy2: 43690 }) === 2, 'a curve that is a straight line needs the fewest pieces (2)');
  const bent = { cx1: 32768, cy1: 65535, cx2: 32768, cy2: 0 }, n = curvePieces([0, 0], [30000, 65535], bent, 8);
  check(n > 8 && n < 256 && curveError([0, 0], [30000, 65535], { ...bent, n }) <= 8, `a bent curve gets the pieces it needs for the tolerance (${n} for 8 units)`);
  const back = expandTracks([{ target: 0, base: 0, step: 1 }], [2, 0, (100 | (65535 << 16)) >>> 0], [{ key: 1, n: 4, cx1: 21845, cy1: 21845, cx2: 43690, cy2: 43690, reserved: 0 }]);
  check(back.keys.length === 5 && back.tracks[0][2] === 5, 'expandTracks puts a curve\'s points between its keys');
  const plain = toCurveFile(v10), mp = rt.loadModel(plain);
  let same = true;
  for (let s = 0; s < 2; s += 0.013) { const x = mp.createInstance(), y = m10.createInstance(); x.play(0, s); y.play(0, s); same &&= paramIds.every((id) => x.get(id) === y.get(id)); }
  check(mp.format.minor === 1 && same, 'a 1.1 file without curves plays exactly as its 1.0 twin');
}

// ---- broken tables are refused ----
const errorOf = (bytes) => { try { rt.loadModel(bytes); return 0; } catch (e) { return Number(/error (\d+)/.exec(e.message)?.[1] ?? -1); } };
const mutate = (f) => { const t = readTables(v11); f(t.tables); return writeTables(t); };
const curveTable = (tables) => new DataView(tables.get(43).bytes.buffer);
const cases = [
  ['a curve on a count word', 6, (t) => curveTable(t).setUint32(0, 0, true)],
  ['a curve on a track\'s last key', 6, (t) => { const w = new Uint32Array(t.get(42).bytes.buffer); curveTable(t).setUint32(0, 1 + w[0] - 1, true); }],
  ['curves out of order', 6, (t) => { const d = curveTable(t), a = d.getUint32(0, true); d.setUint32(0, d.getUint32(16, true), true); d.setUint32(16, a, true); }],
  ['a curve of 1 piece', 7, (t) => curveTable(t).setUint16(4, 1, true)],
  ['a curve of 257 pieces', 7, (t) => curveTable(t).setUint16(4, 257, true)],
  ['a curve whose reserved field is not 0', 7, (t) => curveTable(t).setUint16(14, 1, true)],
  ['a key count of 1', 6, (t) => { new Uint32Array(t.get(42).bytes.buffer)[0] = 1; }],
  ['a key count past the table', 6, (t) => { new Uint32Array(t.get(42).bytes.buffer)[0] = 1e6; }],
  ['words left over', 7, (t) => { const k = t.get(42); const b = new Uint8Array(k.bytes.length + 4); b.set(k.bytes); b.set([2, 0, 0, 0], k.bytes.length); t.set(42, { ...k, bytes: b, count: k.count + 1 }); }],
  ['tables 41 and 21 both', 7, (t) => t.set(21, { bytes: new Uint8Array(20), count: 1, recSize: 20, flags: 2 })],
  ['curves without tracks', 7, (t) => { t.delete(41); t.delete(42); }],
  ['a curve on a smooth track', 7, (t) => { const d = new DataView(t.get(41).bytes.buffer); d.setUint32(12, (d.getUint32(12, true) | 0x80000000) >>> 0, true); }],
  ['a curved segment whose keys go back in time', 7, (t) => { const k = curveTable(t).getUint32(0, true), w = new Uint32Array(t.get(42).bytes.buffer); w[k + 1] = (w[k + 1] & 0xffff0000) | 0; w[k] = (w[k] & 0xffff0000) | 500; }],
];
for (const [what, code, f] of cases) { const got = errorOf(mutate(f)); check(got === code, `${what}: refused (error ${got}, expected ${code})`); }
check(errorOf(mutate(() => {})) === 0, 'the same file rewritten unchanged still loads');

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all curve key checks passed');
