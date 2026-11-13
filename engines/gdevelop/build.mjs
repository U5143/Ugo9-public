// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Makes Ugo9 for GDevelop: one classic script with the Web runtime (engines/web_bundle.mjs) and gdevelop_main.js.
//   node engines/gdevelop/build.mjs [out file]   (default: build/gdevelop/Ugo9GDevelop.js)
import path from 'node:path';
import { root, webRuntime, engineFile, write } from '../web_bundle.mjs';

const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'gdevelop', 'Ugo9GDevelop.js'));
write(out, `// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for GDevelop (gdjs.ugo9). Built by engines/gdevelop/build.mjs from web/ugo.js, web/ugo_layer.js, web/ugo.wasm and gdevelop_main.js.
(() => {
'use strict';
${webRuntime()}
${engineFile('engines/gdevelop/gdevelop_main.js')}
})();
`);
