// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The scenes every game engine draws for its picture test, and the comparison
// with the Web runtime (tests/godot/page.html in headless Chromium). Used by
// tests/godot_test.mjs (CI) and tests/unity_test.mjs (on the user's PC).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileUgo } from '../tools/compile.mjs';
import { encodePng } from '../tools/png.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copies the test models into dir/<name>/ (model.ug9 + PNGs):
 * basic: the sample. editor: what the editor makes (authoring JSON compiled by
 * the same compiler). rig: masks, blend modes, colours, six bone weights
 * (format 0.4). warp: warp grids (format 0.5).
 */
export function putModels(dir) {
  const put = (name, ugoBytes, textureDir) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'model.ug9'), ugoBytes);
    for (const f of fs.readdirSync(textureDir).filter((f) => f.endsWith('.png'))) fs.copyFileSync(path.join(textureDir, f), path.join(dir, name, f));
  };
  put('basic', fs.readFileSync(path.join(root, 'samples', 'basic', 'model.ug9')), path.join(root, 'samples', 'basic'));
  put('editor', new Uint8Array(compileUgo(JSON.parse(fs.readFileSync(path.join(root, 'samples', 'basic', 'model.json'), 'utf8')))), path.join(root, 'samples', 'basic'));
  put('rig', fs.readFileSync(path.join(root, 'tests', 'pose', 'rig.ug9')), path.join(root, 'tests', 'pose'));
  put('warp', fs.readFileSync(path.join(root, 'tests', 'warp', 'model.ug9')), path.join(root, 'tests', 'warp'));
  // exprs: the core's small 0.8 model with two expressions (API checks only)
  put('exprs', fs.readFileSync(path.join(root, 'tests', 'order', 'model.ug9')), path.join(root, 'tests', 'order'));
  // future: a later 1.x file (tests/future): loads with a warning
  put('future', fs.readFileSync(path.join(root, 'tests', 'future', 'model.ug9')), path.join(root, 'tests', 'future'));
  // v11: a 1.1 file with curve keys (tests/v11): loads with the memory it needs (API checks only)
  put('v11', fs.readFileSync(path.join(root, 'tests', 'v11', 'model.ug9')), path.join(root, 'tests', 'v11'));
  // switch: "once" (does not loop) and "loop", for switching animations (API checks only; tests/unity_logic/make_model.mjs)
  put('switch', fs.readFileSync(path.join(root, 'tests', 'unity_logic', 'model.ug9')), path.join(root, 'tests', 'unity_logic'));
  // reach: an arm, a swaying chain and hit areas, for bones, wind and areas (API checks only; tests/unity_logic/make_model.mjs)
  put('reach', fs.readFileSync(path.join(root, 'tests', 'unity_logic', 'rig.ug9')), path.join(root, 'tests', 'unity_logic'));
  // order: draw order keys (format 0.8), made here with its colour atlas
  fs.mkdirSync(path.join(dir, 'order'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'order', 'model.ug9'), new Uint8Array(compileUgo(orderModel())));
  fs.writeFileSync(path.join(dir, 'order', 'atlas.png'), orderAtlas());
}

// four coloured squares (red, blue, a multiply shade, a grey back) whose draw order a parameter
// ("Swap": red from behind blue to the front) and an animation ("flip": blue to the back, a step) change
export function orderModel() {
  const quad = (x, y, w, h, cell) => ({ vertices: [x, y, x + w, y, x + w, y + h, x, y + h],
    uvs: [cell / 4 + 0.02, 0.1, cell / 4 + 0.23, 0.1, cell / 4 + 0.23, 0.9, cell / 4 + 0.02, 0.9], triangles: [0, 1, 2, 0, 2, 3] });
  return {
    format: 'ugo9', version: '1.0',
    canvas: { width: 200, height: 200, originX: 100, originY: 100 },
    textures: ['atlas.png'],
    parameters: [{ id: 'Swap', min: 0, default: 0, max: 1 }],
    bones: [{ id: 'root' }],
    parts: [
      { id: 'back', texture: 0, order: 100, ...quad(-90, -90, 180, 180, 3) },
      { id: 'red', texture: 0, order: 400, ...quad(-70, -60, 90, 90, 0) },
      { id: 'blue', texture: 0, order: 600, ...quad(-20, -30, 90, 90, 1) },
      { id: 'shade', texture: 0, blend: 'multiply', order: 550, ...quad(-50, 0, 100, 60, 2) },
    ],
    deformers: [{ region: { Swap: [0, 1, 1] }, order: { red: 800 } }],
    animations: [{ id: 'flip', duration: 2, loop: true, tracks: {}, order: { blue: [[0, 600], [1, 300, 'step'], [2, 600]] } }],
  };
}

function orderAtlas() {
  const w = 64, h = 16, px = new Uint8Array(w * h * 4);
  const colours = [[220, 60, 50], [50, 90, 210], [250, 220, 120], [150, 150, 150]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...colours[x >> 4], 255], 4 * (y * w + x));
  return encodePng(w, h, px);
}

/**
 * The scenes. Positions are in pixels of a W x H view, y down; rotation in
 * radians (clockwise on screen). Each case names its model (default basic).
 * webDir: where the browser finds the models copied by putModels (a URL path).
 * loose: compared with tests/mask_test.mjs's rule (edges of masks may differ).
 * textures: false when the model's texture files are not there (every renderer draws it white).
 * sampling: 'nearest' for pixel art (Godot's UgoModel.pixel_art; the Web renderer's sampling).
 * unity: false when the Unity test leaves the case out.
 */
export function scenes(webDir) {
  const W = 640, H = 480;
  // the look parameters under both names (standard and older): a runtime skips the one the model lacks
  const pose = { AngleX: 22, AngleY: -12, EyeOpenL: 0.3, MouthOpen: 0.7, EyeBallX: -0.6, BodyAngleX: 4, HeadTurnX: 22, HeadTurnY: -12, PupilX: -0.6, BodyTurnX: 4 };
  const grid = (n, cols, s, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({
    x: ((i % cols) + 0.5) * (W / cols), y: (Math.floor(i / cols) + 1) * (H / Math.ceil(n / cols)) - 4,
    scaleX: s, scaleY: s, ...extra(i),
  }));
  const cases = [
    { name: 'neutral', characters: [{ x: 320, y: 470, scaleX: 0.75, scaleY: 0.75 }] },
    { name: 'pose', characters: [{ x: 300, y: 450, scaleX: 0.7, scaleY: 0.7, rotation: 0.2, params: pose }] },
    { name: 'animations', characters: grid(24, 8, 0.36, (i) => ({
      anim: i % 3 === 2 ? 'talk' : 'idle', time: i * 0.37, rotation: (i % 5 - 2) * 0.08,
      scaleX: i % 4 === 1 ? -0.36 : 0.36, params: i % 6 === 0 ? { EyeOpenL: 0, EyeOpenR: 0 } : {},
    })) },
    { name: 'editor', modelName: 'editor',
      characters: [{ x: 200, y: 470, scaleX: 0.7, scaleY: 0.7, params: pose }, { x: 470, y: 470, scaleX: -0.7, scaleY: 0.7, anim: 'talk', time: 0.8 }] },
    { name: 'rig', modelName: 'rig', loose: true, textures: false, characters: [ // the rig has no texture files: white
      { x: 170, y: 240, scaleX: 1.2, scaleY: 1.2 },
      { x: 470, y: 240, scaleX: 1.2, scaleY: 1.2, anim: 'idle', time: 0.6, params: { Bend: 0.7 } }] },
    { name: 'warp', modelName: 'warp', loose: true, characters: [
      { x: 170, y: 240, scaleX: 1.5, scaleY: 1.5 },
      { x: 470, y: 240, scaleX: 1.5, scaleY: 1.5, anim: 'idle', time: 0.5 }] },
    { name: 'order', modelName: 'order', characters: [ // groups of neighbours with the same draw order: [0], [1, 2], [3], [4]
      { x: 100, y: 120, scaleX: 0.9, scaleY: 0.9 },
      { x: 260, y: 120, scaleX: 0.9, scaleY: 0.9, params: { Swap: 1 } },
      { x: 420, y: 120, scaleX: 0.9, scaleY: 0.9, params: { Swap: 1 } },
      { x: 180, y: 330, scaleX: 0.9, scaleY: 0.9, anim: 'flip', time: 1.2 },
      { x: 400, y: 330, scaleX: -0.9, scaleY: 0.9, params: { Swap: 0.45 } }] },
    // pixel art: the warp model's checker atlas read texel by texel, enlarged (Godot, three.js; Unity's is an import setting)
    { name: 'warp_nearest', modelName: 'warp', sampling: 'nearest', unity: false, loose: true, characters: [
      { x: 320, y: 240, scaleX: 2, scaleY: 2, anim: 'idle', time: 0.5 }] },
    { name: 'count_1', save: false, characters: grid(1, 1, 0.2) },
    { name: 'count_200', save: false, characters: grid(200, 20, 0.08, (i) => ({ anim: 'idle', time: i * 0.1 })) },
    { name: 'standalone_20', save: false, standalone: true, characters: grid(20, 5, 0.2) },
  ];
  for (const c of cases) {
    c.modelName ??= 'basic';
    c.webModel = `${webDir}/${c.modelName}/model.ug9`;
  }
  return { width: W, height: H, background: [0.95, 0.94, 0.92], cases };
}

/**
 * Compares each saved case's picture (dir/<case>.png) with the Web runtime's.
 * Writes <case>_web.png and <case>_diff.png next to it. check(ok, message) reports.
 */
export async function compareWithWeb(spec, dir, check, port = 8125) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(port)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const rel = path.relative(root, dir).split(path.sep).join('/');
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`http://localhost:${port}/tests/godot/page.html`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
    for (const c of spec.cases.filter((c) => c.save !== false)) {
      const png = path.join(dir, `${c.name}.png`);
      if (!fs.existsSync(png)) { check(false, `${c.name}: the engine saved no picture`); continue; }
      const d = await page.evaluate(([s, cc, url]) => window.compare(s, cc, url), [spec, c, `/${rel}/${c.name}.png`]);
      if (d.error) { check(false, `${c.name}: ${d.error}`); continue; }
      fs.writeFileSync(path.join(dir, `${c.name}_web.png`), Buffer.from(d.web, 'base64'));
      fs.writeFileSync(path.join(dir, `${c.name}_diff.png`), Buffer.from(d.diff, 'base64'));
      check(d.drawn > 0.01 * d.pixels, `${c.name}: the character is drawn (${d.drawn} pixels)`);
      if (c.loose) { // tests/mask_test.mjs: pixels off by more than 24/255 are at most 1% of the drawn ones, or 60
        check(d.over24 <= Math.max(60, 0.01 * d.drawn),
          `${c.name}: matches the Web runtime (max ${d.max}, mean ${d.mean.toFixed(3)}, ${d.over24} pixels differ by > 24)`);
      } else {
        check(d.over16 / d.pixels < 0.002 && d.mean < 1.0,
          `${c.name}: matches the Web runtime (max ${d.max}, mean ${d.mean.toFixed(3)}, ${d.over16} pixels differ by > 16)`);
      }
    }
    check(pageErrors.length === 0, `no errors in the browser ${pageErrors.length ? JSON.stringify(pageErrors) : ''}`);
  } finally {
    await browser.close();
    server.kill();
  }
}
