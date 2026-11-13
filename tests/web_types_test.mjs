// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Web runtime's types (web/*.d.ts, engines/gdevelop/ugo9_gdevelop.d.ts) against the real code:
//   1. tests/types/example.ts type-checks (tsc --strict --noEmit): the names in docs/エンジンのAPI.md's Web column work
//   2. every class, method and field the .d.ts files declare exists on the real objects (a real model and instance from
//      the core, the classes' prototypes), and every export is declared — so the types cannot drift from the code
//   3. gdjs.ugo9's declared functions are exactly those of engines/gdevelop/gdevelop_main.js
//   node tests/web_types_test.mjs   (installs typescript@5.6.3 into build/types once)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsDir = path.join(root, 'build', 'types');
if (!fs.existsSync(path.join(tsDir, 'node_modules', 'typescript'))) {
  fs.mkdirSync(tsDir, { recursive: true });
  fs.writeFileSync(path.join(tsDir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'typescript@5.6.3'], { cwd: tsDir, stdio: 'inherit' });
}
const ts = createRequire(path.join(tsDir, 'package.json'))('typescript');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// 1. the example type-checks
const program = ts.createProgram([path.join(root, 'tests', 'types', 'example.ts')], {
  strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
});
const diags = ts.getPreEmitDiagnostics(program);
for (const d of diags.slice(0, 10)) console.log('  ' + ts.flattenDiagnosticMessageText(d.messageText, '\n') + (d.file ? ` (${path.relative(root, d.file.fileName)})` : ''));
check(diags.length === 0, `tests/types/example.ts type-checks with --strict (${diags.length} error(s))`);

// declarations of a .d.ts: { exports: [names], classes: { name: { members: [[name, static?, method?]] } }, interfaces }
function declared(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const out = { exports: [], classes: {}, interfaces: {} };
  const memberName = (m) => m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null;
  for (const st of src.statements) {
    if (ts.isClassDeclaration(st) && st.name) {
      out.exports.push(st.name.text);
      out.classes[st.name.text] = st.members.filter((m) => !ts.isConstructorDeclaration(m) && memberName(m))
        .map((m) => [memberName(m), !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword), ts.isMethodDeclaration(m)]);
    } else if (ts.isFunctionDeclaration(st) && st.name) out.exports.push(st.name.text);
    else if (ts.isVariableStatement(st) && st.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)) st.declarationList.declarations.forEach((d) => out.exports.push(d.name.text));
    else if (ts.isInterfaceDeclaration(st)) out.interfaces[st.name.text] = st.members.map(memberName).filter(Boolean);
  }
  return out;
}

// 2. against the real code
const ugo = await import(pathToFileURL(path.join(root, 'web', 'ugo.js')));
const rt = await ugo.UgoRuntime.load(fs.readFileSync(path.join(root, 'web', 'ugo.wasm')));
const model = rt.loadModel(fs.readFileSync(path.join(root, 'samples', 'basic', 'model.ug9')));
const live = { UgoRuntime: rt, UgoModel: model, UgoInstance: model.createInstance(), UgoAnimator: new ugo.UgoAnimator(model),
  UgoExpressionMixer: new ugo.UgoExpressionMixer(model), UgoLook: new ugo.UgoLook(model), UgoBlink: new ugo.UgoBlink(model),
  UgoMouth: new ugo.UgoMouth(model), UgoLinks: new ugo.UgoLinks(model), UgoFrames: new ugo.UgoFrames(model) };
for (const [dts, js] of [['ugo.d.ts', 'ugo.js'], ['ugo_layer.d.ts', 'ugo_layer.js'], ['ugo_pixi.d.ts', 'ugo_pixi.js'], ['ugo_phaser.d.ts', 'ugo_phaser.js'], ['ugo_three.d.ts', 'ugo_three.js']]) {
  const d = declared(path.join(root, 'web', dts));
  const mod = js === 'ugo.js' ? ugo : await import(pathToFileURL(path.join(root, 'web', js)));
  const missingExports = d.exports.filter((n) => !(n in mod));
  const undeclared = Object.keys(mod).filter((n) => !d.exports.includes(n));
  check(missingExports.length === 0 && undeclared.length === 0, `${js}: exports and ${dts} agree${missingExports.length ? `; declared, not exported: ${missingExports}` : ''}${undeclared.length ? `; exported, not declared: ${undeclared}` : ''}`);
  const wrong = [];
  for (const [cls, members] of Object.entries(d.classes)) {
    const C = mod[cls];
    if (!C) continue;
    for (const [name, isStatic, isMethod] of members) {
      if (isStatic) { if (typeof C[name] !== 'function' && !(name in C)) wrong.push(`${cls}.${name}`); continue; }
      if (isMethod) { if (typeof C.prototype[name] !== 'function') wrong.push(`${cls}#${name}()`); continue; }
      // fields: checked on a real object where one can be made outside a browser
      if (live[cls] && !(name in live[cls])) wrong.push(`${cls}#${name}`);
    }
  }
  check(wrong.length === 0, `${dts}: every declared method${js === 'ugo.js' ? ' and field' : ''} exists in ${js}${wrong.length ? ` — not found: ${wrong.join(', ')}` : ''}`);
}

// 3. gdjs.ugo9
const gd = declared(path.join(root, 'engines', 'gdevelop', 'ugo9_gdevelop.d.ts')).interfaces.Ugo9GDevelop;
const src = fs.readFileSync(path.join(root, 'engines', 'gdevelop', 'gdevelop_main.js'), 'utf8');
const body = src.slice(src.indexOf('const ugo9 = {'), src.indexOf('gdjs.ugo9 = ugo9'));
const real = [...body.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\(/gm)].map((m) => m[1]);
const a = gd.filter((n) => !real.includes(n)), b = real.filter((n) => !gd.includes(n));
check(a.length === 0 && b.length === 0, `gdjs.ugo9: ugo9_gdevelop.d.ts declares exactly its ${real.length} functions${a.length ? `; declared only: ${a}` : ''}${b.length ? `; missing in the types: ${b}` : ''}`);

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all Web type checks passed');
