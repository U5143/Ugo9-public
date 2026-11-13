// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Blend modes as drawing apps define them, on straight colours 0..1: f(backdrop, source) -> the
// blended colour, for one RGB triple (the separable ones work channel by channel). The formulas are
// the W3C "Compositing and Blending" ones and the usual ones for Photoshop's extra modes.
// Used where pictures are mixed on the CPU: the PSD importer bakes clipped layers into their base,
// replaceLayerPixels draws the merged picture.

const sep = (g) => (b, s) => [g(b[0], s[0]), g(b[1], s[1]), g(b[2], s[2])];
const clamp = (x) => Math.max(0, Math.min(1, x));
const dodge = (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const hardLight = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
const vivid = (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1));
// the non-separable ones: luminosity and saturation (W3C)
const lum = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c) {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  if (n < 0) c = c.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return c;
}
const setLum = (c, l) => { const d = l - lum(c); return clipColor(c.map((v) => v + d)); };
const sat = (c) => Math.max(...c) - Math.min(...c);
function setSat(c, s) {
  const x = Math.max(...c), n = Math.min(...c);
  if (x === n) return [0, 0, 0];
  return c.map((v) => ((v - n) * s) / (x - n));
}

export const BLEND_FUNCTIONS = {
  normal: (b, s) => s,
  multiply: sep((b, s) => b * s),
  screen: sep((b, s) => b + s - b * s),
  add: sep((b, s) => Math.min(1, b + s)), // linear dodge
  subtract: sep((b, s) => Math.max(0, b - s)),
  darken: sep(Math.min),
  lighten: sep(Math.max),
  difference: sep((b, s) => Math.abs(b - s)),
  exclusion: sep((b, s) => b + s - 2 * b * s),
  linearBurn: sep((b, s) => Math.max(0, b + s - 1)),
  hardLight: sep(hardLight),
  overlay: sep((b, s) => hardLight(s, b)),
  softLight: sep((b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b))),
  colorDodge: sep(dodge),
  colorBurn: sep(burn),
  divide: sep((b, s) => (s === 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s))),
  vividLight: sep(vivid),
  linearLight: sep((b, s) => clamp(b + 2 * s - 1)),
  pinLight: sep((b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1))),
  hardMix: sep((b, s) => (b + s >= 1 ? 1 : 0)),
  darkerColor: (b, s) => (lum(s) < lum(b) ? s : b),
  lighterColor: (b, s) => (lum(s) > lum(b) ? s : b),
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};
// the ones Ugo9's runtime draws itself (a part's blend): the rest are drawn as normal there
export const RUNTIME_BLENDS = new Set(['normal', 'passThrough', 'multiply', 'screen', 'add']);
