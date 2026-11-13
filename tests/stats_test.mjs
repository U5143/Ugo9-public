// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// web model.stats() and inst.measure(): the counts agree with what the model has (also a 1.1 file's
// expanded keys), the bytes are there, and measuring gives finite times.
//   node tests/stats_test.mjs
import fs from 'node:fs';
import { UgoRuntime } from '../web/ugo.js';
import { build } from './v11/make_model.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const basicBytes = fs.readFileSync(new URL('../samples/basic/model.ug9', import.meta.url));
const basic = rt.loadModel(basicBytes), s = basic.stats();
check(s.parts === basic.partCount && s.vertices === basic.vertexCount && s.triangles * 3 === basic.indexCount && s.bones === basic.boneCount,
  `counts of parts, vertices, triangles and bones (${s.parts}, ${s.vertices}, ${s.triangles}, ${s.bones})`);
check(s.parameters === basic.params.length && s.animations === basic.animations.length && s.physics > 0, `parameters, animations and physics (${s.parameters}, ${s.animations}, ${s.physics})`);
check(s.bytes.file === basicBytes.length && s.bytes.model > 0 && s.bytes.instance > 0 && s.bytes.frame === 4 * basic.frameFloats, `bytes: file ${s.bytes.file}, model ${s.bytes.model}, instance ${s.bytes.instance}, frame ${s.bytes.frame}`);
const v11 = rt.loadModel(build().v11), t = v11.stats();
const keys = v11.animations.reduce((n, a) => n + v11.animationTracks(a.name).reduce((m, tr) => m + tr.keys.length, 0), 0);
check(t.keys === keys && t.tracks === 8 && t.bytes.model > rt.ex.ugo_model_mem_size(), `a 1.1 file counts its expanded keys (${t.keys}) and the memory they take (${t.bytes.model} bytes)`);
const inst = basic.createInstance();
const m = inst.measure(50, 0);
check(Number.isFinite(m.update) && Number.isFinite(m.total) && m.update >= 0 && m.total >= 0, `measure: update ${(m.update * 1000).toFixed(1)} µs, with an animation ${(m.total * 1000).toFixed(1)} µs`);

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all stats checks passed');
