// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// How heavy a model is (tools/model_info.mjs, 機能の比べ #8): the counts are model.stats()'s; the draws break at each
// texture page, blend and mask in drawing order; the texture bytes from the pages' sizes; the drawn area against the
// canvas; the heaviest parts; the command line from a .ug9 and from a working JSON says the same.
//   node tests/model_info_test.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { modelInfo, formatInfo } from '../tools/model_info.mjs';
import { UgoRuntime } from '../web/ugo.js';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const wasm = fs.readFileSync('web/ugo.wasm'), runtime = new UgoRuntime((await WebAssembly.instantiate(wasm, {})).instance.exports);
const json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8')), bytes = fs.readFileSync('samples/basic/model.ug9');
const r = await modelInfo(bytes, json, { runtime, textureSizes: [[1024, 1024]] });
check(JSON.stringify(r.stats) === JSON.stringify(runtime.loadModel(bytes).stats()), 'the counts and bytes are model.stats()\'s');
const masked = json.parts.filter((p) => p.mask && !p.maskOnly).length;
check(r.draws === 1 + r.breaks.texture + r.breaks.blend + r.breaks.mask && r.breaks.mask === 2 * masked && r.breaks.texture === 0, `draws ${r.draws}: one page, each of the ${masked} masked parts on its own`);
check(r.textureBytes === 1024 * 1024 * 4 && r.mipmapBytes === Math.round((1024 * 1024 * 4 * 4) / 3), 'texture bytes: 4 MB, with mipmaps 4/3 of it');
check(r.area.ratio > 0.5 && r.area.ratio < 3 && r.area.canvas === json.canvas.width * json.canvas.height, `drawn area ${r.area.ratio} × the canvas`);
check(r.heaviest.vertices[0][1] === Math.max(...json.parts.map((p) => p.vertices.length / 2)) && r.heaviest.morphs.length > 0, `the heaviest: ${r.heaviest.vertices[0].join(' ')}`);
// a second page, a blend: more draws
const two = structuredClone(json);
two.textures.push('atlas2.png'); two.parts[3].texture = 1; two.parts[11].blend = 'add'; // hairSideL: not masked
const r2 = await modelInfo(new Uint8Array(compileUgo(two, { warnings: [] })), two, { runtime });
check(r2.breaks.texture >= 2 && r2.breaks.blend >= 1 && r2.draws > r.draws, `another page and an added blend: ${r.draws} → ${r2.draws} draws`);
check(/draws \(estimated\): \d+/.test(formatInfo(r)) && /atlas.png 1024×1024/.test(formatInfo(r)), 'the text');
const a = execFileSync('node', ['tools/model_info.mjs', 'samples/basic/model.ug9'], { encoding: 'utf8' }), b = execFileSync('node', ['tools/model_info.mjs', 'samples/basic/model.json'], { encoding: 'utf8' });
check(a === b && /textures: atlas.png 1024×1024/.test(a), 'command line: the same from the .ug9 and the working JSON (the page size from the PNG)');

console.log(failures ? `\n${failures} check(s) failed` : '\nall model info checks passed');
process.exit(failures ? 1 : 0);
