// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Warnings for people and for programs: each English sentence in `warnings` has a twin in
// `notes` (same order) with a code and its values, for the editor to word in its own language.
//   const { warnings, notes, note } = makeNotes();
//   note('layerEmpty', { layer: 'face/eye' }, 'layer face/eye: empty (skipped)');
//   // notes: [{ code: 'layerEmpty', vars: { layer: 'face/eye' }, level: 'warn', text: '...' }]

export function makeNotes() {
  const warnings = [], notes = [];
  const note = (code, vars, text, level = 'warn') => { warnings.push(text); notes.push({ code, vars, level, text }); };
  return { warnings, notes, note };
}
