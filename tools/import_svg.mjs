// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// An SVG drawing as a character's parts (利用者の声 #14「PSD 以外が読めない」): each element at the top of the
// drawing is one part (an Inkscape layer, <g inkscape:groupmode="layer">, is a group of parts, one per element
// in it), drawn at the canvas's size by the browser's own SVG renderer, then made into a model the way a PSD
// is (tools/import_psd.mjs importLayerStack): the same { model, atlas, atlases, groups, layers, ... }.
//
//   const res = await importSvgAsync(svgText, { rasterize, ...the options of importPsd });
//     rasterize(svgText, width, height) -> Promise<Uint8Array> (straight RGBA): by default the browser's
//     (an <img> drawn on a canvas, in a page); in Node it must be given (the tests draw with Chromium).
//
// Each part is drawn alone with the drawing's <defs> and <style> (gradients, patterns, clip paths and masks
// still work), its parents' transforms and styles. Pictures linked from outside the file are not loaded by a
// browser drawing an SVG as an image (said: svgExternal); text is drawn with the fonts the computer has (said:
// svgText, info); <foreignObject> cannot be drawn into pixels (left out: svgForeignObject). Sizes in mm, cm,
// in, pt and pc are turned into pixels at 96 per inch.
import { importLayerStack } from './import_psd.mjs';

function svgError(code, vars, text) { const e = new Error(text); e.code = code; e.vars = vars; e.psd = true; throw e; }

// ---- a small XML reader: elements as { tag, attrs, children, start, end } over the text (comments, CDATA, PIs skipped) ----
function parseXml(src) {
  const root = { tag: '#root', attrs: {}, children: [], start: 0, end: src.length };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt), tag = src.slice(lt + 2, e).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { while (stack.length > k) { const el = stack.pop(); el.end = e + 1; } break; }
      i = e + 1;
      continue;
    }
    // a start tag: its attributes (quoted values may hold '>')
    let p = lt + 1;
    while (p < src.length && !/[\s/>]/.test(src[p])) p++;
    const tag = src.slice(lt + 1, p), attrs = {};
    for (;;) {
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '>' || src[p] === '/' || p >= src.length) break;
      let q = p;
      while (q < src.length && !/[\s=/>]/.test(src[q])) q++;
      const name = src.slice(p, q);
      p = q;
      while (/\s/.test(src[p])) p++;
      if (src[p] === '=') {
        p++;
        while (/\s/.test(src[p])) p++;
        const quote = src[p];
        if (quote === '"' || quote === "'") { const e = src.indexOf(quote, p + 1); attrs[name] = src.slice(p + 1, e < 0 ? src.length : e); p = e < 0 ? src.length : e + 1; }
        else { let e = p; while (e < src.length && !/[\s>]/.test(src[e])) e++; attrs[name] = src.slice(p, e); p = e; }
      } else attrs[name] = '';
      if (!name) p++;
    }
    const self = src[p] === '/', gt = src.indexOf('>', p);
    const el = { tag, attrs, children: [], start: lt, end: gt + 1 };
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
    i = gt + 1;
  }
  return root;
}

const UNIT = { px: 1, '': 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
const length = (v) => { const m = /^\s*([0-9.eE+-]+)\s*([a-z%]*)\s*$/.exec(v || ''); return m && m[2] !== '%' && UNIT[m[2]] !== undefined ? parseFloat(m[1]) * UNIT[m[2]] : null; };
const SHARED = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'sodipodi:namedview', 'script']);
const LAYER_GROUP = (el) => el.tag === 'g' && el.attrs['inkscape:groupmode'] === 'layer';
const titleOf = (src, el) => { const t = el.children.find((c) => c.tag === 'title'); return t ? src.slice(src.indexOf('>', t.start) + 1, t.end - '</title>'.length).trim() : ''; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// the browser's way to draw an SVG into pixels: an <img> of it (a browser does not decode SVG in
// createImageBitmap), drawn on a canvas (main thread: it needs the page's document)
async function browserRasterize(svg, w, h) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') svgError('svgNoRasterizer', {}, 'drawing an SVG needs a browser page (or opts.rasterize)');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    return new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
  } finally { URL.revokeObjectURL(url); }
}

/** the layers of an SVG text: { width, height, layers: [{ name, group (an Inkscape layer's name or null), svg (the part alone) }], notes } */
export function svgLayers(src) {
  const doc = parseXml(src), svg = doc.children.find((e) => e.tag === 'svg' || e.tag.endsWith(':svg'));
  if (!svg) svgError('svgNotSvg', {}, 'not an SVG drawing (no <svg> element)');
  const vb = (svg.attrs.viewBox || '').split(/[\s,]+/).map(Number);
  let width = length(svg.attrs.width), height = length(svg.attrs.height);
  if (vb.length === 4 && vb.every(Number.isFinite)) { if (width == null && height == null) [width, height] = [vb[2], vb[3]]; else if (width == null) width = (height * vb[2]) / vb[3]; else if (height == null) height = (width * vb[3]) / vb[2]; }
  if (!(width > 0 && height > 0)) svgError('svgNoSize', {}, 'the SVG has no size (width and height, or a viewBox)');
  width = Math.round(width); height = Math.round(height);
  const notes = [], note = (code, vars, text, level = 'warn') => notes.push({ code, vars, text, level });
  // the root's own attributes (namespaces, viewBox, styles), with the size in pixels
  const rootAttrs = Object.entries(svg.attrs).filter(([k]) => k !== 'width' && k !== 'height').map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const open = `<svg${rootAttrs}${svg.attrs.xmlns ? '' : ' xmlns="http://www.w3.org/2000/svg"'} width="${width}" height="${height}"${svg.attrs.viewBox ? '' : ` viewBox="0 0 ${width} ${height}"`}>`;
  const shared = svg.children.filter((e) => SHARED.has(e.tag) && e.tag !== 'script' && e.tag !== 'sodipodi:namedview').map((e) => src.slice(e.start, e.end)).join('');
  // a hidden part is drawn as if shown (it is imported hidden: shown later by the editor or an animation)
  const unhide = (v) => v.replace(/display\s*:\s*none\s*;?/g, '');
  const groupAttrs = (el) => ['transform', 'style', 'opacity', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'class'].filter((k) => el.attrs[k] !== undefined).map((k) => ` ${k}="${esc(k === 'style' ? unhide(el.attrs[k]) : el.attrs[k])}"`).join('');
  const layers = [];
  const add = (el, i, parent) => {
    if (el.tag === 'foreignObject') { note('svgForeignObject', { element: el.attrs.id || el.tag }, `${el.attrs.id || el.tag}: <foreignObject> cannot be drawn into pixels (left out)`); return; }
    const whole = src.slice(el.start, el.end), headEnd = whole.indexOf('>') + 1;
    const text = unhide(whole.slice(0, headEnd)).replace(/\sdisplay\s*=\s*["']none["']/, '') + whole.slice(headEnd);
    if (/<foreignObject/.test(text)) note('svgForeignObject', { element: el.attrs.id || el.tag }, `${el.attrs.id || el.tag}: has a <foreignObject> (it may not draw)`);
    const name = el.attrs['inkscape:label'] || titleOf(src, el) || el.attrs.id || `${el.tag}${i + 1}`;
    const body = parent ? `<g${groupAttrs(parent)}>${text}</g>` : text;
    layers.push({ name, group: parent ? parent.attrs['inkscape:label'] || parent.attrs.id || 'layer' : null, hidden: /display\s*:\s*none/.test(el.attrs.style || '') || el.attrs.display === 'none' || (parent && (/display\s*:\s*none/.test(parent.attrs.style || '') || parent.attrs.display === 'none')), svg: `${open}${shared}${body}</svg>` });
  };
  svg.children.filter((e) => !SHARED.has(e.tag)).forEach((el, i) => {
    if (LAYER_GROUP(el)) el.children.filter((c) => !SHARED.has(c.tag)).forEach((c, k) => add(c, k, el));
    else add(el, i, null);
  });
  if (/<(svg:)?image[\s>]/.test(src) && /(xlink:)?href\s*=\s*["'](?!data:|#)/.test(src)) note('svgExternal', {}, 'pictures linked from outside the file are not drawn (a browser draws an SVG image with what is in it only); put them in the file (data: URLs) or draw them in');
  if (/<(svg:)?text[\s>]/.test(src)) note('svgText', {}, 'text is drawn with the fonts this computer has (the look may differ): turn it into paths in the drawing app to be sure', 'info');
  if (!layers.length) svgError('svgEmpty', {}, 'the SVG has nothing to draw');
  return { width, height, layers, notes };
}

/** An SVG drawing (text or bytes) -> the same as importPsd. opts.rasterize: see the top; the other options are importPsd's. */
export async function importSvgAsync(source, opts = {}) {
  const src = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const { width, height, layers, notes } = svgLayers(src);
  const draw = opts.rasterize || browserRasterize, folders = new Map(), out = [];
  for (const L of layers) {
    const rgba = await draw(L.svg, width, height);
    if (!rgba || rgba.length !== width * height * 4) svgError('svgDrawFailed', { layer: L.name }, `${L.name}: could not be drawn`);
    if (L.group && !folders.has(L.group)) folders.set(L.group, { name: L.group, visible: true, opacity: 255, blend: 'passThrough' });
    out.push({ name: L.name, groupObjs: L.group ? [folders.get(L.group)] : [], left: 0, top: 0, width, height, visible: !L.hidden, opacity: 1, blend: 'normal', clipping: 0, kind: 'pixel', effects: false, rgba });
  }
  return importLayerStack({ width, height, layers: out, notes }, opts);
}
