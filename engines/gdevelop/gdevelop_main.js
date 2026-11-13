// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 in GDevelop (engines/gdevelop/build.mjs puts the Web runtime before this in one file). Characters of
// a scene are drawn into one canvas (UgoLayer) shown as one PIXI sprite on a GDevelop layer, following the
// layer's camera (position; zoom and rotation not yet). Everything is under gdjs.ugo9, called from
// "JavaScript code" events:
//
//   gdjs.ugo9.show(runtimeScene, 'hero', 'ugo9/hero/model.ug9', 400, 600, { scale: 0.5 });  // once
//   gdjs.ugo9.play(runtimeScene, 'hero', 'talk', 0, 0.3);   // name, from time, fade (as the engines' Play)
//   gdjs.ugo9.setParam(runtimeScene, 'hero', 'HeadTurnX', 20);
//   gdjs.ugo9.partAt(runtimeScene, 'hero', x, y)   // -> 'face', ... or ''
//
// The model's file and its PNGs are fetched by URL, relative to the game's page (put them with the
// game's files). Each frame the scene's characters update after its events.
/* global gdjs, PIXI, UgoRuntime, UgoLayer, UgoBlink, UgoMouth, UgoLook, UgoExpressionMixer, loadImage, ugoWasmBytes */

async function readBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Ugo9: ${url}: ${r.status}`);
  return r.arrayBuffer();
}
// PixiJS 7 (GDevelop 5): Texture.from and baseTexture.update; v8 too
function canvasTexture(canvas) {
  if (PIXI.CanvasSource) return new PIXI.Texture({ source: new PIXI.CanvasSource({ resource: canvas }) });
  return PIXI.Texture.from(canvas);
}
function refreshTexture(tex) {
  if (tex.source && typeof tex.source.update === 'function') tex.source.update();
  else if (tex.baseTexture) tex.baseTexture.update();
}

let runtimePromise = null;
const runtime = () => (runtimePromise ??= UgoRuntime.load(ugoWasmBytes()));

// one per scene: its layer, sprite, models and characters
const scenes = new WeakMap();
function stateOf(runtimeScene, layerName = '') {
  let s = scenes.get(runtimeScene);
  if (!s) {
    s = { layerName, rt: null, layer: null, sprite: null, texture: null, models: new Map(), characters: new Map(), ready: null };
    s.ready = runtime().then((rt) => {
      const game = runtimeScene.getGame();
      s.rt = rt;
      s.layer = new UgoLayer(rt, { width: game.getGameResolutionWidth(), height: game.getGameResolutionHeight() });
      s.texture = canvasTexture(s.layer.canvas);
      s.sprite = new PIXI.Sprite(s.texture);
      runtimeScene.getLayer(s.layerName).getRendererObject().addChild(s.sprite);
      return s;
    });
    scenes.set(runtimeScene, s);
  }
  return s;
}

function kindFor(s, url) {
  if (!s.models.has(url)) {
    s.models.set(url, (async () => {
      await s.ready;
      const model = s.rt.loadModel(await readBytes(url));
      const dir = url.replace(/[^/]*$/, '');
      const names = model.textures.length ? model.textures : ['atlas.png'];
      const images = await Promise.all(names.map(async (n) => loadImage(new Blob([await readBytes(dir + n)]))));
      return s.layer.addModel(model, images);
    })());
  }
  return s.models.get(url);
}

const get = (runtimeScene, id) => { const c = scenes.get(runtimeScene)?.characters.get(String(id)); return c && c.instance ? c : null; };

const ugo9 = {
  /** Shows a character (it appears once its files are read). options: scale, animation, layer (the GDevelop layer's name, first call per scene), blink. */
  async show(runtimeScene, id, url, x, y, { scale = 1, animation = '', layer = '', blink = true } = {}) {
    id = String(id);
    const s = stateOf(runtimeScene, layer);
    ugo9.hide(runtimeScene, id);
    const token = {};
    s.characters.set(id, token);
    const kind = await kindFor(s, url);
    if (s.characters.get(id) !== token) return;
    const model = kind.model;
    const ch = s.layer.add(kind, { x, y, scale });
    Object.assign(ch, {
      id, sceneX: x, sceneY: y, animation: animation || model.animations[0]?.name || '', time: 0, from: '', fromTime: 0, fade: 0, fadeT: 0,
      params: new Map(), autoBlink: blink, blinker: new UgoBlink(model, { seed: 1 + s.characters.size }), mouth: new UgoMouth(model),
      look: new UgoLook(model), lookAt: null, mixer: new UgoExpressionMixer(model),
    });
    s.characters.set(id, ch);
  },
  hide(runtimeScene, id) {
    const s = scenes.get(runtimeScene);
    const c = s?.characters.get(String(id));
    if (c && c.instance) s.layer.remove(c);
    s?.characters.delete(String(id));
  },
  move(runtimeScene, id, x, y, scale) {
    const c = get(runtimeScene, id);
    if (!c) return;
    c.sceneX = x; c.sceneY = y;
    if (scale !== undefined) c.scaleX = c.scaleY = scale;
  },
  /** Plays an animation from fromTime (seconds); fade > 0 blends from the one playing now (the same arguments as the engines' Play). */
  play(runtimeScene, id, name, fromTime = 0, fade = 0) {
    const c = get(runtimeScene, id);
    if (!c) return;
    if (fade > 0 && c.animation) { c.from = c.animation; c.fromTime = c.time; c.fade = fade; c.fadeT = 0; } else c.from = '';
    c.animation = name; c.time = fromTime;
  },
  /** Keeps a parameter at a value over the animation (until clearParam). */
  setParam(runtimeScene, id, name, value) { const c = get(runtimeScene, id); if (c) c.params.set(name, value); },
  clearParam(runtimeScene, id, name) { const c = get(runtimeScene, id); if (c) c.params.delete(name); },
  clearParams(runtimeScene, id) { const c = get(runtimeScene, id); if (c) c.params.clear(); },
  getParam(runtimeScene, id, name) { const c = get(runtimeScene, id); return c ? c.instance.get(name) : 0; },
  /** The model's expressions, faded in and out (fade < 0 or left out: the expression's own time). */
  showExpression(runtimeScene, id, name, fade) { const c = get(runtimeScene, id); if (c) c.mixer.show(name, fade >= 0 ? fade : undefined); },
  hideExpression(runtimeScene, id, name, fade) { const c = get(runtimeScene, id); if (c) c.mixer.hide(name, fade >= 0 ? fade : undefined); },
  /** Shows only these (the others fade out); none: hides them all. */
  onlyExpressions(runtimeScene, id, ...names) { const c = get(runtimeScene, id); if (c) c.mixer.only(...names); },
  /** The mouth's opening 0..1 (e.g. while a dialogue line shows); negative: back to the animation. */
  setMouthLevel(runtimeScene, id, level) { const c = get(runtimeScene, id); if (c) c.mouth.level = level; },
  /** Face and eyes turn towards this scene point until stopLooking. */
  lookAt(runtimeScene, id, x, y) { const c = get(runtimeScene, id); if (c) c.lookAt = [x, y]; },
  stopLooking(runtimeScene, id) { const c = get(runtimeScene, id); if (c) c.lookAt = null; },
  /** The part drawn in front at a scene point, or ''. */
  partAt(runtimeScene, id, x, y) {
    const c = get(runtimeScene, id);
    if (!c) return '';
    const p = c.instance.pickPart((x - c.sceneX) / c.scaleX, (y - c.sceneY) / c.scaleY, 0.01);
    const m = c.kind.model;
    return p >= 0 ? m.rt.str(m.rt.ex.ugo_part_name(m.ptr, p)) : '';
  },
  /** True once the character's files are read and it is shown. */
  isShown(runtimeScene, id) { return get(runtimeScene, id) !== null; },

  /** Each frame (after the scene's events; registered below when gdjs allows it). */
  update(runtimeScene) {
    const s = scenes.get(runtimeScene);
    if (!s || !s.layer) return;
    const dt = Math.min(0.1, runtimeScene.getElapsedTime() / 1000);
    // the canvas covers the camera's view; characters are drawn at their scene points minus its corner
    const gl = runtimeScene.getLayer(s.layerName);
    const left = gl.getCameraX() - s.layer.width / 2, top = gl.getCameraY() - s.layer.height / 2;
    s.sprite.position.set(left, top);
    for (const c of s.characters.values()) {
      if (!c.instance) continue;
      c.x = c.sceneX - left; c.y = c.sceneY - top;
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
      if (c.lookAt) c.look.lookAt((c.lookAt[0] - c.sceneX) / c.scaleX, (c.lookAt[1] - c.sceneY) / c.scaleY); else c.look.stop();
      c.look.update(dt); c.look.apply(inst);
      if (c.autoBlink) { c.blinker.update(dt); c.blinker.apply(inst); }
      c.mouth.update(dt); c.mouth.apply(inst);
    }
    s.layer.render(dt);
    refreshTexture(s.texture);
  },
};

gdjs.ugo9 = ugo9;
if (typeof gdjs.registerRuntimeScenePostEventsCallback === 'function') gdjs.registerRuntimeScenePostEventsCallback((runtimeScene) => ugo9.update(runtimeScene));
