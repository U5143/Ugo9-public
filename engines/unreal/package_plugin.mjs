// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Copies the Ugo9 Unreal plugin, with the core's C sources inside it, into a project's Plugins folder:
//   node engines/unreal/package_plugin.mjs <your project>/Plugins
// (Inside this repository the plugin also builds where it is: its Build.cs copies the core itself.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dest = process.argv[2];
if (!dest) throw new Error('usage: node engines/unreal/package_plugin.mjs <your project>/Plugins');
const from = path.join(root, 'engines', 'unreal', 'Ugo9'), to = path.join(path.resolve(dest), 'Ugo9');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true, filter: (p) => !/[\\/](Binaries|Intermediate)([\\/]|$)/.test(p) });
const core = path.join(to, 'Source', 'Ugo9', 'Private', 'UgoCore');
fs.mkdirSync(core, { recursive: true });
// ugo.c and every header of the core (a new header, such as the SIMD one, comes along by itself)
const coreFiles = ['core/src/ugo.c', ...['core/src', 'core/include'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith('.h')).map((n) => `${d}/${n}`))];
for (const f of coreFiles) fs.copyFileSync(path.join(root, f), path.join(core, path.basename(f)));
// the sample character (samples/basic, made for this project), for the automation tests and a first import
const sample = path.join(to, 'Resources', 'Samples', 'basic');
fs.mkdirSync(sample, { recursive: true });
for (const f of ['model.ug9', 'atlas.png']) fs.copyFileSync(path.join(root, 'samples', 'basic', f), path.join(sample, f));
console.log(`copied the Ugo9 plugin (with the core and samples/basic) -> ${to}`);
