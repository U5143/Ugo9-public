// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The PNG mov and the PNG ZIP written to a file as the frames come (web/encoders.js createWriter's opts.sink, 進行 #391
// の 2): the file is the same bytes as the one made in memory (a Blob); the frames reach the file before finish (only
// a few wait to be encoded); the writer keeps no frames; the mov's head is put right at the end (its mdat size); a
// sink that cannot seek is enough for the ZIP. fileSink adapts a File System Access file (here a stand-in).
//   node tests/writer_sink_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWriter, fileSink } from '../web/encoders.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-')), W = 64, H = 48, N = 40, FPS = 24;
const frame = (i) => { const px = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4, inside = Math.hypot(x - 32 - 10 * Math.sin(i / 5), y - 24) < 16; px.set(inside ? [(x * 4 + i) & 255, y * 5, 200, 255] : [0, 0, 0, 0], k); } return px; };

// a sink on a file (as fileSink gives): it counts what has gone out
const fileOut = (file) => {
  const fd = fs.openSync(file, 'w');
  let at = 0;
  const s = { written: 0, seeks: 0, closed: false,
    write: async (b) => { fs.writeSync(fd, b, 0, b.length, at); at += b.length; s.written += b.length; },
    seek: async (p) => { at = p; s.seeks++; },
    close: async () => { fs.closeSync(fd); s.closed = true; } };
  return s;
};

for (const format of ['mov-png', 'png-zip']) {
  const mem = await createWriter(format, W, H, FPS, { name: 'x' });
  for (let i = 0; i < N; i++) await mem.add(frame(i));
  const blob = Buffer.from(await (await mem.finish()).arrayBuffer());
  const file = path.join(dir, `a.${format === 'mov-png' ? 'mov' : 'zip'}`), sink = fileOut(file);
  const w = await createWriter(format, W, H, FPS, { name: 'x', sink });
  let before = 0;
  for (let i = 0; i < N; i++) { await w.add(frame(i)); if (i === N - 1) before = sink.written; }
  const r = await w.finish(), onDisk = fs.readFileSync(file);
  check(onDisk.equals(blob) && r.size === blob.length && sink.closed, `${format}: written to the file as it comes, the same ${blob.length} bytes as in memory (finish gives { size: ${r.size} })`);
  check(before > blob.length / 2, `${format}: ${before} of ${blob.length} bytes were on the file before finish (only the frames still being encoded wait)`);
  if (format === 'mov-png') {
    check(sink.seeks === 1, 'mov-png: one seek back, to put the mdat size in the head');
    let s = null;
    try { s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file]).toString()).streams[0]; } catch { console.log('skip the ffprobe check (no ffprobe)'); }
    if (s) check(s.codec_name === 'png' && Number(s.nb_read_frames) === N && s.width === W, `ffprobe reads it: ${s.codec_name}, ${s.nb_read_frames} frames, ${s.width}×${s.height}`);
  } else check(sink.seeks === 0, 'png-zip: no seek (a sink that only writes is enough)');
}

// fileSink: a File System Access file handle (a stand-in with createWritable, written at positions)
{
  const bytes = [];
  const handle = { createWritable: async () => ({ write: async ({ type, position, data }) => { if (type === 'write') { for (let i = 0; i < data.length; i++) bytes[position + i] = data[i]; } }, close: async () => {} }) };
  const sink = await fileSink(handle), w = await createWriter('mov-png', W, H, FPS, { sink });
  for (let i = 0; i < 5; i++) await w.add(frame(i));
  await w.finish();
  const mem = await createWriter('mov-png', W, H, FPS);
  for (let i = 0; i < 5; i++) await mem.add(frame(i));
  const blob = Buffer.from(await (await mem.finish()).arrayBuffer());
  check(Buffer.from(bytes).equals(blob) && (await fileSink({})) === null, 'fileSink: a picked file is written at the right places (the same bytes); no createWritable: null');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall sink checks passed');
process.exit(failures ? 1 : 0);
