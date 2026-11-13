// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Godot test: the GDExtension draws the same pictures as the Web runtime,
// and many characters under one UgoBatch cost one draw call.
//
//   GODOT=/path/to/godot node tests/godot_test.mjs
//
// Needs the extension built first (cmake -S engines/godot -B build/godot && cmake --build build/godot)
// and the Web test's Playwright. Godot draws with the Compatibility renderer
// (OpenGL); without a display it runs under xvfb-run. Output: build/godot/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { putModels, scenes, compareWithWeb } from './engine_scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'engines', 'godot', 'project');
const out = path.join(root, 'build', 'godot');
fs.mkdirSync(out, { recursive: true });
const godot = process.env.GODOT;
if (!godot) {
  console.log('skip: set GODOT to the Godot 4.4+ executable');
  process.exit(0);
}

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`FAIL ${msg}`); } else console.log(`ok   ${msg}`); };

// ---- the scenes (tests/engine_scenes.mjs), with the test models in the Godot project ----
putModels(path.join(project, 'samples'));
const spec = scenes('/engines/godot/project/samples');
spec.model = 'res://samples/basic/model.ug9';
for (const c of spec.cases) c.model = `res://samples/${c.modelName}/model.ug9`;
const specPath = path.join(out, 'scene.json');
fs.writeFileSync(specPath, JSON.stringify(spec));

// ---- Godot ----
const run = (args, timeout) => {
  const useXvfb = !process.env.DISPLAY && spawnSync('which', ['xvfb-run']).status === 0;
  const cmd = useXvfb ? 'xvfb-run' : godot;
  const full = useXvfb ? ['-a', '-s', '-screen 0 1280x1024x24', godot, ...args] : args;
  const r = spawnSync(cmd, full, { encoding: 'utf8', timeout, env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' } });
  return { status: r.status, log: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
};
const ext = fs.readdirSync(path.join(project, 'addons', 'ugo9', 'bin')).filter((f) => /\.(so|dll|dylib)$/.test(f));
check(ext.length > 0, `extension built (${ext.join(', ') || 'none'})`);
check(fs.existsSync(path.join(project, 'samples', 'basic', 'model.ug9')), 'sample copied into the project');

// first run: import the assets and register the extension (.godot/extension_list.cfg)
const imp = spawnSync(godot, ['--headless', '--path', project, '--import'], { encoding: 'utf8', timeout: 180000 });
fs.writeFileSync(path.join(out, 'import.log'), `${imp.stdout}${imp.stderr}`);
check(fs.existsSync(path.join(project, '.godot', 'extension_list.cfg')), 'Godot imported the project and registered the extension');

const stale = fs.readdirSync(out).filter((f) => f.endsWith('.png') || f === 'results.json');
for (const f of stale) fs.rmSync(path.join(out, f));
const g = run(['--path', project, '--audio-driver', 'Dummy', '--rendering-method', 'gl_compatibility', '--rendering-driver', 'opengl3',
  '--resolution', `${spec.width}x${spec.height}`, '--quit-after', '3000', 'res://tests/render.tscn', '--', `--spec=${specPath}`, `--out=${out}`], 240000);
fs.writeFileSync(path.join(out, 'godot.log'), g.log);
const resultsPath = path.join(out, 'results.json');
check(fs.existsSync(resultsPath), `Godot ran the test scene (exit ${g.status}${g.error ? `, ${g.error.message}` : ''}; log in build/godot/godot.log)`);
if (!fs.existsSync(resultsPath)) {
  console.log(g.log.split('\n').slice(-40).join('\n'));
  process.exit(1);
}
const res = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
console.log(`     ${res.godot}, ${res.renderer}`);
// the API checks load a broken file on purpose: that one error is expected
const lines = g.log.split('\n');
const errors = lines.flatMap((l, i) => (/^(ERROR|SCRIPT ERROR)/.test(l) && !l.includes('Ugo9: not a valid .ug9 file') ? [lines.slice(i, i + 3).join(' | ')] : []));
check(errors.length === 0, `no unexpected errors in the Godot log ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);

// ---- API ----
const api = res.api ?? {};
check(res.model_loaded, 'load("res://….ug9") gives a loaded UgoModel');
check((api.parameters?.includes('AngleX') || api.parameters?.includes('HeadTurnX')) && api.animations?.includes('idle'), `parameter and animation names (${api.parameters?.length} parameters, animations ${JSON.stringify(api.animations)})`);
check(Math.abs(api.idle_length - 6) < 1e-6, `animation length (${api.idle_length})`);
check(api.bad_file_rejected === true, 'a broken file is rejected');
check(Math.abs(api.param_after_update - 0.75) < 1e-6, `set_param stays through updates (${api.param_after_update})`);
check(Math.abs(api.param_after_clear) < 1e-6, `clear_param goes back to the default (${api.param_after_clear})`);
// colour and order (modulate, z_index, y_sort under a batch; self_modulate alone): [drawn, greener or bluer, red, blue]
const col = res.colour ?? {};
check(col.red?.[0] > 500 && col.red?.[1] === 0, `modulate under a batch tints the character (red: ${JSON.stringify(col.red)})`);
check(col.clear?.[0] === 0, `modulate alpha 0 hides it (${JSON.stringify(col.clear)})`);
check(col.alone_red?.[0] > 500 && col.alone_red?.[1] === 0, `self_modulate tints a character drawn alone (${JSON.stringify(col.alone_red)})`);
check(col.tree?.[3] > col.tree?.[2] && col.z?.[2] > col.z?.[3] && col.y?.[2] > col.y?.[3],
  `order under a batch: tree order, then z_index, then y_sort (tree ${JSON.stringify(col.tree)}, z ${JSON.stringify(col.z)}, y ${JSON.stringify(col.y)})`);

// hit areas, bones, reaching, wind: [area at head, at body, outside, count, arm1 x, y, reached tip x, y, hair x still, blown]
const R = api.reach ?? [];
check(R[0] === 'head' && R[1] === 'body' && R[2] === '' && R[3] === 2 && Math.abs(R[4] - 100) < 1e-3 && Math.abs(R[5] - 100) < 1e-3
  && Math.abs(R[6] - 130) < 2 && Math.abs(R[7] - 165) < 2 && R[9] > R[8] + 5,
  `get_area_at, get_bone_transform, reach_for, wind (${JSON.stringify(R)})`);

// picking by part name
check(api.pick?.[0] === 'face' && api.pick?.[1] === '' && api.pick?.[2] === true && api.pick?.[3] === true && api.pick?.[4] === 0,
  `get_part_at finds the face through the node's transform, get_part_rect boxes it inside the whole (${JSON.stringify(api.pick)})`);

// flipped characters pick what they show
check(api.flip_pick?.[2] === 0 && api.flip_pick?.[1] > 0, `get_part_at on a flipped character (scale.x -1) matches the mirrored point of an unflipped one (same, one-sided, differ: ${JSON.stringify(api.flip_pick)})`);
// the playground scene: a slider per parameter, the face under its middle
check(api.playground?.[0] > 0 && api.playground?.[0] === api.playground?.[1] && api.playground?.[2] === 'face',
  `demo/playground.tscn builds its panel and names the part under a point (${JSON.stringify(api.playground)})`);
// the conversation and ordering samples (the same as Unity's Conversation and its step 11-4)
check(api.conversation?.[0] >= 4 && api.conversation?.[1] === 0 && api.conversation?.[2] === 'face',
  `demo/conversation.tscn: the preset's expressions, key 1 shows the first, the face under its middle (${JSON.stringify(api.conversation)})`);
check(api.ordering?.[0] === 3 && api.ordering?.[1] === 'Character2' && api.ordering?.[2] === 'face' && api.ordering?.[3] === 2 && api.ordering?.[4] < 0.8,
  `demo/ordering.tscn: clicking names the character and part, bring to front sets z_index, the tint (${JSON.stringify(api.ordering)})`);

// helpers
check(api.helpers?.[0] > 29 && api.helpers?.[1] > 0.95 && api.helpers?.[2] > 0.95 && Math.abs(api.helpers_after) < 1,
  `look_at_point turns face and eyes, set_mouth_level opens the mouth, stop_looking lets go (${JSON.stringify(api.helpers)}, then AngleX ${api.helpers_after})`);
// set in the Inspector
check(Math.abs(api.inspector?.[0] - 0.6) < 1e-4 && Math.abs(api.inspector?.[1] - 0.75) < 1e-4 && Math.abs(api.inspector?.[2] - 0.6) < 1e-4,
  `"parameters/<name>" and the starting expression apply (${JSON.stringify(api.inspector)})`);
// layers: [A, B] with B masked in, A + nudge, at weight 0.5, B half faded out, B from the queued layer, its name, finished
const L = api.layers ?? [];
check(Math.abs(L[0] - 0.5) < 1e-4 && Math.abs(L[1] - 0.6) < 1e-4 && Math.abs(L[2] - 0.75) < 1e-4 && Math.abs(L[3] - 0.625) < 1e-4
  && Math.abs(L[4] - 0.3) < 1e-3 && Math.abs(L[5] - 0.6) < 1e-4 && L[6] === 'both' && JSON.stringify(L[7]) === '["2:nudge"]',
  `layers: masked, added, weighted, stopped, queued (${JSON.stringify(L)})`);

// AnimationPlayer: time 0.5 of "once" (A 0.5) and the parameter track (B 0.2 -> 0.8 at 0.5: 0.5)
check(Math.abs(api.anim_player?.[0] - 0.5) < 1e-3 && Math.abs(api.anim_player?.[1] - 0.5) < 1e-3,
  `an AnimationPlayer drives time and parameters/<name> (${JSON.stringify(api.anim_player)})`);

// switching animations (once: A 0 -> 1 in 1 s, not looping; loop: A 1 -> 0 -> 1 in 2 s)
check(Math.abs(api.switch_start - 0.25) < 1e-4 && Math.abs(api.switch_mixed - 0.625) < 1e-3,
  `play with a fade mixes the two (A ${api.switch_start} at the start, ${api.switch_mixed} half way through a 1 s fade)`);
check(api.switch_before_end === 0 && JSON.stringify(api.switch_ended) === '["once"]' && api.switch_now === 'loop',
  `animation_finished at the end of a once-only animation, then play_next's (${JSON.stringify(api.switch_ended)}, now ${api.switch_now})`);
// format 1.1: curve keys (the model memory is asked for the file)
check(api.v11_loaded === true && api.v11_early > 0 && api.v11_early < 0.25, `a 1.1 file with curve keys loads and eases (A at 0.25 s: ${api.v11_early})`);
// format 1.0: a later 1.x file loads and says it skipped what it did not know
check(api.future_loaded === true && g.log.includes('newer than this plugin'), 'a later 1.x file loads with a warning in the log');
// expressions (format 0.8)
check(JSON.stringify(api.expressions) === '["puffed","swapped"]', `expression names (${JSON.stringify(api.expressions)})`);
check(Math.abs(api.expr_quarter - 0.75 * 0.25) < 1e-4 && Math.abs(api.expr_full - 0.75) < 1e-4,
  `show_expression fades in with the clock (Sw ${api.expr_quarter} after 0.25 s, ${api.expr_full} after 1.25 s)`);
check(JSON.stringify(api.expr_missing) === '["Nope"]', `load_expressions reports the names the model lacks (${JSON.stringify(api.expr_missing)})`);
check(Math.abs(api.expr_only?.[0] - 1) < 1e-4 && Math.abs(api.expr_only?.[1]) < 1e-4, `only_expressions: the preset's shows, the others fade out (${JSON.stringify(api.expr_only)})`);

// ---- draw calls ----
const cs = res.cases;
console.log(`     draw calls: 1 character ${cs.count_1.draw_calls}, 200 characters ${cs.count_200.draw_calls}, 20 standalone ${cs.standalone_20.draw_calls}`);
check(cs.count_200.batch_draws === cs.count_1.batch_draws && cs.count_200.batch_characters === 200,
  `UgoBatch draws 200 characters with as many calls as 1 (${cs.count_1.batch_draws} → ${cs.count_200.batch_draws})`);
check(cs.count_200.draw_calls === cs.count_1.draw_calls, `the frame's draw calls do not grow with the character count (${cs.count_1.draw_calls} → ${cs.count_200.draw_calls})`);

// ---- pictures: Godot vs the Web runtime ----
await compareWithWeb(spec, out, check);
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all Godot checks passed');
