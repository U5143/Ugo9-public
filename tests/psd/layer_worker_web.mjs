// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A browser Worker (type: 'module') for tests/psd_big_browser_test.mjs: reads one PSD layer's
// pixels (decodePsdLayer) per message and sends them back (transferred). The editor's own pool
// does the same.
import { decodePsdLayer } from '../../tools/import_psd.mjs';

self.onmessage = async ({ data: { id, job } }) => {
  try {
    const px = await decodePsdLayer(job);
    self.postMessage({ id, px }, px && px.rgba.byteLength ? [px.rgba.buffer] : []);
  } catch (e) { self.postMessage({ id, error: { message: e.message, code: e.code, vars: e.vars, psd: !!e.psd } }); }
};
