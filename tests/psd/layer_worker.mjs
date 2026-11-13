// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A worker_threads worker for tests/psd_parallel_test.mjs: reads one PSD layer's pixels
// (decodePsdLayer) per message and sends them back (transferred), the way the editor's Workers do.
import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';
import { decodePsdLayer } from '../../tools/import_psd.mjs';

parentPort.on('message', async ({ id, job }) => {
  try {
    const px = await decodePsdLayer(job, { inflate: (b) => zlib.inflateSync(b) });
    parentPort.postMessage({ id, px }, px && px.rgba.byteLength ? [px.rgba.buffer] : []);
  } catch (e) { parentPort.postMessage({ id, error: { message: e.message, code: e.code, vars: e.vars, psd: !!e.psd } }); }
});
