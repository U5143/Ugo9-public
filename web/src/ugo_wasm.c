/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* WebAssembly glue: a bump allocator so JavaScript can hand memory to the core.
 * Built together with the core sources by tools/build_wasm.sh (no libc). */
#include <stddef.h>
#include <stdint.h>

#include "ugo.h"

extern unsigned char __heap_base;
static uintptr_t heap_top;

/* Returns 16-byte aligned memory inside the wasm heap, or 0. */
UGO_API void *ugo_wasm_alloc(uint32_t size)
{
    uintptr_t p, end, have;
    if (!heap_top) heap_top = (uintptr_t)&__heap_base;
    p = (heap_top + 15u) & ~(uintptr_t)15u;
    end = p + size;
    have = (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
    if (end > have && __builtin_wasm_memory_grow(0, (end - have + 65535u) / 65536u) == (size_t)-1) return 0;
    heap_top = end;
    return (void *)p;
}

/* Everything allocated after `mark` is released (stack style). */
UGO_API uint32_t ugo_wasm_mark(void) { if (!heap_top) heap_top = (uintptr_t)&__heap_base; return (uint32_t)heap_top; }
UGO_API void ugo_wasm_release(uint32_t mark) { if (mark >= (uint32_t)(uintptr_t)&__heap_base) heap_top = mark; }

/* 1 in the build with WebAssembly SIMD (web/ugo_simd.wasm), 0 in web/ugo.wasm. */
UGO_API uint32_t ugo_wasm_simd(void)
{
#ifdef __wasm_simd128__
    return 1;
#else
    return 0;
#endif
}
