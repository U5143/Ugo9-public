// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A sprite sheet of every animation for game engines without a Ugo9 runtime (web/sheet.js packSheet,
// tools/export_sheet.mjs; 利用者の声 #2). Every frame put back together from the PNG and its JSON
// (the frame's place, its trimmed box in the full frame) must be the frame itself, byte for byte: for
// made-up frames (some the same: kept once; one empty) and for the sample's two animations against
// ugo_export's own frames. The tags cover the animations in order; the times are 1000 / fps; without
// trimming every frame is whole.
//   node tests/export_sheet_test.mjs        (the sample needs build/ugo_export)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packSheet } from '../web/sheet.js';
import { exportSheet } from '../tools/export_sheet.mjs';
import { decodePng } from '../tools/png.mjs';
import { findExporter } from '../tools/compare_frames.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'export_sheet_test');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// a frame put back together from the sheet: the full frame, empty where it was trimmed away
function unpack(sheet, width, json, name) {
  const f = json.frames[name], { w, h } = f.sourceSize, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < f.frame.h; y++) {
    const from = ((f.frame.y + y) * width + f.frame.x) * 4;
    out.set(sheet.subarray(from, from + f.frame.w * 4), ((f.spriteSourceSize.y + y) * w + f.spriteSourceSize.x) * 4);
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// made-up frames: a square moving, a still part (the same frame three times), an empty frame
{
  const W = 24, H = 16;
  const frame = (x0) => { const f = new Uint8Array(W * H * 4); if (x0 >= 0) for (let y = 4; y < 10; y++) for (let x = x0; x < x0 + 5; x++) f.set([x * 10, y * 20, 200, 128 + x], (y * W + x) * 4); return f; };
  const anims = [{ name: 'walk', fps: 10, frames: [frame(1), frame(5), frame(9)] }, { name: 'stand', fps: 4, frames: [frame(5), frame(5), frame(5)] }, { name: 'gone', fps: 10, frames: [frame(-1)] }];
  const r = packSheet(anims, W, H, { image: 'x.png' }), json = JSON.parse(r.json);
  const names = Object.keys(json.frames);
  const back = anims.flatMap((a) => a.frames.map((f, i) => same(unpack(r.rgba, r.width, json, `${a.name}_${String(i).padStart(4, '0')}`), f)));
  check(names.length === 7 && back.every(Boolean), `every frame put back from the sheet is the frame itself (${back.filter(Boolean).length} of 7)`);
  check(r.unique === 4, `the same picture kept once: 7 frames, ${r.unique} pictures (the still frame is walk's second)`);
  const f0 = json.frames.walk_0000;
  check(f0.trimmed && f0.frame.w === 5 && f0.frame.h === 6 && f0.spriteSourceSize.x === 1 && f0.spriteSourceSize.y === 4 && json.frames.gone_0000.frame.w === 1,
    'trimmed to what shows (5×6 at 1, 4 in the 24×16 frame); an empty frame is one transparent pixel');
  check(JSON.stringify(json.meta.frameTags.map((t) => [t.name, t.from, t.to])) === '[["walk",0,2],["stand",3,5],["gone",6,6]]' && json.frames.walk_0000.duration === 100 && json.frames.stand_0000.duration === 250 && json.meta.image === 'x.png',
    'one frame tag per animation in order; the time of a frame 1000 / fps; the image named');
  const whole = packSheet(anims, W, H, { trim: false, dedupe: false }), wj = JSON.parse(whole.json);
  check(whole.unique === 7 && Object.values(wj.frames).every((f) => f.frame.w === W && f.frame.h === H && !f.trimmed), 'without trimming and keeping once: 7 whole frames');
}

// the sample: both animations, against ugo_export's own frames
const exe = findExporter();
if (exe) {
  const model = path.join(ROOT, 'samples/basic/model.ug9');
  const r = exportSheet(model, { fps: 6, size: '70x100', image: 'basic.png' }), json = JSON.parse(r.json);
  fs.writeFileSync(path.join(OUT, 'basic.png'), r.png);
  const png = decodePng(fs.readFileSync(path.join(OUT, 'basic.png')));
  let good = 0, total = 0;
  for (const a of r.anims) {
    execFileSync(exe, [model, '--anim', a.name, '--frames', String(a.frames), '--fps', '6', '--size', '70x100', '--format', 'raw', '--out', path.join(OUT, `${a.name}.rgba`)], { stdio: 'ignore' });
    const raw = fs.readFileSync(path.join(OUT, `${a.name}.rgba`)), n = 70 * 100 * 4;
    for (let i = 0; i < a.frames; i++) { total++; if (same(unpack(png.rgba, png.width, json, `${a.name}_${String(i).padStart(4, '0')}`), raw.subarray(i * n, (i + 1) * n))) good++; }
  }
  check(good === total && r.anims.map((a) => a.name).join() === 'idle,talk' && r.anims[0].frames === 36, `the sample (idle 6 s, talk 2 s at 6 fps): all ${total} frames put back from the PNG are ugo_export's own (${good} of ${total}); ${r.width}×${r.height}`);
  check(json.meta.frameTags.length === 2 && json.meta.frameTags[1].from === 36, 'the tags: idle 0..35, talk from 36');
  let bad = '';
  try { exportSheet(model, { anims: ['nope'] }); } catch (e) { bad = e.message; }
  check(/no animation named nope/.test(bad), 'an animation that is not there: refused by name');
} else console.log('skip the sample: build/ugo_export not built');

console.log(failures ? `\n${failures} check(s) failed` : '\nall sprite sheet checks passed');
process.exit(failures ? 1 : 0);
