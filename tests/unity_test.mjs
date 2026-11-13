// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Unity picture test (on a PC with Unity; see docs/エンジン.md「PC での確認」).
//
//   node tests/unity_test.mjs prepare <Unity project>/Assets/Ugo9Test
//       copies the test models (tests/engine_scenes.mjs) and scene_unity.json there
//   (in Unity: the Render test sample writes build/unity/<scene>.png and results.json)
//   node tests/unity_test.mjs compare [build/unity]
//       compares Unity's pictures with the Web runtime's (needs Playwright, like the Web test)
import fs from 'node:fs';
import path from 'node:path';
import { putModels, scenes, compareWithWeb, root } from './engine_scenes.mjs';

const [mode, dirArg] = process.argv.slice(2);
const webModels = path.join(root, 'build', 'unity', 'models');

if (mode === 'prepare') {
  if (!dirArg) { console.error('usage: node tests/unity_test.mjs prepare <Unity project>/Assets/Ugo9Test'); process.exit(2); }
  const dir = path.resolve(dirArg);
  putModels(path.join(dir, 'models'));
  // JsonUtility reads no dictionaries: parameters become a list of { name, value }
  const spec = scenes('/build/unity/models');
  spec.cases = spec.cases.filter((c) => c.unity !== false);
  for (const c of spec.cases) {
    for (const ch of c.characters) {
      ch.parameters = Object.entries(ch.params ?? {}).map(([name, value]) => ({ name, value }));
      delete ch.params;
    }
  }
  fs.writeFileSync(path.join(dir, 'scene_unity.json'), JSON.stringify(spec, null, 1));
  console.log(`wrote ${dir}/models (basic, editor, rig, warp, order) and ${dir}/scene_unity.json`);
} else if (mode === 'compare') {
  const dir = path.resolve(dirArg ?? path.join(root, 'build', 'unity'));
  let failures = 0;
  const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };
  putModels(webModels);
  const spec = scenes('/build/unity/models');
  spec.cases = spec.cases.filter((c) => c.unity !== false);
  const resultsPath = path.join(dir, 'results.json');
  check(fs.existsSync(resultsPath), `Unity wrote ${resultsPath}`);
  if (fs.existsSync(resultsPath)) {
    const res = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    console.log(`     Unity ${res.unity}, ${res.graphics}, colour space ${res.colorSpace}`);
    const by = Object.fromEntries(res.cases.map((c) => [c.name, c]));
    check(by.count_200?.characters === 200 && by.count_200.batchDraws === by.count_1?.batchDraws,
      `UgoBatch draws 200 characters with as many calls as 1 (${by.count_1?.batchDraws} → ${by.count_200?.batchDraws})`);
    if (res.colorSpace !== 'Gamma') console.log('     note: the project uses the Linear colour space; blending then differs from the Web runtime (use Gamma to compare)');
  }
  await compareWithWeb(spec, dir, check, 8126);
  if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
  console.log('all Unity checks passed');
} else {
  console.error('usage: node tests/unity_test.mjs prepare <dir> | compare [dir]');
  process.exit(2);
}
