# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Compile-checks the Unity shader's HLSL with glslang (each variant, vertex and
# fragment): python3 tests/unity_shader_check.py   (needs glslangValidator)
import os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(root, 'engines/unity/com.ugo9.runtime/Runtime/Resources/Ugo9Character.shader')).read()
body = src[src.index('HLSLPROGRAM') + len('HLSLPROGRAM'):src.index('ENDHLSL')]
body = '\n'.join(l for l in body.split('\n') if not l.strip().startswith('#pragma'))  # Unity-only lines
failures = 0
with tempfile.TemporaryDirectory() as tmp:
    for variant, define in [('normal', ''), ('mask', '#define UGO_MASK_PASS 1\n'), ('mask array', '#define UGO_MASK_ARRAY 1\n')]:
        f = os.path.join(tmp, 'shader.hlsl')
        open(f, 'w').write(define + body)
        for stage in ['vert', 'frag']:
            r = subprocess.run(['glslangValidator', '-D', '-S', stage, '-e', stage, '-V', '--target-env', 'vulkan1.1', f, '-o', os.devnull],
                               capture_output=True, text=True)
            ok = r.returncode == 0
            print(f"{'ok  ' if ok else 'FAIL'} {variant} {stage}")
            if not ok:
                failures += 1
                print(r.stdout + r.stderr)
sys.exit(1 if failures else 0)
