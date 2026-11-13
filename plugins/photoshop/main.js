// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The Ugo9 check panel in Photoshop (UXP): the open document's layers checked by rules.js, each line a button that
// selects its layer, and "下塗りを足す" (an empty layer under the selected one, to paint what hides behind it: the
// forehead under the bangs, the eye white under the lids, the inside of the mouth). Written from Adobe's public UXP and
// Photoshop API documentation (require('photoshop'): app, core.executeAsModal, action.batchPlay, constants).
// Nothing is changed in the document except by the button, and that is one step to undo (Photoshop's history).
/* global Ugo9Rules */
const { app, core, action, constants } = require('photoshop');

const $ = (id) => document.getElementById(id);

// the layer tree as rules.js takes it (top first, as the Layers panel shows it)
function treeOf(layers) {
  return Array.from(layers || []).map((l) => ({
    id: l.id, name: l.name, kind: String(l.kind), visible: l.visible,
    ...(String(l.kind) === 'group' ? { children: treeOf(l.layers) } : {}),
  }));
}

async function selectLayer(id) {
  await core.executeAsModal(async () => {
    await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }], {});
  }, { commandName: 'Ugo9: select a layer' });
}

async function addUnderpaint() {
  const doc = app.activeDocument;
  const sel = doc && doc.activeLayers && doc.activeLayers[0];
  if (!sel || String(sel.kind) === 'group') { status('レイヤーを 1 つ選んでください / Select one layer first'); return; }
  await core.executeAsModal(async () => {
    const opts = { name: Ugo9Rules.underpaintName(sel.name) };
    const layer = doc.createPixelLayer ? await doc.createPixelLayer(opts) : await doc.createLayer(opts);
    layer.move(sel, constants.ElementPlacement.PLACEAFTER); // after = under it in the Layers panel
  }, { commandName: 'Ugo9: add an underpaint layer' });
  status(`「${Ugo9Rules.underpaintName(sel.name)}」を足しました / added`);
  await refresh();
}

function status(text) { $('status').textContent = text; }

async function refresh() {
  const list = $('items');
  list.textContent = '';
  const doc = app.activeDocument;
  if (!doc) { status('文書を開いてください / Open a document'); return; }
  let items;
  try { items = Ugo9Rules.checkTree(treeOf(doc.layers)); } catch (e) { status(`読めませんでした / could not read the layers: ${e.message}`); return; }
  const warn = items.filter((x) => x.level === 'warn').length;
  status(warn ? `直す所 ${warn} 件 / ${warn} to fix` : '直す所はありません / nothing to fix');
  for (const it of items) {
    const row = document.createElement('div');
    row.className = `item ${it.level}`;
    row.textContent = it.text;
    if (it.layerId !== undefined) { row.classList.add('link'); row.title = 'クリックでレイヤーを選ぶ / click to select the layer'; row.addEventListener('click', () => selectLayer(it.layerId)); }
    list.appendChild(row);
  }
}

// refresh when the document changes (debounced)
let timer = null;
const later = () => { clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 300); };
action.addNotificationListener(['open', 'close', 'select', 'make', 'delete', 'set', 'move'], later);

document.addEventListener('DOMContentLoaded', () => {
  $('refresh').addEventListener('click', () => refresh());
  $('underpaint').addEventListener('click', () => addUnderpaint().catch((e) => status(e.message)));
  refresh().catch(() => {});
});
