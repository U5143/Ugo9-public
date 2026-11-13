// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The GameMaker extension's native side, built with the C core (cc -Werror) and run without GameMaker
// (tests/gamemaker/main.c).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'gamemaker');
fs.mkdirSync(out, { recursive: true });
const cc = process.env.CC ?? 'cc';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
run(cc, ['-std=c99', '-O1', '-Wall', '-Wextra', '-Werror', '-Icore/include', 'core/src/ugo.c', 'engines/gamemaker/extension/ugo9_gm.c', 'tests/gamemaker/main.c', '-lm', '-o', path.join(out, 'gamemaker_test')]);
run(path.join(out, 'gamemaker_test'), [root]);
