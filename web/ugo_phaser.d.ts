// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for web/ugo_phaser.js (Phaser 4). Phaser's own objects are left loose so this needs no phaser types.
import type { UgoLayer, UgoLayerCharacter, UgoSheetCharacter } from './ugo_layer.js';

export declare class UgoPhaserLayer {
  /** scene: a Phaser.Scene. layer: a UgoLayer or UgoSpriteSheet. */
  constructor(scene: any, layer: UgoLayer, key?: string);
  readonly layer: UgoLayer;
  /** The whole layer as one Phaser Image. */
  readonly image: any;
  /** A Phaser Image for one character of a UgoSpriteSheet. */
  imageFor(ch: UgoSheetCharacter, x?: number, y?: number): any;
  update(dt?: number): void;
  pick(x: number, y: number, minOpacity?: number): { character: UgoLayerCharacter; part: number; name: string } | null;
  destroy(): void;
}
