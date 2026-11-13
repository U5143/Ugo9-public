// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The VTuber page's face and voice logic (web/tracking.js), without a camera or a browser (利用者の声 #47):
// mirror on/off changes every left-right value together, the eyes are synced (winks allowed or not), the
// eyes and mouth fitted to the person, smoothing per group (head / eyes / mouth) that still follows fast moves,
// the eyes counted as lost when the head turns far, the microphone's noise gate (key clicks do not open the
// mouth), and choosing the mouth between the camera and the microphone.
//   node tests/tracking_test.mjs
import { FaceToParams, VoiceLevel, mouthLevel } from '../web/tracking.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const face = (angles = {}, shapes = {}) => ({ angles: { yaw: 0, pitch: 0, roll: 0, ...angles }, shapes });

// ---- 6. mirror: every left-right value changes together ------------------------------------------
{
  // turned and tilted, looking to their own left, their own left eye shut, mouth a little open
  const f = face({ yaw: 15, pitch: -5, roll: 10 }, { eyeLookOutLeft: 0.6, eyeLookInRight: 0.6, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.05, jawOpen: 0.3, browInnerUp: 0.3 });
  const on = new FaceToParams({ mirror: true, eyeSync: 'free' }).map(f), off = new FaceToParams({ mirror: false, eyeSync: 'free' }).map(f);
  const flipped = ['HeadTurnX', 'HeadTilt', 'BodyTurnX', 'PupilX'].filter((k) => near(on[k], -off[k]) && Math.abs(on[k]) > 0.1);
  const same = ['HeadTurnY', 'PupilY', 'MouthOpen', 'BrowHeightL', 'BrowHeightR'].filter((k) => near(on[k], off[k]));
  check(flipped.length === 4, `mirror on/off flips the head turn, the tilt, the body and the gaze together (${flipped})`);
  check(near(on.EyeOpenL, off.EyeOpenR) && near(on.EyeOpenR, off.EyeOpenL), 'and swaps the eyes');
  check(same.length === 5, `and keeps looking up, the gaze up, the mouth and the brows (${same})`);
  // in a mirror your own left is on the screen's left: the shut eye, the turn and the gaze all on that side
  check(on.EyeOpenL < 0.1 && on.EyeOpenR > 0.9, `mirror: your own left eye shut -> the eye on the screen's left shuts (${on.EyeOpenL.toFixed(2)}, ${on.EyeOpenR.toFixed(2)})`);
  check(Math.sign(on.HeadTurnX) === Math.sign(on.PupilX) && Math.sign(on.HeadTurnX) === Math.sign(on.BodyTurnX), 'mirror: head, gaze and body turn to the same side');
}

// ---- 5. the two eyes ---------------------------------------------------------------------------------
{
  const f = (l, r) => face({}, { eyeBlinkLeft: l, eyeBlinkRight: r });
  const m = (sync, l, r) => new FaceToParams({ eyeSync: sync }).map(f(l, r));
  const a = m('wink', 0.3, 0.45);
  check(near(a.EyeOpenL, a.EyeOpenR), `'wink': eyes a little apart are made the same (${a.EyeOpenL.toFixed(2)})`);
  const w = m('wink', 0.9, 0.05);
  check(w.EyeOpenL < 0.1 && w.EyeOpenR > 0.9, 'a clear wink stays a wink');
  const s = m('sync', 0.9, 0.05);
  check(near(s.EyeOpenL, s.EyeOpenR), "'sync': always together, winks too");
  const fr = m('free', 0.3, 0.45);
  check(!near(fr.EyeOpenL, fr.EyeOpenR), "'free': each eye on its own");
  // eyes lost: the head turned far, so the eyes are left to the automatic blink
  const t = new FaceToParams();
  const out = t.update(face({ yaw: 45 }, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }), 1 / 30);
  check(!t.eyesTracked && !('EyeOpenL' in out) && 'HeadTurnX' in out, 'turned far (45°): the eyes count as lost and are left out (auto blink takes over)');
  t.update(face({ yaw: 10 }), 1 / 30);
  check(t.eyesTracked, 'facing the camera again: the eyes are tracked');
}

// ---- 4. fitted to the person ---------------------------------------------------------------------------
{
  // small eyes far from the camera: open reads 0.35, closed 0.7; a small mouth: wide reads 0.2
  const t = new FaceToParams({ eyeSync: 'free' });
  const before = t.map(face({}, { eyeBlinkLeft: 0.35, eyeBlinkRight: 0.35, jawOpen: 0.2 }));
  const hold = async (kind, shapes) => {
    const p = t.startCapture(kind, 1);
    for (let i = 0; i < 40; i++) t.update(face({}, shapes), 1 / 30);
    return p;
  };
  const r1 = await hold('eyesOpen', { eyeBlinkLeft: 0.35, eyeBlinkRight: 0.33 });
  const r2 = await hold('eyesClosed', { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.72 });
  const r3 = await hold('mouthClosed', { jawOpen: 0.02 });
  const r4 = await hold('mouthWide', { jawOpen: 0.2 });
  check(r1.ok && r2.ok && r3.ok && r4.ok, 'the four captures are kept');
  const open = t.map(face({}, { eyeBlinkLeft: 0.35, eyeBlinkRight: 0.33, jawOpen: 0.2 }));
  const shut = t.map(face({}, { eyeBlinkLeft: 0.7, eyeBlinkRight: 0.72, jawOpen: 0.02 }));
  check(before.EyeOpenL < 0.6 && open.EyeOpenL > 0.95 && open.EyeOpenR > 0.95 && shut.EyeOpenL < 0.05 && shut.EyeOpenR < 0.05,
    `eyes: their open reads fully open (${before.EyeOpenL.toFixed(2)} before, ${open.EyeOpenL.toFixed(2)} after) and their closed fully shut (${shut.EyeOpenL.toFixed(2)})`);
  check(before.MouthOpen < 0.5 && open.MouthOpen > 0.95 && shut.MouthOpen < 0.05, `mouth: their wide reads fully open (${before.MouthOpen.toFixed(2)} before, ${open.MouthOpen.toFixed(2)} after)`);
  const bad = await hold('eyesClosed', { eyeBlinkLeft: 0.36, eyeBlinkRight: 0.34 });
  check(!bad.ok && t.settings.eyeRange.left[1] > 0.6, 'a "closed" that is the same as open is refused and the old fit kept');
  const lost = t.startCapture('mouthWide', 1);
  t.resetFit();
  check(t.settings.eyeRange === null && t.settings.mouthRange === null, 'resetFit forgets the fit');
  t.startCapture('mouthWide', 1);
  check((await lost).ok === false, 'starting another capture cancels the first');
}

// ---- 3. smoothing per group, fast moves still followed --------------------------------------------------
{
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const dt = 1 / 30;
  const spread = (v) => { const tail = v.slice(30), mean = tail.reduce((a, b) => a + b) / tail.length; return Math.sqrt(tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length); };
  const jitter = (k) => { // a still head with ±1° of noise: the spread in and out
    const t = new FaceToParams({ smoothHead: k, mirror: false }), inp = [], out = [];
    for (let i = 0; i < 90; i++) { const y = 2 * noise(); inp.push(y); out.push(t.update(face({ yaw: y }), dt).HeadTurnX); }
    return [spread(inp), spread(out)];
  };
  const [raw, half] = jitter(0.5), [, smooth] = jitter(1);
  check(half < raw / 2.5 && smooth < half, `smoothing calms a still head's jitter (spread ${raw.toFixed(2)}° -> ${half.toFixed(2)}° at 0.5, ${smooth.toFixed(2)}° at 1)`);
  const reach = (k) => { // a fast 25° turn: how long until 90% of it
    const t = new FaceToParams({ smoothHead: k, mirror: false });
    for (let i = 0; i < 30; i++) t.update(face(), dt);
    for (let i = 1; i < 60; i++) if (t.update(face({ yaw: 25 }), dt).HeadTurnX > 22.5) return i * dt;
    return Infinity;
  };
  const r5 = reach(0.5), r1 = reach(1);
  check(r5 <= 0.2, `a fast turn is followed quickly at smoothHead 0.5 (90% in ${(r5 * 1000).toFixed(0)} ms)`);
  // a fixed low-pass at smoothHead 1's still-cutoff (0.3 Hz) would need about 1.2 s
  check(r1 < 0.6, `even at smoothHead 1 a fast turn catches up (90% in ${(r1 * 1000).toFixed(0)} ms; a fixed 0.3 Hz filter needs ~1200 ms)`);
  // the groups are separate: the mouth's slider moves the mouth only
  const run = (o) => {
    const t = new FaceToParams({ mirror: false, ...o });
    for (let i = 0; i < 10; i++) t.update(face({}, { jawOpen: 0.03 }), dt);
    const out = [];
    for (let i = 0; i < 6; i++) out.push(t.update(face({ yaw: 3 * Math.sin(i) }, { jawOpen: 0.03 + 0.04 * Math.sin(2 * i), eyeBlinkLeft: 0.1 + 0.1 * Math.sin(i) }), dt));
    return out;
  };
  const a = run({ smoothMouth: 0 }), b = run({ smoothMouth: 1 });
  check(a.every((o, i) => o.HeadTurnX === b[i].HeadTurnX && o.EyeOpenL === b[i].EyeOpenL) && a.some((o, i) => Math.abs(o.MouthOpen - b[i].MouthOpen) > 0.01),
    'head, eyes and mouth have their own smoothing (the mouth slider changes the mouth only)');
  const legacy = new FaceToParams({ smoothing: 0.8 });
  check(legacy.settings.smoothHead === 0.8 && legacy.settings.smoothMouth === 0.8 && !('smoothing' in legacy.settings), 'an old saved "smoothing" becomes the three');
}

// ---- 1. the microphone's noise gate ---------------------------------------------------------------------
{
  const dt = 1 / 60;
  const run = (v, frames) => { let most = 0; for (let i = 0; i < frames.length; i++) most = Math.max(most, v.update(frames[i], dt)); return most; };
  const quiet = -60;
  // typing: 20 ms clicks (one or two frames) at -15 dB, five times a second
  const typing = Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? -15 : quiet));
  check(run(new VoiceLevel(), typing) === 0, 'key clicks (20 ms, loud) do not open the mouth');
  const v = new VoiceLevel();
  const talk = [...Array(24).fill(-25), ...Array(30).fill(quiet)];
  const levels = talk.map((db) => v.update(db, dt));
  check(Math.max(...levels) > 0.7 && levels[1] === 0, `a voice held 0.4 s at -25 dB opens it (level ${Math.max(...levels).toFixed(2)}), after the ${(new VoiceLevel().attack * 1000).toFixed(0)} ms attack`);
  check(levels[levels.length - 1] === 0, 'and it closes when the voice stops');
  check(run(new VoiceLevel({ gateDb: -45 }), Array(60).fill(-50)) === 0, 'sound below the gate (a fan, -50 dB) never opens it');
  const hold = new VoiceLevel();
  const words = [...Array(10).fill(-25), -47, -47, ...Array(5).fill(-25)].map((db) => hold.update(db, dt));
  check(words.slice(10).every((x, i) => i < 2 || x > 0), 'a short dip between words keeps it open');
}

// ---- the mouth from the camera and the microphone ---------------------------------------------------------
{
  check(mouthLevel('camera', 0.2, 0.9) === 0.2 && mouthLevel('mic', 0.2, 0.9) === 0.9 && mouthLevel('max', 0.2, 0.9) === 0.9 && mouthLevel('max', 0.6, 0.1) === 0.6,
    'mouth source: camera, microphone, or the larger');
  check(mouthLevel('mic', 0.4, null) === 0.4 && mouthLevel('camera', null, 0.3) === 0.3 && mouthLevel('max', null, null) === null,
    'one missing: the other one is used; none: null (left to the animation)');
}

// ---- standard names out, either kind of names in a model ---------------------------------------------------
{
  const { applyParams } = await import('../web/tracking.js');
  const out = new FaceToParams({ mirror: false }).map(face({ yaw: 10 }, {}));
  check(['HeadTurnX', 'HeadTilt', 'BodyTurnX', 'PupilX', 'BrowHeightL'].every((k) => k in out) && !('AngleX' in out), 'the tracking writes the standard names (docs/パラメータの名前.md)');
  const fake = (names) => {
    const vals = new Map(names.map((n, i) => [i, 0]));
    return { model: { paramIndex: new Map(names.map((n, i) => [n, i])) }, get: (i) => vals.get(i), set: (i, v) => vals.set(i, v), vals };
  };
  const older = fake(['AngleX', 'BrowY']), live2d = fake(['ParamAngleX']), std = fake(['HeadTurnX']);
  for (const m of [older, live2d, std]) applyParams(m, { HeadTurnX: 12, BrowHeightL: 0.5 });
  check(older.vals.get(0) === 12 && older.vals.get(1) === 0.5 && live2d.vals.get(0) === 12 && std.vals.get(0) === 12,
    'applyParams finds a model\'s older names (AngleX, BrowY), "Param" names (ParamAngleX) and the standard ones');
}

// ---- the mapping: which parameter each tracked value moves (a model with names of its own) --------------------
{
  const { defaultMapping, fitMapping, applyMapping, findParam } = await import('../web/tracking.js');
  const model = (names) => ({ paramIndex: new Map(names.map((n, i) => [n, i])), params: names.map((name) => ({ name })) });
  const inst = (m) => { const v = new Map(); return { model: m, get: (i) => v.get(i) ?? 0, set: (i, x) => v.set(i, x), v }; };
  const std = model(['HeadTurnX', 'EyeOpenL', 'MouthOpen']), older = model(['AngleX', 'ParamEyeOpenL', 'BrowY']), own = model(['KaoYoko', 'Kuchi']);
  check(findParam(std, 'HeadTurnX') === 'HeadTurnX' && findParam(older, 'HeadTurnX') === 'AngleX' && findParam(older, 'EyeOpenL') === 'ParamEyeOpenL'
    && findParam(older, 'BrowHeightR') === 'BrowY' && findParam(own, 'HeadTurnX') === null, 'findParam: the standard name, an older one, a Param name, or none');
  const auto = defaultMapping(own);
  check(auto.length === 11 && auto.every((m) => m.to === null && m.scale === 1 && !m.invert), 'a model with names of its own: every row found nothing (to be chosen on the page)');
  const mine = fitMapping(own, [{ from: 'HeadTurnX', to: 'KaoYoko', scale: 2, invert: true }, { from: 'MouthOpen', to: 'Kuchi', scale: 1 }, { from: 'PupilX', to: 'Gone' }]);
  const i = inst(own);
  applyMapping(i, { HeadTurnX: 10, MouthOpen: 0.5, PupilX: 1 }, mine, 1);
  check(i.v.get(0) === -20 && i.v.get(1) === 0.5, `a chosen parameter, its scale and invert (HeadTurnX 10 -> KaoYoko ${i.v.get(0)})`);
  check(mine.find((m) => m.from === 'PupilX').to === null, 'a saved target the model does not have falls back to what is found by name');
  const half = inst(std); half.set(0, 4);
  applyMapping(half, { HeadTurnX: 10 }, defaultMapping(std), 0.5);
  check(half.v.get(0) === 7, 'mixed in by weight, as applyParams');
}

if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('all tracking checks passed');
