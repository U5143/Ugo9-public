# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Compile-checks the Unreal plugin's shader (engines/unreal/Ugo9/Shaders/Private/Ugo9.usf) with
# glslang, vertex and pixel, with Unreal's Platform.ush left out (it is only a common header there):
#   python3 tests/unreal_shader_check.py   (needs glslangValidator)
import os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(root, 'engines/unreal/Ugo9/Shaders/Private/Ugo9.usf')).read()
body = '\n'.join(l for l in src.split('\n') if not l.strip().startswith('#include "/Engine/'))
failures = 0
with tempfile.TemporaryDirectory() as tmp:
    f = os.path.join(tmp, 'shader.hlsl')
    open(f, 'w').write(body)
    for stage, entry in [('vert', 'MainVS'), ('frag', 'MainPS'), ('vert', 'MaskVS'), ('frag', 'MaskPS')]:
        r = subprocess.run(['glslangValidator', '-D', '-S', stage, '-e', entry, '-V', '--target-env', 'vulkan1.1', f, '-o', os.devnull],
                           capture_output=True, text=True)
        ok = r.returncode == 0
        print(f"{'ok  ' if ok else 'FAIL'} {entry}")
        if not ok:
            failures += 1
            print(r.stdout + r.stderr)
sys.exit(1 if failures else 0)
