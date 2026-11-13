// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Expressions (format 0.8): a smile, anger, ... as changes to parameters, written by the
// parameters' names so that one set fits every model whose parameters share those names.
// The same shape is a model's `expressions` in its authoring JSON and a preset file of its own (.ug9x):
//
//   { "format": "ugo9-expressions", "version": 1, "expressions": [
//     { "id": "smile", "fadeIn": 0.5, "fadeOut": 0.5,
//       "params": { "MouthShape": ["add", 1], "EyeSmileL": ["set", 1], "BrowHeightL": ["multiply", 0.5] } } ] }
//
// Each item at weight w (0..1): set v <- v + (x - v) w, add v <- v + x w, multiply v <- v (1 + (x - 1) w).
// Plain ES module: the compiler, the Web player and the editor use it.

export const EXPR_OPS = ['set', 'add', 'multiply']; // numbers as EXPR_SET.. in core/src/ugo_internal.h
export const PRESET_FORMAT = 'ugo9-expressions';
export const FADE_DEFAULT = 0.5; // seconds, when an expression gives none

class PresetError extends Error {
  constructor(msg, path, code, vars) { super(`ugo expressions: ${path ? `[${path}] ` : ''}${msg}`); this.path = path; this.code = code; this.vars = vars; }
}

/**
 * Checks a list of expressions (as written) and returns them tidied:
 *   [{ id, fadeIn, fadeOut, items: [[paramName, op (0..2), value], ...] }]
 * Throws an Error with .path ("expressions[2].params.MouthOpen"), .code and .vars on a bad one.
 */
export function readExpressions(list, where = 'expressions') {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new PresetError('must be a list', where, 'notList', { field: where });
  const seen = new Set();
  return list.map((e, i) => {
    const at = `${where}[${i}]`;
    if (!e || typeof e.id !== 'string' || !e.id) throw new PresetError(`expression #${i} has no id`, at, 'missingId', { kind: 'expression', index: i });
    if (seen.has(e.id)) throw new PresetError(`duplicate expression id "${e.id}"`, at, 'duplicateId', { kind: 'expression', id: e.id });
    seen.add(e.id);
    const fade = (k) => {
      const v = e[k] ?? FADE_DEFAULT;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PresetError(`${k} must be a number of seconds, 0 or more`, `${at}.${k}`, 'expressionFade', { expression: e.id, field: k });
      return v;
    };
    if (e.params != null && (typeof e.params !== 'object' || Array.isArray(e.params))) throw new PresetError('"params" must be { name: [op, value] }', `${at}.params`, 'expressionItem', { expression: e.id, param: '' });
    const items = Object.entries(e.params || {}).map(([name, item]) => {
      const ok = Array.isArray(item) && item.length === 2 && EXPR_OPS.includes(item[0]) && typeof item[1] === 'number' && Number.isFinite(item[1]);
      if (!ok) throw new PresetError(`${name} must be [op, value] with op one of ${EXPR_OPS.join(', ')} and a finite value`, `${at}.params.${name}`, 'expressionItem', { expression: e.id, param: name });
      return [name, EXPR_OPS.indexOf(item[0]), item[1]];
    });
    return { id: e.id, fadeIn: fade('fadeIn'), fadeOut: fade('fadeOut'), items };
  });
}

/** A preset file's object -> its tidied expressions (see readExpressions). */
export function readPreset(preset) {
  if (!preset || preset.format !== PRESET_FORMAT) throw new PresetError(`not an expression preset (format must be "${PRESET_FORMAT}")`, 'format', 'presetFormat', {});
  if (preset.version !== 1) throw new PresetError(`preset version ${preset.version} is not known (this reads 1)`, 'version', 'presetVersion', { version: String(preset.version) });
  return readExpressions(preset.expressions);
}

/** Tidied expressions (or as written) -> a preset file's object. */
export function makePreset(expressions) {
  const tidy = expressions.every((e) => Array.isArray(e.items)) ? expressions : readExpressions(expressions);
  return {
    format: PRESET_FORMAT, version: 1,
    expressions: tidy.map((e) => ({ id: e.id, fadeIn: e.fadeIn, fadeOut: e.fadeOut, params: Object.fromEntries(e.items.map(([n, op, v]) => [n, [EXPR_OPS[op], v]])) })),
  };
}

/** The parameter names the expressions use that the model (its parameters[] or a list of ids) lacks, each once. */
export function missingParams(expressions, parameters) {
  const have = new Set((parameters || []).map((p) => (typeof p === 'string' ? p : p.id)));
  const tidy = expressions.every((e) => Array.isArray(e.items)) ? expressions : readExpressions(expressions);
  return [...new Set(tidy.flatMap((e) => e.items.map(([n]) => n)).filter((n) => !have.has(n)))];
}

/** The same math as the core (for tools without it): params { name: value } changed in place. */
export function applyExpression(params, expression, weight) {
  for (const [name, op, x] of expression.items) {
    if (!(name in params)) continue;
    const v = params[name];
    params[name] = op === 0 ? v + (x - v) * weight : op === 1 ? v + x * weight : v * (1 + (x - 1) * weight);
  }
  return params;
}
