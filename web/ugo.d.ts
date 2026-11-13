// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for web/ugo.js (the Web runtime). Only the public names; tests/web_types_test.mjs checks every
// name here exists on the real module and that tests/types/example.ts type-checks against it.

/** Blend modes of parts, as the core numbers them. */
export declare const BLEND: { readonly normal: 0; readonly add: 1; readonly multiply: 2; readonly screen: 3 };

/** The core (WebAssembly). One per page is enough; models and instances come from it. */
export declare class UgoRuntime {
  /** Loads the core: from ugo.wasm next to ugo.js, a URL, or its bytes. Where the browser has WebAssembly SIMD, a URL
   * ending in ugo.wasm loads ugo_simd.wasm next to it (the same results, faster; ugo.wasm if it is missing).
   * options.simd: false loads the given file. */
  static load(source?: string | URL | ArrayBuffer | ArrayBufferView, options?: { simd?: boolean }): Promise<UgoRuntime>;
  /** From the bytes of ugo.wasm or ugo_simd.wasm. */
  static fromBytes(bytes: ArrayBuffer | ArrayBufferView): Promise<UgoRuntime>;
  /** Whether this browser runs WebAssembly SIMD. */
  static simdSupported(): boolean;
  /** Whether the SIMD build (ugo_simd.wasm) runs. */
  readonly simd: boolean;
  /** A model from .ug9 bytes (throws with the reason when they cannot be read). */
  loadModel(bytes: ArrayBuffer | ArrayBufferView): UgoModel;
}

export interface UgoParamInfo { name: string; min: number; max: number; def: number }
export interface UgoAnimationInfo { name: string; duration: number; loop: boolean }
export interface UgoBoneInfo { name: string; parent: number; length: number; rest: { x: number; y: number; rotate: number; scaleX: number; scaleY: number } }
export interface UgoExpressionInfo { name: string; fadeIn: number; fadeOut: number; items: Array<[string, number, number]> }
/** A preset's expression as written ({ id, fadeIn, fadeOut, params: { name: [op, value] } }). */
export interface UgoExpressionPresetItem { id: string; fadeIn?: number; fadeOut?: number; params: Record<string, ['set' | 'add' | 'multiply', number]> }
export interface UgoExpressionPreset { format: 'ugo9-expressions'; version: number; expressions: UgoExpressionPresetItem[] }

/** A loaded .ug9: names, ranges, and instances of it. */
export declare class UgoModel {
  readonly rt: UgoRuntime;
  /** width, height, origin x, origin y (model pixels, y down) */
  readonly canvas: [number, number, number, number];
  readonly params: UgoParamInfo[];
  readonly paramIndex: Map<string, number>;
  readonly animations: UgoAnimationInfo[];
  readonly animationIndex: Map<string, number>;
  readonly bones: UgoBoneInfo[];
  readonly textures: string[];
  readonly expressions: UgoExpressionInfo[];
  readonly expressionIndex: Map<string, number>;
  /** Hit areas: parts named "hit:<name>" or "当たり:<name>". */
  readonly hitAreas: Array<{ name: string; part: number }>;
  readonly partCount: number;
  readonly vertexCount: number;
  readonly frameFloats: number;
  readonly hasDrawOrder: boolean;
  /** What a later 1.x file had that this core skipped (0: nothing). */
  readonly warnings: number;
  createInstance(): UgoInstance;
  /** A mask for layers: only these bones / parts / parameters (by name or number; left out: all of that kind). */
  animationMask(spec?: { bones?: Array<string | number>; parts?: Array<string | number>; params?: Array<string | number> }): UgoAnimMask;
  boneIndex(name: string): number | undefined;
  partIndex(name: string): number | undefined;
  /** Binds a preset's expressions to this model's parameters. */
  loadExpressions(preset: UgoExpressionPreset | UgoExpressionPresetItem[]): { expressions: Array<{ name: string; fadeIn: number; fadeOut: number; missing: string[] }>; missing: string[] };
  /** This model's expressions as a preset file's object. */
  exportExpressions(): UgoExpressionPreset;
}

/** Which tracks an animation applies (UgoModel.animationMask). */
export interface UgoAnimMask { readonly ptr: number }

/** One character's state: parameters, animation time, physics. */
export declare class UgoInstance {
  readonly model: UgoModel;
  /** Parameters back to their defaults (each frame, before the animations). */
  reset(): void;
  resetPhysics(): void;
  set(nameOrIndex: string | number, value: number): void;
  get(nameOrIndex: string | number): number;
  /** Applies an animation at a time (seconds) and weight; opts.add adds its change from the rest pose, opts.mask limits it. */
  play(nameOrIndex: string | number, time: number, weight?: number, opts?: { add?: boolean; mask?: UgoAnimMask }): void;
  /** Applies an expression (the model's, by name or number, or a preset's) at a weight. */
  expression(e: string | number | object, weight?: number): void;
  /** Placement in model pixels: (x, y) -> (a·x + c·y + tx, b·x + d·y + ty). Before update: swaying chains feel moves. */
  setTransform(a: number, b: number, c: number, d: number, tx: number, ty: number): void;
  update(dt: number): void;
  setWind(x: number, y: number, gust?: number): void;
  settlePhysics(seconds?: number): void;
  /** After update: the part drawn in front at (x, y), model pixels, or -1. */
  pickPart(x: number, y: number, minOpacity?: number): number;
  /** After update: the hit area at (x, y) ("head" for a part "hit:head"), or null. */
  hitTest(x: number, y: number): string | null;
  /** After update: [x0, y0, x1, y1] around a part (name or number; -1: all drawn), or null. */
  bounds(part?: string | number): [number, number, number, number] | null;
  boundsEstimate(): [number, number, number, number] | null;
  /** After update: the bone's world matrix [a, b, c, d, tx, ty], before the placement. */
  boneWorld(bone: string | number): number[];
  boneWorldPlaced(bone: string | number): number[];
  /** Turns the bone and up to count - 1 of its parents so its tip reaches (x, y); update again to see it. */
  dragBone(bone: string | number, x: number, y: number, count?: number, iterations?: number): number;
  setBoneOffset(bone: string | number, pose: { x?: number; y?: number; rotate?: number; scaleX?: number; scaleY?: number }, weight?: number): void;
  saveState(): unknown;
  loadState(state: unknown): void;
  copyStateFrom(other: UgoInstance): void;
  /** After update (format 0.8): 0 while the parts draw in their stored order. */
  drawOrderKey(): number;
  drawOrder(): Uint32Array;
  frame(): Float32Array;
}

export interface UgoAnimatorEntry { name: string; time: number; from: number; to: number; loop: boolean; speed: number; weight: number; add: boolean; done: boolean }
export interface UgoAnimatorOptions { layer?: number; fade?: number; loop?: boolean; speed?: number; weight?: number; add?: boolean; mask?: UgoAnimMask; from?: number; to?: number }

/** Animation layers with cross-fades and queues (the engines' Play / PlayLayer / PlayNext). */
export declare class UgoAnimator {
  constructor(model: UgoModel);
  /** 'end': a non-looping animation reached its end. */
  on(event: 'end', fn: (ended: { layer: number; name: string }) => void): this;
  play(name: string | number, options?: UgoAnimatorOptions): UgoAnimatorEntry;
  queue(name: string | number, options?: UgoAnimatorOptions): UgoAnimatorEntry;
  stop(layer?: number, fade?: number): void;
  update(dt: number): void;
  apply(instance: UgoInstance): void;
  save(): unknown;
  load(state: unknown): void;
}

/** Expressions shown and hidden with fades. */
export declare class UgoExpressionMixer {
  constructor(model: UgoModel);
  show(e: string | number | object, fadeIn?: number): this;
  hide(e: string | number | object, fadeOut?: number): this;
  only(...list: Array<string | number | object>): this;
  update(dt: number): this;
  weights(): Array<[string | number | object, number]>;
  apply(instance: UgoInstance): void;
}

/** Face, eyes and a little of the body turn towards a point. */
export declare class UgoLook {
  constructor(model: UgoModel, options?: { range?: number; smoothing?: number; body?: number; from?: [number, number] });
  lookAt(x: number, y: number): void;
  stop(): void;
  update(dt: number): void;
  apply(instance: UgoInstance): void;
}

/** Blinking on its own. */
export declare class UgoBlink {
  constructor(model: UgoModel, options?: { min?: number; max?: number; close?: number; open?: number; seed?: number });
  update(dt: number): void;
  apply(instance: UgoInstance): void;
}

/** The mouth following a level (0..1; negative: left to the animation). */
export declare class UgoMouth {
  constructor(model: UgoModel, options?: { smoothing?: number });
  level: number;
  update(dt: number): void;
  apply(instance: UgoInstance): void;
}

/** Linked parameters, set from code. */
export declare class UgoLinks {
  constructor(model: UgoModel);
  add(link: { from: string | number; to: string | number; scale?: number; delay?: number; invert?: boolean }): this;
  update(dt: number, instance: UgoInstance): void;
  apply(instance: UgoInstance): void;
}

/** Any frame of an animation at a fixed rate, the same every time (for video and seeking): frame(n) gives the instance at frame n. */
export declare class UgoFrames {
  constructor(model: UgoModel, options?: { fps?: number; setup?: (instance: UgoInstance, seconds: number, n: number) => void; every?: number; instance?: UgoInstance });
  readonly fps: number;
  frame(n: number): UgoInstance;
}

/** Draws a model's instances with WebGL2 (one draw per run of parts, any number of instances). */
export declare class UgoRenderer {
  constructor(gl: WebGL2RenderingContext, model: UgoModel, images: Array<TexImageSource | ImageBitmap>, options?: { sampling?: 'linear' | 'nearest' });
  /** Draws the instances (after their update) into a width × height target. */
  draw(instances: UgoInstance[], width: number, height: number, mode?: 'gpu' | 'cpu'): { drawCalls: number; uploadBytes: number; cpuDeformMs: number };
  setSampling(sampling: 'linear' | 'nearest'): void;
  dispose(): void;
  /** The texels to put beside an atlas page smaller than the texture array's layers (aw × ah): its last column and
   * row repeated (up to 64 texels, and the corner), so its mipmaps do not mix in the padding. [] for a full-size page. */
  static pageEdges(image: TexImageSource | ImageBitmap, aw: number, ah: number): Array<{ source: OffscreenCanvas; x: number; y: number }>;
}

/** An image for UgoRenderer (premultiplied), from a URL or a Blob. */
export declare function loadImage(src: string | URL | Blob): Promise<ImageBitmap>;
