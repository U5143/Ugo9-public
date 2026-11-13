// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// docs/芯のAPI.md lists every C function (UGO_API in core/include) and every Web class and method (web/ugo.js
// exports): a new one must be added to the list.
//   node tests/api_doc_test.mjs
import fs from 'node:fs';
import * as web from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const doc = fs.readFileSync(new URL('../docs/芯のAPI.md', import.meta.url), 'utf8');
const headers = ['ugo.h', 'ugo_raster.h'].map((f) => fs.readFileSync(new URL(`../core/include/${f}`, import.meta.url), 'utf8')).join('\n');
const cNames = [...new Set([...headers.matchAll(/UGO_API[^;(]*?\b(ugo_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]))];
const cMissing = cNames.filter((n) => !doc.includes(`\`${n}`) && !doc.includes(`・\`${n}`) && !new RegExp(`\\b${n}\\b`).test(doc));
check(cNames.length > 100 && cMissing.length === 0, `every C function is listed (${cNames.length}${cMissing.length ? `; missing: ${cMissing.join(', ')}` : ''})`);

// internal helpers of the Web classes, not for callers
const INTERNAL = new Set(['UgoRuntime.f32', 'UgoRuntime.u32', 'UgoRuntime.u8', 'UgoRuntime.u16', 'UgoRuntime.str', 'UgoRuntime.alloc', 'UgoAnimator.entry', 'UgoAnimator.layer',
  'UgoAnimator.start', 'UgoBlink.random01', 'UgoFrames.step', 'UgoRenderer.ensureFrameCapacity', 'UgoRenderer.ensureMasks', 'UgoRenderer.setUniforms', 'UgoRenderer.applySampling', 'UgoRenderer.setBlend']);
const webMissing = [];
for (const [name, v] of Object.entries(web)) {
  if (!doc.includes(name)) webMissing.push(name);
  if (typeof v !== 'function' || !v.prototype) continue;
  for (const m of Object.getOwnPropertyNames(v.prototype)) {
    if (m === 'constructor' || INTERNAL.has(`${name}.${m}`)) continue;
    if (!new RegExp(`\\b${m}\\b`).test(doc)) webMissing.push(`${name}.${m}`);
  }
}
check(webMissing.length === 0, `every Web export and method is listed${webMissing.length ? ` (missing: ${webMissing.join(', ')})` : ''}`);

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all API doc checks passed');
