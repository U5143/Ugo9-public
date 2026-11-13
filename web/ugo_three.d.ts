// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for web/ugo_three.js (three.js). THREE's own objects are left loose so this needs no three types.
import type { UgoModel, UgoInstance } from './ugo.js';

/** A character: a THREE.Mesh with these added. */
export interface UgoThreeCharacterMesh {
  instance: UgoInstance;
  /** The whole character's colour (a THREE.Color) and opacity. */
  color: any;
  opacity: number;
  /** Before instance.update: the mesh's place, so swaying chains feel moves. */
  place(): void;
  /** After update: uploads the frame block and draws the masks. */
  sync(renderer: any): void;
  /** The part under a THREE.Raycaster's ray (or a world point), or null. */
  partAt(rayOrPoint: any, minOpacity?: number): string | null;
  partBounds(name?: string): [number, number, number, number] | null;
  [key: string]: any;
}

/** Shared GPU data of a model; makes its characters. */
export declare class UgoThreeCharacterFactory {
  constructor(THREE: any, model: UgoModel, textures: any | any[], options?: { maskScale?: number; sampling?: 'linear' | 'nearest' });
  readonly model: UgoModel;
  create(options?: { metresPerPixel?: number; billboard?: boolean; depth?: number }): UgoThreeCharacterMesh;
}

export declare class UgoThreeCharacter {
  constructor(factory: UgoThreeCharacterFactory, options?: { metresPerPixel?: number; billboard?: boolean; depth?: number });
}
