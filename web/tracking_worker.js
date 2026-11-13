// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The face tracking on a thread of its own (WorkerTracker in tracking.js), so a slow camera frame never holds up
// the drawing. A classic worker (MediaPipe's loader uses importScripts, which module workers do not have); the
// modules come in by import(). Messages: init { options } -> ready { delegate } | error { message };
// frame { bitmap, time } -> face { face, ms, time } (the bitmap is closed here).
let tracker = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const { FaceTracker } = await import(new URL('./tracking.js', self.location.href).href);
      tracker = await FaceTracker.create(m.options || {});
      self.postMessage({ type: 'ready', delegate: tracker.delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (m.type === 'frame') {
    const t0 = performance.now();
    let face = null;
    try { face = tracker ? tracker.detect(m.bitmap, m.time) : null; } catch (err) { face = null; }
    m.bitmap.close();
    self.postMessage({ type: 'face', face, ms: performance.now() - t0, time: m.time });
  }
};
