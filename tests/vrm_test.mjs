// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// VRM 1.0 export (tools/export_vrm.mjs) loaded by pixiv's three-vrm.
//   npm install --no-save three@0.186.1 @pixiv/three-vrm@3.5.5   (once)
//   node tools/export_vrm.mjs samples/basic/model.ug9 build/vrm/basic.vrm
//   node tests/vrm_test.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sp } from './sample_names.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'vrm');
fs.mkdirSync(out, { recursive: true });
const port = 8131;
const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('GL Driver Message')) errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/tests/vrm/page.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const info = await page.evaluate(() => window.info);
  console.log('     ' + JSON.stringify(info));
  check(info.metaVersion === '1', 'three-vrm reads it as VRM 1.0');
  check(info.humanBones.length === 7, `humanoid bones found (${info.humanBones.join(', ')})`);
  check(['blink', 'blinkLeft', 'blinkRight', 'aa', 'lookLeft', 'lookUp'].every((n) => info.expressions.includes(n)), `expressions (${info.expressions.length})`);
  check(info.springJoints >= 4, `spring bone joints (${info.springJoints})`);

  const cases = [
    ['neutral', null, {}],
    ['blink', 'blink', { EyeOpenL: 0, EyeOpenR: 0 }],
    ['blinkRight (screen-left eye)', 'blinkRight', { EyeOpenL: 0 }],
    ['aa', 'aa', { MouthOpen: 1 }],
    ['lookLeft', 'lookLeft', { [sp('EyeBallX')]: 1 }],
    ['surprised', 'surprised', { BrowY: 1, MouthOpen: 0.5 }],
  ];
  for (const [label, expr, params] of cases) {
    const r = await page.evaluate(([e, p]) => window.compareExpression(e, p), [expr, params]);
    check(r.over16 / r.pixels < 0.01, `${label}: VRM matches Ugo9 (${r.over16} pixels differ by > 16, max ${r.max})`);
    if (label === 'blink') await page.screenshot({ path: path.join(out, 'blink_compare.png') });
  }
  await page.evaluate(() => window.turnHead(35));
  await page.screenshot({ path: path.join(out, 'head_turn_35.png') });
  const swing = await page.evaluate(() => window.swing());
  check(swing > 1, `spring bones swing the hair when the body moves (${swing.toFixed(1)} degrees)`);
  check(errors.length === 0, `no errors ${errors.length ? JSON.stringify(errors) : ''}`);

  // the model's own swaying chains (format 0.6) become the VRM's spring bones
  const chainJson = JSON.parse(fs.readFileSync(path.join(root, 'samples/basic/model.json'), 'utf8'));
  chainJson.version = '0.6';
  chainJson.chains = [{ id: 'hairL', bones: ['hairL1', 'hairL2'], stiffness: 30, damping: 4, gravity: [0, 600] }];
  const chainDir = path.join(out, 'chain');
  fs.mkdirSync(chainDir, { recursive: true });
  for (const t of chainJson.textures) fs.copyFileSync(path.join(root, 'samples/basic', t), path.join(chainDir, t));
  const { compileUgo } = await import('../tools/compile.mjs');
  fs.writeFileSync(path.join(chainDir, 'model.ugo'), new Uint8Array(compileUgo(chainJson)));
  execFileSync(process.execPath, [path.join(root, 'tools/export_vrm.mjs'), path.join(chainDir, 'model.ugo'), path.join(chainDir, 'chain.vrm')], { stdio: 'ignore' });
  const glb = fs.readFileSync(path.join(chainDir, 'chain.vrm')), jl = glb.readUInt32LE(12), gj = JSON.parse(glb.toString('utf8', 20, 20 + jl));
  const springs = gj.extensions.VRMC_springBone.springs, j0 = springs[0]?.joints[0];
  check(springs.length === 1 && springs[0].name === 'hairL1' && springs[0].joints.length === 3, `one spring from the chain: ${springs.map((s) => `${s.name} (${s.joints.length} joints)`)}`);
  check(Math.abs(j0.dragForce - (1 - Math.exp(-4 / 60))) < 1e-3 && j0.gravityDir[1] === -1 && j0.stiffness > 0 && j0.gravityPower > 0,
    `chain settings carried over (dragForce ${j0.dragForce}, stiffness ${j0.stiffness}, gravityPower ${j0.gravityPower}, gravityDir ${j0.gravityDir})`);
  const page2 = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(String(e)));
  await page2.goto(`http://localhost:${port}/tests/vrm/page.html?vrm=/build/vrm/chain/chain.vrm&ugo=/build/vrm/chain/model.ugo`);
  await page2.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const swing2 = await page2.evaluate(() => window.swing()), ugo2 = await page2.evaluate(() => window.ugoSwing('hairL1'));
  check(swing2 > ugo2 / 1.6 && swing2 < ugo2 * 1.6 && errors2.length === 0, `three-vrm loads it and the chain swings about as much as Ugo9's own when the body moves (largest ${swing2.toFixed(1)} degrees; Ugo9's own chain: ${ugo2.toFixed(1)}) ${errors2.join(' ')}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all VRM checks passed');
