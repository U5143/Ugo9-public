// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The core gives the same bits on every machine: the same run of every sample and test model (every
// animation with a second one mixed in, parameters moving, wind, physics, chains, constraints, draw order)
// in native C (tests/frames_dump.c, built here with cc, with this machine's SIMD (core/src/ugo_simd.h) and without:
// UGO_NO_SIMD) and in WebAssembly (web/ugo.wasm, and web/ugo_simd.wasm with WebAssembly SIMD) must write the same
// frame blocks and draw orders, byte for byte. Skipped (not failed) when there is no C compiler.
//   node tests/determinism_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UgoRuntime } from '../web/ugo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = ['samples/basic/model.ug9', 'tests/pose/rig.ug9', 'tests/warp/model.ug9', 'tests/order/model.ug9', 'tests/future/model.ug9', 'tests/v11/model.ug9']
  .map((p) => path.join(root, p)).filter((p) => fs.existsSync(p));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo-det-'));
const natives = [];
for (const [name, defs] of [['native C', []], ['native C without SIMD', ['-DUGO_NO_SIMD']]]) {
  const exe = path.join(dir, `frames_dump${natives.length}`), bin = path.join(dir, `native${natives.length}.bin`);
  try {
    execFileSync(process.env.CC || 'cc', ['-std=c99', '-O2', ...defs, '-I', path.join(root, 'core/include'), ...fs.readdirSync(path.join(root, 'core/src')).filter((f) => f.endsWith('.c')).map((f) => path.join(root, 'core/src', f)),
      path.join(root, 'tests/frames_dump.c'), '-lm', '-o', exe], { stdio: 'pipe' });
  } catch (e) {
    console.log(`skipped: no C compiler (${String(e.message).split('\n')[0]})`);
    process.exit(0);
  }
  execFileSync(exe, [bin, ...models]);
  natives.push([name, fs.readFileSync(bin)]);
}

function runWasm(file) {
const rt = new UgoRuntime(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(root, file))), {}).exports);
const ex = rt.ex, chunks = [];
for (const file of models) {
  const m = rt.loadModel(fs.readFileSync(file)), inst = m.createInstance(), na = m.animations.length;
  inst.setWind(250, -40, 1.25);
  const f32 = (x) => Math.fround(x);
  for (let a = 0; a < (na || 1); a++) for (let i = 0; i < 60; i++) {
    inst.reset();
    // as C: min + ((max - min) * k) / 19, each step in float
    m.params.forEach((p, k) => { if (k % 3 === Math.floor(i / 20) % 3) inst.set(k, f32(p.min + f32(f32(f32(p.max - p.min) * (i % 20)) / 19))); });
    if (na) { inst.play(a, f32(i / 30), 1); if (i % 3 === 0) inst.play((a + 1) % na, f32(i / 20), f32(0.4)); }
    inst.setTransform(1, 0, 0, 1, f32((i % 7) * 3), 0);
    inst.update(f32(1 / 30));
    chunks.push(Buffer.from(new Uint8Array(inst.frame().buffer, inst.frame().byteOffset, 4 * m.frameFloats)));
    chunks.push(Buffer.from(new Uint8Array(rt.u32(ex.ugo_draw_order(inst.ptr), m.partCount).slice().buffer)));
  }
}
return Buffer.concat(chunks);
}
fs.rmSync(dir, { recursive: true, force: true });
const native = natives[0][1];
let failures = 0;
const builds = [...natives.slice(1), ['WebAssembly', runWasm('web/ugo.wasm')], ['WebAssembly SIMD', runWasm('web/ugo_simd.wasm')]];
for (const [name, out] of builds) {
  let first = -1;
  for (let k = 0; k < Math.min(native.length, out.length); k++) if (native[k] !== out[k]) { first = k; break; }
  const ok = native.length === out.length && first < 0;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} native C and ${name} write the same ${native.length} bytes for ${models.length} models${ok ? '' : ` (first difference at byte ${first}; lengths ${native.length} / ${out.length})`}`);
}
if (failures) process.exit(1);
console.log('all determinism checks passed');
