// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Broken and hostile files through the WebAssembly core, not at random but every case in turn: the file cut
// at every 4-byte boundary, every 32-bit word set to 0, 1, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000 and a NaN,
// and every table-of-contents entry given a huge count, a count one too many, an offset past the end, a
// wrong record size, kind 0 and a known kind twice. Each file must be refused (an error code, no trap) or
// load and then play, update, deform, pick and read tracks without trapping and with a finite frame.
// (tests/test_core.c runs random corruptions natively under ASan and UBSan; this is the systematic twin.)
//   node tests/hostile_file_test.mjs
import fs from 'node:fs';

const files = ['tests/v11/model.ug9', 'tests/order/model.ug9', 'tests/future/model.ug9', 'tests/pose/rig.ug9', 'tests/warp/model.ug9', 'samples/basic/model.ug9'];
const { instance } = await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {});
const ex = instance.exports;
const mem = () => ex.memory.buffer;

let failures = 0, refused = 0, loaded = 0, total = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// one file: load it and, if it loads, work it; returns a problem as text, or ''
function tryFile(bytes) {
  const mark = ex.ugo_wasm_mark();
  try {
    const n = bytes.length, data = ex.ugo_wasm_alloc(n + 4);
    new Uint8Array(mem(), data, n).set(bytes);
    const need = ex.ugo_model_mem_size_for(data, n);
    if (!need) { refused++; return ex.ugo_last_error() > 0 ? '' : 'mem_size_for gave 0 without an error'; }
    const m = ex.ugo_model_init_sized(ex.ugo_wasm_alloc(need), need, data, n);
    if (!m) { refused++; return ex.ugo_last_error() > 0 ? '' : 'refused without an error'; }
    loaded++;
    const inst = ex.ugo_instance_init(ex.ugo_wasm_alloc(ex.ugo_instance_mem_size(m)), m);
    const nv = ex.ugo_vertex_count(m), deformed = ex.ugo_wasm_alloc(8 * nv + 8), box = ex.ugo_wasm_alloc(16), info = ex.ugo_wasm_alloc(16);
    const na = ex.ugo_animation_count(m), np = ex.ugo_param_count(m);
    ex.ugo_set_wind(inst, 100, 0, 1);
    for (let step = 0; step < 3; step++) {
      ex.ugo_reset_params(inst);
      for (let p = 0; p < np; p++) ex.ugo_set_param(inst, p, step === 1 ? 1e30 : step === 2 ? -1e30 : 0.5);
      for (let a = 0; a < na; a++) { ex.ugo_apply_animation(inst, a, 0.37 * (step + 1), 1); ex.ugo_apply_animation_ex(inst, a, 1.9, 0.5, 1, 0); }
      for (let e = 0; e < ex.ugo_expression_count(m); e++) ex.ugo_apply_expression(inst, e, 0.6);
      ex.ugo_update(inst, step === 2 ? 0.25 : 1 / 60);
    }
    const nf = ex.ugo_frame_float_count(m), frame = new Float32Array(mem(), ex.ugo_frame(inst), nf);
    if (!frame.every(Number.isFinite)) return 'a frame value is not finite';
    ex.ugo_deform_cpu(inst, deformed);
    ex.ugo_pick_part(inst, deformed, 3, -7, 0);
    ex.ugo_bounds(inst, deformed, -1, box);
    for (let a = 0; a < na; a++) for (let k = 0; k < ex.ugo_animation_track_count(m, a); k++) { ex.ugo_animation_track(m, a, k, info); ex.ugo_animation_track_value(m, a, k, 0.5); }
    return '';
  } catch (e) {
    return `trapped: ${e.message}`;
  } finally {
    ex.ugo_wasm_release(mark);
    total++;
  }
}

for (const file of files) {
  const orig = new Uint8Array(fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  const words = orig.length >> 2, problems = [];
  const run = (what, bytes) => { const p = tryFile(bytes); if (p && problems.length < 5) problems.push(`${what}: ${p}`); };
  const before = { refused, loaded, total };
  run('the file itself', orig);
  for (let cut = 0; cut < orig.length; cut += 4) run(`cut at ${cut}`, orig.slice(0, cut));
  const VALUES = [0, 1, 0xffffffff, 0x7fffffff, 0x80000000, 0x7fc00000];
  for (let w = 0; w < words; w++) for (const v of VALUES) {
    const b = orig.slice();
    new DataView(b.buffer).setUint32(4 * w, v, true);
    run(`word ${w} = 0x${v.toString(16)}`, b);
  }
  const dv = new DataView(orig.buffer), hs = dv.getUint32(12, true), nt = dv.getUint32(32, true);
  for (let e = 0; e < nt; e++) {
    const at = hs + 16 * e, edits = [[8, 0xffffffff], [8, dv.getUint32(at + 8, true) + 1], [4, orig.length], [4, 0xfffffffc], [12, (dv.getUint32(at + 12, true) & 0xffff0000) | ((dv.getUint32(at + 12, true) + 1) & 0xffff)], [0, 0], [0, dv.getUint32(hs, true)]];
    for (const [off, v] of edits) { const b = orig.slice(); new DataView(b.buffer).setUint32(at + off, v >>> 0, true); run(`contents entry ${e} +${off} = ${v >>> 0}`, b); }
  }
  check(problems.length === 0, `${file}: ${total - before.total} broken files, ${refused - before.refused} refused, ${loaded - before.loaded} loaded and worked${problems.length ? ` — ${problems.join('; ')}` : ''}`);
}
console.log(`${total} files in all`);
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all hostile file checks passed');
