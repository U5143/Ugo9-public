// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Writes tests/spine/rig.png: flat colour blocks for the test atlas (our own image).
import fs from 'node:fs';
import zlib from 'node:zlib';
const W = 256, H = 128, px = new Uint8Array(W * H * 4);
const fill = (x, y, w, h, [r, g, b]) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px.set([r, g, b, 255], 4 * (j * W + i)); };
fill(0, 0, 40, 80, [90, 120, 200]);     // torso
fill(40, 0, 60, 20, [230, 150, 60]);    // arm, upper half
fill(100, 0, 60, 20, [200, 90, 40]);    // arm, lower half
fill(160, 0, 10, 10, [30, 30, 30]);     // eye-open
fill(170, 0, 10, 10, [240, 90, 120]);   // eye-closed
fill(186, 4, 40, 30, [60, 170, 90]);    // flag (whitespace stripped; transparent around it)
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const td = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(new URL('./rig.png', import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
