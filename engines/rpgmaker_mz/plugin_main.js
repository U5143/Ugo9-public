// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The plugin's own part (engines/rpgmaker_mz/build.mjs puts web/ugo.js, web/ugo_layer.js and the core's
// wasm before it in one file): Ugo9 characters drawn into one canvas (UgoLayer) shown as one PIXI sprite
// between the map / battle and the windows, driven by plugin commands, with the mouth moving while a
// message is being shown.
/* global UgoRuntime, UgoLayer, UgoBlink, UgoMouth, UgoLook, UgoExpressionMixer, loadImage, ugoWasmBytes */
/* global PluginManager, Scene_Base, Scene_Map, Scene_Battle, Graphics, TouchInput, $gameMessage, SceneManager, PIXI */

const PLUGIN = 'Ugo9';
const args = PluginManager.parameters(PLUGIN);
const settings = {
  folder: String(args.Folder || 'img/ugo9/').replace(/\/?$/, '/'),
  blink: String(args.AutoBlink ?? 'true') !== 'false',
  talk: String(args.TalkWithMessages ?? 'true') !== 'false',
};

// files next to index.html: XMLHttpRequest works in the browser and in the test play (NW.js, file://), like MZ's own loading
function readBytes(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.status < 400 ? resolve(x.response) : reject(new Error(`Ugo9: ${url}: ${x.status}`)));
    x.onerror = () => reject(new Error(`Ugo9: cannot read ${url}`));
    x.send();
  });
}

// PixiJS: MZ has v5 (Texture.from, baseTexture.update); v8 is handled too
function canvasTexture(canvas) {
  if (PIXI.CanvasSource) return new PIXI.Texture({ source: new PIXI.CanvasSource({ resource: canvas }) });
  return PIXI.Texture.from(canvas);
}
function refreshTexture(tex) {
  if (tex.source && typeof tex.source.update === 'function') tex.source.update();
  else if (tex.baseTexture) tex.baseTexture.update();
}

const Ugo9 = {
  ready: null,         // the runtime, loading
  rt: null,
  layer: null,
  sprite: null,
  texture: null,
  models: new Map(),   // folder -> Promise<kind>
  characters: new Map(), // id -> character
  speaker: '',
  error: null,

  start() {
    this.ready = UgoRuntime.load(ugoWasmBytes()).then((rt) => {
      this.rt = rt;
      this.layer = new UgoLayer(rt, { width: Graphics.width, height: Graphics.height });
      this.texture = canvasTexture(this.layer.canvas);
      this.sprite = new PIXI.Sprite(this.texture);
      return rt;
    }).catch((e) => { this.error = e; console.error(e); });
    return this.ready;
  },

  kindFor(folder) {
    const dir = settings.folder + folder.replace(/^\/|\/$/g, '') + '/';
    if (!this.models.has(dir)) {
      this.models.set(dir, (async () => {
        await this.ready;
        const model = this.rt.loadModel(await readBytes(dir + 'model.ug9'));
        const names = model.textures.length ? model.textures : ['atlas.png'];
        const images = await Promise.all(names.map(async (n) => loadImage(new Blob([await readBytes(dir + n)]))));
        return this.layer.addModel(model, images);
      })());
    }
    return this.models.get(dir);
  },

  async show(id, folder, x, y, scale, animation) {
    this.hide(id);
    const token = {};
    this.characters.set(id, token); // a hide or another show before it loads wins
    const kind = await this.kindFor(folder);
    if (this.characters.get(id) !== token) return;
    const model = kind.model;
    const ch = this.layer.add(kind, { x, y, scale });
    Object.assign(ch, {
      id, animation: animation || model.animations[0]?.name || '', time: 0, from: '', fromTime: 0, fade: 0, fadeT: 0,
      params: new Map(), blink: new UgoBlink(model, { seed: 1 + this.characters.size }), mouth: new UgoMouth(model),
      look: new UgoLook(model), lookMouse: false, mixer: new UgoExpressionMixer(model), voiceT: 0,
    });
    this.characters.set(id, ch);
  },

  get(id) { const c = this.characters.get(String(id)); return c && c.instance ? c : null; },

  hide(id) {
    const c = this.characters.get(id);
    if (c && c.instance) this.layer.remove(c);
    this.characters.delete(id);
  },

  play(id, name, fade) {
    const c = this.get(id);
    if (!c) return;
    if (fade > 0 && c.animation) { c.from = c.animation; c.fromTime = c.time; c.fade = fade; c.fadeT = 0; } else c.from = '';
    c.animation = name; c.time = 0;
  },

  // each frame, from the scene's update
  frame(scene) {
    if (!this.layer) return;
    if (this.sprite.parent !== scene) scene.addChildAt(this.sprite, scene.children.indexOf(scene._windowLayer) >= 0 ? scene.children.indexOf(scene._windowLayer) : scene.children.length);
    const dt = 1 / 60; // MZ updates its scenes 60 times a second (a slow PC runs them late, not longer)
    // a message being written out: the speaker talks
    const writing = settings.talk && $gameMessage.isBusy() && scene._messageWindow && scene._messageWindow._textState;
    for (const c of this.characters.values()) {
      if (!c.instance) continue;
      const inst = c.instance;
      c.time += dt;
      inst.reset();
      if (c.from && c.fadeT < c.fade) {
        c.fromTime += dt; c.fadeT += dt;
        inst.play(c.from, c.fromTime, 1);
        inst.play(c.animation, c.time, Math.min(1, c.fadeT / c.fade));
      } else inst.play(c.animation, c.time, 1);
      for (const [n, v] of c.params) inst.set(n, v);
      c.mixer.update(dt).apply(inst);
      if (c.lookMouse) c.look.lookAt((TouchInput.x - c.x) / c.scaleX, (TouchInput.y - c.y) / c.scaleY); else c.look.stop();
      c.look.update(dt); c.look.apply(inst);
      if (settings.blink) { c.blink.update(dt); c.blink.apply(inst); }
      if (writing && c.id === this.speaker) {
        c.voiceT += dt; // a made-up voice: syllables of 0.1-0.2 s
        c.mouth.level = Math.min(1, Math.max(0, 0.55 + 0.45 * Math.sin(c.voiceT * 31) * Math.sin(c.voiceT * 7.3)));
      } else c.mouth.level = c.id === this.speaker ? 0 : -1;
      c.mouth.update(dt); c.mouth.apply(inst);
    }
    this.layer.render(dt);
    refreshTexture(this.texture);
  },
};
window.Ugo9 = Ugo9;
Ugo9.start();

// ---- the scenes: the characters' sprite goes between the spriteset and the windows ----
for (const S of [Scene_Map, Scene_Battle]) {
  const update = S.prototype.update;
  S.prototype.update = function () { update.call(this); Ugo9.frame(this); };
}

// ---- plugin commands ----
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
PluginManager.registerCommand(PLUGIN, 'show', (a) => { Ugo9.show(String(a.id), String(a.model), num(a.x, Graphics.width / 2), num(a.y, Graphics.height), num(a.scale, 1), String(a.animation || '')); });
PluginManager.registerCommand(PLUGIN, 'hide', (a) => Ugo9.hide(String(a.id)));
PluginManager.registerCommand(PLUGIN, 'move', (a) => { const c = Ugo9.get(a.id); if (c) { c.x = num(a.x, c.x); c.y = num(a.y, c.y); const s = num(a.scale, c.scaleX); c.scaleX = c.scaleY = s; } });
PluginManager.registerCommand(PLUGIN, 'play', (a) => Ugo9.play(String(a.id), String(a.animation), num(a.fade, 0.3)));
PluginManager.registerCommand(PLUGIN, 'param', (a) => { const c = Ugo9.get(a.id); if (!c) return; if (a.value === '' || a.value === undefined) c.params.delete(String(a.name)); else c.params.set(String(a.name), Number(a.value)); });
PluginManager.registerCommand(PLUGIN, 'expression', (a) => { const c = Ugo9.get(a.id); if (!c) return; const n = String(a.name || ''); if (n) c.mixer.only(n); else c.mixer.only(); });
PluginManager.registerCommand(PLUGIN, 'speaker', (a) => { Ugo9.speaker = String(a.id || ''); });
PluginManager.registerCommand(PLUGIN, 'lookAtMouse', (a) => { const c = Ugo9.get(a.id); if (c) c.lookMouse = String(a.on) !== 'false'; });
