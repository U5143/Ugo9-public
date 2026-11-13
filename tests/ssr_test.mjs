// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Server-side rendering (Next.js, Nuxt; 利用者の声 #409): importing the Web modules must not touch window,
// document, location, navigator or self, and the core must run without a browser (loaded from bytes).
// A fresh Node process where touching any of those throws imports web/ugo.js, web/ugo_webgpu.js,
// web/tracking.js and web/examples/common.js, then loads the core and the sample, plays and updates it,
// and uses UgoFrames.
//   node tests/ssr_test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const child = `
const touched = [];
for (const name of ['window', 'document', 'location', 'navigator', 'self', 'requestAnimationFrame', 'HTMLCanvasElement', 'createImageBitmap', 'OffscreenCanvas', 'GPUShaderStage']) {
  Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); throw new Error('touched ' + name + ' on the server'); } });
}
const fs = await import('node:fs');
const out = { touched };
try {
  const ugo = await import(${JSON.stringify(root + 'web/ugo.js')});
  await import(${JSON.stringify(root + 'web/ugo_webgpu.js')});
  await import(${JSON.stringify(root + 'web/tracking.js')});
  await import(${JSON.stringify(root + 'web/examples/common.js')});
  out.imported = true;
  const rt = await ugo.UgoRuntime.load(fs.readFileSync(${JSON.stringify(root + 'web/ugo.wasm')}));
  const model = rt.loadModel(fs.readFileSync(${JSON.stringify(root + 'samples/basic/model.ug9')}));
  const inst = model.createInstance();
  inst.reset(); inst.play('idle', 0.5); inst.set('HeadTurnX', 20); inst.update(1 / 30);
  out.angle = inst.get('HeadTurnX');
  out.frameFloats = inst.frame().length;
  const frames = new ugo.UgoFrames(model, { fps: 30, setup: (i, t) => i.play('idle', t) });
  out.frame = frames.frame(45).frame().length;
} catch (e) { out.error = String(e && e.stack || e); }
console.log(JSON.stringify(out));
`;
const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let out = {};
try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { console.log(r.stdout, r.stderr); }
check(out.imported && !out.error, `ugo.js, ugo_webgpu.js, tracking.js and examples/common.js import on a server${out.error ? ` — ${out.error.split('\n')[0]}` : ''}`);
check(Array.isArray(out.touched) && out.touched.length === 0, `importing them touches no browser globals${out.touched?.length ? ` (touched: ${out.touched.join(', ')})` : ''}`);
check(out.angle === 20 && out.frameFloats > 0 && out.frame === out.frameFloats, `the core runs there: loaded from bytes, played, updated, UgoFrames (frame block ${out.frameFloats} floats)`);
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all SSR checks passed');
