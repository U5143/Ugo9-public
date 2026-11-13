// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Web runtime as one classic script, for engines that load plugins as plain <script>s (RPG Maker MZ,
// GDevelop): web/ugo.js and web/ugo_layer.js with their import / export taken out, and the core's two wasm
// builds as base64 (plain and SIMD, so no file has to be found at run time; ugoWasmBytes() gives the one this
// browser runs, as UgoRuntime.load picks on the Web). Wrap it with the engine's own part.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function strip(src, file) {
  let s = src.replace(/^import [^;]+;\n/gm, '').replace(/^export (class|const|function|async function) /gm, '$1 ');
  s = s.replace("static async load(source = new URL('./ugo.wasm', import.meta.url))", 'static async load(source)');
  if (/\bimport\.meta\b|^export |^import /m.test(s)) throw new Error(`${file}: module syntax left after stripping`);
  return s;
}

/** The runtime's code (no wrapper): UgoRuntime, UgoLayer, the helpers, and ugoWasmBytes(). */
export function webRuntime() {
  const b64 = (f) => fs.readFileSync(path.join(root, 'web', f)).toString('base64');
  const simd = fs.existsSync(path.join(root, 'web', 'ugo_simd.wasm')) ? b64('ugo_simd.wasm') : '';
  return [
    `const UGO_WASM_BASE64 = '${b64('ugo.wasm')}';`,
    `const UGO_WASM_SIMD_BASE64 = '${simd}';`,
    strip(read('web/ugo.js'), 'web/ugo.js'),
    strip(read('web/ugo_layer.js'), 'web/ugo_layer.js'),
    `// the core's bytes: the SIMD build where this browser runs WebAssembly SIMD (the same results bit for bit, faster)
function ugoWasmBytes() {
  const s = UGO_WASM_SIMD_BASE64 && UgoRuntime.simdSupported() ? UGO_WASM_SIMD_BASE64 : UGO_WASM_BASE64;
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}`,
  ].join('\n');
}

/** An engine's own file without its SPDX lines (the bundle has them once at the top). */
export function engineFile(p) { return read(p).replace(/^\/\/ SPDX-.*\n/gm, ''); }

export function write(out, text) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`${path.relative(root, out)}: ${(text.length / 1024).toFixed(0)} KB`);
}
