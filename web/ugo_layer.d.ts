// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for web/ugo_layer.js (characters for 2D engines: PixiJS, Phaser, RPG Maker MZ, GDevelop).
import type { UgoRuntime, UgoModel, UgoInstance, UgoRenderer } from './ugo.js';

export interface UgoLayerKind { model: UgoModel; renderer: UgoRenderer }
export interface UgoLayerCharacter {
  kind: UgoLayerKind;
  instance: UgoInstance;
  x: number; y: number; scaleX: number; scaleY: number; rotation: number; visible: boolean; order: number;
}

/** Characters drawn into one WebGL2 canvas the size of the view, shown by the engine as a texture. */
export declare class UgoLayer {
  constructor(rt: UgoRuntime, options?: { width?: number; height?: number; resolution?: number; canvas?: HTMLCanvasElement | OffscreenCanvas });
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  stats: { drawCalls: number; characters: number };
  resize(width: number, height: number): void;
  addModel(model: UgoModel, images: Array<TexImageSource | ImageBitmap>, options?: { sampling?: 'linear' | 'nearest' }): UgoLayerKind;
  add(kind: UgoLayerKind, options?: { x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number; rotation?: number; visible?: boolean; order?: number }): UgoLayerCharacter;
  remove(ch: UgoLayerCharacter): void;
  /** Places, updates by dt and draws every visible character; returns the canvas. */
  render(dt?: number): HTMLCanvasElement | OffscreenCanvas;
  /** The character drawn in front at a view point, and its part, or null. */
  pick(x: number, y: number, minOpacity?: number): { character: UgoLayerCharacter; part: number; name: string } | null;
  dispose(): void;
}

export interface UgoSheetCharacter extends UgoLayerCharacter {
  frame: { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number };
  /** How far the engine's sprite moved since the last frame (cell pixels): swaying chains feel it. */
  moved(dx: number, dy: number): void;
}

/** One cell per character in a shared canvas: each character is its own sprite in the engine. */
export declare class UgoSpriteSheet extends UgoLayer {
  constructor(rt: UgoRuntime, options?: { pad?: number; resolution?: number; maxWidth?: number });
  add(kind: UgoLayerKind, options?: { scale?: number; visible?: boolean }): UgoSheetCharacter;
  pickIn(ch: UgoSheetCharacter, fx: number, fy: number, minOpacity?: number): string | null;
}
