// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Export presets: the export settings as a small JSON file with a version, read and written the
// same way by the editor's export window and `ugo_export --preset` (cli/). Every field but the
// version may be left out; fields this version does not know are kept when the preset is
// written again; a value that does not read is dropped with a note.
//
//   { "ugo9ExportPreset": 1, "name": "PV 1080p 60", "formats": ["webm-alpha", "png-zip"],
//     "fps": 60, "size": { "width": 1920, "height": 1080 }, "background": null,
//     "anim": "idle", "seconds": 4, "pinned": { "AngleX": 10 }, "fileName": "{doc}_{anim}",
//     "camera": [{ "t": 0, "zoom": 1 }, { "t": 2, "zoom": 2.5, "x": 0, "y": -420 }],
//     "sampling": "nearest",   (pixel art; the renderer's setSampling, ugo_export --nearest)
//     "jpegQuality": 90,       (the "jpeg" format: 1..100; ugo_export --quality; the background null is white)
//     "region": { "x": -100, "y": -500, "width": 200, "height": 260 },   (model pixels: only that part of the picture;
//                              ugo_export turns it into --crop's pixels for the size it draws)
//     "eachAnim": true,        (one export per animation; {anim} in fileName, else _{anim} at the end; --each-anim)
//     "holdFrames": 2,         (a new pose every N frames, 1..12; 1 as before; --hold)
//     "seamless": true,        (the physics runs more loops first until the loop has no jump; --seamless)
//     "seamlessLoops": 50,     (at most that many loops for seamless, 1..1000; --seamless-loops)
//     "perAnim": { "idle": { "loops": 3, "seamless": true }, "walk": { "seconds": 2.5, "holdFrames": 2 },
//                  "jump": { "skip": true } } }
//                              (settings for one animation, over the ones above when that animation is written:
//                              seconds, loops (that many times its length, 1..100; seconds wins), seamless,
//                              seamlessLoops, holdFrames, fps, skip (not written with eachAnim);
//                              利用者の声 #25「ループをシーンごとに決められない」)
//
// Also the export camera (the same as ugo_export --camera): cameraAt, cameraTransform.
// No outside dependencies; runs in the browser and in Node.

export const PRESET_VERSION = 1;
export const PRESET_FORMATS = ['gif', 'apng', 'png-zip', 'webm', 'webm-alpha', 'mp4', 'mov-png', 'jpeg'];
const MAX_SIDE = 16384, MAX_KEYS = 32;

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const side = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;

// each known field: value -> the value to keep, or undefined if it does not read
// the settings one animation may have in perAnim
const ANIM_FIELDS = ['seconds', 'loops', 'seamless', 'seamlessLoops', 'holdFrames', 'fps', 'skip'];
const FIELDS = {
  name: (v) => (typeof v === 'string' ? v : undefined),
  formats: (v, bad) => {
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const f of v) if (PRESET_FORMATS.includes(f)) { if (!out.includes(f)) out.push(f); } else bad(`formats: ${JSON.stringify(f)}`);
    return out;
  },
  fps: (v) => (num(v, 1, 240) ? v : undefined),
  scale: (v) => (num(v, 1e-3, 16) ? v : undefined),
  size: (v) => {
    if (!isObj(v)) return undefined;
    if ('long' in v) return side(v.long) ? { long: v.long } : undefined;
    return side(v.width) && side(v.height) ? { width: v.width, height: v.height } : undefined;
  },
  background: (v) => (v === null ? null : typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined),
  anim: (v) => (typeof v === 'string' ? v : undefined),
  seconds: (v) => (num(v, 1e-3, 3600) ? v : undefined),
  pinned: (v, bad) => {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x; else bad(`pinned.${k}: ${JSON.stringify(x)}`);
    return out;
  },
  sampling: (v) => (v === 'nearest' || v === 'linear' ? v : undefined),
  jpegQuality: (v) => (Number.isInteger(v) && v >= 1 && v <= 100 ? v : undefined),
  region: (v) => (isObj(v) && num(v.x, -1e7, 1e7) && num(v.y, -1e7, 1e7) && num(v.width, 1e-6, 1e7) && num(v.height, 1e-6, 1e7) ? { x: v.x, y: v.y, width: v.width, height: v.height } : undefined),
  // a picture behind the model (ugo_export --backdrop): a file name (beside the preset), or with where it lies in model
  // pixels (the four together); the editor's window does not draw it yet
  backdrop: (v) => (typeof v === 'string' && v ? v
    : isObj(v) && typeof v.file === 'string' && v.file && (['x', 'y', 'width', 'height'].every((k) => !(k in v)) || (num(v.x, -1e7, 1e7) && num(v.y, -1e7, 1e7) && num(v.width, 1e-6, 1e7) && num(v.height, 1e-6, 1e7)))
      ? { file: v.file, ...('x' in v ? { x: v.x, y: v.y, width: v.width, height: v.height } : {}) } : undefined),
  eachAnim: (v) => (typeof v === 'boolean' ? v : undefined),
  holdFrames: (v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? v : undefined),
  seamless: (v) => (typeof v === 'boolean' ? v : undefined),
  seamlessLoops: (v) => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : undefined),
  perAnim: (v, bad) => {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const [id, a] of Object.entries(v)) {
      if (!isObj(a)) { bad(`perAnim.${id}: ${JSON.stringify(a)}`); continue; }
      const one = {};
      for (const [k, x] of Object.entries(a)) {
        const got = k === 'loops' ? (num(x, 1e-3, 100) ? x : undefined) : k === 'skip' ? (typeof x === 'boolean' ? x : undefined)
          : ANIM_FIELDS.includes(k) ? FIELDS[k](x, bad) : x; // a setting not known here: kept
        if (got === undefined) bad(`perAnim.${id}.${k}: ${JSON.stringify(x)}`); else one[k] = got;
      }
      out[id] = one;
    }
    return out;
  },
  fileName: (v) => (typeof v === 'string' && v && !/[\\/:*?"<>|\0]/.test(v.replace(/\{[a-z]+\}/g, '')) ? v : undefined),
  camera: (v, bad) => {
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const k of v) {
      const ok = isObj(k) && num(k.t, 0, 1e6) && num(k.zoom, 1e-3, 1000) && ('x' in k) === ('y' in k) && (!('x' in k) || (num(k.x, -1e7, 1e7) && num(k.y, -1e7, 1e7)));
      if (!ok || out.length >= MAX_KEYS) { bad(`camera: ${JSON.stringify(k)}`); continue; }
      if ('cut' in k && typeof k.cut !== 'boolean') { bad(`camera: ${JSON.stringify(k)}`); continue; }
      const key = 'x' in k ? { t: k.t, zoom: k.zoom, x: k.x, y: k.y } : { t: k.t, zoom: k.zoom };
      if (k.cut) key.cut = true;
      out.push(key);
    }
    return out.sort((a, b) => a.t - b.t);
  },
};

/**
 * Reads a preset (JSON text or an object). -> { preset, notes }
 * notes: [{ kind, key?, message }]; kind is 'presetBadValue' (dropped), 'presetNewer' (a newer
 * version: what is known is read, the rest kept), or 'presetNotPreset' (not a preset at all:
 * the preset comes back empty).
 * Throws only when the text is not JSON.
 */
export function readExportPreset(input) {
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (e) { throw new Error(`not an export preset (the JSON does not read: ${e.message})`); }
  }
  const notes = [];
  if (!isObj(raw) || !Number.isInteger(raw.ugo9ExportPreset) || raw.ugo9ExportPreset < 1) {
    notes.push({ kind: 'presetNotPreset', message: 'not an export preset (no "ugo9ExportPreset" version)' });
    return { preset: { ugo9ExportPreset: PRESET_VERSION }, notes };
  }
  if (raw.ugo9ExportPreset > PRESET_VERSION) notes.push({ kind: 'presetNewer', message: `made by a newer version (${raw.ugo9ExportPreset}): the settings this one knows are read, the rest kept` });
  const preset = { ugo9ExportPreset: raw.ugo9ExportPreset };
  for (const [key, v] of Object.entries(raw)) {
    if (key === 'ugo9ExportPreset') continue;
    const read = FIELDS[key];
    if (!read) { preset[key] = v; continue; } // not known here: kept as it is
    const got = read(v, (what) => notes.push({ kind: 'presetBadValue', key, message: `dropped ${what}` }));
    if (got === undefined) notes.push({ kind: 'presetBadValue', key, message: `dropped ${key}: ${JSON.stringify(v)}` });
    else preset[key] = got;
  }
  return { preset, notes };
}

/** A preset as JSON text: the version first, then the known fields in a fixed order, then the rest. */
export function writeExportPreset(preset) {
  const out = { ugo9ExportPreset: preset?.ugo9ExportPreset || PRESET_VERSION };
  for (const key of Object.keys(FIELDS)) if (preset?.[key] !== undefined) out[key] = preset[key];
  for (const [key, v] of Object.entries(preset || {})) if (!(key in out) && v !== undefined) out[key] = v;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The preset as options for the editor's export (editor/export.js exportAnimation; only what
 * the preset says): { formats, fps, size: 'frame:WxH' | 'long:L' | a scale, background:
 * [r, g, b] (0..1) | null, anim, seconds, pinned: Map, fileName, camera, name, sampling: 'nearest' | 'linear',
 * jpegQuality, region { x, y, width, height } (model pixels), backdrop (a file name, or { file, x, y, width, height }),
 * eachAnim, holdFrames, seamless, seamlessLoops }
 * animId: that animation's settings in perAnim over the rest (and anim set to it); null when it is skipped. With
 * { duration } (the animation's length in seconds) its loops become seconds; without, `loops` is passed on.
 */
export function presetToExportOptions(preset, animId, { duration } = {}) {
  // one animation's settings (perAnim) over the rest; skip: null (not written); loops: that many times its length
  // (duration, in seconds: the model's; without it, loops is passed on as it is)
  const own = animId !== undefined ? preset.perAnim?.[animId] : undefined;
  if (own?.skip) return null;
  if (own) {
    preset = { ...preset, anim: animId };
    for (const k of ['seconds', 'seamless', 'seamlessLoops', 'holdFrames', 'fps']) if (own[k] !== undefined) preset[k] = own[k];
    if (own.seconds === undefined && own.loops !== undefined) {
      if (duration > 0) preset.seconds = own.loops * duration;
      else { delete preset.seconds; preset.loops = own.loops; }
    }
  } else if (animId !== undefined) preset = { ...preset, anim: animId };
  const o = {};
  for (const k of ['name', 'formats', 'fps', 'anim', 'seconds', 'fileName', 'camera', 'sampling', 'jpegQuality', 'region', 'backdrop', 'eachAnim', 'holdFrames', 'seamless', 'seamlessLoops', 'loops']) if (preset[k] !== undefined) o[k] = preset[k];
  if (preset.size) o.size = 'long' in preset.size ? `long:${preset.size.long}` : `frame:${preset.size.width}x${preset.size.height}`; // wins over the scale
  else if (preset.scale !== undefined) o.size = preset.scale;
  if (preset.background !== undefined) o.background = preset.background === null ? null : [1, 3, 5].map((i) => parseInt(preset.background.slice(i, i + 2), 16) / 255);
  if (preset.pinned) o.pinned = new Map(Object.entries(preset.pinned));
  return o;
}

/**
 * The picture's size from a size choice: a scale ('0.5', 1, '2'), a long side ('long:3840': the longer side that many
 * px), or a frame ('frame:3840x2160': the character fitted inside it, centred, the rest transparent or the background),
 * as presetToExportOptions gives it. canvas: [width, height]. -> { w, h, s (model px to picture px), dx, dy }
 */
export function frameSize([cw, ch], size) {
  const v = String(size ?? 1);
  if (v.startsWith('long:')) { const s = Number(v.slice(5)) / Math.max(cw, ch); return { w: Math.max(1, Math.round(cw * s)), h: Math.max(1, Math.round(ch * s)), s, dx: 0, dy: 0 }; }
  if (v.startsWith('frame:')) {
    const [W, H] = v.slice(6).split('x').map(Number), s = Math.min(W / cw, H / ch);
    return { w: W, h: H, s, dx: (W - cw * s) / 2, dy: (H - ch * s) / 2 };
  }
  const s = Number(v) || 1;
  return { w: Math.max(1, Math.round(cw * s)), h: Math.max(1, Math.round(ch * s)), s, dx: 0, dy: 0 };
}

/** The file name from the preset's pattern: {doc} {anim} {fps} {w} {h}; characters files cannot have become _. */
export function presetFileName(pattern, vars) {
  const s = (pattern || '{doc}_{anim}').replace(/\{([a-z]+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== '' ? String(vars[k]) : k === 'anim' ? 'still' : m));
  return s.replace(/[\\/:*?"<>|\0]/g, '_');
}

/**
 * The camera at time t (seconds from the first frame): { zoom, x, y }. keys sorted by t
 * ({ t, zoom, x?, y?, cut? }; cut: the camera jumps to that key at its time instead of easing in); a key without x,y looks at `centre` ([x, y], model pixels). Between keys
 * it eases in and out and the zoom goes on a log scale (1 -> 4 passes 2 halfway); before the
 * first key and after the last it holds. The same as ugo_export --camera.
 */
export function cameraAt(keys, t, centre = [0, 0]) {
  const at = (k) => ({ zoom: k.zoom, x: k.x ?? centre[0], y: k.y ?? centre[1] });
  if (!keys?.length) return { zoom: 1, x: centre[0], y: centre[1] };
  if (t <= keys[0].t || keys.length === 1) return at(keys[0]);
  if (t >= keys[keys.length - 1].t) return at(keys[keys.length - 1]);
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = at(keys[i]), b = at(keys[i + 1]);
  if (keys[i + 1].cut) return a; // held until the cut, then the cut key's own value
  let u = (t - keys[i].t) / (keys[i + 1].t - keys[i].t);
  u = u * u * (3 - 2 * u);
  return { zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * u), x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/**
 * The six numbers for inst.setTransform at time t.
 *   out: { w, h } the output size; canvas: [width, height, originX, originY] (or the JSON's
 *   { width, height, originX, originY }); fit: { s, dx, dy } from editor/export.js frameSize, how
 *   the canvas lies in the output without the camera (screen = (model + origin) * s + d;
 *   default: fitted and centred); keys: the camera.
 * Keys without x,y look at the model point that lies in the middle of the output under `fit`.
 */
export function cameraTransform(out, canvas, fit, keys, t) {
  const [cw, ch, ox, oy] = Array.isArray(canvas) ? canvas : [canvas.width, canvas.height, canvas.originX, canvas.originY];
  if (!fit) {
    const s = Math.min(out.w / cw, out.h / ch);
    fit = { s, dx: (out.w - cw * s) / 2, dy: (out.h - ch * s) / 2 };
  }
  const centre = [(out.w / 2 - fit.dx) / fit.s - ox, (out.h / 2 - fit.dy) / fit.s - oy];
  const c = cameraAt(keys, t, centre), s = fit.s * c.zoom;
  return [s, 0, 0, s, out.w / 2 - c.x * s, out.h / 2 - c.y * s];
}
