// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 characters in PixiJS (v8): a UgoLayer (web/ugo_layer.js) shown as one Pixi Sprite.
//
//   import * as PIXI from 'pixi.js';
//   const layer = new UgoLayer(rt, { width: app.screen.width, height: app.screen.height });
//   const kind = layer.addModel(model, [atlasImage]);
//   const hero = layer.add(kind, { x: 400, y: 560 });
//   const ugo = new UgoPixiLayer(PIXI, layer);
//   app.stage.addChild(ugo.sprite);          // between other sprites, like any sprite
//   app.ticker.add((t) => { hero.instance.reset(); hero.instance.play('idle', time); ugo.update(t.deltaMS / 1000); });
//
// The sprite covers the view (layer pixels = stage pixels); put several layers to draw
// characters between other sprites. ugo.pick(x, y) names the part under a stage point.

export class UgoPixiLayer {
  /** PIXI: the pixi.js module (v8). layer: a UgoLayer. */
  constructor(PIXI, layer) {
    this.layer = layer;
    this.PIXI = PIXI;
    // the canvas holds premultiplied colour; Pixi uploads canvases premultiplied (its default)
    this.source = new PIXI.CanvasSource({ resource: layer.canvas, resolution: layer.resolution });
    this.texture = new PIXI.Texture({ source: this.source });
    this.sprite = new PIXI.Sprite(this.texture);
    this.sprite.label = 'Ugo9';
  }

  /**
   * A sprite of its own for a character of a UgoSpriteSheet (the layer given to this UgoPixiLayer): a frame of
   * the shared texture, anchored at the model's origin. Place, sort and tint it like any sprite; this.sprite
   * (the whole sheet) is then not added to the stage. Call after the sheet's characters are added.
   */
  spriteFor(ch) {
    const r = this.layer.resolution, f = ch.frame;
    if (this.source.pixelWidth !== this.layer.canvas.width || this.source.pixelHeight !== this.layer.canvas.height) {
      this.source.resize(this.layer.canvas.width / r, this.layer.canvas.height / r, r);
    }
    const tex = new this.PIXI.Texture({ source: this.source, frame: new this.PIXI.Rectangle(f.x / r, f.y / r, f.width / r, f.height / r) });
    const s = new this.PIXI.Sprite(tex);
    s.anchor.set(f.anchorX, f.anchorY);
    s.label = 'Ugo9 character';
    return s;
  }

  /** Updates the characters by dt seconds, draws them and hands the picture to Pixi (once a frame). */
  update(dt = 0) {
    this.layer.render(dt);
    this.source.update();
  }

  /** The view's size changed (e.g. app.renderer.on('resize')). */
  resize(width, height) {
    this.layer.resize(width, height);
    this.source.resize(width, height, this.layer.resolution);
  }

  /** The character and part under a point of the sprite's space (e.g. a pointer event's getLocalPosition(sprite)), or null. */
  pick(x, y, minOpacity) { return this.layer.pick(x, y, minOpacity); }

  destroy() {
    this.sprite.destroy();
    this.texture.destroy(true);
    this.layer.dispose();
  }
}
