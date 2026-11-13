// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Picking and bounds (ugo_pick_part, ugo_bounds; web inst.pickPart, inst.bounds): the part in front wins,
// draw order changes are followed, masks cut (and invert), hidden and see-through parts are skipped, and
// the boxes follow the deformed mesh.
//   node tests/pick_test.mjs
import fs from 'node:fs';
import { compileUgo } from '../tools/compile.mjs';
import { UgoRuntime } from '../web/ugo.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const rt = new UgoRuntime((await WebAssembly.instantiate(fs.readFileSync(new URL('../web/ugo.wasm', import.meta.url)), {})).instance.exports);

const sq = (x0, y0, x1, y1) => ({ vertices: [x0, y0, x1, y0, x1, y1, x0, y1], uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3] });
const model = rt.loadModel(compileUgo({
  format: 'ugo9', canvas: { width: 200, height: 200 },
  parameters: [{ id: 'Swap', min: 0, default: 0, max: 1 }, { id: 'Move', min: 0, default: 0, max: 1 }],
  bones: [{ id: 'root' }, { id: 'mover' }],
  parts: [
    { id: 'back', bone: 'root', ...sq(0, 0, 100, 100) },
    { id: 'front', bone: 'root', ...sq(40, 40, 60, 60) },
    { id: 'hole', bone: 'root', maskOnly: true, solid: true, ...sq(120, 0, 140, 20) },
    { id: 'clipped', bone: 'root', mask: ['hole'], ...sq(110, 0, 150, 20) },
    { id: 'outside', bone: 'root', mask: ['hole'], maskInvert: true, ...sq(110, 30, 150, 50) },
    { id: 'ghost', bone: 'root', opacity: 0, ...sq(0, 0, 100, 100) },
    { id: 'slider', bone: 'mover', ...sq(0, 150, 10, 160) },
    { id: '当たり：body', bone: 'root', maskOnly: true, ...sq(0, 0, 100, 100) },
    { id: 'hit:head', bone: 'root', maskOnly: true, ...sq(40, 40, 60, 60) },
    { id: '当たり:hand', bone: 'mover', maskOnly: true, ...sq(0, 150, 10, 160) },
  ],
  deformers: [{ region: { Swap: [0, 1, 1] }, order: { back: 900 } }, { region: { Move: [0, 1, 1] }, bones: { mover: { x: 50 } } }],
}));
const name = (i) => (i < 0 ? 'none' : ['back', 'front', 'hole', 'clipped', 'outside', 'ghost', 'slider'][i]);
const inst = model.createInstance();
const at = (x, y, min) => name(inst.pickPart(x, y, min));
inst.reset(); inst.update(0);

check(at(50, 50) === 'front' && at(10, 10) === 'back', `the part in front wins (${at(50, 50)} at the middle, ${at(10, 10)} at the side)`);
check(at(180, 180) === 'none', 'nothing there: -1');
check(at(130, 10) === 'clipped' && at(115, 10) === 'none', `a masked part is picked only inside its mask (${at(130, 10)} inside, ${at(115, 10)} outside)`);
check(at(115, 40) === 'outside', 'an inverted mask: picked outside the mask');
check(at(5, 5, 0) === 'back', 'a part at opacity 0 is skipped');
check(at(130, 10, 0.5) === 'clipped', 'min opacity keeps parts above it');
inst.reset(); inst.set('Swap', 1); inst.update(0);
check(at(50, 50) === 'back', `a draw order change is followed (${at(50, 50)} in front after Swap)`);
inst.reset(); inst.set('Move', 1); inst.update(0);
check(at(55, 155) === 'slider' && at(5, 155) === 'none', 'a moved bone moves where its part is picked');

const b = inst.bounds('slider');
check(b && b.every((v, i) => Math.abs(v - [50, 150, 60, 160][i]) < 1e-4), `a part's box follows its deformed mesh (${b?.map((v) => v.toFixed(1))})`);
const all = inst.bounds();
check(all && Math.abs(all[0]) < 1e-4 && Math.abs(all[1]) < 1e-4 && Math.abs(all[2] - 150) < 1e-4 && Math.abs(all[3] - 160) < 1e-4,
  `the whole box covers every part drawn, not the hidden mask (${all?.map((v) => v.toFixed(1))})`);
check(inst.bounds('nope') === null && inst.bounds(99) === null, 'an unknown part has no box');
{ // the estimate holds every vertex (hidden ones too) without deforming them
  const e = inst.boundsEstimate(), p = inst.deformedPositions();
  let inside = true;
  for (let i = 0; i < p.length; i += 2) inside &&= p[i] >= e[0] - 1e-3 && p[i] <= e[2] + 1e-3 && p[i + 1] >= e[1] - 1e-3 && p[i + 1] <= e[3] + 1e-3;
  check(inside && e[0] <= all[0] && e[2] >= all[2], `boundsEstimate holds every vertex (${e.map((v) => v.toFixed(1))})`);
  inst.setTransform(2, 0, 0, 2, 10, 20);
  const w = inst.boneWorld(1), wp = inst.boneWorldPlaced(1);
  check(Math.abs(wp[4] - (2 * w[4] + 10)) < 1e-4 && Math.abs(wp[5] - (2 * w[5] + 20)) < 1e-4 && Math.abs(wp[0] - 2 * w[0]) < 1e-5, 'boneWorldPlaced applies the placement');
  inst.setTransform(1, 0, 0, 1, 0, 0);
}

// hit areas: parts named hit:<name> / 当たり:<name> / 当たり：<name>
{
  check(model.hitAreas.map((a) => a.name).join(',') === 'body,head,hand', `the hit areas are read from the part names (${model.hitAreas.map((a) => a.name)})`);
  const h = model.createInstance();
  h.reset(); h.update(0);
  check(h.hitTest(50, 50) === 'head' && h.hitTest(10, 10) === 'body' && h.hitTest(180, 180) === null, `the area in front wins, though not drawn (${h.hitTest(50, 50)}, ${h.hitTest(10, 10)}, ${h.hitTest(180, 180)})`);
  check(name(h.pickPart(50, 50)) === 'front', 'pickPart still skips the areas (they are not drawn)');
  h.reset(); h.set('Move', 1); h.update(0);
  check(h.hitTest(55, 155) === 'hand' && h.hitTest(5, 155) === null, 'an area follows its bone');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all pick checks passed');
