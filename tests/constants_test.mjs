// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Numbers that several layers must agree on, read straight from their sources and
// compared: blend modes, part flags, track kinds, bone inherit modes, colour modes.
// The compiler writes them into .ug9 files, the C core and the Web player read them,
// so one forgotten place would otherwise only show up when a picture looks wrong.
// The reading itself is checked too: shifted copies of the sources must fail.
//   node tests/constants_test.mjs
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SOURCES = {
  compile: 'tools/compile.mjs',
  expressions: 'tools/expressions.mjs',
  curves: 'tools/curve_keys.mjs',
  web: 'web/ugo.js',
  header: 'core/include/ugo.h',
  internal: 'core/src/ugo_internal.h',
  // the engines' own copies (the GPU table's 16 / 32 bits are engine-internal, not format numbers)
  unity: 'engines/unity/com.ugo9.runtime/Runtime/Core/UgoCore.cs',
  three: 'web/ugo_three.js',
  unityShader: 'engines/unity/com.ugo9.runtime/Runtime/Resources/Ugo9Character.shader',
  godotShader: 'engines/godot/shaders/ugo9.gdshader',
};

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// ---- readers (each returns { name: number }, or throws when the table is not found) ----

// `const NAME = { a: 0, b: 1 };`
function jsObject(src, name) {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`object ${name} not found`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(-?\d+)/g)) out[k] = Number(v);
  return out;
}
// `const NAME = ['a', 'b'];` (strings: name -> index) or `[['a', ...], ['b', ...]]` (first string of each item)
function jsArray(src, name) {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`array ${name} not found`);
  const body = m[1].trim();
  const items = body.startsWith('[') ? [...body.matchAll(/\[\s*'([^']*)'/g)].map((x) => x[1]) : [...body.matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return Object.fromEntries(items.map((k, i) => [k, i]));
}
// `const A = 1, B = 2;` for the given names
function jsConsts(src, names) {
  const out = {};
  for (const n of names) {
    const m = src.match(new RegExp(`\\b${n}\\s*=\\s*(-?\\d+)`));
    if (!m) throw new Error(`constant ${n} not found`);
    out[n] = Number(m[1]);
  }
  return out;
}
// the C enum that contains `first`: names with their values (explicit, or counted on from the one before)
function cEnum(src, first) {
  const re = /enum\s*\{([\s\S]*?)\}/g;
  for (const [, body] of src.matchAll(re)) {
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const entries = clean.split(',').map((s) => s.trim()).filter(Boolean);
    if (!entries.some((e) => e.split('=')[0].trim() === first)) continue;
    const out = {};
    let next = 0;
    for (const e of entries) {
      const [k, v] = e.split('=').map((s) => s.trim());
      const val = v === undefined ? next : Number(v.replace(/u$/i, ''));
      if (!Number.isInteger(val)) throw new Error(`enum value ${e} is not a number`);
      out[k] = val; next = val + 1;
    }
    return out;
  }
  throw new Error(`enum with ${first} not found`);
}
// `#define NAME 1u` (also in shaders)
function cDefines(src, names) {
  const out = {};
  for (const n of names) {
    const m = src.match(new RegExp(`#define\\s+${n}\\s+(\\d+)u?\\b`));
    if (!m) throw new Error(`#define ${n} not found`);
    out[n] = Number(m[1]);
  }
  return out;
}

// ---- the tables: for each, what every source says, by a shared key ----

function tables(src) {
  const blendC = cEnum(src.header, 'UGO_BLEND_NORMAL');
  const blendJs = jsObject(src.compile, 'BLEND'), blendWeb = jsObject(src.web, 'BLEND');
  const flagNames = ['PART_MASK_INVERT', 'PART_HIDDEN', 'PART_SOLID'];
  const flagsC = cDefines(src.header, flagNames.map((n) => `UGO_${n}`));
  const flagsJs = jsConsts(src.compile, flagNames), flagsWeb = jsConsts(src.web, flagNames);
  const tk = cEnum(src.internal, 'TK_PARAM'), kinds = jsObject(src.compile, 'TRACK_KIND');
  const inhC = cEnum(src.internal, 'INHERIT_NORMAL'), inhJs = jsArray(src.compile, 'INHERIT_NAMES');
  const colC = cEnum(src.internal, 'COLOR_MULTIPLY_SCREEN'), colJs = jsArray(src.compile, 'COLOR_MODES');
  // a key's time fills its 16 bits (0.7): the compiler's largest tick and the core's key type
  const ticksJs = jsConsts(src.compile, ['KEY_TICKS']).KEY_TICKS;
  // expression ops (0.8): the preset module, the Web player, ugo.h and the core
  const opsJs = jsArray(src.expressions, 'EXPR_OPS'), opsWeb = jsArray(src.web, 'EXPR_OPS');
  const opsH = cEnum(src.header, 'UGO_EXPR_SET'), opsC = cEnum(src.internal, 'EXPR_SET');
  // the header (0.8: 48 counts) and the largest draw order value
  const hdrJs = jsConsts(src.compile, ['HEADER_SIZE', 'TOC_ENTRY', 'TOC_MAX']), hdrC = cDefines(src.internal, ['UGO_HEADER_SIZE', 'UGO_TOC_ENTRY', 'UGO_TOC_MAX']);
  // table kinds and what an older core does with an unknown table (1.0)
  const kindsJs = jsObject(src.compile, 'TABLE_KIND'), kindsC = cEnum(src.internal, 'TB_PARAMS');
  const tocJs = jsConsts(src.compile, ['TOC_SKIP', 'TOC_WARN', 'TOC_NEED']), tocC = cEnum(src.internal, 'TOC_SKIP');
  const KIND_NAMES = [['params', 'TB_PARAMS'], ['bones', 'TB_BONES'], ['constraints', 'TB_CONS'], ['parts', 'TB_PARTS'], ['textures', 'TB_TEXTURES'],
    ['positions', 'TB_POSITIONS'], ['uvs', 'TB_UVS'], ['joints', 'TB_JOINTS'], ['weights', 'TB_WEIGHTS'], ['vertexParts', 'TB_VPARTS'],
    ['entryStarts', 'TB_CSR'], ['entries', 'TB_ENTRIES'], ['indices', 'TB_INDICES'], ['regions', 'TB_REGIONS'], ['morphs', 'TB_MORPHS'],
    ['boneDrivers', 'TB_BDRIVERS'], ['opacityDrivers', 'TB_ODRIVERS'], ['physics', 'TB_PHYS'], ['physicsInputs', 'TB_PHYSIN'], ['animations', 'TB_ANIMS'],
    ['tracks', 'TB_TRACKS'], ['keys', 'TB_KEYS'], ['strings', 'TB_STRINGS'], ['masks', 'TB_MASKS'], ['maskParts', 'TB_MASKREFS'],
    ['colors', 'TB_COLORS'], ['colorDrivers', 'TB_CDRIVERS'], ['extraStarts', 'TB_XSTART'], ['extraWeights', 'TB_XWEIGHTS'], ['warps', 'TB_WARPS'],
    ['warpPoints', 'TB_WPOINTS'], ['warpDrivers', 'TB_WDRIVERS'], ['warpDeltas', 'TB_WDELTAS'], ['boneWarps', 'TB_BWARPS'], ['chains', 'TB_CHAINS'],
    ['chainBones', 'TB_CHAINBONES'], ['orders', 'TB_ORDERS'], ['orderDrivers', 'TB_ORDRIVERS'], ['expressions', 'TB_EXPRS'], ['expressionItems', 'TB_EXPRITEMS'],
    ['tracks11', 'TB_TRACKS11'], ['keys11', 'TB_KEYS11'], ['keyCurves', 'TB_CURVES']];
  // curve keys (1.1)
  const curveJs = jsConsts(src.curves, ['TABLE_TRACKS11', 'TABLE_KEYS11', 'TABLE_CURVES', 'CURVE_MAX_PIECES']), curveMaxC = cDefines(src.internal, ['UGO_CURVE_MAX_PIECES']);
  const orderMaxJs = src.compile.match(/ORDER_MAX = (\d+(?:\.\d+)?(?:e\d+)?)/), orderMaxC = src.internal.match(/#define UGO_ORDER_MAX (\d+(?:\.\d+)?(?:e\d+)?)f/);
  const keyType = src.internal.match(/typedef struct \{ uint(\d+)_t t, v; \} KKey;/);
  const blendUnity = jsConsts(src.unity, ['BlendNormal', 'BlendAdd', 'BlendMultiply', 'BlendScreen']);
  const blendThree = jsConsts(src.three, ['BLEND_NORMAL', 'BLEND_ADD', 'BLEND_MULTIPLY', 'BLEND_SCREEN']);
  const flagsUnity = jsConsts(src.unity, ['PartMaskInvert', 'PartHidden', 'PartSolid']);
  const exprUnity = jsConsts(src.unity, ['ExprSet', 'ExprAdd', 'ExprMultiply']);
  const errUnity = jsConsts(src.unity, ['ErrVersion', 'WarnSkippedTable', 'WarnSkippedTracks']);
  const errC = { ...cEnum(src.header, 'UGO_OK'), ...cDefines(src.header, ['UGO_WARN_SKIPPED_TABLE', 'UGO_WARN_SKIPPED_TRACKS']) };
  const flagsThree = jsConsts(src.three, flagNames);
  const shaders = [['Ugo9Character.shader', cDefines(src.unityShader, ['UGO_PART_HIDDEN', 'UGO_PART_SOLID', 'UGO_BLEND_ADD'])],
    ['ugo9.gdshader', cDefines(src.godotShader, ['UGO_PART_HIDDEN', 'UGO_PART_SOLID', 'UGO_BLEND_ADD'])]];
  const inShaders = (name) => shaders.map(([f, d]) => [f, d[name]]).filter(([, v]) => v !== undefined);
  const pascal = (s) => s[0].toUpperCase() + s.slice(1);
  const T = (pairs) => pairs.map(([key, ...values]) => ({ key, values }));
  return {
    'blend modes': T(['normal', 'add', 'multiply', 'screen'].map((b) =>
      [b, ['compile.mjs', blendJs[b]], ['web/ugo.js', blendWeb[b]], ['ugo.h', blendC[`UGO_BLEND_${b.toUpperCase()}`]],
        ['UgoCore.cs', blendUnity[`Blend${pascal(b)}`]], ['ugo_three.js', blendThree[`BLEND_${b.toUpperCase()}`]],
        ...(b === 'add' ? inShaders('UGO_BLEND_ADD') : [])])),
    'part flags': T(flagNames.map((n) =>
      [n, ['compile.mjs', flagsJs[n]], ['web/ugo.js', flagsWeb[n]], ['ugo.h', flagsC[`UGO_${n}`]],
        ['UgoCore.cs', flagsUnity[n.replace('PART_MASK_INVERT', 'PartMaskInvert').replace('PART_HIDDEN', 'PartHidden').replace('PART_SOLID', 'PartSolid')]],
        ['ugo_three.js', flagsThree[n]], ...(n === 'PART_MASK_INVERT' ? [] : inShaders(`UGO_${n}`))])),
    'track kinds': T([['param', 'TK_PARAM'], ['rotate', 'TK_BONE_ROT'], ['x', 'TK_BONE_X'], ['y', 'TK_BONE_Y'],
      ['scaleX', 'TK_BONE_SX'], ['scaleY', 'TK_BONE_SY'], ['opacity', 'TK_PART_OPACITY'], ['morph', 'TK_MORPH'],
      ['shearX', 'TK_BONE_SHX'], ['shearY', 'TK_BONE_SHY'], ['constraint', 'TK_CONS'], ['color', 'TK_COLOR'], ['order', 'TK_PART_ORDER']]
      .map(([js, c]) => [js, ['compile.mjs', kinds[js]], ['ugo_internal.h', tk[c]]])),
    'inherit modes': T([['normal', 'INHERIT_NORMAL'], ['onlyTranslation', 'INHERIT_ONLY_TRANSLATION'],
      ['noRotationOrReflection', 'INHERIT_NO_ROTATION'], ['noScale', 'INHERIT_NO_SCALE'], ['noScaleOrReflection', 'INHERIT_NO_SCALE_OR_REFLECTION']]
      .map(([js, c]) => [js, ['compile.mjs', inhJs[js]], ['ugo_internal.h', inhC[c]]])),
    'colour modes': T([['multiply', 'COLOR_MULTIPLY_SCREEN'], ['tint', 'COLOR_TINT_DARK']]
      .map(([js, c]) => [js, ['compile.mjs', colJs[js]], ['ugo_internal.h', colC[c]]])),
    'header': T([['header bytes', ['compile.mjs', hdrJs.HEADER_SIZE], ['ugo_internal.h', hdrC.UGO_HEADER_SIZE]],
      ['contents entry bytes', ['compile.mjs', hdrJs.TOC_ENTRY], ['ugo_internal.h', hdrC.UGO_TOC_ENTRY]],
      ['contents entries at most', ['compile.mjs', hdrJs.TOC_MAX], ['ugo_internal.h', hdrC.UGO_TOC_MAX]],
      ['largest draw order value', ['compile.mjs', orderMaxJs ? Number(orderMaxJs[1]) : undefined], ['ugo_internal.h', orderMaxC ? Number(orderMaxC[1]) : undefined]]]),
    'table kinds': T(KIND_NAMES.map(([js, c]) => [js, ['compile.mjs', kindsJs[js]], ['ugo_internal.h', kindsC[c]]])),
    'curve keys': T([['tracks 1.1', ['curve_keys.mjs', curveJs.TABLE_TRACKS11], ['ugo_internal.h', kindsC.TB_TRACKS11]],
      ['keys 1.1', ['curve_keys.mjs', curveJs.TABLE_KEYS11], ['ugo_internal.h', kindsC.TB_KEYS11]],
      ['key curves', ['curve_keys.mjs', curveJs.TABLE_CURVES], ['ugo_internal.h', kindsC.TB_CURVES]],
      ['pieces at most', ['curve_keys.mjs', curveJs.CURVE_MAX_PIECES], ['ugo_internal.h', curveMaxC.UGO_CURVE_MAX_PIECES]]]),
    'unknown table flags': T([['skip', 'TOC_SKIP'], ['warn', 'TOC_WARN'], ['need', 'TOC_NEED']].map(([k, c]) => [k, ['compile.mjs', tocJs[c]], ['ugo_internal.h', tocC[c]]])),
    'version errors and warnings': T([['UGO_ERR_VERSION', ['ugo.h', errC.UGO_ERR_VERSION], ['UgoCore.cs', errUnity.ErrVersion]],
      ['UGO_WARN_SKIPPED_TABLE', ['ugo.h', errC.UGO_WARN_SKIPPED_TABLE], ['UgoCore.cs', errUnity.WarnSkippedTable]],
      ['UGO_WARN_SKIPPED_TRACKS', ['ugo.h', errC.UGO_WARN_SKIPPED_TRACKS], ['UgoCore.cs', errUnity.WarnSkippedTracks]]]),
    'expression ops': T(['set', 'add', 'multiply'].map((k) => [k, ['expressions.mjs', opsJs[k]], ['web/ugo.js', opsWeb[k]],
      ['ugo.h', opsH[`UGO_EXPR_${k.toUpperCase()}`]], ['ugo_internal.h', opsC[`EXPR_${k.toUpperCase()}`]], ['UgoCore.cs', exprUnity[`Expr${pascal(k)}`]]])),
    'key time bits': T([['the largest tick', ['compile.mjs', ticksJs], ['ugo_internal.h', keyType ? 2 ** Number(keyType[1]) - 1 : undefined]]]),
    // every kind the compiler knows must exist in the core, and no more (TK_COUNT, INHERIT_COUNT, COLOR_MODE_COUNT)
    'table sizes': T([
      ['track kinds', ['compile.mjs', Object.keys(kinds).length], ['ugo_internal.h', tk.TK_COUNT]],
      ['inherit modes', ['compile.mjs', Object.keys(inhJs).length], ['ugo_internal.h', inhC.INHERIT_COUNT]],
      ['colour modes', ['compile.mjs', Object.keys(colJs).length], ['ugo_internal.h', colC.COLOR_MODE_COUNT]],
      ['expression ops', ['expressions.mjs', Object.keys(opsJs).length], ['ugo_internal.h', opsC.EXPR_OP_COUNT]],
      ['table kinds', ['compile.mjs', Object.keys(kindsJs).length + 1], ['ugo_internal.h', kindsC.TB_KNOWN]],
    ]),
  };
}

// problems as strings ("" when all agree)
function compare(src) {
  const problems = [];
  let t;
  try { t = tables(src); } catch (e) { return [`could not read: ${e.message}`]; }
  for (const [table, rows] of Object.entries(t)) {
    for (const { key, values } of rows) {
      const nums = values.map(([, v]) => v);
      if (nums.some((v) => !Number.isInteger(v))) problems.push(`${table} / ${key}: missing in ${values.filter(([, v]) => !Number.isInteger(v)).map(([f]) => f).join(', ')}`);
      else if (new Set(nums).size > 1) problems.push(`${table} / ${key}: ${values.map(([f, v]) => `${f} ${v}`).join(', ')}`);
    }
  }
  return problems;
}

const src = Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, read(p)]));
const now = compare(src);
check(now.length === 0, `the numbers agree across ${Object.values(SOURCES).join(', ')}${now.length ? `\n  ${now.join('\n  ')}` : ''}`);
const t = tables(src);
check(Object.values(t).every((rows) => rows.length > 0), `tables read: ${Object.entries(t).map(([k, r]) => `${k} ${r.length}`).join(', ')}`);

// the reading is checked too: each of these edits must be caught
const shifted = [
  ['a blend number in the compiler', 'compile', /screen: 3/, 'screen: 4'],
  ['a blend number in the Web player', 'web', /multiply: 2/, 'multiply: 5'],
  ['a blend number in ugo.h', 'header', /UGO_BLEND_ADD = 1/, 'UGO_BLEND_ADD = 7'],
  ['a part flag in the Web player', 'web', /PART_SOLID = 4/, 'PART_SOLID = 8'],
  ['a part flag in ugo.h', 'header', /UGO_PART_HIDDEN 2u/, 'UGO_PART_HIDDEN 3u'],
  ['a track kind in the compiler', 'compile', /color: 11/, 'color: 12'],
  ['a track kind in the core', 'internal', /TK_MORPH = 7/, 'TK_MORPH = 9'],
  ['a new track kind in the compiler only', 'compile', /order: 12 \}/, 'order: 12, wobble: 13 }'],
  ['the draw order kind in the core', 'internal', /TK_PART_ORDER = 12/, 'TK_PART_ORDER = 13'],
  ['the draw order kind in the compiler', 'compile', /order: 12/, 'order: 13'],
  ['the header size in the compiler', 'compile', /HEADER_SIZE = 40/, 'HEADER_SIZE = 44'],
  ['the header size in the core', 'internal', /UGO_HEADER_SIZE 40/, 'UGO_HEADER_SIZE 36'],
  ['the contents entry size in the compiler', 'compile', /TOC_ENTRY = 16/, 'TOC_ENTRY = 20'],
  ['a table kind in the compiler', 'compile', /orders: 37/, 'orders: 41'],
  ['a table kind in the core', 'internal', /TB_WARPS = 30/, 'TB_WARPS = 31'],
  ['a new table kind in the compiler only', 'compile', /expressionItems: 40,/, 'expressionItems: 40, later: 41,'],
  ['an unknown-table flag in the core', 'internal', /TOC_WARN = 1/, 'TOC_WARN = 2'],
  ['the largest draw order value in the compiler', 'compile', /ORDER_MAX = 1e6/, 'ORDER_MAX = 1e7'],
  ['expression ops swapped in the preset module', 'expressions', /\['set', 'add', 'multiply'\]/, "['add', 'set', 'multiply']"],
  ['an expression op in the Web player', 'web', /const EXPR_OPS = \['set', 'add', 'multiply'\]/, "const EXPR_OPS = ['set', 'multiply', 'add']"],
  ['an expression op in ugo.h', 'header', /UGO_EXPR_MULTIPLY = 2/, 'UGO_EXPR_MULTIPLY = 3'],
  ['a new expression op in the core only', 'internal', /EXPR_OP_COUNT = 3/, 'EXPR_OP_COUNT = 4'],
  ['an inherit mode moved in the compiler', 'compile', /'noScale', 'noScaleOrReflection'/, "'noScaleOrReflection', 'noScale'"],
  ['a colour mode swapped in the core', 'internal', /COLOR_MULTIPLY_SCREEN = 0, COLOR_TINT_DARK = 1/, 'COLOR_MULTIPLY_SCREEN = 1, COLOR_TINT_DARK = 0'],
  ['a table the reader cannot find', 'compile', /const BLEND =/, 'const BLENDS ='],
  ['the key time bits in the compiler', 'compile', /KEY_TICKS = 65535/, 'KEY_TICKS = 16383'],
  ['the key type in the core', 'internal', /uint16_t t, v; \} KKey;/, 'uint32_t t, v; } KKey;'],
  ['a blend number in Unity', 'unity', /BlendScreen = 3/, 'BlendScreen = 2'],
  ['a part flag in Unity', 'unity', /PartHidden = 2/, 'PartHidden = 4'],
  ['a blend number in three.js', 'three', /BLEND_MULTIPLY = 2/, 'BLEND_MULTIPLY = 3'],
  ['a part flag in the Unity shader', 'unityShader', /#define UGO_PART_SOLID 4/, '#define UGO_PART_SOLID 8'],
  ['the add blend in the Godot shader', 'godotShader', /#define UGO_BLEND_ADD 1/, '#define UGO_BLEND_ADD 2'],
];
for (const [label, file, from, to] of shifted) {
  const edited = src[file].replace(from, to);
  if (edited === src[file]) { check(false, `shifted copy "${label}": the edit did not apply (the source changed; update this test)`); continue; }
  const p = compare({ ...src, [file]: edited });
  check(p.length > 0, `a shifted copy is caught: ${label}${p.length ? ` (${p[0]})` : ''}`);
}

console.log(failures ? `${failures} check(s) failed` : 'all constants checks passed');
process.exit(failures ? 1 : 0);
