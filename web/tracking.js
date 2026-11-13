// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Face tracking for the VTuber page: camera -> MediaPipe Face Landmarker ->
// head angles and ARKit-style blendshape scores -> Ugo9 parameters; and the microphone -> a gated voice level
// for the mouth. MediaPipe (Apache-2.0) is loaded from a CDN the first time it is used.
// The mapping (FaceToParams), the voice gate (VoiceLevel) and choosing the mouth (mouthLevel) need no browser
// and are tested in tests/tracking_test.mjs.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const DEG = 180 / Math.PI;

// ---- One Euro filter: smooth when still, responsive when moving ----------------
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, dt) {
    if (this.x === null || !(dt > 0)) { this.x = v; this.dx = 0; return v; }
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/** Head angles (degrees) from MediaPipe's facial transformation matrix (column-major 4x4). */
export function headAngles(m) {
  const R = (r, c) => m[c * 4 + r];
  return {
    yaw: Math.atan2(R(0, 2), R(2, 2)) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -R(1, 2)))) * DEG,
    roll: Math.atan2(R(1, 0), R(0, 0)) * DEG,
  };
}

/**
 * Where MediaPipe comes from: the copy tools/fetch_mediapipe.mjs keeps next to this file (vendor/mediapipe/), so the
 * page works without the internet; else cdn.jsdelivr.net and Google's storage (fixed versions). Asked once.
 */
let whereFrom = null;
export function mediapipeFiles() {
  whereFrom ||= (async () => {
    const local = new URL('./vendor/mediapipe/', import.meta.url);
    try {
      const r = await fetch(new URL('vision_bundle.js', local), { method: 'HEAD' });
      if (r.ok) return { local: true, bundle: new URL('vision_bundle.js', local).href, wasm: new URL('wasm', local).href, model: new URL('face_landmarker.task', local).href };
    } catch (e) { /* not there */ }
    return { local: false, bundle: `${MP_BASE}/vision_bundle.mjs`, wasm: `${MP_BASE}/wasm`, model: MODEL_URL };
  })();
  return whereFrom;
}

export class FaceTracker {
  /** Loads MediaPipe; tries the GPU first and falls back to the CPU. modelAssetPath: the face model's URL
   * (default: the local copy or Google's; tools/make_vtuber_artifact.mjs puts one next to the page). */
  static async create({ modelAssetPath } = {}) {
    const where = await mediapipeFiles();
    const { FilesetResolver, FaceLandmarker } = await import(where.bundle);
    const fileset = await FilesetResolver.forVisionTasks(where.wasm);
    modelAssetPath ||= where.model;
    const options = (delegate) => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    let landmarker, delegate = 'GPU';
    try { landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU')); }
    catch (e) { delegate = 'CPU'; landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU')); }
    return new FaceTracker(landmarker, delegate);
  }

  constructor(landmarker, delegate) {
    this.landmarker = landmarker;
    this.delegate = delegate;
    this.lastTime = -1;
  }

  /** Returns { angles, shapes, landmarks } or null when no face is found. video: a <video> or a canvas. */
  detect(video, timeMs) {
    if (timeMs <= this.lastTime) timeMs = this.lastTime + 1;
    this.lastTime = timeMs;
    const r = this.landmarker.detectForVideo(video, timeMs);
    return FaceTracker.read(r);
  }

  /** One still image (for tests and calibration from a photo). */
  async detectImage(image) {
    await this.landmarker.setOptions({ runningMode: 'IMAGE' });
    const r = this.landmarker.detect(image);
    await this.landmarker.setOptions({ runningMode: 'VIDEO' });
    return FaceTracker.read(r);
  }

  static read(r) {
    if (!r || !r.faceBlendshapes || !r.faceBlendshapes.length || !r.facialTransformationMatrixes?.length) return null;
    const shapes = {};
    for (const c of r.faceBlendshapes[0].categories) shapes[c.categoryName] = c.score;
    return { angles: headAngles(r.facialTransformationMatrixes[0].data), shapes, landmarks: r.faceLandmarks?.[0] || [] };
  }
}

/**
 * The same tracking on a worker thread (web/tracking_worker.js): send(source, timeMs) hands a camera frame over
 * (only when the last one is done; false when busy), onface(face, ms) is called with each result. The page keeps
 * drawing while a frame is read. WorkerTracker.create throws when a worker cannot run the tracking (then use
 * FaceTracker on the page itself).
 */
export class WorkerTracker {
  static async create(options = {}, url = new URL('./tracking_worker.js', import.meta.url)) {
    const worker = new Worker(url);
    const delegate = await new Promise((ok, fail) => {
      worker.onmessage = (e) => (e.data.type === 'ready' ? ok(e.data.delegate) : e.data.type === 'error' ? fail(new Error(e.data.message)) : null);
      worker.onerror = (e) => fail(new Error(e.message || 'the tracking worker did not start'));
      worker.postMessage({ type: 'init', options });
    }).catch((e) => { worker.terminate(); throw e; });
    return new WorkerTracker(worker, delegate);
  }
  constructor(worker, delegate) {
    Object.assign(this, { worker, delegate, inWorker: true, busy: false, lastTime: -1, onface: null });
    worker.onmessage = (e) => {
      if (e.data.type !== 'face') return;
      this.busy = false;
      if (this.onface) this.onface(e.data.face, e.data.ms);
    };
  }
  /** Hands the frame over unless one is still being read. */
  async send(source, timeMs) {
    if (this.busy) return false;
    this.busy = true;
    if (timeMs <= this.lastTime) timeMs = this.lastTime + 1;
    this.lastTime = timeMs;
    try {
      const bitmap = await createImageBitmap(source);
      this.worker.postMessage({ type: 'frame', bitmap, time: timeMs }, [bitmap]);
      return true;
    } catch (e) { this.busy = false; return false; }
  }
  close() { this.worker.terminate(); }
}

// ---- tracking result -> Ugo9 parameters ---------------------------------------------
// Names follow the common Live2D-style ids; "Param" prefixed ids are accepted too.
export const DEFAULT_SETTINGS = {
  mirror: true,        // move like a mirror: turn your head left and the character turns to the screen's left
  headGain: 1.0,       // how far the head turns per degree of your head
  eyeClosedAt: 0.55,   // blink score that counts as fully closed (when the eyes are not fitted to the person)
  eyeOpenAt: 0.15,     // blink score that counts as fully open
  mouthGain: 1.0,
  // smoothing per group, 0 = raw, 1 = very smooth; a one-euro filter, so fast moves still follow quickly
  smoothHead: 0.5, smoothEyes: 0.5, smoothMouth: 0.5,
  // the two eyes: 'sync' always together, 'wink' together unless one is clearly shut and the other open, 'free'
  eyeSync: 'wink',
  winkGap: 0.5,        // how far apart the eyes must be to count as a wink ('wink' mode)
  eyeLostYaw: 38,      // beyond this head turn (degrees) the far eye is hidden: the eyes count as lost (auto blink)
  // fitted to the person (see startCapture), null until then. Blink scores per eye of the person, [open, closed];
  // jawOpen scores of the mouth, [closed, wide]
  eyeRange: null,      // { left: [o, c], right: [o, c] }
  mouthRange: null,    // [closed, wide]
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const GROUP = (name) => (name.startsWith('Head') || name === 'BodyTurnX' ? 'Head' : name === 'MouthOpen' ? 'Mouth' : 'Eyes');
const BASE_CUTOFF = { Head: 3, Eyes: 6, Mouth: 8 };  // Hz at smoothing 0 (0.3 Hz at 1)
const BETA = { Head: 0.04, Eyes: 4, Mouth: 6 };      // how much a fast change raises the cutoff (one-euro)
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

export class FaceToParams {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // pages saved before the three sliders had one "smoothing"
    if (settings.smoothing !== undefined && settings.smoothHead === undefined) {
      this.settings.smoothHead = this.settings.smoothEyes = this.settings.smoothMouth = settings.smoothing;
    }
    delete this.settings.smoothing;
    this.neutral = { yaw: 0, pitch: 0, roll: 0 };
    this.filters = new Map();
    this.last = null;
    this.eyesTracked = false; // false when the head is turned too far to see both eyes (then blink on your own)
    this.capture = null;
  }

  /** Makes the current head angle the "facing forward" pose. */
  calibrate(angles) { if (angles) this.neutral = { ...angles }; }

  /**
   * Fits the eyes or the mouth to the person: kind 'eyesOpen', 'eyesClosed', 'mouthClosed' or 'mouthWide'.
   * For `seconds` of tracked frames (update() collects them) the person holds that face; the median is kept in
   * settings.eyeRange / mouthRange. Resolves { ok, message } (ok false when the range would be too small).
   */
  startCapture(kind, seconds = 1) {
    if (this.capture) this.capture.done({ ok: false, message: 'cancelled' });
    return new Promise((done) => { this.capture = { kind, left: seconds, samples: [], done }; });
  }
  /** Forgets the fitted eyes and mouth. */
  resetFit() { this.settings.eyeRange = null; this.settings.mouthRange = null; }

  finishCapture() {
    const c = this.capture, s = this.settings;
    this.capture = null;
    if (!c.samples.length) return c.done({ ok: false, message: 'no face' });
    const m = (k) => median(c.samples.map((x) => x[k] || 0));
    const eyes = s.eyeRange ? { left: [...s.eyeRange.left], right: [...s.eyeRange.right] } : { left: [s.eyeOpenAt, s.eyeClosedAt], right: [s.eyeOpenAt, s.eyeClosedAt] };
    const mouth = s.mouthRange ? [...s.mouthRange] : [0.03, 0.03 + 1 / 2.4];
    let ok = true;
    if (c.kind === 'eyesOpen' || c.kind === 'eyesClosed') {
      const k = c.kind === 'eyesOpen' ? 0 : 1, margin = k ? -0.03 : 0.03;
      eyes.left[k] = m('eyeBlinkLeft') + margin; eyes.right[k] = m('eyeBlinkRight') + margin;
      ok = eyes.left[1] - eyes.left[0] >= 0.1 && eyes.right[1] - eyes.right[0] >= 0.1;
      if (ok) s.eyeRange = eyes;
    } else {
      const k = c.kind === 'mouthClosed' ? 0 : 1;
      mouth[k] = m('jawOpen');
      ok = mouth[1] - mouth[0] >= 0.05;
      if (ok) s.mouthRange = mouth;
    }
    c.done(ok ? { ok, message: 'fitted' } : { ok, message: 'too close to the other end' });
  }

  /** Raw values (before smoothing), keyed by parameter name.
   * Camera image conventions (checked in tests/vtuber_test.mjs): yaw > 0 when the
   * face points to the image's right, roll < 0 when the head leans clockwise in
   * the image, pitch < 0 when looking up. "Left"/"Right" blendshapes are the
   * person's own left and right. Standard names: HeadTurnX > 0 turns the face to the
   * screen's right, HeadTilt > 0 tilts clockwise, HeadTurnY > 0 looks up, EyeOpenL is
   * the eye on the screen's left. Mirror mode flips the camera image left-right:
   * every left-right value changes together (tests/tracking_test.mjs). */
  map(face) {
    const s = this.settings, sh = face.shapes, a = face.angles;
    const flip = s.mirror ? -1 : 1; // image right -> screen right (1) or screen left (-1)
    const yaw = (a.yaw - this.neutral.yaw) * s.headGain;
    const pitch = (a.pitch - this.neutral.pitch) * s.headGain;
    const roll = (a.roll - this.neutral.roll) * s.headGain;
    const g = (n) => sh[n] || 0;
    const range = (side) => (s.eyeRange ? s.eyeRange[side] : [s.eyeOpenAt, s.eyeClosedAt]);
    const open = (blink, [o, c]) => clamp(1 - (blink - o) / Math.max(0.05, c - o), 0, 1);
    // the person's own eyes, then synced, then put on the screen's sides
    let left = open(g('eyeBlinkLeft'), range('left')), right = open(g('eyeBlinkRight'), range('right'));
    if (s.eyeSync === 'sync' || (s.eyeSync === 'wink' && Math.abs(left - right) < s.winkGap)) left = right = (left + right) / 2;
    // gaze towards the person's own left (= the image's right): left eye looks out, right eye looks in
    const gazeLeft = (g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2;
    const gazeUp = (g('eyeLookUpLeft') + g('eyeLookUpRight') - g('eyeLookDownLeft') - g('eyeLookDownRight')) / 2;
    const browRaw = g('browInnerUp') * 0.6 + (g('browOuterUpLeft') + g('browOuterUpRight')) * 0.4 - (g('browDownLeft') + g('browDownRight')) * 0.6;
    const [mc, mw] = s.mouthRange || [0.03, 0.03 + 1 / 2.4];
    // in the camera image the person's right eye is on the left; a mirror swaps that
    // the standard names (docs/パラメータの名前.md); applyParams also finds a model's older names
    const brow = clamp(browRaw * 2.0, -1, 1);
    return {
      HeadTurnX: clamp(flip * yaw, -30, 30),
      HeadTurnY: clamp(-pitch, -30, 30),
      HeadTilt: clamp(-flip * roll, -30, 30),
      BodyTurnX: clamp(flip * yaw * 0.3, -10, 10),
      EyeOpenL: s.mirror ? left : right,
      EyeOpenR: s.mirror ? right : left,
      PupilX: clamp(flip * gazeLeft * 2.2, -1, 1),
      PupilY: clamp(gazeUp * 2.2, -1, 1),
      MouthOpen: clamp((g('jawOpen') - mc) / Math.max(0.02, mw - mc) * s.mouthGain - g('mouthClose') * 0.6, 0, 1),
      BrowHeightL: brow,
      BrowHeightR: brow,
    };
  }

  /** Smoothed values for this frame (dt in seconds). Without the eyes (head turned too far) EyeOpenL/R are left out. */
  update(face, dt) {
    if (this.capture) {
      this.capture.samples.push(face.shapes);
      if ((this.capture.left -= dt) <= 0) this.finishCapture();
    }
    const raw = this.map(face);
    this.eyesTracked = Math.abs(face.angles.yaw - this.neutral.yaw) < this.settings.eyeLostYaw;
    const out = {};
    for (const [name, v] of Object.entries(raw)) {
      const group = GROUP(name), k = this.settings['smooth' + group];
      let f = this.filters.get(name);
      if (!f) this.filters.set(name, (f = new OneEuro(1, BETA[group])));
      f.minCutoff = BASE_CUTOFF[group] * (1 - k) + 0.3 * k;
      out[name] = f.filter(v, dt);
    }
    if (!this.eyesTracked) { delete out.EyeOpenL; delete out.EyeOpenR; }
    this.last = out;
    return out;
  }
}

/**
 * A voice level for the mouth from the microphone's loudness (dB, e.g. -60 quiet .. -10 loud), with a noise
 * gate: the sound has to stay above `gateDb` for `attack` seconds before the mouth opens (a key click is a few
 * milliseconds), stays open while it is above gateDb - 4 dB (or for `hold` seconds after), and the level is
 * how far above the gate it is over `rangeDb`.
 */
export class VoiceLevel {
  constructor({ gateDb = -45, rangeDb = 25, attack = 0.05, hold = 0.12 } = {}) {
    Object.assign(this, { gateDb, rangeDb, attack, hold, above: 0, since: 1e9, open: false, level: 0, db: -100 });
  }
  update(db, dt) {
    this.db = db;
    if (db > this.gateDb) this.above += dt; else this.above = 0;
    if (!this.open && this.above >= this.attack) this.open = true;
    if (this.open) {
      if (db > this.gateDb - 4) this.since = 0; else this.since += dt;
      if (this.since > this.hold) { this.open = false; this.since = 1e9; }
    }
    this.level = this.open ? clamp((db - this.gateDb) / this.rangeDb, 0, 1) : 0;
    return this.level;
  }
}

/** The mouth's level from the camera's MouthOpen and the voice level (either may be null): source 'camera', 'mic' or 'max'. */
export function mouthLevel(source, camera, voice) {
  if (source === 'camera') return camera ?? (voice ?? null);
  if (source === 'mic') return voice ?? (camera ?? null);
  if (camera == null) return voice ?? null;
  return voice == null ? camera : Math.max(camera, voice);
}

/** The microphone (browser): loudness in dB of the voice band (120 Hz .. 4 kHz, so a key's click counts less). */
export class Microphone {
  static async open(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: false }, video: false });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4000;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    src.connect(hp).connect(lp).connect(analyser);
    if (ctx.state === 'suspended') await ctx.resume();
    return new Microphone(stream, ctx, analyser);
  }
  constructor(stream, ctx, analyser) { Object.assign(this, { stream, ctx, analyser, buf: new Float32Array(analyser.fftSize) }); }
  /** Loudness now (dB of the RMS, -100 for silence). */
  db() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let e = 0;
    for (const v of this.buf) e += v * v;
    return Math.max(-100, 10 * Math.log10(e / this.buf.length + 1e-12));
  }
  close() { this.stream.getTracks().forEach((t) => t.stop()); this.ctx.close(); }
}

/** The older names a model may have for a standard one (docs/パラメータの名前.md, the "today's tools" column). */
export const OLDER_NAMES = {
  HeadTurnX: ['AngleX'], HeadTurnY: ['AngleY'], HeadTilt: ['AngleZ'], BodyTurnX: ['BodyAngleX'],
  PupilX: ['EyeBallX'], PupilY: ['EyeBallY'], BrowHeightL: ['BrowY'], BrowHeightR: ['BrowY'],
};

/** The model's parameter for a tracked value: the name, else "Param" + name, else an older name for it (AngleX for
 * HeadTurnX ...), else "Param" + that; null when it has none. */
export function findParam(model, name) {
  const idx = model.paramIndex;
  for (const n of [name, ...(OLDER_NAMES[name] || [])]) {
    if (idx.has(n)) return n;
    if (idx.has('Param' + n)) return 'Param' + n;
  }
  return null;
}

/** What the face tracking writes (FaceToParams), with words for the page. */
export const TRACKED = [
  { id: 'HeadTurnX', label: '顔の左右' }, { id: 'HeadTurnY', label: '顔の上下' }, { id: 'HeadTilt', label: '顔の傾き' },
  { id: 'BodyTurnX', label: '体の左右' }, { id: 'EyeOpenL', label: '目の開き（画面の左）' }, { id: 'EyeOpenR', label: '目の開き（画面の右）' },
  { id: 'PupilX', label: '視線の左右' }, { id: 'PupilY', label: '視線の上下' }, { id: 'MouthOpen', label: '口の開き' },
  { id: 'BrowHeightL', label: '眉の高さ（画面の左）' }, { id: 'BrowHeightR', label: '眉の高さ（画面の右）' },
];

/** Which model parameter each tracked value moves, found by name (findParam): [{ from, to, scale, invert }],
 * to null when the model has none. A page lets the user change it (a model with names of its own). */
export function defaultMapping(model) {
  return TRACKED.map((t) => ({ from: t.id, to: findParam(model, t.id), scale: 1, invert: false }));
}

/** A saved mapping made to fit the model: rows for every tracked value, targets the model really has. */
export function fitMapping(model, saved) {
  const auto = defaultMapping(model);
  if (!Array.isArray(saved)) return auto;
  return auto.map((a) => {
    const s = saved.find((x) => x && x.from === a.from);
    if (!s) return a;
    const to = s.to === null || model.paramIndex.has(s.to) ? s.to : a.to;
    return { from: a.from, to, scale: Number.isFinite(s.scale) ? s.scale : 1, invert: !!s.invert };
  });
}

/** Sets the tracked values through a mapping: value x scale (negated when invert) into the row's parameter,
 * mixed in by weight. Values the mapping does not lead anywhere are left out. */
export function applyMapping(instance, params, mapping, weight = 1) {
  const idx = instance.model.paramIndex;
  for (const m of mapping) {
    if (!m.to || !(m.from in params)) continue;
    const i = idx.get(m.to);
    if (i === undefined) continue;
    const v = params[m.from] * (m.scale ?? 1) * (m.invert ? -1 : 1), cur = instance.get(i);
    instance.set(i, cur + (v - cur) * weight);
  }
}

/** Sets parameters by name on an instance: the name, else "Param" + name, else an older name for it (AngleX for
 * HeadTurnX ...), so models with either kind of names follow. */
export function applyParams(instance, params, weight = 1) {
  const idx = instance.model.paramIndex;
  for (const [name, v] of Object.entries(params)) {
    const found = idx.has(name) ? name : findParam(instance.model, name);
    const i = found === null ? undefined : idx.get(found);
    if (i === undefined) continue;
    const cur = instance.get(i);
    instance.set(i, cur + (v - cur) * weight);
  }
}
