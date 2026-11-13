// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for web/ugo_pixi.js (PixiJS 8). PIXI's own objects are left loose so this needs no pixi.js types.
import type { UgoLayer, UgoLayerCharacter, UgoSheetCharacter } from './ugo_layer.js';

export declare class UgoPixiLayer {
  /** PIXI: the pixi.js module. layer: a UgoLayer or UgoSpriteSheet. */
  constructor(PIXI: any, layer: UgoLayer);
  readonly layer: UgoLayer;
  /** The whole layer as one Pixi Sprite. */
  readonly sprite: any;
  /** A Pixi Sprite for one character of a UgoSpriteSheet. */
  spriteFor(ch: UgoSheetCharacter): any;
  update(dt?: number): void;
  resize(width: number, height: number): void;
  pick(x: number, y: number, minOpacity?: number): { character: UgoLayerCharacter; part: number; name: string } | null;
  destroy(): void;
}
