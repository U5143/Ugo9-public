// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Ugo9 check's rules, without Photoshop (the panel's main.js gives them the open document's layers; the tests give
// them plain objects). The names are those of the automatic tools (tools/eye_mouth.mjs: the patterns below are the same
// text, and tests/photoshop_panel_test.mjs fails if they part) and of docs/PSDの描き方.md.
//
//   Ugo9Rules.checkTree(tree) -> [{ code, level: 'warn' | 'info', text, layerId? }]
//     tree: the layers top first, as Photoshop lists them: [{ id, name, kind ('pixel' | 'group' | 'text' |
//     'smartObject' | another kind: an adjustment or fill layer), visible, children (for a group) }]
//   Ugo9Rules.underpaintName(name) -> the name of the layer the panel adds under a picture
// A plain script (no modules): UXP loads it with a <script> tag; Node reads it with vm.
(function (root) {
  const BROW = /brow|眉|まゆ/i;
  const EYE = /eye|目|瞳|まぶた|瞼|まつ|睫|lash|iris|pupil|sclera/i;
  const EYE_ROLES = [
    ['lower', /lower|下まぶた|下瞼|下まつ|下睫/i],
    ['upper', /upper|上まぶた|上瞼|まつ毛|まつげ|睫|lash|lid|まぶた|瞼/i],
    ['white', /white|白目|sclera/i],
    ['iris', /iris|pupil|瞳|黒目|ハイライト|highlight/i],
  ];
  const MOUTH = /mouth|口|唇|lip|teeth|歯|tongue|舌|jaw|あご|顎/i;
  const MOUTH_ROLES = [
    ['inside', /inside|inner|口内|口の中|中|teeth|歯|tongue|舌|oral/i],
    ['lower', /lower|下唇|下|jaw|あご|顎|chin/i],
    ['upper', /upper|上唇|上/i],
  ];
  const FACE = /顔|輪郭|face/i, HAIR = /髪|hair|bang/i;
  const DEFAULT_NAME = /^(layer|レイヤー|图层|圖層|calque|ebene|capa)\s*\d*(\s*のコピー|\s*copy)?\s*\d*$/i;
  const sideIn = (s, id = s) => {
    if (/左|left/i.test(s)) return 'L';
    if (/右|right/i.test(s)) return 'R';
    if (/(?:^|[^A-Z])L\d*$|[_\-. ]l\d*$/.test(id)) return 'L';
    if (/(?:^|[^A-Z])R\d*$|[_\-. ]r\d*$/.test(id)) return 'R';
    return null;
  };
  const roleOf = (name, roles, other) => (roles.find(([, re]) => re.test(name)) || [other])[0];

  // every picture layer with its folders (outermost first)
  function flatten(tree, folders = [], out = []) {
    for (const l of tree) {
      if (l.kind === 'group') flatten(l.children || [], [...folders, l.name], out);
      else out.push({ ...l, folders });
    }
    return out;
  }

  function checkTree(tree) {
    const items = [], add = (code, level, text, layerId) => items.push({ code, level, text, ...(layerId !== undefined ? { layerId } : {}) });
    const all = flatten(tree);
    const pictures = all.filter((l) => l.kind === 'pixel' || l.kind === 'text' || l.kind === 'smartObject');
    for (const l of all) {
      if (!['pixel', 'text', 'smartObject'].includes(l.kind)) add('panelAdjustment', 'warn', `${l.name}: an adjustment or fill layer (${l.kind}) is not read: merge it into the layers below`, l.id);
      if (DEFAULT_NAME.test(String(l.name).trim())) add('panelDefaultName', 'warn', `${l.name}: a default name (the automatic tools find parts by name)`, l.id);
    }
    // eyes: their sides (the name, else the innermost folder that names one) and their upper lids
    const eyes = pictures.filter((l) => EYE.test(l.name) && !BROW.test(l.name));
    const sideOf = (l) => sideIn(l.name) || [...l.folders].reverse().map((f) => sideIn(String(f))).find(Boolean) || null;
    const bySide = { L: [], R: [] }, noSide = [];
    for (const l of eyes) { const s = sideOf(l); if (s) bySide[s].push(l); else noSide.push(l); }
    if (!eyes.length) add('panelNoEyes', 'warn', 'no eye layers found by name (目 / 白目 / 瞳 / まぶた / eye ...)');
    for (const l of noSide) add('panelEyeNoSide', 'warn', `${l.name}: no side in its name or its folders (左 / 右 / left / right, or L / R at the end; or a 左目 folder)`, l.id);
    for (const s of ['L', 'R']) if (bySide[s].length && !bySide[s].some((l) => roleOf(l.name, EYE_ROLES, 'other') === 'upper'))
      add('panelNoUpperLid', 'warn', `eye ${s}: no upper lid or lashes (上まぶた / まつ毛 / upper lid): the eye can only be squashed`);
    // the mouth: in three (upper lip, lower lip, inside) opens well
    const mouth = pictures.filter((l) => MOUTH.test(l.name));
    const roles = new Set(mouth.map((l) => roleOf(l.name, MOUTH_ROLES, 'other')));
    if (!mouth.length) add('panelNoMouth', 'warn', 'no mouth layers found by name (口 / 唇 / mouth ...)');
    else if (!roles.has('lower')) add('panelMouthSplit', 'warn', `the mouth: split it into the upper lip (上唇), the lower lip (下唇) and the inside (口の中) to open it well (now: ${mouth.map((l) => l.name).join(', ')})`, mouth[0].id);
    // the face, for the face angles
    if (!pictures.some((l) => FACE.test(l.name) && !HAIR.test(l.name))) add('panelNoFace', 'warn', 'no face picture found by name (顔 / 輪郭 / face): the face angles need it');
    // names given twice in the same folder (read as name_2, name_3)
    const seen = new Map();
    for (const l of pictures) { const k = `${l.folders.join('/')}/${l.name}`; seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, n] of seen) if (n > 1) add('panelSameName', 'info', `${k.replace(/^\//, '')}: ${n} layers of this name (read as _2, _3 ...)`);
    // hidden places: what is often under something else and needs drawing
    const has = (re) => pictures.some((l) => re.test(l.name));
    if (has(/前髪|bang/i) && !has(/おでこ|額|forehead/i) && !has(FACE)) add('panelUnderBangs', 'info', 'the forehead under the bangs: is it drawn (on the face, or as its own layer)?');
    if (mouth.length && !roles.has('inside')) add('panelMouthInside', 'info', 'the inside of the mouth (口の中): draw it so the mouth can open');
    return items;
  }

  const underpaintName = (name) => `${name} 下塗り`;
  const api = { checkTree, underpaintName, sideIn, PATTERNS: { BROW, EYE, MOUTH, EYE_ROLES, MOUTH_ROLES } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Ugo9Rules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
