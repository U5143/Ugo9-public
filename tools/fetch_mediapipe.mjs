// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// MediaPipe for the VTuber page's face tracking, kept on this PC, so the page works without the internet:
//
//   node tools/fetch_mediapipe.mjs [--out web/vendor/mediapipe]
//
// Downloads MediaPipe Tasks Vision 0.10.14 (the script and both WebAssembly builds, with and without SIMD) and
// the face model once, checks each against its known SHA-256, and writes them with the Apache-2.0 text and a
// NOTICE. web/vendor/ is not committed (git ignores it; about 22 MB). web/tracking.js uses web/vendor/mediapipe/
// when it is there, else the same files from cdn.jsdelivr.net and Google's storage. The script is stored as
// vision_bundle.js (it is a module either way) so hosts that only take common types take it too.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MEDIAPIPE_VERSION = '0.10.14';
const NPM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// where from, where to (in the folder), and what it must be
export const FILES = [
  [`${NPM}/vision_bundle.mjs`, 'vision_bundle.js', 'e77f281f9619150d937023c355bae170e9120e3b9e43f1e23a2a7bee07197669'],
  [`${NPM}/wasm/vision_wasm_internal.js`, 'wasm/vision_wasm_internal.js', '9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c'],
  [`${NPM}/wasm/vision_wasm_internal.wasm`, 'wasm/vision_wasm_internal.wasm', 'f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc'],
  [`${NPM}/wasm/vision_wasm_nosimd_internal.js`, 'wasm/vision_wasm_nosimd_internal.js', 'abe9b6fbeaf86fcb53a5edce3926c82ccb0619e18fed4d9d9ce561ee7f55e054'],
  [`${NPM}/wasm/vision_wasm_nosimd_internal.wasm`, 'wasm/vision_wasm_nosimd_internal.wasm', '38b61feab2fd7934e05cbe9f68baa308978a5e3b7f85c1913bb8ae89b8ef8b97'],
  [MODEL, 'face_landmarker.task', '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'],
];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Writes the files into `out` (those already there and right are kept). Returns [{ name, bytes, fetched }]. */
export async function fetchMediapipe({ out = path.join(root, 'web', 'vendor', 'mediapipe') } = {}) {
  const done = [];
  for (const [url, name, want] of FILES) {
    const file = path.join(out, name);
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) === want) { done.push({ name, bytes: fs.statSync(file).size, fetched: false }); continue; }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = sha(buf);
    if (got !== want) throw new Error(`${url}: unexpected contents (sha256 ${got})`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    done.push({ name, bytes: buf.length, fetched: true });
  }
  fs.copyFileSync(path.join(root, 'LICENSES', 'Apache-2.0.txt'), path.join(out, 'LICENSE-Apache-2.0.txt'));
  fs.writeFileSync(path.join(out, 'NOTICE.txt'), [
    `MediaPipe Tasks Vision ${MEDIAPIPE_VERSION} (vision_bundle.js = vision_bundle.mjs, wasm/) and the MediaPipe Face`,
    'Landmarker model (face_landmarker.task, float16/1), Google LLC, Apache License 2.0 (LICENSE-Apache-2.0.txt),',
    `unchanged, from ${NPM} and ${MODEL}.`,
    '',
  ].join('\n'));
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  const done = await fetchMediapipe({ out });
  for (const f of done) console.log(`  ${f.name.padEnd(40)} ${(f.bytes / 1048576).toFixed(2).padStart(6)} MB${f.fetched ? '' : '  (already there)'}`);
  console.log(`MediaPipe ${MEDIAPIPE_VERSION}: ${(done.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB in ${path.relative(process.cwd(), out || path.join(root, 'web', 'vendor', 'mediapipe')) || '.'}`);
}
