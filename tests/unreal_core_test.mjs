// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Builds the Unreal plugin's core layer (no Unreal needed) with the C core and runs tests/unreal_core.
//   node tests/unreal_core_test.mjs        (needs cc and c++, e.g. gcc or clang)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'unreal_core');
fs.mkdirSync(out, { recursive: true });
const ue = path.join(root, 'engines', 'unreal', 'Ugo9', 'Source', 'Ugo9');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
const cc = process.env.CC ?? 'cc', cxx = process.env.CXX ?? 'c++';
run(cc, ['-std=c99', '-O1', '-c', 'core/src/ugo.c', '-Icore/include', '-o', path.join(out, 'ugo.o')]);
run(cxx, ['-std=c++17', '-O1', '-Wall', '-Wextra', '-Werror', `-I${path.join(ue, 'Public')}`, '-Icore/include',
  path.join(ue, 'Private', 'UgoCore.cpp'), path.join(ue, 'Private', 'UgoFeatures.cpp'), 'tests/unreal_core/main.cpp', path.join(out, 'ugo.o'), '-lm', '-o', path.join(out, 'unreal_core')]);
run(path.join(out, 'unreal_core'), [root]);
