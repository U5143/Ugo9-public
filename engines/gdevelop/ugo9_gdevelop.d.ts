// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Types for gdjs.ugo9 (engines/gdevelop, Ugo9GDevelop.js), for JavaScript code in GDevelop written with an editor
// that reads .d.ts files. runtimeScene is GDevelop's gdjs.RuntimeScene (left loose here).
export interface Ugo9GDevelop {
  /** Shows a character (it appears once its files are read). */
  show(runtimeScene: any, id: string, url: string, x: number, y: number, options?: { scale?: number; animation?: string; layer?: string; blink?: boolean }): Promise<void>;
  hide(runtimeScene: any, id: string): void;
  move(runtimeScene: any, id: string, x: number, y: number, scale?: number): void;
  isShown(runtimeScene: any, id: string): boolean;
  /** Name, from time (seconds), fade (seconds): as the engines' Play. */
  play(runtimeScene: any, id: string, name: string, fromTime?: number, fade?: number): void;
  setParam(runtimeScene: any, id: string, name: string, value: number): void;
  clearParam(runtimeScene: any, id: string, name: string): void;
  clearParams(runtimeScene: any, id: string): void;
  getParam(runtimeScene: any, id: string, name: string): number;
  showExpression(runtimeScene: any, id: string, name: string, fade?: number): void;
  hideExpression(runtimeScene: any, id: string, name: string, fade?: number): void;
  onlyExpressions(runtimeScene: any, id: string, ...names: string[]): void;
  /** 0..1; negative: back to the animation. */
  setMouthLevel(runtimeScene: any, id: string, level: number): void;
  lookAt(runtimeScene: any, id: string, x: number, y: number): void;
  stopLooking(runtimeScene: any, id: string): void;
  /** The part drawn in front at a scene point, or ''. */
  partAt(runtimeScene: any, id: string, x: number, y: number): string;
  /** Each frame after the events (done by itself where gdjs allows it). */
  update(runtimeScene: any): void;
}

declare global {
  // eslint-disable-next-line no-var
  var gdjs: { ugo9: Ugo9GDevelop; [key: string]: any };
}
