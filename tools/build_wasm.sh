#!/bin/sh
# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Builds the C core for the web with plain clang (no Emscripten, no libc), twice:
#   web/ugo.wasm       runs in every browser with WebAssembly
#   web/ugo_simd.wasm  uses WebAssembly SIMD (core/src/ugo_simd.h): faster, the same results bit for bit;
#                      UgoRuntime.load picks it where the browser has SIMD
set -e
cd "$(dirname "$0")/.."
for v in plain simd; do
  if [ $v = simd ]; then out=web/ugo_simd.wasm; extra=-msimd128; else out=web/ugo.wasm; extra=; fi
  clang --target=wasm32 -std=c99 -O3 -ffreestanding -nostdlib -mbulk-memory $extra \
    -fvisibility=hidden -Icore/include \
    -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-debug -Wl,-z,stack-size=65536 \
    -o $out core/src/ugo.c core/src/ugo_raster.c web/src/ugo_wasm.c
  echo "$out: $(wc -c < $out) bytes"
done
