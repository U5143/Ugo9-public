// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Makes the RPG Maker MZ plugin: one classic script (MZ loads plugins as plain <script>s) holding the
// Web runtime (engines/web_bundle.mjs) and plugin_main.js, after the plugin's header.
//   node engines/rpgmaker_mz/build.mjs [out file]   (default: build/rpgmaker_mz/Ugo9.js)
import fs from 'node:fs';
import path from 'node:path';
import { root, webRuntime, engineFile, write } from '../web_bundle.mjs';

const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'rpgmaker_mz', 'Ugo9.js'));
write(out, `${fs.readFileSync(path.join(root, 'engines', 'rpgmaker_mz', 'header.txt'), 'utf8')}// Built by engines/rpgmaker_mz/build.mjs from web/ugo.js, web/ugo_layer.js, web/ugo.wasm and plugin_main.js.
(() => {
'use strict';
${webRuntime()}
${engineFile('engines/rpgmaker_mz/plugin_main.js')}
})();
`);
