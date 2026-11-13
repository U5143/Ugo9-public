// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Example code against the Web runtime's types (web/*.d.ts) and gdjs.ugo9's: type-checked by tests/web_types_test.mjs
// (tsc --strict --noEmit), never run. The names are those of docs/エンジンのAPI.md's Web column.
import { UgoRuntime, UgoFrames, UgoAnimator, UgoExpressionMixer, UgoLook, UgoBlink, UgoMouth, UgoRenderer, loadImage, BLEND } from '../../web/ugo.js';
import type { UgoModel, UgoInstance } from '../../web/ugo.js';
import { UgoLayer, UgoSpriteSheet } from '../../web/ugo_layer.js';
import { UgoPixiLayer } from '../../web/ugo_pixi.js';
import { UgoPhaserLayer } from '../../web/ugo_phaser.js';
import { UgoThreeCharacterFactory } from '../../web/ugo_three.js';
import '../../engines/gdevelop/ugo9_gdevelop.js';

declare const PIXI: any, THREE: any, phaserScene: any, runtimeScene: any;

export async function web(bytes: ArrayBuffer, gl: WebGL2RenderingContext): Promise<number> {
  const rt: UgoRuntime = await UgoRuntime.load();
  const model: UgoModel = rt.loadModel(bytes);
  const [w, h] = model.canvas;
  const inst: UgoInstance = model.createInstance();
  const anim = new UgoAnimator(model).on('end', ({ layer, name }) => console.log(layer, name));
  anim.play('idle', { fade: 0.3 });
  anim.play('wave', { layer: 1, mask: model.animationMask({ bones: ['armR'] }), add: false });
  anim.queue('idle');
  const mixer = new UgoExpressionMixer(model).show('smile', 0.3);
  const look = new UgoLook(model), blink = new UgoBlink(model), mouth = new UgoMouth(model);
  look.lookAt(100, -300);
  mouth.level = 0.5;
  // a frame
  inst.reset();
  anim.update(1 / 60); anim.apply(inst);
  inst.set('HeadTurnX', 20);
  mixer.update(1 / 60).apply(inst);
  look.update(1 / 60); look.apply(inst);
  blink.update(1 / 60); blink.apply(inst);
  mouth.update(1 / 60); mouth.apply(inst);
  inst.setWind(300, 0, 0.5);
  inst.setTransform(1, 0, 0, 1, w / 2, h);
  inst.update(1 / 60);
  const part: number = inst.pickPart(0, -330);
  const area: string | null = inst.hitTest(0, -330);
  const box = inst.bounds('face');
  const hand: number[] = inst.boneWorld('handR');
  inst.dragBone('handR', 100, -200);
  const renderer = new UgoRenderer(gl, model, [await loadImage('atlas.png')], { sampling: 'nearest' });
  const { drawCalls } = renderer.draw([inst], 800, 600);
  const video = new UgoFrames(model, { fps: 30, setup: (i, t) => i.play('idle', t) });
  renderer.draw([video.frame(12)], 800, 600);
  void area; void box; void hand; void BLEND.multiply;
  return part + drawCalls;
}

export async function engines(rt: UgoRuntime, model: UgoModel, image: ImageBitmap): Promise<void> {
  const layer = new UgoLayer(rt, { width: 800, height: 600 });
  const kind = layer.addModel(model, [image]);
  const hero = layer.add(kind, { x: 400, y: 560, scale: 0.8 });
  hero.instance.reset(); hero.instance.play('idle', 0);
  const pixi = new UgoPixiLayer(PIXI, layer);
  pixi.update(1 / 60);
  const hit = pixi.pick(400, 300);
  const sheet = new UgoSpriteSheet(rt);
  const one = sheet.add(sheet.addModel(model, [image]), { scale: 0.5 });
  one.moved(2, 0);
  const phaser = new UgoPhaserLayer(phaserScene, sheet);
  phaser.imageFor(one, 100, 100);
  const factory = new UgoThreeCharacterFactory(THREE, model, new THREE.Texture(image));
  const mesh = factory.create({ metresPerPixel: 0.002 });
  mesh.place(); mesh.instance.update(1 / 60); mesh.sync(null);
  const name: string | null = mesh.partAt(null);
  // GDevelop
  await gdjs.ugo9.show(runtimeScene, 'hero', 'ugo9/hero/model.ug9', 400, 600, { scale: 0.5 });
  gdjs.ugo9.play(runtimeScene, 'hero', 'talk', 0, 0.3);
  gdjs.ugo9.onlyExpressions(runtimeScene, 'hero', 'smile');
  gdjs.ugo9.setMouthLevel(runtimeScene, 'hero', 0.8);
  const p: string = gdjs.ugo9.partAt(runtimeScene, 'hero', 400, 300);
  void hit; void name; void p;
}
