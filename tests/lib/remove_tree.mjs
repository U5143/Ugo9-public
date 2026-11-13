// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Removes a folder and what is in it, one file at a time (a missing folder is fine). The tests use
// it in place of fs.rmSync({ recursive }): on Windows, Node 24's has been seen to end the process
// without a word (0xC0000409) on paths with Japanese names (the same fix as desktop/scripts/copy-dist.mjs).
import fs from 'node:fs';
import path from 'node:path';

export function removeTree(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) removeTree(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}
