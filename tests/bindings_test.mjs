// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The core from other languages: examples/c/play_png.c (load -> play -> draw on the processor -> PNG) and the
// Python wrapper bindings/python/ugo9.py (ctypes) are built against the core here and must draw the same
// pixels for the same frame; the wrapper reads the model's names, bones and mesh, and refuses a broken file.
// Skipped (not failed) without a C compiler or python3.
//   node tests/bindings_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cc = process.env.CC || 'cc', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugo-bind-'));
const core = ['core/src/ugo.c', 'core/src/ugo_raster.c'].map((f) => path.join(root, f));
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const run = (cmd, args, env) => execFileSync(cmd, args, { cwd: root, stdio: 'pipe', env: { ...process.env, ...env } }).toString();
try {
  try {
    run(cc, ['-std=c99', '-O2', '-shared', '-fPIC', '-I', 'core/include', ...core, '-lm', '-o', path.join(dir, 'libugo.so')]);
    run(cc, ['-std=c99', '-O2', '-I', 'core/include', '-I', 'third_party', 'examples/c/play_png.c', ...core, '-lm', '-o', path.join(dir, 'play_png')]);
    run('python3', ['--version']);
  } catch (e) {
    console.log(`skipped: no C compiler or python3 (${String(e.message).split('\n')[0]})`);
    process.exit(0);
  }
  const cPng = path.join(dir, 'c.png'), pyPng = path.join(dir, 'py.png');
  const said = run(path.join(dir, 'play_png'), ['samples/basic/model.ug9', 'talk', '0.7', cPng, '210', '300']);
  check(fs.existsSync(cPng) && /talk at 0.70 s/.test(said), `the C example draws a frame to PNG (${said.trim()})`);
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(root, 'bindings/python'))})
import ugo9
out = {}
m = ugo9.Model.open('samples/basic/model.ug9')
out['version'] = list(ugo9.version())
out['names'] = [len(m.params), [a['name'] for a in m.animations], len(m.bones), len(m.parts), m.textures]
i = m.instance()
i.play('talk', 0.7); i.update(1 / 30)
m.save_png(${JSON.stringify(pyPng)}, i.render(210, 300))
out['same'] = ugo9.read_png(${JSON.stringify(pyPng)}) == ugo9.read_png(${JSON.stringify(cPng)})
out['bone'] = i.bone_world('head')
before = i.deformed()
out['mesh'] = len(before) == 2 * m.vertex_count
i.reset(); i.set('HeadTurnX', 30); i.update(1 / 30)
out['moved'] = i.deformed() != before
try:
    ugo9.Model(b'UGO9' + bytes(60)); out['broken'] = 'loaded'
except ValueError as e:
    out['broken'] = str(e)
print(json.dumps(out))
`;
  const r = JSON.parse(run('python3', ['-c', py], { UGO9_LIB: path.join(dir, 'libugo.so') }));
  check(r.version[0] === 1, `Python loads the core (format ${r.version.join('.')})`);
  check(r.names[0] === 14 && r.names[1].join() === 'idle,talk' && r.names[2] > 0 && r.names[3] === 16 && r.names[4][0] === 'atlas.png', `and reads the model (${JSON.stringify(r.names)})`);
  check(r.same, 'Python draws the same pixels as the C example for the same frame');
  check(r.mesh && r.bone.length === 6 && r.moved, 'bones and the deformed mesh are read, and the mesh follows a parameter');
  check(/error/.test(r.broken), `a broken file is refused (${r.broken})`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all binding checks passed');
