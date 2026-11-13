// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The compiler's curve keys (format 1.1, tools/compile.mjs with tools/curve_keys.mjs):
// "bezier" keys become curves (tables 41-43) with the fewest pieces (smooth pieces among straight ones
// stay short straight keys, as in 0.7)
// within the tolerance; a model without curves stays 1.0; time handles outside the segment are kept
// inside with a warning; a curve too steep for the core's pieces becomes straight keys; curveKeys
// false writes 1.0 with each curve cut as the core cuts it (the same keys and the same picture).
//   node tests/compile_curves_test.mjs        (the pictures need build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileUgo, fewestPieces, curvePointsFast } from '../tools/compile.mjs';
import { readTables, readCurveTracks, curveAt, curvePoints } from '../tools/curve_keys.mjs';
import { readUg9Tables } from '../tools/import_ug9.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'compile_curves_test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const quad = { vertices: [-10, -10, 10, -10, 10, 10, -10, 10], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] };
const model = (tracks, bones) => ({
  format: 'ugo9', canvas: { width: 100, height: 100, originX: 50, originY: 50 }, textures: [],
  parameters: [{ id: 'A', min: 0, max: 1 }, { id: 'B', min: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'arm', parent: 'root', x: 10 }],
  parts: [{ id: 'p', bone: 'arm', ...quad }],
  animations: [{ id: 'go', duration: 2, tracks, ...(bones ? { bones } : {}) }],
});
const version = (buf) => { const t = readTables(buf); return `${t.major}.${t.minor}`; };

// a model without curves: 1.0
check(version(compileUgo(model({ A: [[0, 0, 'smooth'], [1, 1, 'smooth'], [2, 0]], B: [[0, 0], [2, 1]] }))) === '1.0', 'no curves (straight and eased tracks only): the file stays 1.0');
// a bezier key, and a smooth piece in a mixed track: 1.1 with one curve, the smooth piece straight keys
{
  const buf = compileUgo(model({ A: [[0, 0, 'bezier', 0.1, 0.9, 0.3, 1], [1, 1], [2, 0]], B: [[0, 0, 'smooth'], [1, 1], [2, 0.5]] }));
  const t = readUg9Tables(buf), cs = [...t.curves.values()];
  const tb = t.tracks.find((x) => (x.target >>> 24) === 0 && (x.target & 0xffffff) === 1);
  check(version(buf) === '1.1' && cs.length === 1 && tb.keyCount > 10, `a bezier key, and a smooth piece in a track with straight ones: 1.1 with ${cs.length} curve, B in ${tb.keyCount} straight keys`);
  const bz = cs[0];
  check(bz && bz.cx1 === Math.round(0.1 * 65535) && bz.cx2 === Math.round(0.3 * 65535) && bz.n >= 2, `the bezier: cx in 65535ths of the segment (${bz?.cx1}, ${bz?.cx2}), ${bz?.n} pieces`);
}
// handles outside the segment's time: kept inside, with a warning
{
  const warnings = [];
  const t = readUg9Tables(compileUgo(model({ A: [[0, 0, 'bezier', -0.2, 0, 1.4, 1], [2, 1]] }), { warnings }));
  const c = [...t.curves.values()][0];
  check(c && c.cx1 === 0 && c.cx2 === 65535 && warnings.some((w) => w.code === 'curveHandleClamped'), 'time handles outside the segment: kept inside (0..1), curveHandleClamped');
}
// a curve that leaves its keys' value and comes back is not a flat track
{
  const t = readUg9Tables(compileUgo(model({ A: [[0, 0.5, 'bezier', 0.3, 1, 0.7, 1], [2, 0.5]] })));
  const tr = t.tracks.find((x) => (x.target >>> 24) === 0 && (x.target & 0xffffff) === 0);
  check(tr && tr.keyCount === 2 && t.curves.size === 1 && tr.base + 65535 * tr.step > 0.74, 'a curve out and back (both keys 0.5): kept, the range widened to its handles');
}
// too steep for the core's pieces: straight keys, within the tolerance of the exact curve
{
  const warnings = [];
  const src = model({}, { arm: { rotate: [[0, 0, 'bezier', 0.001, 340, 0.999, 0], [0.04, 340], [2, 340]] } });
  const buf = compileUgo(src, { warnings }), t = readUg9Tables(buf);
  const info = warnings.find((w) => w.code === 'curveBaked');
  const tr = t.tracks.find((x) => (x.target >>> 24) === 1);
  check(info && info.level === 'info' && tr.keyCount > 10 && t.curves.size === 0, `a swing of 340° in 0.04 s with handles at its ends: written as ${tr?.keyCount} straight keys (curveBaked)`);
  // the exact curve (the JSON's: time handles as fractions of the segment, values in degrees) against the keys
  const a = t.animations[0], ks = t.keys.slice(tr.firstKey, tr.firstKey + tr.keyCount).map((k) => [k[0] * a.tick, Math.fround(tr.base + k[1] * Math.fround(tr.step)) * 180 / Math.PI]);
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const s = i / 2000, u = 1 - s, T = 0.04 * (3 * u * u * s * 0.001 + 3 * u * s * s * 0.999 + s * s * s), V = 3 * u * u * s * 340 + s * s * s * 340;
    let j = 0; while (j < ks.length - 2 && ks[j + 1][0] <= T) j++;
    const lin = ks[j + 1][0] > ks[j][0] ? ks[j][1] + (ks[j + 1][1] - ks[j][1]) * Math.min(1, Math.max(0, (T - ks[j][0]) / (ks[j + 1][0] - ks[j][0]))) : ks[j + 1][1];
    worst = Math.max(worst, Math.abs(lin - V));
  }
  // what one tick of time can hold: the curve's largest change within a tick (its start is nearly upright)
  let perTick = 0;
  for (let i = 0; i < 2000; i++) {
    const at = (s) => { const u = 1 - s; return [0.04 * (3 * u * u * s * 0.001 + 3 * u * s * s * 0.999 + s * s * s), 3 * u * u * s * 340 + s * s * s * 340]; };
    const [t0, v0] = at(i / 2000); let j = i; while (j < 2000 && at(j / 2000)[0] - t0 < a.tick) j++;
    perTick = Math.max(perTick, Math.abs(at(j / 2000)[1] - v0));
  }
  check(worst <= 0.05 + perTick, `the straight keys stay within ${worst.toFixed(3)}° of the exact curve: the 0.05° asked plus what the curve does within one tick (${perTick.toFixed(3)}°, at its upright start)`);
}
// curveKeys false: 1.0, the keys the core makes of the 1.1 file
{
  const src = model({ A: [[0, 0, 'bezier', 0.1, 0.9, 0.3, 1], [1, 1], [2, 0]] }, { arm: { rotate: [[0, 0, 'bezier', 0.5, 30, 0.6, 90], [2, 90]] } });
  const v11 = compileUgo(src), v10 = compileUgo(src, { curveKeys: false }), ex = readCurveTracks(v11), t10 = readUg9Tables(v10);
  check(version(v10) === '1.0' && JSON.stringify(ex.keys) === JSON.stringify(t10.keys) && JSON.stringify(ex.tracks.map((x) => x.slice(0, 3))) === JSON.stringify(t10.tracks.map((x) => [x.target, x.firstKey, x.keyCount])),
    'curveKeys false: a 1.0 file whose tracks and keys are those the core makes of the 1.1 file');
}
// the compiler's quicker ways give the same answer as the plain ones (so the same bytes): its curve points
// in plain numbers against curve_keys.mjs curvePoints (BigInt), and its choice of n against the plain search
// (the whole error, then doubling and halving) written out here
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const edge = () => [0, 1, 65534, 65535][int(0, 3)];
  let samePts = 0, ptsTried = 0;
  for (let r = 0; r < 4000; r++) {
    const t0 = r % 5 ? int(0, 65000) : edge(), t1 = Math.min(65535, t0 + (r % 7 ? int(1, 3000) : int(1, 65535)));
    const a = [t0, r % 3 ? int(0, 65535) : edge()], b = [t1, r % 3 ? int(0, 65535) : edge()];
    const c = { n: r % 4 ? int(2, 64) : [2, 63, 64, 65, 200, 256][int(0, 5)], cx1: r % 6 ? int(0, 65535) : edge(), cy1: r % 6 ? int(0, 65535) : edge(), cx2: r % 6 ? int(0, 65535) : edge(), cy2: r % 6 ? int(0, 65535) : edge() };
    ptsTried++;
    if (JSON.stringify(curvePointsFast(a, b, c)) === JSON.stringify(curvePoints(a, b, c))) samePts++;
  }
  // the largest numbers: the longest segment, the most pieces in plain numbers (64) and past them
  for (const n of [63, 64, 65, 128, 256]) for (let r = 0; r < 200; r++) {
    const a = [0, int(0, 65535)], b = [65535, int(0, 65535)], c = { n, cx1: int(0, 65535), cy1: int(0, 65535), cx2: int(0, 65535), cy2: int(0, 65535) };
    ptsTried++;
    if (JSON.stringify(curvePointsFast(a, b, c)) === JSON.stringify(curvePoints(a, b, c))) samePts++;
  }
  check(samePts === ptsTried, `the compiler's curve points in plain numbers: the same as curvePoints in ${samePts} of ${ptsTried} curves (n 2..256, keys and handles to the ends of 16 bits)`);
  const plainError = (A, B, h, n) => {
    const pts = [A, ...curvePoints(A, B, { ...h, n }), B], N = 16 * n;
    let worst = 0, i = 0;
    for (let k = 0; k <= N; k++) {
      const [t, v] = curveAt(A, B, h, k / N);
      while (i < pts.length - 2 && pts[i + 1][0] <= t) i++;
      const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
      worst = Math.max(worst, Math.abs((t1 > t0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : v1) - v));
    }
    return worst;
  };
  const plainFewest = (A, B, h, tol) => {
    let lo = 1, hi = 2;
    while (hi < 256 && plainError(A, B, h, hi) > tol) { lo = hi; hi = Math.min(256, hi * 2); }
    if (hi === 256 && plainError(A, B, h, 256) > tol) return { n: 256, ok: false };
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (plainError(A, B, h, m) <= tol) hi = m; else lo = m; }
    return { n: Math.max(2, hi), ok: true };
  };
  let sameN = 0, tried = 0, fails = 0;
  for (let r = 0; r < 600; r++) {
    // most like an import's curves (handles near the keys' values), some anywhere
    const t0 = int(0, 60000), A = [t0, int(0, 65535)], B = [t0 + int(r % 3 ? 50 : 2, 5000), r % 3 ? Math.min(65535, Math.max(0, A[1] + int(-8000, 8000))) : int(0, 65535)];
    const near = () => (r % 5 ? Math.min(65535, Math.max(0, int(Math.min(A[1], B[1]) - 3000, Math.max(A[1], B[1]) + 3000))) : int(0, 65535));
    const h = { cx1: int(0, 65535), cy1: near(), cx2: int(0, 65535), cy2: near() }, tol = [2, 8, 32, 128][r % 4];
    const want = plainFewest(A, B, h, tol), got = fewestPieces(A, B, h, tol), again = fewestPieces(A, B, h, tol);
    tried++; if (!want.ok) fails++;
    if (got.n === want.n && got.ok === want.ok && again.n === want.n) sameN++;
  }
  check(sameN === tried && fails > 0 && fails < tried / 2, `the compiler's choice of pieces: the same n as the plain search in ${sameN} of ${tried} curves (${fails} too steep for 256), asked twice`);
}

// the picture: 1.1 against curveKeys false, through ugo_export
let exe = null;
for (const p of ['build/ugo_export', 'build/Release/ugo_export.exe', 'build/ugo_export.exe']) if (fs.existsSync(path.join(ROOT, p))) { exe = path.join(ROOT, p); break; }
if (exe) {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/basic/model.json'), 'utf8'));
  const anim = src.animations[0], [pid] = Object.keys(src.parameters.reduce((m, p) => ({ ...m, [p.id]: 1 }), {}));
  anim.tracks = { ...(anim.tracks || {}), [pid]: [[0, src.parameters[0].min, 'bezier', 0.05, src.parameters[0].max, 0.2, src.parameters[0].max], [anim.duration, src.parameters[0].min]] };
  for (const tex of src.textures) fs.copyFileSync(path.join(ROOT, 'samples/basic', tex), path.join(OUT, tex));
  fs.writeFileSync(path.join(OUT, 'v11.ug9'), new Uint8Array(compileUgo(src)));
  fs.writeFileSync(path.join(OUT, 'v10.ug9'), new Uint8Array(compileUgo(src, { curveKeys: false })));
  const draw = (f) => { const out = path.join(OUT, `${f}.rgba`); execFileSync(exe, [path.join(OUT, `${f}.ug9`), '--anim', anim.id, '--frames', '6', '--fps', '3', '--size', '210x300', '--format', 'raw', '--out', out], { stdio: 'ignore' }); return fs.readFileSync(out); };
  check(version(fs.readFileSync(path.join(OUT, 'v11.ug9'))) === '1.1' && Buffer.compare(draw('v11'), draw('v10')) === 0, `the sample with a curve on ${pid}: ugo_export draws the 1.1 file and its 1.0 the same, byte for byte`);
} else console.log('skip the picture: build/ugo_export not built');

console.log(failures ? `\n${failures} check(s) failed` : '\nall compiler curve checks passed');
process.exit(failures ? 1 : 0);
