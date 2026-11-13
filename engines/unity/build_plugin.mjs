// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Builds the C core as a shared library and puts it in the Unity package:
//   node engines/unity/build_plugin.mjs
// Windows: Runtime/Plugins/Windows/x86_64/ugo.dll, macOS: Runtime/Plugins/macOS/libugo.dylib
// (arm64 + x86_64), Linux: Runtime/Plugins/Linux/x86_64/libugo.so. Needs CMake and a C compiler
// (on Windows, Visual Studio 2022 or its Build Tools with "Desktop development with C++").
//
// Phones and the Web (each also writes the .meta files that tell Unity which platform it is for):
//   node engines/unity/build_plugin.mjs --android [--abi arm64-v8a,armeabi-v7a]
//     Runtime/Plugins/Android/libs/<abi>/libugo.so, with the Android NDK (ANDROID_NDK_HOME or
//     ANDROID_NDK_ROOT, or Unity's own: <Unity>/Editor/Data/PlaybackEngines/AndroidPlayer/NDK).
//     arm64-v8a is what phones need (Google Play requires 64-bit); armeabi-v7a only for old ones.
//   node engines/unity/build_plugin.mjs --sources
//     Runtime/Plugins/iOS/ugo9/ and Runtime/Plugins/WebGL/ugo9/: the core's C sources, which
//     Unity compiles into the player itself (Xcode for iOS, Emscripten for WebGL; the C# side
//     calls them as "__Internal"). No compiler needed here.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const build = path.join(root, 'build', 'unity-plugin');
const plugins = path.join(root, 'engines', 'unity', 'com.ugo9.runtime', 'Runtime', 'Plugins');

// CMake: the one on PATH, or (Windows) the one inside Visual Studio or its Build Tools,
// which is not on PATH outside the "Developer PowerShell for VS"
function findCmake() {
  try { execFileSync('cmake', ['--version'], { stdio: 'ignore' }); return 'cmake'; } catch { /* not on PATH */ }
  if (process.platform !== 'win32') throw new Error('cmake not found: install CMake');
  const inVs = (dir) => path.join(dir, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const dirs = [];
  if (fs.existsSync(vswhere)) {
    try {
      dirs.push(...execFileSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
    } catch { /* fall back to the usual places */ }
  }
  for (const base of [process.env.ProgramFiles ?? 'C:\\Program Files', pf86]) {
    for (const year of ['2022', '2019']) {
      for (const kind of ['BuildTools', 'Community', 'Professional', 'Enterprise']) dirs.push(path.join(base, 'Microsoft Visual Studio', year, kind));
    }
  }
  const found = dirs.map(inVs).find((p) => fs.existsSync(p));
  if (!found) throw new Error('cmake not found: install Visual Studio 2022 Build Tools with "Desktop development with C++" (it includes CMake), or put cmake on PATH');
  console.log(`using ${found}`);
  return found;
}
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

// .meta files with fixed GUIDs (from the path), so Unity knows the platform without guessing
function writeMeta(file, platform, settings = {}) {
  const rel = path.relative(plugins, file).split(path.sep).join('/');
  const guid = crypto.createHash('md5').update(`ugo9-plugin:${rel}`).digest('hex');
  const extra = Object.entries(settings).map(([k, v]) => `        ${k}: ${v}`).join('\n');
  const editorOff = '  - first:\n      Editor: Editor\n    second:\n      enabled: 0\n      settings:\n        DefaultValueInitialized: true';
  fs.writeFileSync(`${file}.meta`, `fileFormatVersion: 2
guid: ${guid}
PluginImporter:
  externalObjects: {}
  serializedVersion: 2
  iconMap: {}
  executionOrder: {}
  defineConstraints: []
  isPreloaded: 0
  isOverridable: 1
  isExplicitlyReferenced: 0
  validateReferences: 1
  platformData:
  - first:
      Any: 
    second:
      enabled: 0
      settings: {}
${editorOff}
  - first:
      ${platform}
    second:
      enabled: 1
      settings:${extra ? `\n${extra}` : ' {}'}
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`);
}

if (flag('--sources')) {
  // iOS and WebGL: the C sources go into the player's own build
  // every .c and .h of the core (a new header, such as the SIMD one, comes along by itself)
  const files = ['core/src', 'core/include'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((n) => /\.[ch]$/.test(n)).sort().map((n) => `${d}/${n}`));
  for (const [dir, platform] of [['iOS', 'iPhone: iOS'], ['WebGL', 'WebGL: WebGL']]) {
    const out = path.join(plugins, dir, 'ugo9');
    fs.mkdirSync(out, { recursive: true });
    for (const f of files) {
      const dest = path.join(out, path.basename(f));
      fs.copyFileSync(path.join(root, f), dest);
      writeMeta(dest, platform);
    }
    console.log(`copied the core's sources -> ${out}`);
  }
} else if (flag('--android')) {
  const unityNdk = []; // Unity installs its own NDK next to the editor
  for (const base of ['C:\\Program Files\\Unity\\Hub\\Editor', '/Applications/Unity/Hub/Editor', path.join(process.env.HOME ?? '', 'Unity', 'Hub', 'Editor')]) {
    if (!fs.existsSync(base)) continue;
    for (const v of fs.readdirSync(base).sort().reverse()) {
      unityNdk.push(path.join(base, v, 'Editor', 'Data', 'PlaybackEngines', 'AndroidPlayer', 'NDK'));
      unityNdk.push(path.join(base, v, 'PlaybackEngines', 'AndroidPlayer', 'NDK'));
    }
  }
  const ndk = [process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT, ...unityNdk].find((d) => d && fs.existsSync(path.join(d, 'build', 'cmake', 'android.toolchain.cmake')));
  if (!ndk) throw new Error('Android NDK not found: install Android Build Support (with the NDK) in Unity Hub, or set ANDROID_NDK_HOME');
  console.log(`using the NDK at ${ndk}`);
  const cmake = findCmake();
  const ninja = (() => { try { execFileSync('ninja', ['--version'], { stdio: 'ignore' }); return ['-G', 'Ninja']; } catch { return []; } })();
  for (const abi of option('--abi', 'arm64-v8a').split(',')) {
    const dir = path.join(root, 'build', `unity-plugin-android-${abi}`);
    const run = (a) => execFileSync(cmake, a, { stdio: 'inherit', cwd: root });
    run(['-S', '.', '-B', dir, ...ninja, '-DCMAKE_BUILD_TYPE=Release', '-DUGO_SHARED=ON',
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, 'build', 'cmake', 'android.toolchain.cmake')}`, `-DANDROID_ABI=${abi}`, '-DANDROID_PLATFORM=android-23',
      '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON']); // 16 KB pages (Android 15 and later devices)
    run(['--build', dir, '--config', 'Release', '--target', 'ugo_shared']);
    const out = path.join(plugins, 'Android', 'libs', abi);
    fs.mkdirSync(out, { recursive: true });
    const dest = path.join(out, 'libugo.so');
    fs.copyFileSync(path.join(dir, 'libugo.so'), dest);
    writeMeta(dest, 'Android: Android', { CPU: abi === 'arm64-v8a' ? 'ARM64' : abi === 'armeabi-v7a' ? 'ARMv7' : 'X86_64' });
    console.log(`copied -> ${dest}`);
  }
} else {
  const cmake = findCmake();
  const run = (a) => execFileSync(cmake, a, { stdio: 'inherit', cwd: root });
  const extra = process.platform === 'darwin' ? ['-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64'] : [];
  run(['-S', '.', '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DUGO_SHARED=ON', ...extra]);
  run(['--build', build, '--config', 'Release', '--target', 'ugo_shared']);

  const [file, dest] = {
    win32: ['ugo.dll', 'Windows/x86_64'],
    darwin: ['libugo.dylib', 'macOS'],
    linux: ['libugo.so', 'Linux/x86_64'],
  }[process.platform];
  const found = [path.join(build, 'Release', file), path.join(build, file)].find((p) => fs.existsSync(p));
  if (!found) throw new Error(`built library not found: ${file}`);
  fs.mkdirSync(path.join(plugins, dest), { recursive: true });
  fs.copyFileSync(found, path.join(plugins, dest, file));
  console.log(`copied ${found} -> ${path.join(plugins, dest, file)}`);
}
