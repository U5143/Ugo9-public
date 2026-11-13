// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The glTF and VRM exports in the browser (tools/gltf_export.mjs, tools/vrm_export.mjs, as the
// editor's export window uses them): a page imports them, exports samples/basic, and the bytes are
// the same as the commands' (node tools/export_gltf.mjs / export_vrm.mjs).
//   node tests/export_browser_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_browser');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// the commands' output
const model = path.join(ROOT, 'samples', 'basic', 'model.ug9');
execFileSync('node', [path.join(ROOT, 'tools', 'export_gltf.mjs'), model, path.join(OUT, 'basic.glb'), '--height', '1.6', '--depth', '0.002'], { stdio: 'ignore' });
execFileSync('node', [path.join(ROOT, 'tools', 'export_vrm.mjs'), model, path.join(OUT, 'basic.vrm'), '--name', 'basic'], { stdio: 'ignore' });

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 8700 + Math.floor(Math.random() * 200);
const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/blank`).catch(() => {}); // any page of the server: the modules are loaded from it
  const r = await page.evaluate(async () => {
    const { UgoRuntime } = await import('/web/ugo.js');
    const { exportGlb } = await import('/tools/gltf_export.mjs');
    const { exportVrm } = await import('/tools/vrm_export.mjs');
    const rt = await UgoRuntime.load('/web/ugo.wasm');
    const ugo = new Uint8Array(await (await fetch('/samples/basic/model.ug9')).arrayBuffer());
    const png = new Uint8Array(await (await fetch('/samples/basic/atlas.png')).arrayBuffer());
    const logs = [];
    const glb = exportGlb(rt, ugo, png, { height: 1.6, depth: 0.002, log: (s) => logs.push(s) }).glb;
    const vrm = exportVrm(rt, ugo, png, { name: 'basic', log: (s) => logs.push(s) }).vrm;
    const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((x) => x.toString(16).padStart(2, '0')).join('');
    return { glb: await hex(glb), vrm: await hex(vrm), glbLen: glb.length, vrmLen: vrm.length, logs };
  });
  check(r.glb === sha(fs.readFileSync(path.join(OUT, 'basic.glb'))), `glTF from the page: the same ${r.glbLen} bytes as node tools/export_gltf.mjs (notes to the log: ${r.logs.length})`);
  check(r.vrm === sha(fs.readFileSync(path.join(OUT, 'basic.vrm'))), `VRM from the page: the same ${r.vrmLen} bytes as node tools/export_vrm.mjs`);
  check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
} finally { await browser.close(); server.kill(); }
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser export checks passed');
process.exit(failures ? 1 : 0);
