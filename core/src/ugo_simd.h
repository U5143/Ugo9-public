/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Small vectors for the core's hot loops, with the same results bit for bit
 * as the plain C (only exact operations: loads, stores, xor/or of bits, and
 * IEEE add and multiply lane by lane, each rounded on its own: never fused,
 * NEON's vmulq/vaddq and SSE's mul/add are separate instructions). Picked by the compiler's target:
 * WebAssembly SIMD (clang -msimd128), SSE2 (x86-64), NEON (AArch64); else
 * plain C. Define UGO_NO_SIMD to use plain C everywhere. */
#ifndef UGO_SIMD_H
#define UGO_SIMD_H

#include <stdint.h>

#if defined(_MSC_VER) && !defined(__cplusplus)
#define UGO_INLINE __inline /* (MSVC's C before C11 has no inline) */
#else
#define UGO_INLINE inline
#endif

#if !defined(UGO_NO_SIMD) && defined(__wasm_simd128__)
#include <wasm_simd128.h>
#define UGO_SIMD_KIND 1
typedef v128_t ugo_u4;
static UGO_INLINE ugo_u4 u4_load(const void *p) { return wasm_v128_load(p); }
static UGO_INLINE void u4_store(void *p, ugo_u4 v) { wasm_v128_store(p, v); }
static UGO_INLINE ugo_u4 u4_xor(ugo_u4 a, ugo_u4 b) { return wasm_v128_xor(a, b); }
static UGO_INLINE ugo_u4 u4_or(ugo_u4 a, ugo_u4 b) { return wasm_v128_or(a, b); }
static UGO_INLINE int u4_any(ugo_u4 a) { return wasm_v128_any_true(a); }
typedef v128_t ugo_d2; /* 2 doubles */
static UGO_INLINE ugo_d2 d2_set(double a, double b) { return wasm_f64x2_make(a, b); }
static UGO_INLINE ugo_d2 d2_add(ugo_d2 a, ugo_d2 b) { return wasm_f64x2_add(a, b); }
static UGO_INLINE ugo_d2 d2_mul(ugo_d2 a, ugo_d2 b) { return wasm_f64x2_mul(a, b); }
static UGO_INLINE double d2_lo(ugo_d2 a) { return wasm_f64x2_extract_lane(a, 0); }
static UGO_INLINE double d2_hi(ugo_d2 a) { return wasm_f64x2_extract_lane(a, 1); }
typedef v128_t ugo_f4; /* 4 floats */
static UGO_INLINE ugo_f4 f4_set(float a, float b, float c, float d) { return wasm_f32x4_make(a, b, c, d); }
static UGO_INLINE ugo_f4 f4_add(ugo_f4 a, ugo_f4 b) { return wasm_f32x4_add(a, b); }
static UGO_INLINE ugo_f4 f4_mul(ugo_f4 a, ugo_f4 b) { return wasm_f32x4_mul(a, b); }
static UGO_INLINE void f4_store(float *p, ugo_f4 v) { wasm_v128_store(p, v); }
#elif !defined(UGO_NO_SIMD) && (defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2))
#include <emmintrin.h>
#define UGO_SIMD_KIND 2
typedef __m128i ugo_u4;
static UGO_INLINE ugo_u4 u4_load(const void *p) { return _mm_loadu_si128((const __m128i *)p); }
static UGO_INLINE void u4_store(void *p, ugo_u4 v) { _mm_storeu_si128((__m128i *)p, v); }
static UGO_INLINE ugo_u4 u4_xor(ugo_u4 a, ugo_u4 b) { return _mm_xor_si128(a, b); }
static UGO_INLINE ugo_u4 u4_or(ugo_u4 a, ugo_u4 b) { return _mm_or_si128(a, b); }
static UGO_INLINE int u4_any(ugo_u4 a) { return _mm_movemask_epi8(_mm_cmpeq_epi8(a, _mm_setzero_si128())) != 0xffff; }
typedef __m128d ugo_d2;
static UGO_INLINE ugo_d2 d2_set(double a, double b) { return _mm_set_pd(b, a); }
static UGO_INLINE ugo_d2 d2_add(ugo_d2 a, ugo_d2 b) { return _mm_add_pd(a, b); }
static UGO_INLINE ugo_d2 d2_mul(ugo_d2 a, ugo_d2 b) { return _mm_mul_pd(a, b); }
static UGO_INLINE double d2_lo(ugo_d2 a) { return _mm_cvtsd_f64(a); }
static UGO_INLINE double d2_hi(ugo_d2 a) { return _mm_cvtsd_f64(_mm_unpackhi_pd(a, a)); }
typedef __m128 ugo_f4;
static UGO_INLINE ugo_f4 f4_set(float a, float b, float c, float d) { return _mm_set_ps(d, c, b, a); }
static UGO_INLINE ugo_f4 f4_add(ugo_f4 a, ugo_f4 b) { return _mm_add_ps(a, b); }
static UGO_INLINE ugo_f4 f4_mul(ugo_f4 a, ugo_f4 b) { return _mm_mul_ps(a, b); }
static UGO_INLINE void f4_store(float *p, ugo_f4 v) { _mm_storeu_ps(p, v); }
#elif !defined(UGO_NO_SIMD) && (defined(__aarch64__) || defined(_M_ARM64)) && defined(__ARM_NEON)
#include <arm_neon.h>
#define UGO_SIMD_KIND 3
typedef uint32x4_t ugo_u4;
static UGO_INLINE ugo_u4 u4_load(const void *p) { return vld1q_u32((const uint32_t *)p); }
static UGO_INLINE void u4_store(void *p, ugo_u4 v) { vst1q_u32((uint32_t *)p, v); }
static UGO_INLINE ugo_u4 u4_xor(ugo_u4 a, ugo_u4 b) { return veorq_u32(a, b); }
static UGO_INLINE ugo_u4 u4_or(ugo_u4 a, ugo_u4 b) { return vorrq_u32(a, b); }
static UGO_INLINE int u4_any(ugo_u4 a) { return vmaxvq_u32(a) != 0; }
typedef float64x2_t ugo_d2;
static UGO_INLINE ugo_d2 d2_set(double a, double b) { float64x2_t v = vdupq_n_f64(a); return vsetq_lane_f64(b, v, 1); }
static UGO_INLINE ugo_d2 d2_add(ugo_d2 a, ugo_d2 b) { return vaddq_f64(a, b); }
static UGO_INLINE ugo_d2 d2_mul(ugo_d2 a, ugo_d2 b) { return vmulq_f64(a, b); }
static UGO_INLINE double d2_lo(ugo_d2 a) { return vgetq_lane_f64(a, 0); }
static UGO_INLINE double d2_hi(ugo_d2 a) { return vgetq_lane_f64(a, 1); }
typedef float32x4_t ugo_f4;
static UGO_INLINE ugo_f4 f4_set(float a, float b, float c, float d) { float v[4]; v[0] = a; v[1] = b; v[2] = c; v[3] = d; return vld1q_f32(v); }
static UGO_INLINE ugo_f4 f4_add(ugo_f4 a, ugo_f4 b) { return vaddq_f32(a, b); }
static UGO_INLINE ugo_f4 f4_mul(ugo_f4 a, ugo_f4 b) { return vmulq_f32(a, b); }
static UGO_INLINE void f4_store(float *p, ugo_f4 v) { vst1q_f32(p, v); }
#else
#define UGO_SIMD_KIND 0
#endif

#endif
