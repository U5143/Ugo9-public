// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// UgoLayer: Ugo9 characters for 2D web engines (PixiJS, Phaser, ...). The characters are drawn
// by web/ugo.js into one offscreen WebGL2 canvas the size of the game's view (one instanced
// draw per model, as everywhere in Ugo9); the engine shows that canvas as a texture
// (web/ugo_pixi.js, web/ugo_phaser.js), refreshed once a frame. The engine's own renderer is
// never touched, so this works with any version and with WebGL1 or Canvas engines.
//
//   const layer = new UgoLayer(rt, { width: 800, height: 600 });
//   const kind = layer.addModel(model, [atlasImage]);         // once per model
//   const hero = layer.add(kind, { x: 400, y: 560, scale: 0.8 });
//   // each frame:
//   hero.instance.reset(); hero.instance.play('idle', t);     // the usual web/ugo.js calls
//   layer.render(dt);                                          // places, updates, draws
//
// Characters are in the layer's pixels (y down), drawn in the order added (or by `order`).
// The canvas is premultiplied: show it with premultiplied alpha.
import { UgoRenderer } from './ugo.js';

export class UgoLayer {
  /**
   * rt: a UgoRuntime (web/ugo.js). options: width, height (the view, pixels), resolution
   * (canvas pixels per view pixel, default 1), canvas (an existing canvas to draw into).
   */
  constructor(rt, { width = 800, height = 600, resolution = 1, canvas = null } = {}) {
    this.rt = rt;
    this.canvas = canvas ?? (typeof OffscreenCanvas !== 'undefined' && !globalThis.document ? new OffscreenCanvas(1, 1) : document.createElement('canvas'));
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('Ugo9: this browser has no WebGL2 (needed by UgoLayer)');
    this.gl = gl;
    this.kinds = [];
    this.characters = [];
    this.resolution = resolution;
    this.resize(width, height);
    this.stats = { drawCalls: 0, characters: 0 };
  }

  /** The view's size in pixels (call when the game's view changes). */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * this.resolution));
    this.canvas.height = Math.max(1, Math.round(height * this.resolution));
  }

  /** A model the layer can draw: images are its atlas images (loadImage). options: as UgoRenderer's (sampling: 'nearest' for pixel art). */
  addModel(model, images, options = {}) {
    const kind = { model, renderer: new UgoRenderer(this.gl, model, images, options), list: [] };
    this.kinds.push(kind);
    return kind;
  }

  /**
   * A character of a model: { instance, x, y, scale, scaleX, scaleY, rotation (radians), visible, order }.
   * Move it by changing those; the instance is the usual web/ugo.js UgoInstance.
   */
  add(kind, { x = 0, y = 0, scale = 1, scaleX, scaleY, rotation = 0, visible = true, order = 0 } = {}) {
    const ch = {
      kind, instance: kind.model.createInstance(), x, y, scaleX: scaleX ?? scale, scaleY: scaleY ?? scale, rotation, visible, order,
      seq: this.characters.length,
    };
    this.characters.push(ch);
    return ch;
  }

  remove(ch) {
    const i = this.characters.indexOf(ch);
    if (i >= 0) this.characters.splice(i, 1);
  }

  /**
   * Places every visible character (its transform, which swaying chains feel), updates it by dt
   * seconds (after the game set its animations and parameters) and draws the layer. Returns the canvas.
   */
  render(dt = 0) {
    const gl = this.gl, r = this.resolution;
    const shown = this.characters.filter((c) => c.visible);
    shown.sort((a, b) => a.order - b.order || a.seq - b.seq);
    for (const k of this.kinds) k.list.length = 0;
    for (const c of shown) {
      const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
      c.instance.setTransform(cos * c.scaleX * r, sin * c.scaleX * r, -sin * c.scaleY * r, cos * c.scaleY * r, c.x * r, c.y * r);
      c.instance.update(dt);
      c.kind.list.push(c.instance);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let calls = 0;
    // models draw in the order their first character comes (a model's characters draw together)
    const firsts = [];
    for (const c of shown) if (!firsts.includes(c.kind)) firsts.push(c.kind);
    for (const k of firsts) calls += k.renderer.draw(k.list, this.canvas.width, this.canvas.height).drawCalls;
    this.stats = { drawCalls: calls, characters: shown.length };
    return this.canvas;
  }

  /** The character drawn in front at a view point (x, y), and its part's name, or null. */
  pick(x, y, minOpacity = 0.01) {
    for (let i = this.characters.length - 1; i >= 0; i--) {
      const c = this.characters[i];
      if (!c.visible) continue;
      // back to the model's pixels through the character's own transform
      const dx = x - c.x, dy = y - c.y, cos = Math.cos(-c.rotation), sin = Math.sin(-c.rotation);
      const mx = (cos * dx - sin * dy) / c.scaleX, my = (sin * dx + cos * dy) / c.scaleY;
      const part = c.instance.pickPart(mx, my, minOpacity);
      if (part >= 0) return { character: c, part, name: partName(c.kind.model, part) };
    }
    return null;
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function partName(model, i) {
  return model.rt.str(model.rt.ex.ugo_part_name(model.ptr, i));
}

/**
 * UgoSpriteSheet: one cell per character in a shared WebGL2 canvas, so each character can be its own
 * sprite in the engine (sorted, moved, rotated, tinted and hidden like any sprite, between the engine's
 * other sprites). All characters still draw with one call per model; the engine shows each cell as a
 * frame of one texture (web/ugo_pixi.js spriteFor, web/ugo_phaser.js imageFor).
 *
 *   const sheet = new UgoSpriteSheet(rt);
 *   const kind = sheet.addModel(model, [atlas]);
 *   const a = sheet.add(kind, { scale: 0.5 });     // a.frame = { x, y, width, height, anchorX, anchorY } in the canvas
 *   each frame: a.instance.reset(); a.instance.play(...); a.moved(dx, dy) (optional, for swaying);
 *   sheet.render(dt)
 *
 * The character stands in its cell with its model origin at (anchorX, anchorY) of the frame (0..1), so an
 * engine sprite with that anchor puts the origin where the sprite is. A swaying chain feels the sprite move
 * through moved(dx, dy) (how far it moved since the last frame, in the cell's pixels: view pixels / the sprite's scale). Cells are the model's canvas times scale,
 * plus pad on each side (hair swinging out of the canvas is cut at the cell's edge).
 */
export class UgoSpriteSheet extends UgoLayer {
  constructor(rt, { pad = 0.15, resolution = 1, maxWidth = 2048 } = {}) {
    super(rt, { width: 1, height: 1, resolution });
    Object.assign(this, { pad, maxWidth, cursorX: 0, cursorY: 0, rowH: 0, sheetW: 1, sheetH: 1 });
  }

  add(kind, { scale = 1, visible = true } = {}) {
    const [cw, chh, ox, oy] = kind.model.canvas, r = this.resolution;
    const w = Math.ceil(cw * scale * (1 + 2 * this.pad) * r), h = Math.ceil(chh * scale * (1 + 2 * this.pad) * r);
    if (this.cursorX + w > this.maxWidth * r && this.cursorX > 0) { this.cursorX = 0; this.cursorY += this.rowH; this.rowH = 0; }
    const x = this.cursorX, y = this.cursorY;
    this.cursorX += w;
    this.rowH = Math.max(this.rowH, h);
    this.sheetW = Math.max(this.sheetW, this.cursorX);
    this.sheetH = Math.max(this.sheetH, this.cursorY + this.rowH);
    this.canvas.width = this.sheetW;
    this.canvas.height = this.sheetH;
    this.width = this.sheetW / r;
    this.height = this.sheetH / r;
    const originX = x + (cw * this.pad + ox) * scale * r, originY = y + (chh * this.pad + oy) * scale * r;
    const ch = super.add(kind, { x: originX / r, y: originY / r, scale, visible });
    ch.frame = { x, y, width: w, height: h, anchorX: (originX - x) / w, anchorY: (originY - y) / h };
    ch.cell = { x: originX / r, y: originY / r };
    ch.dx = 0; ch.dy = 0;
    ch.moved = (dx, dy) => { ch.dx += dx; ch.dy += dy; };
    if (!this.lastBuf) this.lastBuf = this.rt.alloc(16);
    return ch;
  }

  render(dt = 0) {
    // the sprite's movement, as if the character had moved from where it was: swaying chains feel it
    const r = this.resolution, rt = this.rt, ex = rt.ex;
    for (const c of this.characters) {
      if (!c.visible || (!c.dx && !c.dy)) continue;
      rt.f32(this.lastBuf, 3).set([(c.cell.x - c.dx) * r, (c.cell.y - c.dy) * r, 1]);
      ex.ugo_set_last_placement(c.instance.ptr, this.lastBuf);
      c.dx = 0; c.dy = 0;
    }
    return super.render(dt);
  }

  /** The part under a point of a character's frame (canvas pixels from the frame's top left), or null. */
  pickIn(ch, fx, fy, minOpacity = 0.01) {
    const r = this.resolution;
    const mx = ((ch.frame.x + fx) / r - ch.x) / ch.scaleX, my = ((ch.frame.y + fy) / r - ch.y) / ch.scaleY;
    const part = ch.instance.pickPart(mx, my, minOpacity);
    return part >= 0 ? partName(ch.kind.model, part) : null;
  }
}
