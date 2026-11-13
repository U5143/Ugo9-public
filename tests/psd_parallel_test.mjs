// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// importPsdParallel: the layers' pixels read in a pool of workers (worker_threads here, Workers in
// the editor) give the same result as importPsd, byte for byte: the model, the atlas pages, the
// layers (and their pixels) and the notes. PSDs: tests/psd/, and made here: big ones (scaled
// down), one with an unreadable layer, a CMYK one, one with every layer unreadable.
//   node tests/psd_parallel_test.mjs [file.psd ...]   (with files: also times them)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { importPsd, importPsdParallel } from '../tools/import_psd.mjs';
import { writePsd, bigLayers } from './psd/make_big.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const inflate = (b) => zlib.inflateSync(b);

// a pool of n workers: run(job) -> Promise of the layer's pixels
function pool(n) {
  const workers = Array.from({ length: n }, () => new Worker(path.join(here, 'psd', 'layer_worker.mjs')));
  const waiting = new Map(), queue = [], idle = [...workers];
  let id = 0, most = 0, busy = 0;
  const send = () => {
    while (idle.length && queue.length) {
      const w = idle.pop(), { job, k } = queue.shift();
      busy++; most = Math.max(most, busy);
      w.postMessage({ id: k, job }, [job.bytes]);
    }
  };
  for (const w of workers) w.on('message', ({ id: k, px, error }) => {
    const { resolve, reject } = waiting.get(k); waiting.delete(k);
    busy--; idle.push(w); send();
    if (error) reject(Object.assign(new Error(error.message), error)); else resolve(px);
  });
  return {
    run: (job) => new Promise((resolve, reject) => { const k = id++; waiting.set(k, { resolve, reject }); queue.push({ job, k }); send(); }),
    most: () => most, close: () => Promise.all(workers.map((w) => w.terminate())),
  };
}

const hash = (r) => {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(r.model)); h.update(JSON.stringify(r.notes)); h.update(JSON.stringify(r.warnings)); h.update(String(r.scale));
  for (const a of r.atlases) h.update(a.rgba);
  for (const l of r.layers) { h.update(JSON.stringify({ ...l, rgba: undefined })); if (l.rgba) h.update(l.rgba); }
  return h.digest('hex').slice(0, 16);
};

const files = process.argv.slice(2);
const workers = Math.max(2, Math.min(4, os.cpus().length - 1));
const P = pool(workers);
try {
  if (files.length) {
    for (const f of files) {
      const b = fs.readFileSync(f);
      let t = performance.now(); const a = importPsd(b, { inflate }); const t1 = performance.now() - t;
      t = performance.now(); const c = await importPsdParallel(b, { inflate }, P.run); const t2 = performance.now() - t;
      check(hash(a) === hash(c), `${path.basename(f)}: same result; one by one ${(t1 / 1000).toFixed(1)} s, ${workers} workers ${(t2 / 1000).toFixed(1)} s`);
    }
  } else {
    const cases = ['face.psd', 'face_v2.psd', 'clip.psd', 'nested.psd', 'face16.psd', 'vector.psd', 'folder_mask.psd'].map((f) => [f, fs.readFileSync(path.join(here, 'psd', f))]);
    const blob = (name, x, extra = {}) => ({ name, left: x, top: 10, width: 40, height: 30, pixel: (px, py) => [200, px * 6, py * 8, 255], ...extra });
    cases.push(['big 5000x4000 (scaled)', writePsd(5000, 4000, bigLayers(5000, 4000, 8))]);
    cases.push(['2400x900, unreadable layers', writePsd(2400, 900, [blob('a', 0), blob('bad', 50, { compression: 7 }), blob('c', 100), blob('bad 2', 150, { compression: 7 })])]);
    cases.push(['CMYK', writePsd(200, 100, [blob('ink', 0, { pixel: () => [255, 0, 0, 0, 255] })], { mode: 4 })]);
    cases.push(['every layer unreadable', writePsd(120, 60, [blob('bad', 0, { compression: 7 })], { composite: () => [10, 20, 30] })]);
    for (const [name, b] of cases) {
      const a = importPsd(b, { inflate }), c = await importPsdParallel(b, { inflate }, P.run), d = await importPsdParallel(b, { inflate });
      check(hash(a) === hash(c) && hash(a) === hash(d), `${name}: same as importPsd (workers, and without run) [${a.model.parts.length} parts${a.scale < 1 ? `, scale ${a.scale.toFixed(3)}` : ''}${a.notes.some((n) => n.code === 'layerUnreadable') ? ', unreadable noted' : ''}]`);
    }
    { // mesh 'none' made in the workers too
      const b = cases[0][1], a = importPsd(b, { inflate, mesh: 'none' }), c = await importPsdParallel(b, { inflate, mesh: 'none' }, P.run);
      check(hash(a) === hash(c) && a.model.parts.every((p) => p.vertices.length === 8), `mesh 'none': same as importPsd, 4 points a part`);
    }
    check(P.most() > 1, `the layers were read side by side (up to ${P.most()} of ${workers} workers at once)`);
    // the memory bound: with a tiny maxInFlightBytes the layers go out one at a time
    const one = pool(workers), b = writePsd(1000, 800, bigLayers(1000, 800, 6));
    const r = await importPsdParallel(b, { inflate, maxInFlightBytes: 1 }, one.run);
    check(one.most() === 1 && hash(r) === hash(importPsd(b, { inflate })), `maxInFlightBytes: 1 -> one layer out at a time (${one.most()}), same result`);
    await one.close();
    // progress: 'read' as each layer comes back, then 'mesh'
    const seen = [];
    await importPsdParallel(b, { inflate, onProgress: (p) => seen.push(p) }, P.run);
    const reads = seen.filter((p) => p.step === 'read');
    check(reads.length === 9 && reads.every((p, i) => p.done === i && p.total === 8) && seen.at(-1).step === 'mesh', `onProgress: ${reads.map((p) => p.done).join(',')} of 8, then meshes`);
  }
} finally { await P.close(); }
console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel PSD checks passed');
process.exit(failures ? 1 : 0);
