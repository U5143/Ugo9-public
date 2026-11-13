// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Validates a .glb with the official Khronos glTF-Validator (npm gltf-validator).
//   node tests/gltf/validate.mjs build/gltf/basic.glb
import fs from 'node:fs';
import { createRequire } from 'node:module';
const validator = createRequire(import.meta.url)('gltf-validator');
const file = process.argv[2];
const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(file)));
const { numErrors, numWarnings, numInfos, numHints, messages } = report.issues;
console.log(JSON.stringify({ numErrors, numWarnings, numInfos, numHints }));
const seen = new Map();
for (const m of messages) { const k = `${['ERROR','WARNING','INFO','HINT'][m.severity]} ${m.code}`; if (!seen.has(k)) seen.set(k, { n: 0, ex: m }); seen.get(k).n++; }
for (const [k, v] of seen) console.log(`${k} x${v.n}: ${v.ex.message} (${v.ex.pointer || ''})`);
console.log('info:', JSON.stringify(report.info));
