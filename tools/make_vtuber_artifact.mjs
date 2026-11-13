// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Writes the VTuber page (web/vtuber.html) as one folder that works on its own: served over https anywhere
// (e.g. a claude.ai Artifact, to try it on a phone, whose browser lets a page use the camera only over https).
//
//   node tools/make_vtuber_artifact.mjs [--out build/vtuber_artifact] [--no-face-model] [--offline]
//
// The folder: index.html (the page in standalone mode: no relay to an OBS page, no tools/serve.mjs), ugo.js,
// ugo.wasm and ugo_simd.wasm (the core; the SIMD build where the browser has SIMD), tracking.js, tracking_worker.js (the face read on a thread of its own; the page reads it itself where
// a worker may not run), the sample character (samples/basic, CC0) and, unless --no-face-model, MediaPipe's
// face model (Apache-2.0, downloaded once into build/cache/) with THIRD_PARTY.txt and the license text. Every
// path is relative. The binary data files' names end in .wasm (sample_model.ug9.wasm, face_landmarker.task.wasm):
// a claude.ai Artifact only takes some types (.html .js .wasm .png .json .txt ...); the page reads them with fetch,
// so the type they are served as does not matter. The only outside loads left are MediaPipe's script and its WebAssembly from
// cdn.jsdelivr.net at a fixed version (and, with --no-face-model, the face model from Google's storage).
// --offline also puts MediaPipe itself in the folder (vendor/mediapipe/, from tools/fetch_mediapipe.mjs, about 18 MB
// more): then the page loads nothing from outside at all.
// Prints the files and their sizes, and the outside hosts the page will load from.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchMediapipe } from './fetch_mediapipe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACE_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const FACE_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

export async function makeVtuberArtifact({ out = path.join(root, 'build', 'vtuber_artifact'), faceModel = true, offline = false } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(out, to));
  copy('web/ugo.js', 'ugo.js');
  copy('web/ugo.wasm', 'ugo.wasm');
  copy('web/ugo_simd.wasm', 'ugo_simd.wasm');
  copy('web/tracking.js', 'tracking.js');
  copy('web/tracking_worker.js', 'tracking_worker.js');
  copy('samples/basic/model.ug9', 'sample_model.ug9.wasm');
  copy('samples/basic/atlas.png', 'sample_atlas.png');
  if (offline) { // MediaPipe in the folder too: tracking.js finds vendor/mediapipe/ next to it (the face model is passed apart)
    const vendor = path.join(root, 'web', 'vendor', 'mediapipe');
    await fetchMediapipe({ out: vendor });
    const into = path.join(out, 'vendor', 'mediapipe');
    for (const f of ['vision_bundle.js', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm', 'NOTICE.txt', 'LICENSE-Apache-2.0.txt']) {
      fs.mkdirSync(path.dirname(path.join(into, f)), { recursive: true });
      fs.copyFileSync(path.join(vendor, f), path.join(into, f));
    }
  }

  const attrs = ['data-standalone', 'data-sample-model="sample_model.ug9.wasm"', 'data-sample-atlas="sample_atlas.png"'];
  if (faceModel) {
    const cache = path.join(root, 'build', 'cache', 'face_landmarker.task');
    if (!fs.existsSync(cache)) {
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      const r = await fetch(FACE_URL);
      if (!r.ok) throw new Error(`face model: ${r.status} from ${FACE_URL}`);
      fs.writeFileSync(cache, Buffer.from(await r.arrayBuffer()));
    }
    const sum = crypto.createHash('sha256').update(fs.readFileSync(cache)).digest('hex');
    if (sum !== FACE_SHA256) throw new Error(`face model: unexpected contents (sha256 ${sum}); delete ${cache} and try again`);
    fs.copyFileSync(cache, path.join(out, 'face_landmarker.task.wasm'));
    fs.copyFileSync(path.join(root, 'LICENSES', 'Apache-2.0.txt'), path.join(out, 'LICENSE-Apache-2.0.txt'));
    attrs.push('data-face-model="face_landmarker.task.wasm"');
  }
  let html = fs.readFileSync(path.join(root, 'web', 'vtuber.html'), 'utf8');
  if (!html.includes('<html lang="ja">')) throw new Error('web/vtuber.html: <html lang="ja"> not found');
  html = html.replace('<html lang="ja">', `<html lang="ja" ${attrs.join(' ')}>`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
  fs.writeFileSync(path.join(out, 'THIRD_PARTY.txt'), [
    'Ugo9 VTuber (standalone)',
    '',
    'index.html, ugo.js, ugo.wasm, ugo_simd.wasm, tracking.js, tracking_worker.js: Ugo9, MIT License.',
    'sample_model.ug9.wasm, sample_atlas.png: the Ugo9 sample character (samples/basic), CC0-1.0.',
    ...(faceModel ? [
      'face_landmarker.task.wasm: MediaPipe Face Landmarker model (face_landmarker.task, float16/1), Google LLC,',
      `  Apache License 2.0 (LICENSE-Apache-2.0.txt), from ${FACE_URL}, unchanged (sha256 ${FACE_SHA256}).`,
    ] : []),
    offline ? 'vendor/mediapipe/: MediaPipe Tasks Vision 0.10.14, Google LLC, Apache License 2.0 (vendor/mediapipe/NOTICE.txt), unchanged.'
      : 'Loaded at run time, not included: MediaPipe Tasks Vision 0.10.14 (Apache License 2.0) from cdn.jsdelivr.net.',
    '',
  ].join('\n'));

  // what is in it, and what it loads from outside
  const walk = (dir) => fs.readdirSync(path.join(out, dir)).flatMap((n) => { const rel = dir ? `${dir}/${n}` : n; return fs.statSync(path.join(out, rel)).isDirectory() ? walk(rel) : [rel]; });
  const files = walk('').sort().map((name) => ({ name, bytes: fs.statSync(path.join(out, name)).size }));
  const text = ['index.html', 'tracking.js', 'tracking_worker.js', 'ugo.js'].map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  // MediaPipe from the folder (offline): its CDN address is still written in tracking.js but not used
  const hosts = [...new Set([...text.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1]))].filter((h) => (faceModel ? h !== 'storage.googleapis.com' : true) && !(offline && h === 'cdn.jsdelivr.net'));
  return { out, files, hosts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = await makeVtuberArtifact({ out: arg('--out') ? path.resolve(arg('--out')) : undefined, faceModel: !process.argv.includes('--no-face-model'), offline: process.argv.includes('--offline') });
  console.log(r.out);
  for (const f of r.files) console.log(`  ${f.name.padEnd(24)} ${(f.bytes / 1024).toFixed(1).padStart(8)} KB`);
  console.log(`  ${'(all)'.padEnd(24)} ${(r.files.reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(1).padStart(8)} KB`);
  console.log(`loads from outside: ${r.hosts.join(', ') || 'nothing'}`);
}
