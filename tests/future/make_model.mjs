// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// A .ug9 as a later 1.x might write it (minor 3, a longer header, tables and a track kind this version
// does not know), made from tests/order/model.json. The core must read it (tests/compile_test.mjs), and it is
// one of the core's corrupted-file runs (CMakeLists.txt, CI).
//   node tests/future/make_model.mjs   -> tests/future/model.ug9
import fs from 'node:fs';
import { compileUgo } from '../../tools/compile.mjs';

export function build() {
  const src = JSON.parse(fs.readFileSync(new URL('../order/model.json', import.meta.url), 'utf8'));
  const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 255);
  return compileUgo(src, { future: {
    minor: 3, headerExtra: 12,
    tables: [
      { kind: 200, flag: 0, count: 3, recSize: 8, bytes: bytes(24, 1) },
      { kind: 201, flag: 1, count: 5, recSize: 4, bytes: bytes(20, 2) },
      { kind: 202, flag: 1, count: 0, recSize: 4 },
    ],
    tracks: [{ kind: 99, index: 1, value: 0.5 }],
  } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL('./model.ug9', import.meta.url);
  fs.writeFileSync(out, new Uint8Array(build()));
  console.log(`${out.pathname}: ${fs.statSync(out).size} bytes`);
}
