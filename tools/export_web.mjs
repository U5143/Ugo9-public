// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A character for a web page in one file (利用者の声 #29「Web SDK が今の作り方に合わない」): the Web runtime
// (web/ugo.js), the core (ugo.wasm), the model and its pictures in one ES module that defines the element
// <ugo9-player>, or in one HTML page. Nothing else to fetch or install.
//
//   node tools/export_web.mjs model.ug9 --out hero.ugo9.js [--textures atlas.png,...]   (an ES module)
//   node tools/export_web.mjs model.ug9 --out hero.html                                 (a page)
//   node tools/export_web.mjs a.ug9 b.ug9 --out cast.ugo9.js [--names a,b]           (several models, the core once;
//                                                                                        <ugo9-player model="b">)
//   node tools/export_web.mjs model.ug9 --out hero.html --viewer                        (a page to look at it with: animations,
//                                                                                        speed, zoom, background, parameter sliders)
//   ... --no-simd   only the plain core (about 120 KB smaller); by default both, and the page loads the SIMD one where
//                   the browser has WebAssembly SIMD (web/ugo.js UgoRuntime.simdSupported: the same picture, faster)
//
// In a page:
//   <script type="module" src="hero.ugo9.js"></script>
//   <ugo9-player anim="idle" style="width: 300px; height: 400px"></ugo9-player>
// or from a script: import { mount } from './hero.ugo9.js'; const p = await mount(canvas, { anim: 'idle' });
//   p.play('talk'); p.set('MouthOpen', 0.5); p.stop();
// Attributes: anim (the animation, looped; default idle or the first), paused, follow (the head follows the
// pointer where the model has AngleX / AngleY). The picture fits the element, kept in proportion, on a
// transparent background.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUg9Tables } from './import_ug9.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// the player, written into the module after the runtime (it uses UgoRuntime, UgoRenderer and loadImage from it)
const PLAYER = `
const bytesOf = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let core = null; const loaded = new Map(); // one core for the page; each model read once, for every player of it
/** the models in this file, by name (the first is the default) */
export const models = UGO9_MODELS.map((m) => m.name);
async function loadShared(name) {
  const entry = name === undefined ? UGO9_MODELS[0] : UGO9_MODELS.find((m) => m.name === name);
  if (!entry) throw new Error('Ugo9: no model named ' + name + ' (this file has ' + models.join(', ') + ')');
  // the SIMD build where the browser has WebAssembly SIMD (the same picture bit for bit, faster), else the plain one;
  // window.UGO9_NO_SIMD = true before loading keeps the plain one
  const wasm = UGO9_WASM_SIMD && !globalThis.UGO9_NO_SIMD && UgoRuntime.simdSupported?.() ? UGO9_WASM_SIMD : UGO9_WASM;
  if (!core) core = WebAssembly.instantiate(bytesOf(wasm), {}).then(({ instance }) => new UgoRuntime(instance.exports));
  if (!loaded.has(entry.name)) loaded.set(entry.name, core.then((rt) => ({
    rt, model: rt.loadModel(bytesOf(entry.model).buffer), blobs: entry.images.map(([type, data]) => new Blob([bytesOf(data)], { type })),
  })));
  return loaded.get(entry.name);
}

/** canvas (an element or a selector) -> a player: { play(name), set(param, value), stop(), model, instance }.
 *  opts.model: which model of this file (by name; the first by default) */
export async function mount(target, opts = {}) {
  const canvas = typeof target === 'string' ? document.querySelector(target) : target;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, alpha: true });
  if (!gl) throw new Error('Ugo9: this browser has no WebGL2');
  const { model, blobs } = await loadShared(opts.model);
  const renderer = new UgoRenderer(gl, model, await Promise.all(blobs.map((b) => loadImage(b))));
  const inst = model.createInstance(), names = model.animations.map((a) => a.name);
  let anim = opts.anim && names.includes(opts.anim) ? opts.anim : names.includes('idle') ? 'idle' : names[0] || '', paused = !!opts.paused;
  const pinned = new Map(), pointer = { x: 0, y: 0, on: false };
  let clock = 0, last = performance.now(), running = true, speed = opts.speed ?? 1, zoom = opts.zoom ?? 1, follow = !!opts.follow;
  {
    canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1; pointer.on = true; });
    canvas.addEventListener('pointerleave', () => { pointer.on = false; });
  }
  const frame = (now) => {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) clock += dt * speed;
    const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const [cw, ch, ox, oy] = model.canvas, s = Math.min(w / cw, h / ch) * zoom;
    inst.setTransform(s, 0, 0, s, (w - cw * s) / 2 + ox * s, (h - ch * s) / 2 + oy * s);
    inst.reset();
    if (anim) inst.play(anim, clock);
    if (follow && pointer.on) for (const [n, v] of [['HeadTurnX', pointer.x * 30], ['HeadTurnY', -pointer.y * 30], ['AngleX', pointer.x * 30], ['AngleY', -pointer.y * 30]]) if (model.paramIndex.has(n)) inst.set(n, v);
    for (const [k, v] of pinned) inst.set(k, v);
    inst.update(paused ? 0 : dt * speed);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.draw([inst], w, h, 'gpu');
  };
  requestAnimationFrame(frame);
  return {
    model, instance: inst, animations: names,
    play(name) { if (names.includes(name)) { anim = name; clock = 0; } else throw new Error('Ugo9: no animation named ' + name); },
    set(param, value) { pinned.set(param, value); },
    unset(param) { pinned.delete(param); },
    pause(on = true) { paused = on; },
    // for a viewer: the speed (1 normal), the zoom (1 fits the canvas), the head following the pointer, the time and animation now
    setSpeed(v) { speed = v; }, setZoom(v) { zoom = v; }, setFollow(on) { follow = !!on; },
    get time() { return clock; }, get animation() { return anim; },
    stop() { running = false; },
  };
}

if (typeof customElements !== 'undefined' && !customElements.get('ugo9-player')) {
  customElements.define('ugo9-player', class extends HTMLElement {
    connectedCallback() {
      if (this.player) return;
      this.style.display = this.style.display || 'inline-block';
      const c = document.createElement('canvas');
      c.style.width = '100%'; c.style.height = '100%'; c.style.display = 'block';
      this.appendChild(c);
      this.ready = mount(c, { model: this.getAttribute('model') || undefined, anim: this.getAttribute('anim') || undefined, paused: this.hasAttribute('paused'), follow: this.hasAttribute('follow') })
        .then((p) => { this.player = p; this.dispatchEvent(new Event('ready')); return p; });
    }
    disconnectedCallback() { this.player?.stop(); }
  });
}
`;

/**
 * model (.ug9 path) -> the module's text. opts.textures: the pictures' paths (default: the model's texture names
 * next to it), opts.runtime / opts.wasm / opts.wasmSimd: web/ugo.js, web/ugo.wasm and web/ugo_simd.wasm (opts.simd false:
 * only the plain core, a smaller file; else both, the browser's chosen when the page loads).
 */
export function webModule(model, opts = {}) {
  const list = Array.isArray(model) ? model : [model];
  const entries = list.map((file, k) => {
    const bytes = fs.readFileSync(file), t = readUg9Tables(bytes);
    const names = (t.textures || []).map((x) => (typeof x === 'number' ? t.string(x) : x?.name !== undefined ? t.string(x.name) : String(x)));
    const textures = (list.length === 1 && opts.textures) || names.map((n) => path.join(path.dirname(file), n));
    for (const f of textures) if (!fs.existsSync(f)) throw new Error(`the picture ${f} is not there (give --textures)`);
    const name = opts.names?.[k] || path.basename(file).replace(/\.(ug9|ugo)$/i, '');
    return { name, model: b64(bytes), images: textures.map((f) => [MIME[path.extname(f).toLowerCase()] || 'image/png', b64(fs.readFileSync(f))]) };
  });
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.name)) throw new Error(`two models are named ${e.name} (give names)`); seen.add(e.name); }
  const runtime = fs.readFileSync(opts.runtime || path.join(ROOT, 'web/ugo.js'), 'utf8'), wasm = fs.readFileSync(opts.wasm || path.join(ROOT, 'web/ugo.wasm'));
  const simdFile = opts.wasmSimd || path.join(ROOT, 'web/ugo_simd.wasm'), simd = opts.simd !== false && fs.existsSync(simdFile) ? fs.readFileSync(simdFile) : null;
  return `// Generated by Ugo9 (tools/export_web.mjs) from ${list.map((f) => path.basename(f)).join(', ')}: the Web runtime (MIT), the core and the model(s) in one module.
// <script type="module" src="this file"></script> <ugo9-player anim="idle"${entries.length > 1 ? ` model="${entries[1].name}"` : ''}></ugo9-player>
${runtime}
const UGO9_WASM = "${b64(wasm)}";
const UGO9_WASM_SIMD = ${simd ? `"${b64(simd)}"` : 'null'};
const UGO9_MODELS = ${JSON.stringify(entries)};
${PLAYER}`;
}

/** a page to look at the model with (利用者の声 #29, 機能の比べ #93): the player and a panel to pick the animation,
 *  pause, change the speed and zoom, the background, the head following the pointer, and a slider per parameter */
export function viewerPage(model, opts = {}) {
  const mod = webModule(model, opts).replace(/<\/script/gi, '<\\/script');
  const title = (opts.title || path.basename(model, '.ug9')).replace(/[<&"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
:root { --bg: #f4f4f6; --panel: #ffffff; --text: #222; --line: #ddd; }
@media (prefers-color-scheme: dark) { :root { --bg: #1d1e22; --panel: #26272c; --text: #eee; --line: #3a3b40; } }
html, body { margin: 0; height: 100%; font: 14px system-ui, sans-serif; color: var(--text); background: var(--bg); }
body { display: flex; flex-wrap: wrap; }
#stage { flex: 1 1 360px; min-height: 60vh; position: relative; }
ugo9-player { position: absolute; inset: 0; width: 100%; height: 100%; }
#panel { flex: 0 1 280px; background: var(--panel); border-left: 1px solid var(--line); padding: 12px; box-sizing: border-box; overflow: auto; max-height: 100vh; }
#panel h1 { font-size: 16px; margin: 0 0 8px; } #panel label { display: block; margin: 8px 0 2px; }
#panel input[type=range], #panel select { width: 100%; } .row { display: flex; gap: 8px; align-items: center; } .row > * { flex: 1; }
#params .p { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; margin-top: 6px; } #params input { grid-column: 1 / 3; }
button { padding: 4px 8px; }
</style></head>
<body><div id="stage"><ugo9-player id="player"></ugo9-player></div>
<div id="panel"><h1>${title}</h1>
<label for="anim">アニメ / Animation</label><select id="anim"></select>
<div class="row" style="margin-top:8px"><button id="pause">一時停止 / Pause</button><button id="reset">最初から / Restart</button></div>
<label for="speed">速さ / Speed <span id="speedv">1.00</span></label><input id="speed" type="range" min="0.1" max="3" step="0.05" value="1">
<label for="zoom">大きさ / Zoom <span id="zoomv">1.00</span></label><input id="zoom" type="range" min="0.25" max="4" step="0.05" value="1">
<label for="bg">背景 / Background</label><div class="row"><input id="bg" type="color" value="#f4f4f6"><button id="clear">透明 / None</button></div>
<label><input id="follow" type="checkbox" checked> 顔がポインタを追う / Follow the pointer</label>
<label>パラメータ / Parameters <button id="unpin">戻す / Release all</button></label><div id="params"></div>
</div>
<script type="module">
${mod}
const el = document.getElementById('player'), $ = (id) => document.getElementById(id);
const p = await el.ready;
p.setFollow(true);
for (const a of p.animations) $('anim').add(new Option(a, a));
$('anim').value = p.animation;
$('anim').onchange = () => p.play($('anim').value);
let paused = false;
$('pause').onclick = () => { paused = !paused; p.pause(paused); };
$('reset').onclick = () => p.play($('anim').value);
$('speed').oninput = () => { p.setSpeed(+$('speed').value); $('speedv').textContent = (+$('speed').value).toFixed(2); };
$('zoom').oninput = () => { p.setZoom(+$('zoom').value); $('zoomv').textContent = (+$('zoom').value).toFixed(2); };
$('bg').oninput = () => { $('stage').style.background = $('bg').value; };
$('clear').onclick = () => { $('stage').style.background = 'transparent'; };
$('follow').onchange = () => p.setFollow($('follow').checked);
const sliders = [];
for (const q of p.model.params) {
  const d = document.createElement('div'); d.className = 'p';
  const name = document.createElement('span'); name.textContent = q.name;
  const val = document.createElement('span'); val.textContent = '—';
  const r = document.createElement('input'); Object.assign(r, { type: 'range', min: q.min, max: q.max, step: (q.max - q.min) / 200 || 0.01, value: q.def });
  r.oninput = () => { p.set(q.name, +r.value); val.textContent = (+r.value).toFixed(2); };
  d.append(name, val, r); $('params').append(d); sliders.push([q, r, val]);
}
$('unpin').onclick = () => { for (const [q, r, val] of sliders) { p.unset(q.name); r.value = q.def; val.textContent = '—'; } };
window.ugo9Viewer = p;
</script></body></html>
`;
}

/** the same as one page: the player filling it (anim: the animation; title: the page's title) */
export function webPage(model, opts = {}) {
  const list = Array.isArray(model) ? model : [model];
  const mod = webModule(model, opts).replace(/<\/script/gi, '<\\/script');
  const esc = (v) => String(v).replace(/[<&"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' })[c]);
  const title = esc(opts.title || list.map((f) => path.basename(f, '.ug9')).join(', '));
  const anim = opts.anim ? ` anim="${esc(opts.anim)}"` : '';
  // one model: it fills the page; several: side by side, each as wide as the page shared out
  const players = list.length === 1 ? `<ugo9-player${anim} follow></ugo9-player>`
    : list.map((f, k) => `<ugo9-player model="${esc(opts.names?.[k] || path.basename(f).replace(/\.(ug9|ugo)$/i, ''))}"${anim} follow></ugo9-player>`).join('');
  const style = list.length === 1 ? 'ugo9-player { width: 100vw; height: 100vh; display: block; }' : 'body { display: flex; } ugo9-player { flex: 1; height: 100vh; display: block; }';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>html, body { margin: 0; height: 100%; background: transparent; } ${style}</style></head>
<body>${players}
<script type="module">
${mod}
</script></body></html>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opts = {};
  const list = []; let out = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = () => args[++i];
    if (a === '--out') out = v();
    else if (a === '--textures') opts.textures = v().split(',');
    else if (a === '--anim') opts.anim = v();
    else if (a === '--title') opts.title = v();
    else if (a === '--viewer') opts.viewer = true;
    else if (a === '--no-simd') opts.simd = false;
    else if (a === '--names') opts.names = v().split(',');
    else if (!a.startsWith('--')) list.push(a);
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  const model = list.length > 1 ? list : list[0];
  if (!model || !out) { console.error('usage: node tools/export_web.mjs model.ug9 [more.ug9 ...] --out hero.ugo9.js | hero.html [--names a,b] [--viewer] [--textures a.png,...] [--anim idle] [--title name] [--no-simd]'); process.exit(2); }
  if (opts.viewer && list.length > 1) { console.error('--viewer takes one model'); process.exit(2); }
  const text = opts.viewer ? viewerPage(model, opts) : /\.html?$/i.test(out) ? webPage(model, opts) : webModule(model, opts);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`${out}: ${(text.length / 1024).toFixed(0)} KB`);
}
