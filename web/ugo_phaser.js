// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 characters in Phaser (3.60+ and 4): a UgoLayer (web/ugo_layer.js) shown as one Image.
//
//   create() {
//     const layer = new UgoLayer(rt, { width: this.scale.width, height: this.scale.height });
//     const kind = layer.addModel(model, [atlasImage]);
//     this.hero = layer.add(kind, { x: 400, y: 560 });
//     this.ugo = new UgoPhaserLayer(this, layer);     // an Image at (0, 0), depth like any object
//   }
//   update(time, delta) {
//     this.hero.instance.reset(); this.hero.instance.play('idle', time / 1000);
//     this.ugo.update(delta / 1000);
//   }
//
// The image covers the view (layer pixels = game pixels; it scrolls with the camera unless
// setScrollFactor(0)). ugo.pick(x, y) names the part under a point.

let count = 0;

export class UgoPhaserLayer {
  /** scene: a Phaser.Scene. layer: a UgoLayer. key: the texture's key (made up when left out). */
  constructor(scene, layer, key = `ugo9-layer-${count++}`) {
    this.scene = scene;
    this.layer = layer;
    this.key = key;
    layer.render(0); // a first picture, so the texture has its size
    // the WebGL canvas itself is the texture's source: refreshed by re-uploading it (no 2D copy)
    this.texture = scene.textures.addImage(key, layer.canvas);
    this.image = scene.add.image(0, 0, key).setOrigin(0, 0);
    if (layer.resolution !== 1) this.image.setScale(1 / layer.resolution);
  }

  /**
   * An Image of its own for a character of a UgoSpriteSheet (the layer given to this UgoPhaserLayer): a frame of
   * the shared texture, its origin at the model's origin. Place, sort (depth) and tint it like any image; hide
   * this.image (the whole sheet). Call after the sheet's characters are added.
   */
  imageFor(ch, x = 0, y = 0) {
    const src = this.texture.source[0], c = this.layer.canvas, f = ch.frame;
    if (src.width !== c.width || src.height !== c.height) { src.width = c.width; src.height = c.height; }
    const name = `ugo9-${this.layer.characters.indexOf(ch)}`;
    if (!this.texture.has(name)) this.texture.add(name, 0, f.x, f.y, f.width, f.height);
    return this.scene.add.image(x, y, this.key, name).setOrigin(f.anchorX, f.anchorY);
  }

  /** Updates the characters by dt seconds, draws them and re-uploads the picture (once a frame). */
  update(dt = 0) {
    this.layer.render(dt);
    this.texture.source[0].update();
  }

  /** The character and part under a game point (e.g. pointer.worldX, pointer.worldY), or null. */
  pick(x, y, minOpacity) { return this.layer.pick(x - this.image.x, y - this.image.y, minOpacity); }

  destroy() {
    this.image.destroy();
    this.scene.textures.remove(this.key);
    this.layer.dispose();
  }
}
