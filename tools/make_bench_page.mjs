// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Builds a single self-contained HTML page that measures, on the device it is
// opened on (phones included), how many characters each method can animate:
//   A. Ugo9 (deform on the GPU, one draw call)
//   B. CPU deformation, one draw per character (how Live2D/Spine runtimes work)
//   C. glTF played by three.js (one skinned mesh per character)
// The wasm core, the sample model, its atlas and the .glb are embedded.
//
//   node tools/make_bench_page.mjs build/gltf/basic.glb out.html
import fs from 'node:fs';

const [glbPath = 'build/gltf/basic.glb', outPath = 'build/bench/ugo9_bench.html'] = process.argv.slice(2);
const b64 = (p) => fs.readFileSync(p).toString('base64');
const ugoJs = fs.readFileSync(new URL('../web/ugo.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const assets = {
  wasm: b64(new URL('../web/ugo.wasm', import.meta.url)),
  model: b64(new URL('../samples/basic/model.ug9', import.meta.url)),
  atlas: b64(new URL('../samples/basic/atlas.png', import.meta.url)),
  glb: b64(glbPath),
};

const html = String.raw`<title>Ugo9 端末ベンチ</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
  /* Layout: one column on phones, stage + results side by side on wide screens. */
  :root {
    --bg: #f6f5fa; --panel: #ffffff; --ink: #1f1c2b; --muted: #676379; --line: #e2dfec;
    --ugo: #5b3fa0; --cpu: #b8641c; --gltf: #13807a; --good: #1f7a45; --bad: #b2352a;
    --font-body: "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif;
    --font-data: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg: #14121b; --panel: #1d1a27; --ink: #ece9f5; --muted: #a29db5; --line: #2f2b3d;
      --ugo: #b49cf0; --cpu: #e8a25e; --gltf: #5cc8bf; --good: #6fd39a; --bad: #f08a7c; color-scheme: dark; }
  }
  :root[data-theme="dark"] { --bg: #14121b; --panel: #1d1a27; --ink: #ece9f5; --muted: #a29db5; --line: #2f2b3d;
    --ugo: #b49cf0; --cpu: #e8a25e; --gltf: #5cc8bf; --good: #6fd39a; --bad: #f08a7c; color-scheme: dark; }
  body { background: var(--bg); color: var(--ink); font-family: var(--font-body); line-height: 1.6;
    padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 16px 32px; }
  main { max-width: 1100px; margin: 0 auto; display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 900px) { main { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); align-items: start; } }
  header { grid-column: 1 / -1; display: grid; gap: 4px; }
  h1 { font-size: 1.5rem; margin: 0; text-wrap: balance; }
  h2 { font-size: .8rem; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; font-weight: 700; }
  p { margin: 0; }
  .lead { color: var(--muted); max-width: 62ch; }
  .stage { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: grid; }
  .stage canvas { width: 100%; height: min(56vh, 520px); display: block; background: #efedf5; grid-area: 1 / 1; }
  .stage canvas[hidden] { display: none !important; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--line); font-size: .9rem; }
  .now { font-family: var(--font-data); font-size: .85rem; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
  section { display: grid; gap: 12px; min-width: 0; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  input[type=text] { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 0; flex: 1 1 180px; }
  button { font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 16px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  button.go { background: var(--ugo); border-color: var(--ugo); color: var(--panel); font-weight: 700; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--ugo); outline-offset: 2px; }
  .status { font-size: .9rem; color: var(--muted); }
  .status.ok { color: var(--good); }
  .status.err { color: var(--bad); }
  .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: grid; gap: 2px; border-top: 4px solid var(--c); }
  .tile .k { font-size: .78rem; color: var(--muted); }
  .tile .v { font-family: var(--font-data); font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tile .s { font-size: .72rem; color: var(--muted); }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: .85rem; }
  th, td { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { font-weight: 700; color: var(--muted); font-size: .75rem; }
  td { font-family: var(--font-data); }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; font-family: var(--font-body); font-size: .75rem; font-weight: 700; padding: 1px 8px; border-radius: 999px; color: var(--panel); background: var(--c); }
  .fps-good { color: var(--good); } .fps-bad { color: var(--bad); }
  .note { font-size: .8rem; color: var(--muted); }
  .runs { display: grid; gap: 6px; }
  .run { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; display: grid; gap: 2px; font-size: .85rem; }
  .run b { font-weight: 700; }
  .run .d { font-family: var(--font-data); font-size: .75rem; color: var(--muted); overflow-wrap: anywhere; }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style>

<main>
  <header>
    <h1>Ugo9 端末ベンチ</h1>
    <p class="lead">この端末で、2D キャラを何体まで滑らかに動かせるかを、3 つの方式で測ります。全部で 1〜2 分ほどかかります。測っている間は画面を消さず、他のアプリを閉じておくと正確になります。</p>
  </header>

  <section aria-label="表示">
    <div class="stage">
      <canvas id="cvUgo" aria-label="Ugo9 と CPU 変形の表示"></canvas>
      <canvas id="cvThree" aria-label="glTF（three.js）の表示" hidden></canvas>
      <div class="bar"><span class="now" id="now">見本のキャラを表示中</span></div>
    </div>
  </section>

  <section aria-label="計測">
    <div class="controls">
      <input type="text" id="label" placeholder="端末の名前（例：iPhone 13）" autocomplete="off">
      <button class="go" id="go">計測を始める</button>
    </div>
    <p class="status" id="status">押すと 1・10・50・100 体、その後は 2 倍ずつ（最大 3,200 体）、滑らかでなくなるまで測ります。</p>

    <div>
      <h2>60fps 近くを保てた最大の体数</h2>
      <div class="summary">
        <div class="tile" style="--c: var(--ugo)"><span class="k">Ugo9（GPU で変形）</span><span class="v" id="maxA">–</span><span class="s">描画 1 回</span></div>
        <div class="tile" style="--c: var(--cpu)"><span class="k">CPU で変形（Live2D・Spine 型）</span><span class="v" id="maxB">–</span><span class="s">描画 1 体 1 回</span></div>
        <div class="tile" style="--c: var(--gltf)"><span class="k">glTF（three.js）</span><span class="v" id="maxC">–</span><span class="s">描画 1 体 1 回</span></div>
      </div>
      <p class="note" id="refreshNote"></p>
    </div>

    <div>
      <h2>結果</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>方式</th><th>体数</th><th>fps</th><th>1 コマの時間</th><th>CPU の時間</th><th>描画回数</th></tr></thead>
          <tbody id="rows"><tr><td colspan="6" class="note" style="text-align:left;font-family:var(--font-body)">まだ測っていません。上のボタンで始めます。</td></tr></tbody>
        </table>
      </div>
      <p class="note">fps は 1 秒あたりのコマ数（画面の上限は多くの端末で 60）。CPU の時間は 1 コマを作るのに JavaScript が使った時間で、短いほど電池と発熱に優しい。</p>
    </div>

    <div class="controls">
      <button id="copy" disabled>結果を文字でコピー</button>
      <span class="status" id="copyStatus"></span>
    </div>

    <div>
      <h2>保存した計測</h2>
      <div class="runs" id="runs"><p class="note">計測を終えると、ここに端末ごとの結果が並びます（保存できる時）。</p></div>
    </div>
  </section>
</main>

<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
</script>
<script type="module">
${ugoJs}

const ASSETS = ${JSON.stringify(assets)};
const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const $ = (id) => document.getElementById(id);
const COUNTS = [1, 10, 50, 100, 200, 400, 800, 1600, 3200];
const METHODS = [
  { key: 'A', name: 'Ugo9', color: 'var(--ugo)' },
  { key: 'B', name: 'CPU 変形', color: 'var(--cpu)' },
  { key: 'C', name: 'glTF', color: 'var(--gltf)' },
];
const raf = () => new Promise((r) => requestAnimationFrame(r));

// ---- device ------------------------------------------------------------------
function deviceInfo(gl) {
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { gpu = ''; }
  return {
    userAgent: navigator.userAgent, platform: navigator.platform || '', cores: navigator.hardwareConcurrency || 0,
    memoryGB: navigator.deviceMemory || 0, screen: screen.width + 'x' + screen.height, dpr: window.devicePixelRatio || 1, gpu,
  };
}

// ---- Ugo9 -------------------------------------------------------------------------
const cvUgo = $('cvUgo');
const gl = cvUgo.getContext('webgl2', { antialias: true, alpha: false });
let rt, model, ugoRenderer;
if (!gl) {
  $('status').textContent = 'この端末のブラウザは WebGL2 に対応していないため、測れません。';
  $('status').className = 'status err';
  $('go').disabled = true;
} else {
  try {
    rt = new UgoRuntime((await WebAssembly.instantiate(bytesOf(ASSETS.wasm), {})).instance.exports);
    model = rt.loadModel(bytesOf(ASSETS.model).buffer);
    ugoRenderer = new UgoRenderer(gl, model, [await loadImage(new Blob([bytesOf(ASSETS.atlas)], { type: 'image/png' }))]);
  } catch (e) {
    model = null;
    $('status').textContent = '準備に失敗したため測れません（' + (e && e.message || e) + '）。';
    $('status').className = 'status err';
    $('go').disabled = true;
  }
}
const [CW, CH, OX, OY] = model ? model.canvas : [420, 600, 210, 590];

function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return [w, h];
}
function grid(n, w, h) {
  const cols = Math.max(1, Math.round(Math.sqrt((n * w * CH) / (h * CW)))), rows = Math.ceil(n / cols);
  const s = Math.min(w / (cols * CW), h / (rows * CH)) * (n === 1 ? 0.92 : 1);
  const gx = (w - cols * CW * s) / 2, gy = (h - rows * CH * s) / 2;
  return Array.from({ length: n }, (_, i) => [gx + (i % cols) * CW * s, gy + Math.floor(i / cols) * CH * s, s]);
}
let instances = [];
function ugoInstances(n) {
  while (instances.length < n) instances.push(model.createInstance());
  return instances.slice(0, n);
}
function ugoFrame(n, t, mode) {
  const [w, h] = fitCanvas(cvUgo);
  const list = ugoInstances(n), pos = grid(n, w, h);
  const t0 = performance.now();
  list.forEach((inst, i) => {
    const [x, y, s] = pos[i];
    inst.reset(); inst.play('idle', t + i * 0.37); inst.update(1 / 60);
    inst.setTransform(s, 0, 0, s, x + OX * s, y + OY * s);
  });
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.937, 0.929, 0.96, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const st = ugoRenderer.draw(list, w, h, mode);
  return { cpu: performance.now() - t0, draws: st.drawCalls };
}

// ---- glTF via three.js (loaded on demand; the page works without it) ----------------
const cvThree = $('cvThree');
let three = null;
async function loadThree() {
  if (three) return three;
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
  cvThree.hidden = false;
  const renderer = new THREE.WebGLRenderer({ canvas: cvThree, antialias: true });
  cvThree.hidden = true;
  renderer.setClearColor(new THREE.Color().setRGB(0.937, 0.929, 0.96, THREE.SRGBColorSpace), 1);
  const glb = bytesOf(ASSETS.glb);
  const gltf = await new GLTFLoader().parseAsync(glb.buffer, '');
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) { o.material.forceSinglePass = true; o.frustumCulled = false; } });
  const clip = gltf.animations.find((a) => a.name === 'idle');
  three = { THREE, renderer, gltf, clip, SkeletonUtils, scene: new THREE.Scene(), items: [] };
  return three;
}
function threeFrame(n, t) {
  const { THREE, renderer, gltf, clip, SkeletonUtils, scene, items } = three;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  const w = cvThree.clientWidth, h = cvThree.clientHeight;
  renderer.setSize(w, h, false);
  while (items.length < n) {
    const obj = SkeletonUtils.clone(gltf.scene);
    const mixer = new THREE.AnimationMixer(obj);
    mixer.clipAction(clip).play();
    items.push({ obj, mixer });
  }
  scene.clear();
  const pos = grid(n, w, h);
  const cam = new THREE.OrthographicCamera(0, w, 0, -h, -10, 10); // 1 unit = 1 CSS px, y up
  for (let i = 0; i < n; i++) {
    const { obj, mixer } = items[i];
    const [x, y, s] = pos[i];
    obj.scale.setScalar(s * 100);
    obj.position.set(x + OX * s, -(y + OY * s), 0);
    scene.add(obj);
  }
  const t0 = performance.now();
  for (let i = 0; i < n; i++) items[i].mixer.setTime((t + i * 0.37) % clip.duration);
  renderer.render(scene, cam);
  return { cpu: performance.now() - t0, draws: renderer.info.render.calls };
}

// ---- idle preview ---------------------------------------------------------------------
let running = false, previewStart = performance.now();
async function preview() {
  while (!running && model) {
    ugoFrame(1, (performance.now() - previewStart) / 1000, 'gpu');
    await raf();
  }
}
preview();

// ---- measuring ------------------------------------------------------------------------
async function measure(method, n) {
  const frame = method === 'C' ? threeFrame : (c, t) => ugoFrame(c, t, method === 'A' ? 'gpu' : 'cpu');
  const t0 = performance.now();
  let last = t0, frames = 0, cpu = 0, draws = 0;
  const frameTimes = [];
  while (performance.now() - t0 < 2600) {
    const now = performance.now();
    const r = frame(n, (now - t0) / 1000);
    if (now - t0 > 600) { frames++; cpu += r.cpu; frameTimes.push(now - last); draws = r.draws; }
    last = now;
    await raf();
  }
  frameTimes.sort((a, b) => a - b);
  const avg = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
  return { method, count: n, fps: +(1000 / avg).toFixed(1), frameMs: +avg.toFixed(2),
    p95FrameMs: +(frameTimes[Math.floor(frameTimes.length * 0.95)] || 0).toFixed(2),
    cpuMs: +(cpu / Math.max(1, frames)).toFixed(3), draws };
}

async function refreshRate() {
  const t = [];
  let last = await new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 40; i++) { const now = await new Promise((r) => requestAnimationFrame(r)); t.push(now - last); last = now; }
  t.sort((a, b) => a - b);
  return Math.round(1000 / t[20]);
}

let results = [], lastRun = null;
function renderRows() {
  const tb = $('rows');
  tb.textContent = '';
  for (const r of results) {
    const m = METHODS.find((x) => x.key === r.method);
    const tr = document.createElement('tr');
    const good = r.fps >= lastRun.refreshHz * 0.9;
    tr.innerHTML = '<td><span class="pill"></span></td><td></td><td></td><td></td><td></td><td></td>';
    const pill = tr.querySelector('.pill');
    pill.textContent = m.name;
    pill.style.setProperty('--c', m.color);
    const cells = tr.querySelectorAll('td');
    cells[1].textContent = r.count;
    cells[2].textContent = r.fps.toFixed(0);
    cells[2].className = good ? 'fps-good' : (r.fps < 30 ? 'fps-bad' : '');
    cells[3].textContent = r.frameMs.toFixed(1) + ' ms';
    cells[4].textContent = r.cpuMs.toFixed(2) + ' ms';
    cells[5].textContent = r.draws;
    tb.appendChild(tr);
  }
}
function maxSmooth(key, hz) {
  const ok = results.filter((r) => r.method === key && r.fps >= hz * 0.9).map((r) => r.count);
  return ok.length ? Math.max(...ok) : 0;
}
function renderSummary() {
  const hz = lastRun.refreshHz;
  for (const m of METHODS) {
    const has = results.some((r) => r.method === m.key);
    $('max' + m.key).textContent = has ? maxSmooth(m.key, hz) + ' 体' : (lastRun.skipped?.[m.key] || '–');
  }
  $('refreshNote').textContent = 'この端末の画面は ' + hz + ' Hz。その 9 割以上の fps を「滑らか」としています。';
}

$('go').onclick = async () => {
  if (running) return;
  running = true;
  $('go').disabled = true;
  $('copy').disabled = true;
  const status = $('status');
  status.className = 'status';
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { wake = null; }
  results = [];
  lastRun = { label: $('label').value.trim(), at: new Date().toISOString(), device: deviceInfo(gl), refreshHz: 60, skipped: {} };
  status.textContent = '画面の速さを測っています…';
  lastRun.refreshHz = await refreshRate();
  renderSummary();
  for (const m of METHODS) {
    if (m.key === 'C') {
      try { status.textContent = 'three.js を読み込んでいます…'; await loadThree(); }
      catch (e) { lastRun.skipped.C = '読み込めず'; renderSummary(); continue; }
      cvUgo.hidden = true; cvThree.hidden = false;
    } else { cvUgo.hidden = false; cvThree.hidden = true; }
    for (const n of COUNTS) {
      $('now').textContent = m.name + '：' + n + ' 体を測っています';
      status.textContent = m.name + ' を測っています（' + n + ' 体）';
      const r = await measure(m.key, n);
      results.push(r);
      renderRows();
      renderSummary();
      // stop once clearly below smooth: the next, doubled count would only be slower
      if (r.fps < lastRun.refreshHz * 0.6 && !window.UGO_BENCH_NO_BREAK) break;
    }
  }
  cvUgo.hidden = false; cvThree.hidden = true;
  $('now').textContent = '見本のキャラを表示中';
  lastRun.results = results;
  try { await wake?.release(); } catch (e) { /* ignore */ }
  status.textContent = '測り終えました。';
  status.className = 'status ok';
  $('copy').disabled = false;
  running = false;
  $('go').disabled = false;
  previewStart = performance.now();
  preview();
  await save(lastRun);
};

$('copy').onclick = async () => {
  const text = JSON.stringify(lastRun);
  try { await navigator.clipboard.writeText(text); $('copyStatus').textContent = 'コピーしました。'; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.rows = 4; ta.style.width = '100%';
    $('copyStatus').textContent = '下の文字を選んでコピーしてください。';
    $('copyStatus').after(ta);
    ta.select();
  }
};

// ---- saving (db capability; the page works without it) ----------------------------------
let db = null;
async function save(run) {
  const status = $('status');
  if (!db) { status.textContent = '測り終えました（この表示では保存できません。「結果を文字でコピー」で送ってください）。'; return; }
  try {
    await db.collection('runs').add(run);
    status.textContent = '測り終え、結果を保存しました。';
  } catch (e) {
    status.textContent = '測り終えました。保存はできませんでした（' + (e && e.code || 'error') + '）。「結果を文字でコピー」で送ってください。';
  }
}
function renderRuns(snap) {
  const box = $('runs');
  if (snap.empty) return;
  box.textContent = '';
  for (const d of snap.docs) {
    const r = d.data();
    if (!r || !Array.isArray(r.results)) continue;
    const hz = r.refreshHz || 60;
    const best = (k) => { const ok = r.results.filter((x) => x.method === k && x.fps >= hz * 0.9).map((x) => x.count); return ok.length ? Math.max(...ok) : 0; };
    const el = document.createElement('div');
    el.className = 'run';
    const title = document.createElement('b');
    title.textContent = (r.label || '名前なしの端末') + '　' + new Date(r.at).toLocaleString();
    const line = document.createElement('span');
    line.textContent = 'Ugo9 ' + best('A') + ' 体　CPU 変形 ' + best('B') + ' 体　glTF ' + best('C') + ' 体（' + hz + ' Hz）';
    const dev = document.createElement('span');
    dev.className = 'd';
    dev.textContent = (r.device && r.device.gpu || '') + ' / ' + (r.device && r.device.userAgent || '');
    el.append(title, line, dev);
    box.appendChild(el);
  }
}
(async () => {
  try {
    db = window.claude && window.claude.use ? await window.claude.use('db') : null;
  } catch (e) { db = null; }
  if (!db) return;
  db.collection('runs').orderBy('at', 'desc').limit(20).onSnapshot(renderRuns, () => {});
})();
</script>
`;
fs.mkdirSync(outPath.replace(/[^/]+$/, '') || '.', { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`${outPath}: ${(html.length / 1024).toFixed(0)} KB`);
