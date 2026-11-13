/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Ugo9 runtime core. See core/include/ugo.h and the format spec in docs/. */
#include "ugo.h"
#include "ugo_internal.h"
#include "ugo_simd.h"

static int g_last_error = UGO_OK;

int ugo_last_error(void) { return g_last_error; }
uint32_t ugo_version(void) { return ((uint32_t)UGO_VERSION_MAJOR << 16) | UGO_VERSION_MINOR; }

/* ---- small freestanding helpers --------------------------------------- */

static uint32_t align16(uint32_t v) { return (v + 15u) & ~15u; }
static uint32_t align4(uint32_t v) { return (v + 3u) & ~3u; }

static int is_finite(float f)
{
    union { float f; uint32_t u; } x;
    x.f = f;
    return (x.u & 0x7f800000u) != 0x7f800000u;
}

static int str_eq(const char *a, const char *b)
{
    while (*a && *a == *b) { a++; b++; }
    return *a == *b;
}

static double kfloor(double x)
{
    double t;
    if (x > 9.0e15 || x < -9.0e15) return x;
    t = (double)(int64_t)x;
    return (t > x) ? t - 1.0 : t;
}

/* Deterministic sin/cos (same bits on every platform that has IEEE doubles). */
static void ksincos(float angle, float *s_out, float *c_out)
{
    const double TWO_PI = 6.28318530717958647692;
    const double HALF_PI = 1.57079632679489661923;
    double x = (double)angle, r, r2, s, c;
    int q;
    /* Taylor series to r^11 / r^10 with constant coefficients (multiplications only: divisions are slow) */
    static const double S1 = -1.0 / 6.0, S2 = 1.0 / 120.0, S3 = -1.0 / 5040.0, S4 = 1.0 / 362880.0, S5 = -1.0 / 39916800.0;
    static const double C1 = -1.0 / 2.0, C2 = 1.0 / 24.0, C3 = -1.0 / 720.0, C4 = 1.0 / 40320.0, C5 = -1.0 / 3628800.0;
    x -= TWO_PI * kfloor(x * (1.0 / TWO_PI) + 0.5); /* [-pi, pi] */
    q = (int)kfloor(x * (1.0 / HALF_PI) + 0.5);     /* -2..2 */
    r = x - q * HALF_PI;                            /* [-pi/4, pi/4] */
    r2 = r * r;
#if UGO_SIMD_KIND
    { /* both series side by side: the same operations in the same order */
        ugo_d2 R2 = d2_set(r2, r2), t = d2_set(S5, C5);
        t = d2_add(d2_set(S4, C4), d2_mul(R2, t));
        t = d2_add(d2_set(S3, C3), d2_mul(R2, t));
        t = d2_add(d2_set(S2, C2), d2_mul(R2, t));
        t = d2_add(d2_set(S1, C1), d2_mul(R2, t));
        t = d2_add(d2_set(1.0, 1.0), d2_mul(R2, t));
        s = r * d2_lo(t);
        c = d2_hi(t);
    }
#else
    s = r * (1.0 + r2 * (S1 + r2 * (S2 + r2 * (S3 + r2 * (S4 + r2 * S5)))));
    c = 1.0 + r2 * (C1 + r2 * (C2 + r2 * (C3 + r2 * (C4 + r2 * C5))));
#endif
    switch (q & 3) {
    case 0: *s_out = (float)s; *c_out = (float)c; break;
    case 1: *s_out = (float)c; *c_out = (float)-s; break;
    case 2: *s_out = (float)-s; *c_out = (float)-c; break;
    default: *s_out = (float)-c; *c_out = (float)s; break;
    }
}

/* 1 / sqrt(x) for 1e-300 < x < 1e300 by Newton steps, which need no division
 * (divisions are slow). The first guess is within 3.5%; four steps reach a
 * double's precision. */
static double krsqrt(double x)
{
    union { double d; uint64_t u; } v;
    double y;
    int i;
    v.d = x;
    v.u = (uint64_t)0x5fe6eb50c7b537a9u - (v.u >> 1);
    y = v.d;
    for (i = 0; i < 4; i++) y = y * (1.5 - 0.5 * x * y * y);
    return y;
}

static double ksqrt(double x)
{
    if (!(x > 0.0)) return 0.0;
    if (x > 1.0e300 || x < 1.0e-300) return x > 1.0e300 ? x : 0.0;
    return x * krsqrt(x);
}

/* atan for 0 <= x <= 1: one argument reduction, then the Taylor series. */
static double katan_unit(double x)
{
    const double T = 0.26794919243112270; /* tan(pi/12) */
    const double R3 = 1.7320508075688772;
    static const double A[14] = { 1.0, -1.0 / 3, 1.0 / 5, -1.0 / 7, 1.0 / 9, -1.0 / 11, 1.0 / 13, -1.0 / 15, 1.0 / 17,
                                  -1.0 / 19, 1.0 / 21, -1.0 / 23, 1.0 / 25, -1.0 / 27 };
    double base = 0.0, x2, p;
    int k;
    if (x > T) { x = (x * R3 - 1.0) / (x + R3); base = 0.52359877559829887; } /* + pi/6 */
    x2 = x * x;
    p = A[13];
    for (k = 12; k >= 0; k--) p = p * x2 + A[k]; /* Horner: multiplications only */
    return base + x * p;
}

/* Deterministic atan2 (same bits everywhere). */
static double katan2(double y, double x)
{
    const double PI = 3.14159265358979323846;
    double ax = x < 0.0 ? -x : x, ay = y < 0.0 ? -y : y, a;
    if (!(ax > 0.0) && !(ay > 0.0)) return 0.0;
    a = ay <= ax ? katan_unit(ay / ax) : PI / 2.0 - katan_unit(ax / ay);
    if (x < 0.0) a = PI - a;
    return y < 0.0 ? -a : a;
}

/* Angle into (-pi, pi]. */
static double kwrap(double r)
{
    const double TWO_PI = 6.28318530717958647692;
    r -= TWO_PI * kfloor(r / TWO_PI + 0.5);
    return r;
}

/* out = A * B for 2x3 affine matrices (a,b,c,d,tx,ty). out may alias neither. */
static void mat_mul(float *out, const float *A, const float *B)
{
#if UGO_SIMD_KIND
    /* (the same products and sums, four at a time; out[4], out[5] add A[4], A[5] last as below) */
    ugo_f4 x = f4_add(f4_mul(f4_set(A[0], A[1], A[0], A[1]), f4_set(B[0], B[0], B[2], B[2])),
                      f4_mul(f4_set(A[2], A[3], A[2], A[3]), f4_set(B[1], B[1], B[3], B[3])));
    ugo_f4 y = f4_add(f4_add(f4_mul(f4_set(A[0], A[1], 0.0f, 0.0f), f4_set(B[4], B[4], 0.0f, 0.0f)),
                             f4_mul(f4_set(A[2], A[3], 0.0f, 0.0f), f4_set(B[5], B[5], 0.0f, 0.0f))),
                      f4_set(A[4], A[5], 0.0f, 0.0f));
    float t[4];
    f4_store(out, x);
    f4_store(t, y);
    out[4] = t[0]; out[5] = t[1];
#else
    out[0] = A[0] * B[0] + A[2] * B[1];
    out[1] = A[1] * B[0] + A[3] * B[1];
    out[2] = A[0] * B[2] + A[2] * B[3];
    out[3] = A[1] * B[2] + A[3] * B[3];
    out[4] = A[0] * B[4] + A[2] * B[5] + A[4];
    out[5] = A[1] * B[4] + A[3] * B[5] + A[5];
#endif
}

/* Variable-font style "tent": 1 at peak, falling linearly to 0 at start/end. */
static float tent(float v, float start, float peak, float end)
{
    if (v == peak) return 1.0f;
    if (v < peak) {
        if (v <= start || peak == start) return 0.0f;
        return (v - start) / (peak - start);
    }
    if (v >= end || end == peak) return 0.0f;
    return (end - v) / (end - peak);
}

/* ---- warp grids --------------------------------------------------------- */
/* In the frame block a warp is its control points with one more ring around
 * them (P[-1] = 2 P[0] - P[1], so the surface passes through the outer
 * points): (cols + 3) x (rows + 3) points, 2 floats each. A point (x, y) in
 * cell coordinates is placed by the uniform cubic B-spline of that net, and
 * outside 0..cols x 0..rows it continues straight along the edge's slope. */
static uint32_t warp_frame_floats(const KWarp *w) { return align4(2 * (w->cols + 3) * (w->rows + 3)); }

static void bspline4(float t, float *b, float *d)
{
    float t2 = t * t, t3 = t2 * t, s = 1.0f - t;
    b[0] = s * s * s * (1.0f / 6.0f);
    b[1] = (4.0f - 6.0f * t2 + 3.0f * t3) * (1.0f / 6.0f);
    b[2] = (1.0f + 3.0f * t + 3.0f * t2 - 3.0f * t3) * (1.0f / 6.0f);
    b[3] = t3 * (1.0f / 6.0f);
    if (d) { d[0] = -0.5f * s * s; d[1] = -2.0f * t + 1.5f * t2; d[2] = 0.5f + t - 1.5f * t2; d[3] = 0.5f * t2; }
}

/* E: the extended net of a cols x rows warp. */
static void warp_eval(const float *E, uint32_t cols, uint32_t rows, float x, float y, float *out)
{
    float qx = x < 0.0f ? 0.0f : (x > (float)cols ? (float)cols : x);
    float qy = y < 0.0f ? 0.0f : (y > (float)rows ? (float)rows : y);
    uint32_t cx = (uint32_t)qx, cy = (uint32_t)qy, W = cols + 3, i, j;
    float bu[4], bv[4], du[4], dv[4], ox = 0.0f, oy = 0.0f;
    int outside = (qx != x || qy != y) && x == x && y == y;
    if (cx > cols - 1) cx = cols - 1;
    if (cy > rows - 1) cy = rows - 1;
    bspline4(qx - (float)cx, bu, outside ? du : 0);
    bspline4(qy - (float)cy, bv, outside ? dv : 0);
    for (j = 0; j < 4; j++)
        for (i = 0; i < 4; i++) {
            const float *P = E + 2 * ((cy + j) * W + cx + i);
            float w = bu[i] * bv[j];
            ox += w * P[0]; oy += w * P[1];
        }
    if (outside) { /* straight on along the slope at the edge */
        float ex = x - qx, ey = y - qy;
        for (j = 0; j < 4; j++)
            for (i = 0; i < 4; i++) {
                const float *P = E + 2 * ((cy + j) * W + cx + i);
                float w = du[i] * bv[j] * ex + bu[i] * dv[j] * ey;
                ox += w * P[0]; oy += w * P[1];
            }
    }
    out[0] = ox; out[1] = oy;
}

/* ---- model loading ---------------------------------------------------- */

#define FAIL(code) do { g_last_error = (code); return 0; } while (0)

static const uint32_t g_limit[KC_COUNT_FIELDS] = {
    4096, 8192, 8192, 65535, 64,
    1u << 22, 1u << 24, 1u << 24, 1u << 20, 1u << 20,
    1u << 20, 1u << 20, 4096, 1u << 16,
    4096, 1u << 20, 1u << 22, 1u << 24,
    65535, 1u << 20, 65535, 1u << 20, 1u << 24,
    4096, 1u << 20, 1u << 20, 1u << 24, 8192,
    4096, 8192,
    65535, 1u << 20,
    4096, 1u << 20
};

/* Each known table kind: where its count goes, and the size of one record. */
#define SLOT_VERT 100u  /* one record per vertex (the positions table's count) */
#define SLOT_VERT1 101u /* one per vertex, plus one */
#define SLOT_NONE 102u
static const struct { uint8_t slot; uint16_t size; } g_tables[TB_KNOWN] = {
    { SLOT_NONE, 0 },
    { KC_PARAMS, sizeof(KParam) }, { KC_BONES, sizeof(KBone) }, { KC_CONS, sizeof(KCons) }, { KC_PARTS, sizeof(KPart) },
    { KC_TEXTURES, 4 }, { KC_VERTS, 8 }, { SLOT_VERT, 8 }, { SLOT_VERT, 8 }, { SLOT_VERT, 16 }, { SLOT_VERT, 4 },
    { SLOT_VERT1, 4 }, { KC_ENTRIES, sizeof(KEntry) }, { KC_INDICES, 4 }, { KC_REGIONS, sizeof(KRegion) }, { KC_MORPHS, 4 },
    { KC_BDRIVERS, sizeof(KBoneDriver) }, { KC_ODRIVERS, sizeof(KOpDriver) }, { KC_PHYS, sizeof(KPhys) },
    { KC_PHYSIN, sizeof(KPhysIn) }, { KC_ANIMS, sizeof(KAnim) },
    { KC_TRACKS, sizeof(KTrack) }, { KC_KEYS, sizeof(KKey) }, { KC_STRINGS, 1 }, { KC_MASKS, sizeof(KMask) }, { KC_MASKREFS, 4 },
    { KC_COLORS, sizeof(KColor) }, { KC_CDRIVERS, sizeof(KColorDriver) }, { SLOT_VERT1, 4 }, { KC_XWEIGHTS, sizeof(KXWeight) },
    { KC_WARPS, sizeof(KWarp) }, { KC_WPOINTS, 8 }, { KC_WDRIVERS, sizeof(KWarpDriver) }, { KC_WDELTAS, 8 },
    { KC_BWARPS, sizeof(KBoneWarp) }, { KC_CHAINS, sizeof(KChain) },
    { KC_CHAINBONES, 4 }, { KC_ORDERS, 4 }, { KC_ORDRIVERS, sizeof(KOrderDriver) }, { KC_EXPRS, sizeof(KExpr) },
    { KC_EXPRITEMS, sizeof(KExprItem) },
    { SLOT_NONE, sizeof(KTrack11) }, { SLOT_NONE, 4 }, { SLOT_NONE, sizeof(KCurve) }, /* 1.1: expanded at load */
};

uint32_t ugo_model_mem_size(void) { return align16((uint32_t)sizeof(UgoModel)); }
uint32_t ugo_model_warnings(const UgoModel *m) { return m->warnings; }
uint32_t ugo_model_format(const UgoModel *m) { return m->format; }

static int name_ok(const UgoModel *m, uint32_t off) { return off < m->n[KC_STRINGS]; }

/* The header and the table of contents: each known table's records and count (absent:
 * none), and the UGO_WARN_* bits for the unknown ones skipped. UGO_OK or an error. */
static int read_toc(const uint8_t *p, uint32_t size, const uint8_t **tab, uint32_t *cnt, uint32_t *warnings)
{
    const uint32_t *hdr = (const uint32_t *)p;
    uint64_t body;
    uint32_t i, j, hsize, ntoc;
    const uint32_t one = 1;
    if (((uintptr_t)p & 3u)) return UGO_ERR_ALIGN;
    if (*(const uint8_t *)&one != 1) return UGO_ERR_VERSION; /* big-endian hosts unsupported */
    if (size < 8) return UGO_ERR_SIZE;
    if (p[0] != 'U' || p[1] != 'G' || p[2] != 'O' || p[3] != '9') return UGO_ERR_MAGIC;
    if ((hdr[1] & 0xffffu) != UGO_VERSION_MAJOR) return UGO_ERR_VERSION; /* any minor of the same major is read */
    if (size < UGO_HEADER_SIZE) return UGO_ERR_SIZE;
    if (hdr[2] != size) return UGO_ERR_SIZE;
    hsize = hdr[3];
    ntoc = hdr[8];
    if (hsize < UGO_HEADER_SIZE || (hsize & 3u) || hsize > size) return UGO_ERR_SIZE; /* (a later 1.x may add header fields) */
    if (ntoc > UGO_TOC_MAX) return UGO_ERR_LIMIT;
    body = (uint64_t)hsize + (uint64_t)ntoc * UGO_TOC_ENTRY;
    if (body > size) return UGO_ERR_SIZE;
    *warnings = 0;
    for (i = 0; i < TB_KNOWN; i++) { tab[i] = p; cnt[i] = 0; } /* absent: no records (an earlier 1.x, or not used) */
    for (i = 0; i < ntoc; i++) {
        const uint32_t *e = (const uint32_t *)(p + hsize + (uint64_t)i * UGO_TOC_ENTRY);
        uint32_t kind = e[0], at = e[1], count = e[2], rsize = e[3] & 0xffffu, flags = e[3] >> 16;
        uint64_t bytes = (uint64_t)count * rsize;
        if (kind == 0) return UGO_ERR_VALUE;
        if (count && ((at & 3u) || at < body || (uint64_t)at + bytes > size)) return UGO_ERR_SIZE;
        for (j = 0; j < i; j++) { /* one entry per kind, and no two tables share bytes */
            const uint32_t *f = (const uint32_t *)(p + hsize + (uint64_t)j * UGO_TOC_ENTRY);
            uint64_t fb = (uint64_t)f[2] * (f[3] & 0xffffu);
            if (f[0] == kind) return UGO_ERR_VALUE;
            if (count && f[2] && at < (uint64_t)f[1] + fb && f[1] < (uint64_t)at + bytes) return UGO_ERR_VALUE;
        }
        if (kind < TB_KNOWN) {
            if (rsize != g_tables[kind].size) return UGO_ERR_VALUE; /* a table's records never change shape */
            tab[kind] = p + at;
            cnt[kind] = count;
        } else if ((flags & TOC_ACTION_MASK) >= TOC_NEED) return UGO_ERR_VERSION; /* needs a newer core */
        else if ((flags & TOC_ACTION_MASK) == TOC_WARN) *warnings |= UGO_WARN_SKIPPED_TABLE;
    }
    return UGO_OK;
}

static int is_zero(float f) { union { float f; uint32_t u; } c; c.f = f; return !(c.u & 0x7fffffffu); }

/* 1.1 tracks and keys (tables 41-43): checks their shape and counts what they expand
 * to: tracks, and keys at most (some of a curve's points may be dropped). UGO_OK or an error. */
static int curve_counts(const uint8_t *const *tab, const uint32_t *cnt, uint32_t *ntracks, uint32_t *nkeys)
{
    const KTrack11 *tr = (const KTrack11 *)tab[TB_TRACKS11];
    const uint32_t *w = (const uint32_t *)tab[TB_KEYS11];
    const KCurve *cv = (const KCurve *)tab[TB_CURVES];
    uint32_t nw = cnt[TB_KEYS11], ncv = cnt[TB_CURVES], i, at = 0, ci = 0;
    uint64_t keys = 0;
    *ntracks = *nkeys = 0;
    if (!cnt[TB_TRACKS11]) return nw || ncv ? UGO_ERR_VALUE : UGO_OK; /* keys or curves without tracks */
    if (cnt[TB_TRACKS] || cnt[TB_KEYS]) return UGO_ERR_VALUE;           /* both kinds of tracks */
    if (cnt[TB_TRACKS11] > g_limit[KC_TRACKS]) return UGO_ERR_LIMIT;
    for (i = 0; i < cnt[TB_TRACKS11]; i++) {
        uint32_t c, first, last;
        if (is_zero(tr[i].step)) continue; /* step 0: no keys, its value is base */
        if (at >= nw) return UGO_ERR_RANGE;
        c = w[at];
        if (c < 2 || c > nw - at - 1) return UGO_ERR_RANGE;
        first = at + 1;
        last = at + c; /* the last key: no segment starts there */
        keys += c;
        for (; ci < ncv && cv[ci].key < last; ci++) {
            const KCurve *k = &cv[ci];
            const KKey *a = (const KKey *)&w[k->key];
            if (k->key < first || (ci && k->key <= cv[ci - 1].key)) return UGO_ERR_RANGE; /* on a key, one per segment, in order */
            if (k->n < 2 || k->n > UGO_CURVE_MAX_PIECES || k->reserved) return UGO_ERR_VALUE;
            if (TRACK_EASED(tr[i].target) || a[1].t < a[0].t) return UGO_ERR_VALUE;
            keys += k->n - 1u;
        }
        at = last + 1;
    }
    if (at != nw) return UGO_ERR_VALUE; /* words left over */
    if (ci != ncv) return UGO_ERR_RANGE;  /* a curve not on a segment */
    if (keys > g_limit[KC_KEYS]) return UGO_ERR_LIMIT;
    *ntracks = cnt[TB_TRACKS11];
    *nkeys = (uint32_t)keys;
    return UGO_OK;
}

/* x / d rounded half up, exactly (x * 2 + d fits in 64 bits here) */
static uint32_t div_round(uint64_t x, uint64_t d) { return (uint32_t)((2u * x + d) / (2u * d)); }

/* Writes the 1.1 tracks as 1.0 tracks and keys (checked by curve_counts first); each curve's
 * points at i / n (i = 1..n-1), times and values rounded half up, a point not later than the
 * previous key or not before the segment's end dropped. Returns the keys written. */
static uint32_t expand_curves(const uint8_t *const *tab, const uint32_t *cnt, KTrack *out, KKey *keys)
{
    const KTrack11 *tr = (const KTrack11 *)tab[TB_TRACKS11];
    const uint32_t *w = (const uint32_t *)tab[TB_KEYS11];
    const KCurve *cv = (const KCurve *)tab[TB_CURVES];
    uint32_t i, j, at = 0, ci = 0, nk = 0;
    for (i = 0; i < cnt[TB_TRACKS11]; i++) {
        uint32_t c, first;
        out[i].target = tr[i].target;
        out[i].base = tr[i].base;
        out[i].step = tr[i].step;
        if (is_zero(tr[i].step)) { out[i].firstKey = 0; out[i].keyCount = 1; continue; }
        c = w[at];
        first = at + 1;
        out[i].firstKey = nk;
        for (j = first; j < first + c; j++) {
            const KKey a = *(const KKey *)&w[j];
            keys[nk++] = a;
            if (ci < cnt[TB_CURVES] && cv[ci].key == j) {
                const KCurve *k = &cv[ci++];
                const KKey b = *(const KKey *)&w[j + 1];
                uint64_t n = k->n, n3 = n * n * n, span = (uint64_t)(b.t - a.t);
                uint32_t s, last = a.t;
                for (s = 1; s < k->n; s++) {
                    uint64_t u = n - s, v = s;
                    uint64_t x = 3u * u * u * v * k->cx1 + 3u * u * v * v * k->cx2 + v * v * v * 65535u;
                    uint64_t y = u * u * u * a.v + 3u * u * u * v * k->cy1 + 3u * u * v * v * k->cy2 + v * v * v * b.v;
                    uint32_t t = a.t + div_round(x * span, 65535u * n3);
                    if (t <= last || t >= b.t) continue;
                    keys[nk].t = (uint16_t)t;
                    keys[nk].v = (uint16_t)div_round(y, n3);
                    nk++;
                    last = t;
                }
            }
        }
        out[i].keyCount = nk - out[i].firstKey;
        at = first + c;
    }
    return nk;
}

/* Where a track of this kind writes: base + stride * index (see ugo_apply_animation). */
static uint32_t track_stride(uint32_t kind) { return (kind >= TK_BONE_ROT && kind <= TK_BONE_SY) || kind == TK_BONE_SHX || kind == TK_BONE_SHY ? 7u : 1u; }

/* The runs of the animations' tracks (see KRun). Tracks are `tsize` bytes from `trk`, nt of them:
 * KTrack (single key: keyCount 1) or, with v11, KTrack11 (single key: step 0; what expand_curves
 * makes keyCount 1). Counts the runs and single-key entries; with `runs`, also writes them
 * (then the tracks are KTrack, checked). Animations whose tracks are out of range have none. */
static void scan_runs(const KAnim *anims, uint32_t na, const uint8_t *trk, uint32_t tsize, uint32_t nt, int v11,
                      uint64_t *nruns, uint64_t *nconst, KRun *runs, uint32_t *animRun, uint32_t *cOff, float *cVal)
{
    uint32_t a;
    uint64_t r = 0, c = 0;
#define SC_TARGET(i) (*(const uint32_t *)(trk + (uintptr_t)(i) * tsize))
#define SC_SINGLE(i) (v11 ? is_zero(((const KTrack11 *)(trk + (uintptr_t)(i) * tsize))->step) : ((const KTrack *)(trk + (uintptr_t)(i) * tsize))->keyCount == 1u)
    for (a = 0; a < na; a++) {
        uint32_t i, end;
        if (animRun) animRun[a] = (uint32_t)r;
        if ((uint64_t)anims[a].firstTrack + anims[a].trackCount > nt) continue;
        if (r + c > 8u * (uint64_t)nt + 256u) { r = c = (uint64_t)1 << 40; break; } /* too many: none (see runs_bytes) */
        i = anims[a].firstTrack;
        end = i + anims[a].trackCount;
        while (i < end) {
            uint32_t kind = TRACK_KIND(SC_TARGET(i)), j = i, k;
            if (kind != TK_PART_OPACITY && kind < TK_COUNT) {
                while (j < end && TRACK_KIND(SC_TARGET(j)) == kind && SC_SINGLE(j)) j++;
                if (j > i) {
                    if (runs) {
                        const KTrack *t = (const KTrack *)(trk + (uintptr_t)i * tsize);
                        uint32_t q, st = track_stride(kind);
                        runs[r].kind = kind; runs[r].first = i; runs[r].count = j - i; runs[r].cfirst = (uint32_t)c;
                        for (q = 0; q < j - i; q++) { cOff[c + q] = st * TRACK_INDEX(t[q].target); cVal[c + q] = t[q].base; }
                    }
                    r++;
                    c += j - i;
                }
            }
            for (k = j; k < end && TRACK_KIND(SC_TARGET(k)) == kind; k++) {}
            if (k > j) {
                if (runs) { runs[r].kind = kind; runs[r].first = j; runs[r].count = k - j; runs[r].cfirst = UGO_NONE; }
                r++;
            }
            i = k;
        }
    }
    if (animRun) animRun[na] = (uint32_t)r; /* (not reached with too many: runs_bytes gave 0, nothing is written) */
#undef SC_TARGET
#undef SC_SINGLE
    *nruns = r;
    *nconst = c;
}

/* Bytes of the run tables for these counts (0 when they would be too large to be worth it:
 * a file whose animations share tracks many times over; it plays without them). */
static uint64_t runs_bytes(uint32_t na, uint64_t nruns, uint64_t nconst, uint32_t nt)
{
    uint64_t b = 16u + 4u * ((uint64_t)na + 1u) + 16u * nruns + 8u * nconst;
    b = (b + 15u) & ~(uint64_t)15u;
    return b > 64u * (uint64_t)nt + 4096u ? 0 : b;
}

/* The run tables of `tab`'s tracks (raw: 1.0 KTrack or 1.1 KTrack11), as ugo_model_init_sized makes them. */
static uint64_t runs_bytes_raw(const uint8_t *const *tab, const uint32_t *cnt)
{
    uint64_t nr, nc;
    int v11 = cnt[TB_TRACKS11] != 0;
    uint32_t nt = v11 ? cnt[TB_TRACKS11] : cnt[TB_TRACKS];
    if (!nt || !cnt[TB_ANIMS]) return 0;
    scan_runs((const KAnim *)tab[TB_ANIMS], cnt[TB_ANIMS], v11 ? tab[TB_TRACKS11] : tab[TB_TRACKS], v11 ? sizeof(KTrack11) : sizeof(KTrack), nt, v11,
              &nr, &nc, 0, 0, 0, 0);
    return runs_bytes(cnt[TB_ANIMS], nr, nc, nt);
}

uint32_t ugo_model_mem_size_for(const void *data, uint32_t size)
{
    const uint8_t *tab[TB_KNOWN];
    uint32_t cnt[TB_KNOWN], warnings, nt = 0, nk = 0; /* (set by curve_counts; MSVC's C4701 cannot see it) */
    uint64_t need;
    int e;
    g_last_error = UGO_OK;
    if (!data) FAIL(UGO_ERR_SIZE);
    e = read_toc((const uint8_t *)data, size, tab, cnt, &warnings);
    if (!e) e = curve_counts(tab, cnt, &nt, &nk);
    if (e) FAIL(e);
    need = (uint64_t)ugo_model_mem_size() + (uint64_t)nt * sizeof(KTrack) + (uint64_t)nk * sizeof(KKey);
    need = (need + 15u) & ~(uint64_t)15u;
    need += runs_bytes_raw(tab, cnt); /* the animations' track runs (faster to play; optional) */
    if (need > 0xfffffff0u) FAIL(UGO_ERR_LIMIT);
    return (uint32_t)need;
}

UgoModel *ugo_model_init(void *mem, const void *data, uint32_t size)
{
    return ugo_model_init_sized(mem, ugo_model_mem_size(), data, size);
}

UgoModel *ugo_model_init_sized(void *mem, uint32_t mem_size, const void *data, uint32_t size)
{
    UgoModel *m = (UgoModel *)mem;
    const uint8_t *p = (const uint8_t *)data;
    const uint32_t *hdr = (const uint32_t *)data;
    uint32_t i, j, nv, nt = 0, nk = 0, cnt[TB_KNOWN]; /* (nt, nk: as in ugo_model_mem_size_for) */
    const uint8_t *tab[TB_KNOWN];
    int err;

    g_last_error = UGO_OK;
    if (!mem || !data) FAIL(UGO_ERR_SIZE);
    if (((uintptr_t)mem & 15u) || ((uintptr_t)data & 3u)) FAIL(UGO_ERR_ALIGN);
    if (mem_size < ugo_model_mem_size()) FAIL(UGO_ERR_SIZE);
    /* the table of contents: each known table found, unknown ones skipped (or refused, by their flags) */
    err = read_toc(p, size, tab, cnt, &m->warnings);
    if (!err) err = curve_counts(tab, cnt, &nt, &nk);
    if (err) FAIL(err);
    if ((uint64_t)ugo_model_mem_size() + (uint64_t)nt * sizeof(KTrack) + (uint64_t)nk * sizeof(KKey) > mem_size) FAIL(UGO_ERR_SIZE);
    for (i = 0; i < 4; i++) {
        union { uint32_t u; float f; } c;
        c.u = hdr[UGO_CANVAS_WORD + i];
        if (!is_finite(c.f)) FAIL(UGO_ERR_VALUE);
        m->canvas[i] = c.f;
    }
    nv = cnt[TB_POSITIONS];
    for (i = 1; i < TB_KNOWN; i++) {
        uint32_t slot = g_tables[i].slot;
        if (slot == SLOT_VERT && cnt[i] != nv) FAIL(UGO_ERR_RANGE);
        if (slot == SLOT_VERT1 && cnt[i] != nv + 1) FAIL(UGO_ERR_RANGE);
        if (slot < KC_COUNT_FIELDS) {
            if (cnt[i] > g_limit[slot]) FAIL(UGO_ERR_LIMIT);
            m->n[slot] = cnt[i];
        }
    }
    if (m->n[KC_BONES] < 1 || m->n[KC_STRINGS] < 1) FAIL(UGO_ERR_RANGE);
    m->params = (const KParam *)tab[TB_PARAMS];
    m->bones = (const KBone *)tab[TB_BONES];
    m->cons = (const KCons *)tab[TB_CONS];
    m->parts = (const KPart *)tab[TB_PARTS];
    m->textures = (const uint32_t *)tab[TB_TEXTURES];
    m->pos = (const float *)tab[TB_POSITIONS];
    m->uv = (const float *)tab[TB_UVS];
    m->joints = (const uint16_t *)tab[TB_JOINTS];
    m->weights = (const float *)tab[TB_WEIGHTS];
    m->vparts = (const uint32_t *)tab[TB_VPARTS];
    m->csr = (const uint32_t *)tab[TB_CSR];
    m->entries = (const KEntry *)tab[TB_ENTRIES];
    m->indices = (const uint32_t *)tab[TB_INDICES];
    m->regions = (const KRegion *)tab[TB_REGIONS];
    m->morphs = (const uint32_t *)tab[TB_MORPHS];
    m->bdrv = (const KBoneDriver *)tab[TB_BDRIVERS];
    m->odrv = (const KOpDriver *)tab[TB_ODRIVERS];
    m->phys = (const KPhys *)tab[TB_PHYS];
    m->physin = (const KPhysIn *)tab[TB_PHYSIN];
    m->anims = (const KAnim *)tab[TB_ANIMS];
    m->tracks = (const KTrack *)tab[TB_TRACKS];
    m->keys = (const KKey *)tab[TB_KEYS];
    if (nt) { /* 1.1: expanded after the model */
        KTrack *xt = (KTrack *)((uint8_t *)mem + ugo_model_mem_size());
        KKey *xk = (KKey *)(xt + nt);
        m->n[KC_TRACKS] = nt;
        m->n[KC_KEYS] = expand_curves(tab, cnt, xt, xk);
        m->tracks = xt;
        m->keys = xk;
    }
    m->strings = (const char *)tab[TB_STRINGS];
    m->masks = (const KMask *)tab[TB_MASKS];
    m->maskrefs = (const uint32_t *)tab[TB_MASKREFS];
    m->colors = (const KColor *)tab[TB_COLORS];
    m->cdrv = (const KColorDriver *)tab[TB_CDRIVERS];
    m->xstart = (const uint32_t *)tab[TB_XSTART];
    m->xweights = (const KXWeight *)tab[TB_XWEIGHTS];
    m->warps = (const KWarp *)tab[TB_WARPS];
    m->wpoints = (const float *)tab[TB_WPOINTS];
    m->wdrv = (const KWarpDriver *)tab[TB_WDRIVERS];
    m->wdeltas = (const float *)tab[TB_WDELTAS];
    m->bwarps = (const KBoneWarp *)tab[TB_BWARPS];
    m->chains = (const KChain *)tab[TB_CHAINS];
    m->chainBones = (const uint32_t *)tab[TB_CHAINBONES];
    m->orders = (const float *)tab[TB_ORDERS];
    m->ordrv = (const KOrderDriver *)tab[TB_ORDRIVERS];
    m->exprs = (const KExpr *)tab[TB_EXPRS];
    m->exprItems = (const KExprItem *)tab[TB_EXPRITEMS];
    m->format = ((hdr[1] & 0xffffu) << 16) | (hdr[1] >> 16);
    if (m->strings[m->n[KC_STRINGS] - 1] != '\0') FAIL(UGO_ERR_VALUE);

    /* parameters */
    for (i = 0; i < m->n[KC_PARAMS]; i++) {
        const KParam *q = &m->params[i];
        if (!is_finite(q->min) || !is_finite(q->max) || !is_finite(q->def)) FAIL(UGO_ERR_VALUE);
        if (!(q->min <= q->def && q->def <= q->max)) FAIL(UGO_ERR_VALUE);
        if (!name_ok(m, q->name)) FAIL(UGO_ERR_RANGE);
    }
    /* bones: parents come first */
    for (i = 0; i < m->n[KC_BONES]; i++) {
        const KBone *b = &m->bones[i];
        if (b->parent >= (int32_t)i || b->parent < -1) FAIL(UGO_ERR_RANGE);
        if (!name_ok(m, b->name)) FAIL(UGO_ERR_RANGE);
        if (!is_finite(b->x) || !is_finite(b->y) || !is_finite(b->rot) || !is_finite(b->sx) || !is_finite(b->sy)) FAIL(UGO_ERR_VALUE);
        if (!is_finite(b->shx) || !is_finite(b->shy) || !is_finite(b->length) || b->inherit >= INHERIT_COUNT) FAIL(UGO_ERR_VALUE);
        for (j = 0; j < 6; j++) if (!is_finite(b->bindInv[j])) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_CONS]; i++) {
        const KCons *c = &m->cons[i];
        int32_t nb = (int32_t)m->n[KC_BONES];
        if (c->type >= CONS_COUNT) FAIL(UGO_ERR_VALUE);
        if (c->bone < 0 || c->bone >= nb || c->target < 0 || c->target >= nb) FAIL(UGO_ERR_RANGE);
        if (c->bone2 < -1 || c->bone2 >= nb || (c->type != CONS_IK && c->bone2 != -1)) FAIL(UGO_ERR_RANGE);
        for (j = 0; j < 6; j++) if (!is_finite(c->mix[j]) || !is_finite(c->off[j])) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_TEXTURES]; i++)
        if (!name_ok(m, m->textures[i])) FAIL(UGO_ERR_RANGE);
    /* parts: contiguous vertex/index ranges, indices stay inside the part */
    for (i = 0; i < m->n[KC_PARTS]; i++) {
        const KPart *q = &m->parts[i];
        if ((uint64_t)q->firstVert + q->vertCount > nv) FAIL(UGO_ERR_RANGE);
        if ((uint64_t)q->firstIndex + q->indexCount > m->n[KC_INDICES]) FAIL(UGO_ERR_RANGE);
        if (q->indexCount % 3) FAIL(UGO_ERR_VALUE);
        if (q->texture >= m->n[KC_TEXTURES] && m->n[KC_TEXTURES] > 0) FAIL(UGO_ERR_RANGE);
        if (!is_finite(q->opacity) || !name_ok(m, q->name)) FAIL(UGO_ERR_RANGE);
        if (q->blend >= BLEND_COUNT || (q->flags & ~PART_FLAGS_ALL)) FAIL(UGO_ERR_VALUE);
        if (q->warp != UGO_NONE && q->warp >= m->n[KC_WARPS]) FAIL(UGO_ERR_RANGE);
        if (q->mask != UGO_NONE && q->mask >= m->n[KC_MASKS]) FAIL(UGO_ERR_RANGE);
        if (q->color != UGO_NONE && q->color >= m->n[KC_COLORS]) FAIL(UGO_ERR_RANGE);
        for (j = q->firstIndex; j < q->firstIndex + q->indexCount; j++) {
            uint32_t v = m->indices[j];
            if (v < q->firstVert || v >= q->firstVert + q->vertCount) FAIL(UGO_ERR_RANGE);
        }
    }
    /* vertices */
    for (i = 0; i < nv; i++) {
        if (m->vparts[i] >= m->n[KC_PARTS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(m->pos[2 * i]) || !is_finite(m->pos[2 * i + 1])) FAIL(UGO_ERR_VALUE);
        if (!is_finite(m->uv[2 * i]) || !is_finite(m->uv[2 * i + 1])) FAIL(UGO_ERR_VALUE);
        for (j = 0; j < 4; j++) {
            float w = m->weights[4 * i + j];
            if (m->joints[4 * i + j] >= m->n[KC_BONES]) FAIL(UGO_ERR_RANGE);
            if (!is_finite(w) || w < 0.0f || w > 1.0f) FAIL(UGO_ERR_VALUE);
        }
        if (m->csr[i] > m->csr[i + 1]) FAIL(UGO_ERR_RANGE);
    }
    if (m->csr[0] != 0 || m->csr[nv] != m->n[KC_ENTRIES]) FAIL(UGO_ERR_RANGE);
    /* influences beyond four */
    for (i = 0; i < nv; i++) if (m->xstart[i] > m->xstart[i + 1]) FAIL(UGO_ERR_RANGE);
    if (m->xstart[0] != 0 || m->xstart[nv] != m->n[KC_XWEIGHTS]) FAIL(UGO_ERR_RANGE);
    for (i = 0; i < m->n[KC_XWEIGHTS]; i++) {
        float w = m->xweights[i].weight;
        if (m->xweights[i].bone >= m->n[KC_BONES]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(w) || w < 0.0f || w > 1.0f) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_ENTRIES]; i++) {
        if (m->entries[i].morph >= m->n[KC_MORPHS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(m->entries[i].dx) || !is_finite(m->entries[i].dy)) FAIL(UGO_ERR_VALUE);
    }
    /* regions and everything that points at them */
    for (i = 0; i < m->n[KC_REGIONS]; i++) {
        const KRegion *r = &m->regions[i];
        if (r->axisCount > 4) FAIL(UGO_ERR_VALUE);
        for (j = 0; j < r->axisCount; j++) {
            if (r->axis[j].param >= m->n[KC_PARAMS]) FAIL(UGO_ERR_RANGE);
            if (!is_finite(r->axis[j].start) || !is_finite(r->axis[j].peak) || !is_finite(r->axis[j].end)) FAIL(UGO_ERR_VALUE);
            if (!(r->axis[j].start <= r->axis[j].peak && r->axis[j].peak <= r->axis[j].end)) FAIL(UGO_ERR_VALUE);
        }
    }
    for (i = 0; i < m->n[KC_MORPHS]; i++)
        if (m->morphs[i] >= m->n[KC_REGIONS] && m->morphs[i] != UGO_NO_REGION) FAIL(UGO_ERR_RANGE);
    for (i = 0; i < m->n[KC_BDRIVERS]; i++) {
        const KBoneDriver *d = &m->bdrv[i];
        if (d->region >= m->n[KC_REGIONS] || d->bone >= m->n[KC_BONES]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(d->drot) || !is_finite(d->dx) || !is_finite(d->dy) || !is_finite(d->dsx) || !is_finite(d->dsy)) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_ODRIVERS]; i++) {
        const KOpDriver *d = &m->odrv[i];
        if (d->region >= m->n[KC_REGIONS] || d->part >= m->n[KC_PARTS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(d->dop)) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_PHYS]; i++) {
        const KPhys *q = &m->phys[i];
        if ((uint64_t)q->firstInput + q->inputCount > m->n[KC_PHYSIN]) FAIL(UGO_ERR_RANGE);
        if (q->output >= m->n[KC_PARAMS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(q->stiffness) || !is_finite(q->damping) || !is_finite(q->gain) || !is_finite(q->outMin) || !is_finite(q->outMax)) FAIL(UGO_ERR_VALUE);
        if (q->stiffness < 0.0f || q->damping < 0.0f || q->stiffness > 1.0e5f || q->damping > 1.0e4f) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_PHYSIN]; i++) {
        if (m->physin[i].param >= m->n[KC_PARAMS] || !is_finite(m->physin[i].weight)) FAIL(UGO_ERR_RANGE);
    }
    /* warp grids: parents come first; points and deltas inside their tables */
    for (i = 0; i < m->n[KC_WARPS]; i++) {
        const KWarp *w = &m->warps[i];
        if (w->cols < 1 || w->rows < 1 || w->cols > UGO_WARP_MAX_CELLS || w->rows > UGO_WARP_MAX_CELLS) FAIL(UGO_ERR_VALUE);
        if (w->parent != UGO_NONE && w->parent >= i) FAIL(UGO_ERR_RANGE);
        if (w->bone >= m->n[KC_BONES] || !name_ok(m, w->name)) FAIL(UGO_ERR_RANGE);
        if ((uint64_t)w->firstPoint + (w->cols + 1) * (w->rows + 1) > m->n[KC_WPOINTS]) FAIL(UGO_ERR_RANGE);
    }
    for (i = 0; i < 2 * m->n[KC_WPOINTS]; i++) if (!is_finite(m->wpoints[i])) FAIL(UGO_ERR_VALUE);
    for (i = 0; i < m->n[KC_WDRIVERS]; i++) {
        const KWarpDriver *d = &m->wdrv[i];
        if (d->region >= m->n[KC_REGIONS] || d->warp >= m->n[KC_WARPS]) FAIL(UGO_ERR_RANGE);
        if ((uint64_t)d->firstDelta + (m->warps[d->warp].cols + 1) * (m->warps[d->warp].rows + 1) > m->n[KC_WDELTAS]) FAIL(UGO_ERR_RANGE);
    }
    for (i = 0; i < 2 * m->n[KC_WDELTAS]; i++) if (!is_finite(m->wdeltas[i])) FAIL(UGO_ERR_VALUE);
    for (i = 0; i < m->n[KC_CHAINS]; i++) { /* bones from root to tip, each the child of the one before */
        const KChain *c = &m->chains[i];
        if (c->boneCount < 1 || c->boneCount > UGO_CHAIN_MAX || (uint64_t)c->firstBone + c->boneCount > m->n[KC_CHAINBONES]) FAIL(UGO_ERR_RANGE);
        for (j = 0; j < c->boneCount; j++) {
            uint32_t b = m->chainBones[c->firstBone + j];
            if (b >= m->n[KC_BONES]) FAIL(UGO_ERR_RANGE);
            if (j > 0 && m->bones[b].parent != (int32_t)m->chainBones[c->firstBone + j - 1]) FAIL(UGO_ERR_VALUE);
        }
        if (!is_finite(c->stiffness) || !is_finite(c->damping) || !is_finite(c->gx) || !is_finite(c->gy) || !is_finite(c->inertia) || !is_finite(c->mix)) FAIL(UGO_ERR_VALUE);
        if (c->stiffness < 0.0f || c->stiffness > 1.0e5f || c->damping < 0.0f || c->damping > 1.0e4f) FAIL(UGO_ERR_VALUE);
        if (!name_ok(m, c->name)) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_BWARPS]; i++) { /* in bone order, each bone once, roots only */
        const KBoneWarp *q = &m->bwarps[i];
        if (q->bone >= m->n[KC_BONES] || q->warp >= m->n[KC_WARPS]) FAIL(UGO_ERR_RANGE);
        if (m->bones[q->bone].parent != -1 || (i > 0 && q->bone <= m->bwarps[i - 1].bone)) FAIL(UGO_ERR_VALUE);
        if (!is_finite(q->ox) || !is_finite(q->oy) || !is_finite(q->a) || !is_finite(q->b) || !is_finite(q->c) || !is_finite(q->d)) FAIL(UGO_ERR_VALUE);
        if (!is_finite(q->rc) || !is_finite(q->rs) || q->rc < -1.0f || q->rc > 1.0f || q->rs < -1.0f || q->rs > 1.0f) FAIL(UGO_ERR_VALUE);
    }
    /* draw order (0.8): a value per part, or none */
    if (m->n[KC_ORDERS] != 0 && m->n[KC_ORDERS] != m->n[KC_PARTS]) FAIL(UGO_ERR_RANGE);
    for (i = 0; i < m->n[KC_ORDERS]; i++)
        if (!is_finite(m->orders[i]) || m->orders[i] < -UGO_ORDER_MAX || m->orders[i] > UGO_ORDER_MAX) FAIL(UGO_ERR_VALUE);
    for (i = 0; i < m->n[KC_ORDRIVERS]; i++) {
        const KOrderDriver *d = &m->ordrv[i];
        if (d->region >= m->n[KC_REGIONS] || d->part >= m->n[KC_ORDERS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(d->d) || d->d < -UGO_ORDER_MAX || d->d > UGO_ORDER_MAX) FAIL(UGO_ERR_VALUE);
    }
    /* expressions (0.8) */
    for (i = 0; i < m->n[KC_EXPRS]; i++) {
        const KExpr *e = &m->exprs[i];
        if (!name_ok(m, e->name) || (uint64_t)e->firstItem + e->itemCount > m->n[KC_EXPRITEMS]) FAIL(UGO_ERR_RANGE);
        if (!is_finite(e->fadeIn) || !is_finite(e->fadeOut) || e->fadeIn < 0.0f || e->fadeOut < 0.0f) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_EXPRITEMS]; i++) {
        const KExprItem *q = &m->exprItems[i];
        if (q->param >= m->n[KC_PARAMS]) FAIL(UGO_ERR_RANGE);
        if (q->op >= EXPR_OP_COUNT || !is_finite(q->value)) FAIL(UGO_ERR_VALUE);
    }
    /* masks, colours */
    m->maskChannels = 0;
    for (i = 0; i < m->n[KC_MASKS]; i++) {
        const KMask *k = &m->masks[i];
        if (k->refCount == 0 || (uint64_t)k->firstRef + k->refCount > m->n[KC_MASKREFS]) FAIL(UGO_ERR_RANGE);
        if (k->channel >= UGO_MASK_CHANNELS) FAIL(UGO_ERR_VALUE);
        if (k->channel + 1 > m->maskChannels) m->maskChannels = k->channel + 1;
    }
    for (i = 0; i < m->n[KC_MASKREFS]; i++)
        if (m->maskrefs[i] >= m->n[KC_PARTS]) FAIL(UGO_ERR_RANGE);
    for (i = 0; i < m->n[KC_COLORS]; i++) {
        const KColor *c = &m->colors[i];
        if (c->mode >= COLOR_MODE_COUNT || c->reserved) FAIL(UGO_ERR_VALUE);
        for (j = 0; j < 3; j++) if (!is_finite(c->a[j]) || !is_finite(c->b[j])) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_CDRIVERS]; i++) {
        const KColorDriver *d = &m->cdrv[i];
        if (d->region >= m->n[KC_REGIONS] || d->slot >= m->n[KC_COLORS]) FAIL(UGO_ERR_RANGE);
        for (j = 0; j < 3; j++) if (!is_finite(d->da[j]) || !is_finite(d->db[j])) FAIL(UGO_ERR_VALUE);
    }
    for (i = 0; i < m->n[KC_ANIMS]; i++) {
        const KAnim *a = &m->anims[i];
        if (!name_ok(m, a->name) || !is_finite(a->duration) || a->duration < 0.0f) FAIL(UGO_ERR_VALUE);
        if (!is_finite(a->tick) || !(a->tick > 0.0f)) FAIL(UGO_ERR_VALUE);
        if ((uint64_t)a->firstTrack + a->trackCount > m->n[KC_TRACKS]) FAIL(UGO_ERR_RANGE);
    }
    for (i = 0; i < m->n[KC_TRACKS]; i++) {
        const KTrack *t = &m->tracks[i];
        uint32_t kind = TRACK_KIND(t->target), idx = TRACK_INDEX(t->target), limit;
        if (t->keyCount == 0) FAIL(UGO_ERR_RANGE);
        if (kind >= TK_COUNT) m->warnings |= UGO_WARN_SKIPPED_TRACKS; /* a later 1.x's kind: skipped when played */
        limit = kind >= TK_COUNT ? 0x1000000u : kind == TK_PARAM ? m->n[KC_PARAMS] : kind == TK_PART_OPACITY ? m->n[KC_PARTS] : kind == TK_PART_ORDER ? m->n[KC_ORDERS]
              : kind == TK_MORPH ? m->n[KC_MORPHS] : kind == TK_CONS ? 8 * m->n[KC_CONS]
              : kind == TK_COLOR ? 8 * m->n[KC_COLORS] : m->n[KC_BONES];
        if (idx >= limit || (kind == TK_CONS && (idx & 7u) > 6u) || (kind == TK_COLOR && (idx & 7u) > 5u)) FAIL(UGO_ERR_RANGE);
        if (!is_finite(t->base) || !is_finite(t->step)) FAIL(UGO_ERR_VALUE);
        if (t->keyCount == 1) continue; /* its value is base: no keys */
        if ((uint64_t)t->firstKey + t->keyCount > m->n[KC_KEYS]) FAIL(UGO_ERR_RANGE);
        for (j = t->firstKey; j < t->firstKey + t->keyCount; j++) {
            const KKey *k = &m->keys[j];
            if (j > t->firstKey && k->t < m->keys[j - 1].t) FAIL(UGO_ERR_VALUE);
        }
    }

    /* the animations' track runs, when the memory has room for them (else tracks are walked one by one) */
    m->animRun = 0; m->runs = 0; m->cOff = 0; m->cVal = 0;
    if (m->n[KC_ANIMS] && m->n[KC_TRACKS]) {
        uint64_t nr, nc, at = ((uint64_t)ugo_model_mem_size() + (uint64_t)nt * sizeof(KTrack) + (uint64_t)nk * sizeof(KKey) + 15u) & ~(uint64_t)15u, bytes;
        scan_runs(m->anims, m->n[KC_ANIMS], (const uint8_t *)m->tracks, sizeof(KTrack), m->n[KC_TRACKS], 0, &nr, &nc, 0, 0, 0, 0);
        bytes = runs_bytes(m->n[KC_ANIMS], nr, nc, m->n[KC_TRACKS]);
        if (bytes && at + bytes <= mem_size) {
            uint8_t *q = (uint8_t *)mem + at;
            KRun *runs = (KRun *)q;
            float *cVal = (float *)(q + 16u * nr);
            uint32_t *cOff = (uint32_t *)(q + 16u * nr + 4u * nc), *animRun = cOff + nc;
            scan_runs(m->anims, m->n[KC_ANIMS], (const uint8_t *)m->tracks, sizeof(KTrack), m->n[KC_TRACKS], 0, &nr, &nc, runs, animRun, cOff, cVal);
            m->runs = runs; m->cVal = cVal; m->cOff = cOff; m->animRun = animRun;
        }
    }

    /* frame block layout */
    m->skinOff = 8;
    m->opOff = m->skinOff + 8 * m->n[KC_BONES];
    m->morphOff = m->opOff + align4(m->n[KC_PARTS]);
    m->colorOff = m->morphOff + align4(m->n[KC_MORPHS]);
    m->warpOff = m->colorOff + 8 * m->n[KC_COLORS];
    {
        uint64_t f = m->warpOff;
        for (i = 0; i < m->n[KC_WARPS]; i++) f += warp_frame_floats(&m->warps[i]);
        if (f > (1u << 24)) FAIL(UGO_ERR_LIMIT);
        m->frameFloats = (uint32_t)f;
    }
    m->base = p;
    m->size = size;
    return m;
}

/* ---- model accessors -------------------------------------------------- */

uint32_t ugo_param_count(const UgoModel *m) { return m->n[KC_PARAMS]; }
uint32_t ugo_bone_count(const UgoModel *m) { return m->n[KC_BONES]; }
uint32_t ugo_part_count(const UgoModel *m) { return m->n[KC_PARTS]; }
uint32_t ugo_vertex_count(const UgoModel *m) { return m->n[KC_VERTS]; }
uint32_t ugo_index_count(const UgoModel *m) { return m->n[KC_INDICES]; }
uint32_t ugo_morph_count(const UgoModel *m) { return m->n[KC_MORPHS]; }
uint32_t ugo_entry_count(const UgoModel *m) { return m->n[KC_ENTRIES]; }
uint32_t ugo_animation_count(const UgoModel *m) { return m->n[KC_ANIMS]; }
uint32_t ugo_texture_count(const UgoModel *m) { return m->n[KC_TEXTURES]; }
uint32_t ugo_constraint_count(const UgoModel *m) { return m->n[KC_CONS]; }

int ugo_skeleton_is_simple(const UgoModel *m)
{
    uint32_t i;
    if (m->n[KC_CONS] || m->n[KC_BWARPS] || m->n[KC_CHAINS]) return 0; /* bones in warp grids and swaying chains too */
    for (i = 0; i < m->n[KC_BONES]; i++)
        if (m->bones[i].inherit != INHERIT_NORMAL || m->bones[i].shx != 0.0f || m->bones[i].shy != 0.0f) return 0;
    for (i = 0; i < m->n[KC_TRACKS]; i++) {
        uint32_t k = TRACK_KIND(m->tracks[i].target);
        if (k == TK_BONE_SHX || k == TK_BONE_SHY) return 0;
    }
    return 1;
}

int ugo_find_param(const UgoModel *m, const char *name)
{
    uint32_t i;
    for (i = 0; i < m->n[KC_PARAMS]; i++)
        if (str_eq(m->strings + m->params[i].name, name)) return (int)i;
    return -1;
}

int ugo_find_animation(const UgoModel *m, const char *name)
{
    uint32_t i;
    for (i = 0; i < m->n[KC_ANIMS]; i++)
        if (str_eq(m->strings + m->anims[i].name, name)) return (int)i;
    return -1;
}

const char *ugo_param_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_PARAMS] ? m->strings + m->params[i].name : ""; }
float ugo_param_min(const UgoModel *m, uint32_t i) { return i < m->n[KC_PARAMS] ? m->params[i].min : 0.0f; }
float ugo_param_max(const UgoModel *m, uint32_t i) { return i < m->n[KC_PARAMS] ? m->params[i].max : 0.0f; }
float ugo_param_default(const UgoModel *m, uint32_t i) { return i < m->n[KC_PARAMS] ? m->params[i].def : 0.0f; }
const char *ugo_animation_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_ANIMS] ? m->strings + m->anims[i].name : ""; }
float ugo_animation_duration(const UgoModel *m, uint32_t i) { return i < m->n[KC_ANIMS] ? m->anims[i].duration : 0.0f; }
int ugo_animation_loop(const UgoModel *m, uint32_t i) { return i < m->n[KC_ANIMS] && m->anims[i].loop ? 1 : 0; }
const char *ugo_texture_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_TEXTURES] ? m->strings + m->textures[i] : ""; }
const char *ugo_part_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_PARTS] ? m->strings + m->parts[i].name : ""; }
const float *ugo_canvas(const UgoModel *m) { return m->canvas; }

const float *ugo_positions(const UgoModel *m) { return m->pos; }
const float *ugo_uvs(const UgoModel *m) { return m->uv; }
const uint16_t *ugo_joints(const UgoModel *m) { return m->joints; }
const float *ugo_weights(const UgoModel *m) { return m->weights; }
const uint32_t *ugo_vertex_parts(const UgoModel *m) { return m->vparts; }
const uint32_t *ugo_csr_starts(const UgoModel *m) { return m->csr; }
const float *ugo_entries(const UgoModel *m) { return (const float *)m->entries; }
const uint32_t *ugo_indices(const UgoModel *m) { return m->indices; }
uint32_t ugo_extra_weight_count(const UgoModel *m) { return m->n[KC_XWEIGHTS]; }
const uint32_t *ugo_extra_weight_starts(const UgoModel *m) { return m->xstart; }
const float *ugo_extra_weights(const UgoModel *m) { return (const float *)m->xweights; }
uint32_t ugo_part_texture(const UgoModel *m, uint32_t part) { return part < m->n[KC_PARTS] ? m->parts[part].texture : 0; }

void ugo_part_range(const UgoModel *m, uint32_t part, uint32_t *range)
{
    const KPart *q;
    if (part >= m->n[KC_PARTS]) { range[0] = range[1] = range[2] = range[3] = 0; return; }
    q = &m->parts[part];
    range[0] = q->firstVert; range[1] = q->vertCount; range[2] = q->firstIndex; range[3] = q->indexCount;
}

float ugo_bone_length(const UgoModel *m, uint32_t i) { return i < m->n[KC_BONES] ? m->bones[i].length : 0.0f; }
const char *ugo_bone_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_BONES] ? m->strings + m->bones[i].name : ""; }
int ugo_bone_parent(const UgoModel *m, uint32_t i) { return i < m->n[KC_BONES] ? m->bones[i].parent : -1; }

void ugo_bone_rest(const UgoModel *m, uint32_t i, float *pose)
{
    const KBone *b;
    if (i >= m->n[KC_BONES]) return;
    b = &m->bones[i];
    pose[0] = b->x; pose[1] = b->y; pose[2] = b->rot; pose[3] = b->sx; pose[4] = b->sy;
}

uint32_t ugo_frame_float_count(const UgoModel *m) { return m->frameFloats; }
uint32_t ugo_frame_skin_offset(const UgoModel *m) { return m->skinOff; }
uint32_t ugo_frame_opacity_offset(const UgoModel *m) { return m->opOff; }
uint32_t ugo_frame_morph_offset(const UgoModel *m) { return m->morphOff; }
uint32_t ugo_frame_color_offset(const UgoModel *m) { return m->colorOff; }
uint32_t ugo_frame_warp_offset(const UgoModel *m) { return m->warpOff; }
uint32_t ugo_warp_count(const UgoModel *m) { return m->n[KC_WARPS]; }
int ugo_part_warp(const UgoModel *m, uint32_t part)
{
    return part < m->n[KC_PARTS] && m->parts[part].warp != UGO_NONE ? (int)m->parts[part].warp : -1;
}
void ugo_warp_info(const UgoModel *m, uint32_t warp, uint32_t *info)
{
    uint32_t k, o = m->warpOff;
    if (warp >= m->n[KC_WARPS]) { info[0] = info[1] = info[2] = 0; return; }
    for (k = 0; k < warp; k++) o += warp_frame_floats(&m->warps[k]);
    info[0] = m->warps[warp].cols; info[1] = m->warps[warp].rows; info[2] = o;
}
uint32_t ugo_chain_count(const UgoModel *m) { return m->n[KC_CHAINS]; }
void ugo_chain_info(const UgoModel *m, uint32_t i, float *params, uint32_t *bone_count)
{
    const KChain *c;
    if (i >= m->n[KC_CHAINS]) { *bone_count = 0; return; }
    c = &m->chains[i];
    params[0] = c->stiffness; params[1] = c->damping; params[2] = c->gx; params[3] = c->gy;
    params[4] = c->inertia; params[5] = c->mix;
    *bone_count = c->boneCount;
}
const uint32_t *ugo_chain_bones(const UgoModel *m, uint32_t i)
{
    return i < m->n[KC_CHAINS] ? m->chainBones + m->chains[i].firstBone : m->chainBones;
}
const char *ugo_chain_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_CHAINS] ? m->strings + m->chains[i].name : ""; }

const char *ugo_warp_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_WARPS] ? m->strings + m->warps[i].name : ""; }
int ugo_warp_parent(const UgoModel *m, uint32_t i) { return i < m->n[KC_WARPS] && m->warps[i].parent != UGO_NONE ? (int)m->warps[i].parent : -1; }
int ugo_warp_bone(const UgoModel *m, uint32_t i) { return i < m->n[KC_WARPS] && m->warps[i].parent == UGO_NONE ? (int)m->warps[i].bone : -1; }
const float *ugo_warp_rest_points(const UgoModel *m, uint32_t i) { return i < m->n[KC_WARPS] ? m->wpoints + 2 * m->warps[i].firstPoint : m->wpoints; }

void ugo_warp_eval(const UgoInstance *in, uint32_t warp, float x, float y, float *out)
{
    uint32_t info[3];
    if (warp >= in->m->n[KC_WARPS] || !is_finite(x) || !is_finite(y)) { out[0] = out[1] = 0.0f; return; }
    ugo_warp_info(in->m, warp, info);
    warp_eval(in->frame + info[2], info[0], info[1], x, y, out);
}

void ugo_warp_points(const UgoInstance *in, uint32_t warp, float *out)
{
    uint32_t info[3], i, j;
    if (warp >= in->m->n[KC_WARPS]) return;
    ugo_warp_info(in->m, warp, info);
    for (j = 0; j <= info[1]; j++)
        for (i = 0; i <= info[0]; i++) {
            const float *P = in->frame + info[2] + 2 * ((j + 1) * (info[0] + 3) + i + 1);
            out[2 * (j * (info[0] + 1) + i)] = P[0];
            out[2 * (j * (info[0] + 1) + i) + 1] = P[1];
        }
}

uint32_t ugo_part_blend(const UgoModel *m, uint32_t part) { return part < m->n[KC_PARTS] ? m->parts[part].blend : 0; }
uint32_t ugo_part_flags(const UgoModel *m, uint32_t part) { return part < m->n[KC_PARTS] ? m->parts[part].flags : 0; }
int ugo_part_mask(const UgoModel *m, uint32_t part)
{
    return part < m->n[KC_PARTS] && m->parts[part].mask != UGO_NONE ? (int)m->parts[part].mask : -1;
}
int ugo_part_color(const UgoModel *m, uint32_t part)
{
    return part < m->n[KC_PARTS] && m->parts[part].color != UGO_NONE ? (int)m->parts[part].color : -1;
}
uint32_t ugo_mask_count(const UgoModel *m) { return m->n[KC_MASKS]; }
uint32_t ugo_mask_channel_count(const UgoModel *m) { return m->maskChannels; }
uint32_t ugo_mask_channel(const UgoModel *m, uint32_t mask) { return mask < m->n[KC_MASKS] ? m->masks[mask].channel : 0; }
const uint32_t *ugo_mask_parts(const UgoModel *m, uint32_t mask, uint32_t *count)
{
    if (mask >= m->n[KC_MASKS]) { *count = 0; return m->maskrefs; }
    *count = m->masks[mask].refCount;
    return m->maskrefs + m->masks[mask].firstRef;
}
uint32_t ugo_color_count(const UgoModel *m) { return m->n[KC_COLORS]; }
uint32_t ugo_expression_count(const UgoModel *m) { return m->n[KC_EXPRS]; }
const char *ugo_expression_name(const UgoModel *m, uint32_t i) { return i < m->n[KC_EXPRS] ? m->strings + m->exprs[i].name : ""; }
void ugo_expression_fade(const UgoModel *m, uint32_t i, float *fade)
{
    fade[0] = i < m->n[KC_EXPRS] ? m->exprs[i].fadeIn : 0.0f;
    fade[1] = i < m->n[KC_EXPRS] ? m->exprs[i].fadeOut : 0.0f;
}
const float *ugo_expression_items(const UgoModel *m, uint32_t i, uint32_t *count)
{
    if (i >= m->n[KC_EXPRS]) { *count = 0; return (const float *)m->exprItems; }
    *count = m->exprs[i].itemCount;
    return (const float *)(m->exprItems + m->exprs[i].firstItem);
}
uint32_t ugo_resolve_params(const UgoModel *m, const char *const *names, uint32_t n, int32_t *out_index)
{
    uint32_t i, missing = 0;
    for (i = 0; i < n; i++) {
        out_index[i] = names[i] ? (int32_t)ugo_find_param(m, names[i]) : -1;
        if (out_index[i] < 0) missing++;
    }
    return missing;
}
int ugo_has_draw_order(const UgoModel *m) { return m->n[KC_ORDERS] != 0; }
float ugo_part_draw_order(const UgoModel *m, uint32_t part) { return part < m->n[KC_ORDERS] ? m->orders[part] : 0.0f; }

/* ---- instance --------------------------------------------------------- */

typedef struct { uint32_t params, phys, regions, local, world, frame, anim, stamp, cons, color, sincos, prev, chain, order, boneBox, warpMemo, warpNew, total; } Layout;

static Layout instance_layout(const UgoModel *m)
{
    Layout L;
    uint32_t off = align16((uint32_t)sizeof(UgoInstance));
    L.params = off; off = align16(off + 4 * m->n[KC_PARAMS]);
    L.phys = off; off = align16(off + 4 * 3 * m->n[KC_PHYS]);
    L.regions = off; off = align16(off + 4 * m->n[KC_REGIONS]);
    L.local = off; off = align16(off + 4 * 7 * m->n[KC_BONES]);
    L.world = off; off = align16(off + 4 * 6 * m->n[KC_BONES]);
    L.frame = off; off = align16(off + 4 * m->frameFloats);
    L.anim = off; off = align16(off + 4 * (7 * m->n[KC_BONES] + m->n[KC_PARTS] + m->n[KC_MORPHS]));
    L.stamp = off; off = align16(off + 4 * 3 * m->n[KC_BONES]);
    L.cons = off; off = align16(off + 4 * 8 * m->n[KC_CONS]);
    L.color = off; off = align16(off + 4 * 8 * m->n[KC_COLORS]);
    L.sincos = off; off = align16(off + 4 * 6 * m->n[KC_BONES]);
    L.prev = off; off = align16(off + 4 * 14 * m->n[KC_BONES]);
    L.chain = off; off = align16(off + 4 * (4 * (m->n[KC_CHAINBONES] + m->n[KC_CHAINS]) + m->n[KC_CHAINS] + 3));
    L.order = off; off = align16(off + 4 * (2 * m->n[KC_ORDERS] + m->n[KC_PARTS] + (m->n[KC_ORDERS] ? m->n[KC_PARTS] : 0))); /* animOrder, orderVal (0.8), drawList, scratch */
    L.boneBox = off; off = align16(off + 4 * 5 * m->n[KC_BONES]); /* ugo_bounds_estimate: each bone's rest box and morph reach, made on first use */
    L.warpMemo = off; off = align16(off + 4 * (6 * m->n[KC_WARPS] + m->n[KC_WDRIVERS])); /* warpMemo */
    L.warpNew = off; off = align16(off + m->n[KC_WARPS]); /* warpNew */
    L.total = off;
    return L;
}

uint32_t ugo_instance_mem_size(const UgoModel *m) { return instance_layout(m).total; }

UgoInstance *ugo_instance_init(void *mem, const UgoModel *m)
{
    UgoInstance *in = (UgoInstance *)mem;
    uint8_t *base = (uint8_t *)mem;
    Layout L;
    uint32_t i;
    if (!mem || !m || ((uintptr_t)mem & 15u)) return 0;
    L = instance_layout(m);
    in->m = m;
    in->params = (float *)(base + L.params);
    in->phys = (float *)(base + L.phys);
    in->regionW = (float *)(base + L.regions);
    in->local = (float *)(base + L.local);
    in->world = (float *)(base + L.world);
    in->frame = (float *)(base + L.frame);
    in->animBone = (float *)(base + L.anim);
    in->animOpacity = in->animBone + 7 * m->n[KC_BONES];
    in->animMorph = in->animOpacity + m->n[KC_PARTS];
    in->stamp = (uint32_t *)(base + L.stamp);
    in->animCons = (float *)(base + L.cons);
    in->animColor = (float *)(base + L.color);
    in->sincos = (float *)(base + L.sincos);
    in->memo = (uint32_t *)(base + L.prev);
    in->prevValid = 0;
    in->chain = (float *)(base + L.chain);
    in->boneBox = (float *)(base + L.boneBox);
    in->boneBoxReady = 0;
    in->warpMemo = (uint32_t *)(base + L.warpMemo);
    in->warpNew = base + L.warpNew;
    in->animOrder = (float *)(base + L.order);
    in->orderVal = in->animOrder + m->n[KC_ORDERS];
    in->drawList = (uint32_t *)(in->orderVal + m->n[KC_ORDERS]);
    for (i = 0; i < m->n[KC_PARTS]; i++) in->drawList[i] = i;
    in->orderKey = 0;
    in->wind[0] = in->wind[1] = in->wind[2] = 0.0f;
    in->windTime = 0.0;
    for (i = 0; i < m->n[KC_BONES]; i++) { /* angle 0: exactly what ksincos(0) gives */
        float *c = &in->sincos[6 * i];
        c[0] = 0.0f; c[1] = 0.0f; c[2] = 1.0f; c[3] = 0.0f; c[4] = 0.0f; c[5] = 1.0f;
    }
    for (i = 0; i < m->frameFloats; i++) in->frame[i] = 0.0f;
    ugo_set_transform(in, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f);
    ugo_reset_params(in);
    ugo_reset_physics(in);
    ugo_update(in, 0.0f);
    return in;
}

void ugo_reset_params(UgoInstance *in)
{
    const UgoModel *m = in->m;
    uint32_t i;
    for (i = 0; i < m->n[KC_PARAMS]; i++) in->params[i] = m->params[i].def;
    for (i = 0; i < 7 * m->n[KC_BONES]; i++) in->animBone[i] = 0.0f;
    for (i = 0; i < m->n[KC_PARTS]; i++) in->animOpacity[i] = -1.0f; /* not keyed this frame */
    for (i = 0; i < m->n[KC_MORPHS]; i++) in->animMorph[i] = 0.0f;
    for (i = 0; i < m->n[KC_ORDERS]; i++) in->animOrder[i] = m->orders[i]; /* the part's own until a track keys it */
    for (i = 0; i < m->n[KC_CONS]; i++) { /* the constraint's own values until a track keys them */
        float *c = &in->animCons[8 * i];
        uint32_t k;
        for (k = 0; k < 6; k++) c[k] = m->cons[i].mix[k];
        c[6] = m->cons[i].off[0];
        c[7] = 0.0f;
    }
    for (i = 0; i < m->n[KC_COLORS]; i++) {
        float *c = &in->animColor[8 * i];
        uint32_t k;
        for (k = 0; k < 3; k++) { c[k] = m->colors[i].a[k]; c[3 + k] = m->colors[i].b[k]; }
        c[6] = c[7] = 0.0f;
    }
}

void ugo_reset_physics(UgoInstance *in)
{
    uint32_t i;
    for (i = 0; i < 3 * in->m->n[KC_PHYS]; i++) in->phys[i] = 0.0f; /* y, v, initialised */
    for (i = 0; i < 4 * (in->m->n[KC_CHAINBONES] + in->m->n[KC_CHAINS]) + in->m->n[KC_CHAINS] + 3; i++) in->chain[i] = 0.0f;
}

/* Physics and chain state, to carry it into an instance of an edited model. */
uint32_t ugo_physics_output(const UgoModel *m, uint32_t i) { return i < m->n[KC_PHYS] ? m->phys[i].output : 0; }
uint32_t ugo_physics_count(const UgoModel *m) { return m->n[KC_PHYS]; }
void ugo_get_physics_state(const UgoInstance *in, uint32_t i, float *state)
{
    uint32_t k;
    if (i >= in->m->n[KC_PHYS]) return;
    for (k = 0; k < 3; k++) state[k] = in->phys[3 * i + k];
}
void ugo_set_physics_state(UgoInstance *in, uint32_t i, const float *state)
{
    uint32_t k;
    if (i >= in->m->n[KC_PHYS]) return;
    for (k = 0; k < 3; k++) in->phys[3 * i + k] = is_finite(state[k]) ? state[k] : 0.0f;
}
uint32_t ugo_chain_state_floats(const UgoModel *m, uint32_t c) { return c < m->n[KC_CHAINS] ? 4 * (m->chains[c].boneCount + 1) + 1 : 0; }
void ugo_get_chain_state(const UgoInstance *in, uint32_t c, float *state)
{
    const UgoModel *m = in->m;
    uint32_t k, n;
    if (c >= m->n[KC_CHAINS]) return;
    n = 4 * (m->chains[c].boneCount + 1);
    for (k = 0; k < n; k++) state[k] = in->chain[4 * (m->chains[c].firstBone + c) + k];
    state[n] = in->chain[4 * (m->n[KC_CHAINBONES] + m->n[KC_CHAINS]) + c];
}
void ugo_set_chain_state(UgoInstance *in, uint32_t c, const float *state)
{
    const UgoModel *m = in->m;
    uint32_t k, n;
    int ok = 1;
    if (c >= m->n[KC_CHAINS]) return;
    n = 4 * (m->chains[c].boneCount + 1);
    for (k = 0; k <= n; k++) ok = ok && is_finite(state[k]);
    for (k = 0; k < n; k++) in->chain[4 * (m->chains[c].firstBone + c) + k] = ok ? state[k] : 0.0f;
    in->chain[4 * (m->n[KC_CHAINBONES] + m->n[KC_CHAINS]) + c] = ok && state[n] != 0.0f ? 1.0f : 0.0f; /* bad state: start over */
}

/* Where the character was on screen at the last update (x, y, 1 once known), for the chains' inertia. */
void ugo_get_last_placement(const UgoInstance *in, float *xy_known)
{
    const float *mv = in->chain + 4 * (in->m->n[KC_CHAINBONES] + in->m->n[KC_CHAINS]) + in->m->n[KC_CHAINS];
    xy_known[0] = mv[0]; xy_known[1] = mv[1]; xy_known[2] = mv[2];
}
void ugo_set_last_placement(UgoInstance *in, const float *xy_known)
{
    float *mv = in->chain + 4 * (in->m->n[KC_CHAINBONES] + in->m->n[KC_CHAINS]) + in->m->n[KC_CHAINS];
    int ok = is_finite(xy_known[0]) && is_finite(xy_known[1]) && xy_known[2] != 0.0f;
    mv[0] = ok ? xy_known[0] : 0.0f; mv[1] = ok ? xy_known[1] : 0.0f; mv[2] = ok ? 1.0f : 0.0f;
}

void ugo_set_param(UgoInstance *in, uint32_t i, float value)
{
    if (i < in->m->n[KC_PARAMS] && is_finite(value)) in->params[i] = value;
}

/* Pose (editor): a bone's offsets from the rest pose, as the animation tracks set them:
 * rot, x, y, scaleX, scaleY, shearX, shearY (angles in radians). */
void ugo_set_bone_offset(UgoInstance *in, uint32_t bone, const float *pose, float weight)
{
    uint32_t k;
    float *p;
    if (bone >= in->m->n[KC_BONES] || !pose || !is_finite(weight)) return;
    for (k = 0; k < 7; k++) if (!is_finite(pose[k])) return;
    p = in->animBone + 7 * bone;
    for (k = 0; k < 7; k++) p[k] += (pose[k] - p[k]) * weight;
}

void ugo_get_bone_offset(const UgoInstance *in, uint32_t bone, float *pose)
{
    uint32_t k;
    if (bone >= in->m->n[KC_BONES] || !pose) return;
    for (k = 0; k < 7; k++) pose[k] = in->animBone[7 * bone + k];
}

/* Drag (editor): turns the bone and up to count - 1 of its parents so that the bone's tip
 * (its end, or its origin if it has no length) comes nearer the point (x, y), by cyclic
 * coordinate descent on last ugo_update's world matrices. The turns are added to the bones'
 * rotation offsets (as ugo_set_bone_offset's), so ugo_update shows them. Returns the distance
 * left as those matrices see it, or -1 for a bad call. */
float ugo_solve_ik_to(UgoInstance *in, uint32_t bone, uint32_t count, float x, float y, uint32_t iterations)
{
    const UgoModel *m = in->m;
    uint32_t chain[64], n = 0, it, j, k, b;
    double px[65], py[65], turn[64], tx, ty;
    if (bone >= m->n[KC_BONES] || !count || !is_finite(x) || !is_finite(y)) return -1.0f;
    if (count > 64) count = 64;
    if (iterations > 64) iterations = 64;
    for (b = bone; n < count; b = (uint32_t)m->bones[b].parent) {
        chain[n++] = b;
        if (m->bones[b].parent < 0) break;
    }
    /* joints from the root of the chain to the bone, then the tip */
    for (j = 0; j < n; j++) {
        const float *w = &in->world[6 * chain[n - 1 - j]];
        px[j] = w[4]; py[j] = w[5]; turn[j] = 0.0;
    }
    {
        const float *w = &in->world[6 * bone];
        float len = m->bones[bone].length;
        tx = w[4] + (double)w[0] * len; ty = w[5] + (double)w[1] * len;
    }
    for (it = 0; it < iterations; it++) {
        for (j = n; j-- > 0;) {
            double ax = tx - px[j], ay = ty - py[j], bx = x - px[j], by = y - py[j], d, c, sn;
            float sf, cf;
            if (ax * ax + ay * ay < 1e-12 || bx * bx + by * by < 1e-12) continue;
            d = katan2(ax * by - ay * bx, ax * bx + ay * by);
            turn[j] += d;
            ksincos((float)d, &sf, &cf);
            c = cf; sn = sf;
            for (k = j + 1; k <= n; k++) {
                double *qx = k < n ? &px[k] : &tx, *qy = k < n ? &py[k] : &ty;
                double rx = *qx - px[j], ry = *qy - py[j];
                *qx = px[j] + rx * c - ry * sn;
                *qy = py[j] + rx * sn + ry * c;
            }
        }
    }
    /* a turn in world space is the same turn of the local rotation, or its opposite under a reflection */
    for (j = 0; j < n; j++) {
        uint32_t i = chain[n - 1 - j];
        const float *w = &in->world[6 * i], *l = &in->local[7 * i];
        double det = (double)w[0] * w[3] - (double)w[1] * w[2], own = (double)l[3] * l[4];
        float t = (float)((det * own < 0.0) ? -turn[j] : turn[j]);
        if (is_finite(t)) in->animBone[7 * i] += t;
    }
    return (float)ksqrt((tx - x) * (tx - x) + (ty - y) * (ty - y));
}

float ugo_get_param(const UgoInstance *in, uint32_t i) { return i < in->m->n[KC_PARAMS] ? in->params[i] : 0.0f; }
float *ugo_params(UgoInstance *in) { return in->params; }
const float *ugo_frame(const UgoInstance *in) { return in->frame; }
const uint32_t *ugo_draw_order(const UgoInstance *in) { return in->drawList; }
uint32_t ugo_draw_order_key(const UgoInstance *in) { return in->orderKey; }

/* One expression item on a parameter value, at weight w (0.8). */
static void expr_op(float *v, uint32_t op, float x, float w)
{
    if (op == EXPR_SET) *v += (x - *v) * w;
    else if (op == EXPR_ADD) *v += x * w;
    else if (op == EXPR_MULTIPLY) *v *= 1.0f + (x - 1.0f) * w;
}

void ugo_apply_expression(UgoInstance *in, uint32_t i, float weight)
{
    const UgoModel *m = in->m;
    uint32_t k;
    if (i >= m->n[KC_EXPRS] || !is_finite(weight)) return;
    for (k = m->exprs[i].firstItem; k < m->exprs[i].firstItem + m->exprs[i].itemCount; k++) {
        const KExprItem *q = &m->exprItems[k];
        expr_op(&in->params[q->param], q->op, q->value, weight);
    }
}

void ugo_apply_params(UgoInstance *in, const int32_t *index, const uint32_t *ops, const float *values, uint32_t n, float weight)
{
    uint32_t k;
    if (!is_finite(weight)) return;
    for (k = 0; k < n; k++) {
        if (index[k] < 0 || (uint32_t)index[k] >= in->m->n[KC_PARAMS] || ops[k] >= EXPR_OP_COUNT || !is_finite(values[k])) continue;
        expr_op(&in->params[index[k]], ops[k], values[k], weight);
    }
}

void ugo_set_transform(UgoInstance *in, float a, float b, float c, float d, float tx, float ty)
{
    in->frame[0] = a; in->frame[1] = b; in->frame[2] = c; in->frame[3] = d;
    in->frame[4] = tx; in->frame[5] = ty; in->frame[6] = 0.0f; in->frame[7] = 0.0f;
}

/* The value of a track with keys at time t (in ticks, t >= 0): straight lines between keys. */
static float sample_track(const KTrack *tr, const KKey *k, float t)
{
    const KKey *lo = k;
    uint32_t n = tr->keyCount, len = n - 1, ti;
    float f, span, t0, v0;
    if (t >= KEY_TIME(k[n - 1])) return tr->base + (float)k[n - 1].v * tr->step;
    /* key times are whole ticks: key time <= t is key tick <= floor(t) (t < 65535 here) */
    ti = (uint32_t)t;
    if (k[0].t > ti) return tr->base + (float)k[0].v * tr->step;
    /* the last key at or before t among k[0..n-2] (then t < the next key's time): a
     * binary search without branches, which the processor cannot mispredict */
    while (len > 1) {
        uint32_t half = len / 2;
        lo = lo[half].t <= ti ? lo + half : lo;
        len -= half;
    }
    t0 = KEY_TIME(lo[0]);
    span = KEY_TIME(lo[1]) - t0;
    v0 = tr->base + (float)lo[0].v * tr->step;
    if (span <= 0.0f) return v0;
    f = (t - t0) / span;
    if (TRACK_EASED(tr->target)) f = f * f * (3.0f - 2.0f * f);
    return v0 + (tr->base + (float)lo[1].v * tr->step - v0) * f;
}

void ugo_apply_animation(UgoInstance *in, uint32_t anim, float time, float weight)
{
    const UgoModel *m = in->m;
    const KAnim *a;
    const KTrack *tr, *end;
    float *base[TK_COUNT];
    uint32_t stride[TK_COUNT], i;
    float t;
    if (anim >= m->n[KC_ANIMS] || !is_finite(time) || !is_finite(weight)) return;
    a = &m->anims[anim];
    t = time;
    if (a->duration > 0.0f) {
        if (a->loop) t = (float)((double)time - (double)a->duration * kfloor((double)time / a->duration));
        else if (t > a->duration) t = a->duration;
    }
    if (t < 0.0f) t = 0.0f;
    t /= a->tick; /* key times are in ticks */
    /* where each kind of track writes: base[kind] + stride[kind] * index */
    for (i = TK_BONE_ROT; i <= TK_BONE_SY; i++) { base[i] = in->animBone + (i - TK_BONE_ROT); stride[i] = 7; } /* rot, x, y, sx, sy */
    base[TK_BONE_SHX] = in->animBone + 5; stride[TK_BONE_SHX] = 7;
    base[TK_BONE_SHY] = in->animBone + 6; stride[TK_BONE_SHY] = 7;
    base[TK_PARAM] = in->params; stride[TK_PARAM] = 1;
    base[TK_PART_OPACITY] = in->animOpacity; stride[TK_PART_OPACITY] = 1;
    base[TK_MORPH] = in->animMorph; stride[TK_MORPH] = 1;
    base[TK_CONS] = in->animCons; stride[TK_CONS] = 1;
    base[TK_COLOR] = in->animColor; stride[TK_COLOR] = 1;
    base[TK_PART_ORDER] = in->animOrder; stride[TK_PART_ORDER] = 1;
    if (m->runs) { /* the same, run by run as made at load (see KRun) */
        const KRun *r = m->runs + m->animRun[anim], *rend = m->runs + m->animRun[anim + 1];
        for (; r < rend; r++) {
            uint32_t kind = r->kind, n = r->count, k;
            float *b;
            if (kind >= TK_COUNT) continue; /* a kind of a later 1.x */
            b = base[kind];
            tr = m->tracks + r->first;
            if (kind == TK_PART_OPACITY) {
                for (k = 0; k < n; k++, tr++) {
                    uint32_t idx = TRACK_INDEX(tr->target);
                    float v = tr->keyCount == 1 ? tr->base : sample_track(tr, m->keys + tr->firstKey, t), *p = b + idx;
                    if (*p < 0.0f) *p = m->parts[idx].opacity;
                    *p += (v - *p) * weight;
                }
            } else if (r->cfirst != UGO_NONE) { /* single keys: their values, all at once */
                const uint32_t *off = m->cOff + r->cfirst;
                const float *val = m->cVal + r->cfirst;
                for (k = 0; k < n; k++) {
                    float *p = b + off[k];
                    *p += (val[k] - *p) * weight;
                }
            } else {
                uint32_t s = stride[kind];
                for (k = 0; k < n; k++, tr++) {
                    float *p = b + s * TRACK_INDEX(tr->target);
                    *p += (sample_track(tr, m->keys + tr->firstKey, t) - *p) * weight;
                }
            }
        }
        return;
    }
    /* the compiler groups the tracks by kind: one run per kind, its single keys first */
    tr = m->tracks + a->firstTrack;
    end = tr + a->trackCount;
    while (tr < end) {
        uint32_t kind = TRACK_KIND(tr->target), s;
        float *b;
        if (kind >= TK_COUNT) { /* a kind of a later 1.x: skipped (ugo_model_warnings says so) */
            for (; tr < end && TRACK_KIND(tr->target) == kind; tr++) {}
            continue;
        }
        s = stride[kind];
        b = base[kind];
        if (kind == TK_PART_OPACITY) {
            for (; tr < end && TRACK_KIND(tr->target) == kind; tr++) {
                uint32_t idx = TRACK_INDEX(tr->target);
                float v = tr->keyCount == 1 ? tr->base : sample_track(tr, m->keys + tr->firstKey, t), *p = b + idx;
                if (*p < 0.0f) *p = m->parts[idx].opacity; /* first track: start from the part's own opacity */
                *p += (v - *p) * weight;
            }
            continue;
        }
        for (; tr < end && TRACK_KIND(tr->target) == kind && tr->keyCount == 1; tr++) {
            float *p = b + s * TRACK_INDEX(tr->target);
            *p += (tr->base - *p) * weight;
        }
        for (; tr < end && TRACK_KIND(tr->target) == kind; tr++) {
            float *p = b + s * TRACK_INDEX(tr->target);
            *p += (sample_track(tr, m->keys + tr->firstKey, t) - *p) * weight;
        }
    }
}

/* A target's value at rest (what ugo_reset_params gives it): what an added animation adds to. */
static float rest_value(const UgoModel *m, uint32_t kind, uint32_t idx)
{
    switch (kind) {
    case TK_PARAM: return m->params[idx].def;
    case TK_PART_OPACITY: return m->parts[idx].opacity;
    case TK_PART_ORDER: return m->orders[idx];
    case TK_CONS: return (idx & 7u) < 6u ? m->cons[idx >> 3].mix[idx & 7u] : (idx & 7u) == 6u ? m->cons[idx >> 3].off[0] : 0.0f;
    case TK_COLOR: return (idx & 7u) < 3u ? m->colors[idx >> 3].a[idx & 7u] : (idx & 7u) < 6u ? m->colors[idx >> 3].b[(idx & 7u) - 3u] : 0.0f;
    default: return 0.0f; /* bone offsets and morph weights */
    }
}

void ugo_apply_animation_ex(UgoInstance *in, uint32_t anim, float time, float weight, uint32_t flags, const UgoAnimMask *mask)
{
    const UgoModel *m = in->m;
    const KAnim *a;
    const KTrack *tr, *end;
    float t;
    if (!flags && !mask) { ugo_apply_animation(in, anim, time, weight); return; }
    if (anim >= m->n[KC_ANIMS] || !is_finite(time) || !is_finite(weight)) return;
    a = &m->anims[anim];
    t = time;
    if (a->duration > 0.0f) {
        if (a->loop) t = (float)((double)time - (double)a->duration * kfloor((double)time / a->duration));
        else if (t > a->duration) t = a->duration;
    }
    if (t < 0.0f) t = 0.0f;
    t /= a->tick;
    end = m->tracks + a->firstTrack + a->trackCount;
    for (tr = m->tracks + a->firstTrack; tr < end; tr++) {
        uint32_t kind = TRACK_KIND(tr->target), idx = TRACK_INDEX(tr->target);
        float v, *p;
        if (kind >= TK_COUNT) continue;
        if (mask) { /* only what the mask lets through (a NULL list lets everything through) */
            const uint8_t *list = kind == TK_PARAM ? mask->params : kind == TK_PART_OPACITY || kind == TK_PART_ORDER ? mask->parts
                                : kind == TK_MORPH ? mask->morphs : kind == TK_CONS ? mask->constraints : kind == TK_COLOR ? mask->colors : mask->bones;
            uint32_t at = kind == TK_CONS ? idx >> 3 : kind == TK_COLOR ? idx >> 3 : idx;
            if (list && !list[at]) continue;
        }
        v = tr->keyCount == 1 ? tr->base : sample_track(tr, m->keys + tr->firstKey, t);
        switch (kind) {
        case TK_PARAM: p = in->params + idx; break;
        case TK_PART_OPACITY:
            p = in->animOpacity + idx;
            if (*p < 0.0f) *p = m->parts[idx].opacity;
            break;
        case TK_MORPH: p = in->animMorph + idx; break;
        case TK_CONS: p = in->animCons + idx; break;
        case TK_COLOR: p = in->animColor + idx; break;
        case TK_PART_ORDER: p = in->animOrder + idx; break;
        default: p = in->animBone + 7 * idx + (kind <= TK_BONE_SY ? kind - TK_BONE_ROT : kind == TK_BONE_SHX ? 5u : 6u); break;
        }
        if (flags & UGO_ANIM_ADD) *p += (v - rest_value(m, kind, idx)) * weight;
        else *p += (v - *p) * weight;
    }
}

/* Reading tracks (editors, tools): the k-th track of an animation. */
static const KTrack *track_at(const UgoModel *m, uint32_t anim, uint32_t k)
{
    if (anim >= m->n[KC_ANIMS] || k >= m->anims[anim].trackCount) return 0;
    return &m->tracks[m->anims[anim].firstTrack + k];
}

uint32_t ugo_animation_track_count(const UgoModel *m, uint32_t anim) { return anim < m->n[KC_ANIMS] ? m->anims[anim].trackCount : 0; }

int ugo_animation_track(const UgoModel *m, uint32_t anim, uint32_t k, uint32_t *info)
{
    const KTrack *tr = track_at(m, anim, k);
    if (!tr || !info) return 0;
    info[0] = TRACK_KIND(tr->target);
    info[1] = TRACK_INDEX(tr->target);
    info[2] = tr->keyCount == 1 ? 0 : tr->keyCount; /* 0: no keys, one value */
    info[3] = TRACK_EASED(tr->target);
    return 1;
}

int ugo_animation_track_key(const UgoModel *m, uint32_t anim, uint32_t k, uint32_t key, float *tv)
{
    const KTrack *tr = track_at(m, anim, k);
    const KKey *kk;
    if (!tr || !tv || tr->keyCount == 1 || key >= tr->keyCount) return 0;
    kk = &m->keys[tr->firstKey + key];
    tv[0] = (float)kk->t * m->anims[anim].tick;
    tv[1] = tr->base + (float)kk->v * tr->step;
    return 1;
}

float ugo_animation_track_value(const UgoModel *m, uint32_t anim, uint32_t k, float time)
{
    const KTrack *tr = track_at(m, anim, k);
    const KAnim *a;
    float t;
    if (!tr || !is_finite(time)) return 0.0f;
    if (tr->keyCount == 1) return tr->base;
    a = &m->anims[anim];
    t = time;
    if (a->duration > 0.0f) {
        if (a->loop) t = (float)((double)time - (double)a->duration * kfloor((double)time / a->duration));
        else if (t > a->duration) t = a->duration;
    }
    if (t < 0.0f) t = 0.0f;
    return sample_track(tr, m->keys + tr->firstKey, t / a->tick);
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* a before b in draw order: smaller value, or the same value and stored first */
static int order_before(const float *v, uint32_t a, uint32_t b) { return v[a] < v[b] || (v[a] == v[b] && a < b); }

/* Draw order (0.8): each part's value (animation, or its own) plus the weighted
 * driver changes; parts sorted by value, equal values in the parts' order (one
 * answer, whatever sorts it, so it is the same on every platform). Sorted from
 * last frame's list by insertion (almost no work when little moved); when much
 * moved, by merging instead (n log n). */
static void update_draw_order(UgoInstance *in)
{
    const UgoModel *m = in->m;
    uint32_t i, n = m->n[KC_PARTS], *L = in->drawList, h = 2166136261u, same = 1, moved = 0, budget = 8 * n + 64;
    float *v = in->orderVal;
    for (i = 0; i < n; i++) v[i] = in->animOrder[i];
    for (i = 0; i < m->n[KC_ORDRIVERS]; i++) {
        const KOrderDriver *d = &m->ordrv[i];
        float w = in->regionW[d->region];
        if (w != 0.0f) v[d->part] += w * d->d;
    }
    for (i = 1; i < n && budget; i++) {
        uint32_t x = L[i], j = i;
        while (j > 0 && budget && order_before(v, x, L[j - 1])) { L[j] = L[j - 1]; j--; budget--; }
        if (j != i) { L[j] = x; moved = 1; }
    }
    if (!budget) { /* too much moved: merge sort (bottom-up, with the scratch list) */
        uint32_t *A = L, *B = in->drawList + n, w;
        for (w = 1; w < n; w *= 2) {
            uint32_t lo;
            for (lo = 0; lo < n; lo += 2 * w) {
                uint32_t mid = lo + w < n ? lo + w : n, hi = lo + 2 * w < n ? lo + 2 * w : n, a = lo, b = mid, k = lo;
                while (a < mid && b < hi) B[k++] = order_before(v, A[b], A[a]) ? A[b++] : A[a++];
                while (a < mid) B[k++] = A[a++];
                while (b < hi) B[k++] = A[b++];
            }
            { uint32_t *t = A; A = B; B = t; }
        }
        if (A != L) for (i = 0; i < n; i++) L[i] = A[i];
        moved = 1;
    }
    if (!moved) return; /* the same list: the same key */
    for (i = 0; i < n; i++) { h = (h ^ L[i]) * 16777619u; same &= L[i] == i; }
    in->orderKey = same ? 0 : (h ? h : 1);
}

static void step_physics(UgoInstance *in, float dt)
{
    const UgoModel *m = in->m;
    uint32_t i, j, steps, s;
    float h;
    steps = 0;
    if (dt > 0.0f) {
        if (dt > 0.25f) dt = 0.25f;
        steps = (uint32_t)(dt * UGO_PHYSICS_HZ);
        if ((float)steps < dt * UGO_PHYSICS_HZ) steps++;
        if (steps > 32) steps = 32;
    }
    h = steps ? dt / (float)steps : 0.0f;
    for (i = 0; i < m->n[KC_PHYS]; i++) {
        const KPhys *q = &m->phys[i];
        float *st = &in->phys[3 * i];
        float input = 0.0f;
        for (j = q->firstInput; j < q->firstInput + q->inputCount; j++)
            input += m->physin[j].weight * in->params[m->physin[j].param];
        if (st[2] == 0.0f) { st[0] = input; st[1] = 0.0f; st[2] = 1.0f; }
        for (s = 0; s < steps; s++) { /* follow-spring, semi-implicit Euler */
            float acc = q->stiffness * (input - st[0]) - q->damping * st[1];
            st[1] += acc * h;
            st[0] += st[1] * h;
        }
        if (!is_finite(st[0]) || !is_finite(st[1])) { st[0] = input; st[1] = 0.0f; }
        in->params[q->output] = clampf(q->gain * (st[0] - input), q->outMin, q->outMax);
    }
}

/* ---- skeleton pose (the same rules as tools/skeleton_pose.mjs) -------- */

#define K_PI 3.14159265358979323846
#define K_HALF_PI 1.57079632679489661923

/* The part of the parent's world matrix a bone's axes inherit (2x2). */
static void inherited_linear(const float *P, uint32_t mode, double *Q)
{
    double det, len2, len = 0.0, inv = 0.0, c = 1.0, s = 0.0, f;
    if (!P || mode == INHERIT_ONLY_TRANSLATION) { Q[0] = 1.0; Q[1] = 0.0; Q[2] = 0.0; Q[3] = 1.0; return; }
    if (mode == INHERIT_NORMAL) { Q[0] = P[0]; Q[1] = P[1]; Q[2] = P[2]; Q[3] = P[3]; return; }
    det = (double)P[0] * P[3] - (double)P[2] * P[1];
    len2 = (double)P[0] * P[0] + (double)P[1] * P[1];
    if (len2 > 1e-18) { /* (the parent's x axis is finite: matrices come from finite values) */
        inv = len2 < 1e300 ? krsqrt(len2) : 1.0 / ksqrt(len2);
        len = len2 * inv; c = P[0] * inv; s = P[1] * inv;
    }
    if (mode == INHERIT_NO_ROTATION) { /* the parent's scale and shear, not its rotation or reflection */
        Q[0] = len; Q[1] = 0.0; Q[2] = c * P[2] + s * P[3];
        Q[3] = (det < 0.0 ? -det : det) * inv;
        return;
    }
    f = (mode == INHERIT_NO_SCALE && det < 0.0) ? -1.0 : 1.0; /* noScale keeps a reflection */
    Q[0] = c; Q[1] = s; Q[2] = -s * f; Q[3] = c * f;
}

/* World matrix W of local values l = x, y, rot, sx, sy, shx, shy under parent P.
 * sc caches the angles of the x and y axes and their sin and cos (6 floats). */
static void compose(const float *P, const float *l, uint32_t mode, float *W, float *sc)
{
    double Q[4];
    float sa, ca, sb, cb, L[4], ax = l[2] + l[5], ay = l[2] + l[6];
    if (ax != sc[0]) { ksincos(ax, &sc[1], &sc[2]); sc[0] = ax; }
    sa = sc[1]; ca = sc[2];
    if (ay == ax) { sb = sa; cb = ca; }
    else {
        if (ay != sc[3]) { ksincos(ay, &sc[4], &sc[5]); sc[3] = ay; }
        sb = sc[4]; cb = sc[5];
    }
    L[0] = ca * l[3]; L[1] = sa * l[3]; L[2] = -sb * l[4]; L[3] = cb * l[4];
    inherited_linear(P, mode, Q);
    W[0] = (float)(Q[0] * L[0] + Q[2] * L[1]); W[1] = (float)(Q[1] * L[0] + Q[3] * L[1]);
    W[2] = (float)(Q[0] * L[2] + Q[2] * L[3]); W[3] = (float)(Q[1] * L[2] + Q[3] * L[3]);
    if (P) { W[4] = P[0] * l[0] + P[2] * l[1] + P[4]; W[5] = P[1] * l[0] + P[3] * l[1] + P[5]; }
    else { W[4] = l[0]; W[5] = l[1]; }
}

/* World matrices are computed lazily while constraints run. stamp[3i] is when
 * bone i's world was last computed, stamp[3i+1] when its local values last
 * changed (in->gen counts up during one update). A world is current when it
 * is newer than its own local values and than its parent's world, and the
 * parent's is current too. */
#if !UGO_SIMD_KIND
static uint32_t fbits(float f) { union { float f; uint32_t u; } x; x.f = f; return x.u; }
/* 0 when the n floats have the bits in b */
static uint32_t bits_differ(const float *a, const uint32_t *b, uint32_t n)
{
    uint32_t k, d = 0;
    for (k = 0; k < n; k++) d |= fbits(a[k]) ^ b[k];
    return d;
}
#endif

/* 0 when the 7 local values l have the bits in memo m */
static uint32_t local_differs(const float *l, const uint32_t *m)
{
#if UGO_SIMD_KIND
    return (uint32_t)u4_any(u4_or(u4_xor(u4_load(l), u4_load(m)), u4_xor(u4_load(l + 3), u4_load(m + 3))));
#else
    return bits_differ(l, m, 7);
#endif
}

/* A world is a pure function of the parent's world and the local values: when both
 * have the same bits as the last time, the world already holds the result. */
static void compose_bone(UgoInstance *in, uint32_t i)
{
    const KBone *b = &in->m->bones[i];
    const float *P = b->parent < 0 ? 0 : &in->world[6 * b->parent], *l = &in->local[7 * i];
    uint32_t *mm = &in->memo[14 * i], d = !in->prevValid;
#if UGO_SIMD_KIND
    /* compared and remembered in one pass (where nothing differs, the same bits are written back) */
    { /* 7 local values as words 0-3 and 3-6, the parent's 6 as 0-3 and 2-5 (overlapping) */
        ugo_u4 l0 = u4_load(l), l1 = u4_load(l + 3), x = u4_or(u4_xor(l0, u4_load(mm)), u4_xor(l1, u4_load(mm + 3)));
        u4_store(mm, l0); u4_store(mm + 3, l1);
        if (P) {
            ugo_u4 p0 = u4_load(P), p1 = u4_load(P + 2);
            x = u4_or(x, u4_or(u4_xor(p0, u4_load(mm + 7)), u4_xor(p1, u4_load(mm + 9))));
            u4_store(mm + 7, p0); u4_store(mm + 9, p1);
        }
        d |= (uint32_t)u4_any(x);
    }
#else
    if (!d) d = bits_differ(l, mm, 7) || (P && bits_differ(P, mm + 7, 6));
    if (d) { /* (stored only when something differs: plain C, one word at a time) */
        uint32_t k;
        for (k = 0; k < 7; k++) mm[k] = fbits(l[k]);
        for (k = 0; P && k < 6; k++) mm[7 + k] = fbits(P[k]);
    }
#endif
    if (d) {
        compose(P, l, b->inherit, &in->world[6 * i], &in->sincos[6 * i]);
        mm[13] = 1; /* the skin matrix follows in ugo_update */
    }
    in->stamp[3 * i] = ++in->gen;
}

static int bone_stale(const UgoInstance *in, uint32_t i)
{
    int32_t p = in->m->bones[i].parent;
    return in->stamp[3 * i] <= in->stamp[3 * i + 1] || (p >= 0 && in->stamp[3 * i] <= in->stamp[3 * p]);
}

/* Bone i's current world matrix (recomputes what changed between it and the root).
 * A world computed after the last change of any local values is current: its
 * chain was current then, and nothing changed since. */
static const float *bone_world(UgoInstance *in, int32_t i)
{
    uint32_t *chain = in->stamp + 2, n = 0; /* stamp[3k+2] doubles as a stack */
    int32_t k;
    if (i < 0) return 0;
    for (k = i; k >= 0 && in->stamp[3 * k] <= in->lastTouch; k = in->m->bones[k].parent) chain[3 * n++] = (uint32_t)k;
    while (n--) {
        uint32_t b = chain[3 * n];
        if (bone_stale(in, b)) compose_bone(in, b);
    }
    return &in->world[6 * i];
}

/* Bone i's local values changed: it and everything below it need a new world. */
static void touch_bone(UgoInstance *in, uint32_t i) { in->stamp[3 * i + 1] = in->lastTouch = ++in->gen; }

static int inv2(const double *M, double *out)
{
    double det = M[0] * M[3] - M[2] * M[1];
    if (det > -1e-12 && det < 1e-12) return 0;
    out[0] = M[3] / det; out[1] = -M[1] / det; out[2] = -M[2] / det; out[3] = M[0] / det;
    return 1;
}

/* The local values l (x, y, rot, sx, sy, shx, shy) that give world W under parent P (shear goes
 * to shy); a part that cannot be solved (a flat parent) keeps l's old values. */
static void local_for_world(const float *P, uint32_t inherit, const double *W, float *l)
{
    double Q[4], iq[4];
    if (P) {
        double PL[4], ip[4];
        PL[0] = P[0]; PL[1] = P[1]; PL[2] = P[2]; PL[3] = P[3];
        if (inv2(PL, ip)) {
            double dx = W[4] - P[4], dy = W[5] - P[5];
            l[0] = (float)(ip[0] * dx + ip[2] * dy); l[1] = (float)(ip[1] * dx + ip[3] * dy);
        }
    } else { l[0] = (float)W[4]; l[1] = (float)W[5]; }
    inherited_linear(P, inherit, Q);
    if (inv2(Q, iq)) {
        double a = iq[0] * W[0] + iq[2] * W[1], bb = iq[1] * W[0] + iq[3] * W[1];
        double c = iq[0] * W[2] + iq[2] * W[3], d = iq[1] * W[2] + iq[3] * W[3];
        double r = katan2(bb, a), sy = ksqrt(c * c + d * d), shy = kwrap(katan2(d, c) - r - K_HALF_PI);
        if (a * d - c * bb < 0.0) { sy = -sy; shy = kwrap(shy + K_PI); }
        l[2] = (float)r; l[3] = (float)ksqrt(a * a + bb * bb); l[4] = (float)sy; l[5] = 0.0f; l[6] = (float)shy;
    }
}

/* Sets bone i's local values so its world matrix becomes W (shear goes to shy). */
static void set_world(UgoInstance *in, uint32_t i, const double *W)
{
    const KBone *b = &in->m->bones[i];
    local_for_world(bone_world(in, b->parent), b->inherit, W, &in->local[7 * i]);
    touch_bone(in, i);
}

/* World pose (editor: keep a child in place while its parent moves, or type values in world
 * space): the offsets that, under the parent's world of the last ugo_update, give the bone the
 * world matrix W. Shear goes to shearY; angles wrap so they never turn the long way round. */
void ugo_set_bone_world(UgoInstance *in, uint32_t bone, const float *W)
{
    const UgoModel *m = in->m;
    const KBone *b;
    double Wd[6];
    float l[7], *cur, *off;
    uint32_t k;
    if (bone >= m->n[KC_BONES] || !W) return;
    for (k = 0; k < 6; k++) { if (!is_finite(W[k])) return; Wd[k] = W[k]; }
    b = &m->bones[bone];
    cur = &in->local[7 * bone];
    off = &in->animBone[7 * bone];
    for (k = 0; k < 7; k++) l[k] = cur[k];
    local_for_world(b->parent < 0 ? 0 : &in->world[6 * (uint32_t)b->parent], b->inherit, Wd, l);
    /* local x, y, rot, sx, sy, shx, shy -> offsets rot, x, y, sx, sy, shx, shy */
    off[1] += l[0] - cur[0];
    off[2] += l[1] - cur[1];
    off[0] += (float)kwrap((double)l[2] - cur[2]);
    off[3] += l[3] - cur[3];
    off[4] += l[4] - cur[4];
    off[5] += l[5] - cur[5];
    off[6] += (float)kwrap((double)l[6] - cur[6]);
}

/* Local rotation that points bone i's x axis at (tx, ty); *dist = distance in the parent's frame. */
static double aim_rotation(UgoInstance *in, uint32_t i, double tx, double ty, double *dist)
{
    const KBone *b = &in->m->bones[i];
    const float *W = bone_world(in, (int32_t)i), *l = &in->local[7 * i];
    double Q[4], iq[4], dx, dy, x, y;
    inherited_linear(bone_world(in, b->parent), b->inherit, Q);
    if (!inv2(Q, iq)) { if (dist) *dist = 0.0; return l[2]; }
    dx = tx - W[4]; dy = ty - W[5];
    x = iq[0] * dx + iq[2] * dy; y = iq[1] * dx + iq[3] * dy;
    if (dist) *dist = ksqrt(x * x + y * y);
    return katan2(y, x) - l[5];
}

static void apply_ik(UgoInstance *in, const KCons *c, const float *v)
{
    const UgoModel *m = in->m;
    double mix = v[0], tx, ty, dist;
    const float *T;
    if (mix == 0.0) return;
    T = bone_world(in, c->target);
    tx = T[4]; ty = T[5];
    if (c->bone2 < 0) {
        uint32_t i = (uint32_t)c->bone;
        float *l = &in->local[7 * i];
        double rot = aim_rotation(in, i, tx, ty, &dist), len;
        l[2] = (float)(l[2] + kwrap(rot - l[2]) * mix);
        len = (double)m->bones[i].length * l[3];
        if (len > 1e-4 && (((c->flags & IK_COMPRESS) && dist < len) || ((c->flags & IK_STRETCH) && dist > len))) {
            double s = (dist / len - 1.0) * mix + 1.0;
            l[3] = (float)(l[3] * s);
            if (c->flags & IK_UNIFORM) l[4] = (float)(l[4] * s);
        }
        touch_bone(in, i);
        return;
    }
    {
        uint32_t a = (uint32_t)c->bone, ch = (uint32_t)c->bone2, k;
        float *la = &in->local[7 * a], *lc = &in->local[7 * ch];
        double r0 = la[2], rc0 = lc[2], A[6], C[6], l1, l2, d;
        const float *wa = bone_world(in, (int32_t)a), *wc = bone_world(in, (int32_t)ch);
        for (k = 0; k < 6; k++) { A[k] = wa[k]; C[k] = wc[k]; }
        l1 = ksqrt((C[4] - A[4]) * (C[4] - A[4]) + (C[5] - A[5]) * (C[5] - A[5]));
        l2 = (double)m->bones[ch].length * ksqrt(C[0] * C[0] + C[1] * C[1]);
        d = ksqrt((tx - A[4]) * (tx - A[4]) + (ty - A[5]) * (ty - A[5]));
        if ((c->flags & IK_STRETCH) && l1 + l2 > 1e-4 && d > l1 + l2) {
            double s = (d / (l1 + l2) - 1.0) * mix + 1.0;
            la[3] = (float)(la[3] * s);
            if (c->flags & IK_UNIFORM) la[4] = (float)(la[4] * s);
            touch_bone(in, a);
        }
        if (l1 > 1e-4 && d > 1e-4) {
            /* angle at the first bone between the target and the second bone (law of cosines) */
            double cv = (l1 * l1 + d * d - l2 * l2) / (2.0 * l1 * d), det, want, cur, ax, ay;
            float sn, cs;
            if (cv < -1.0) cv = -1.0;
            if (cv > 1.0) cv = 1.0;
            det = A[0] * A[3] - A[2] * A[1];
            want = katan2(ty - A[5], tx - A[4]) + (v[6] < 0.0f ? -1.0 : 1.0) * (det < 0.0 ? -1.0 : 1.0) * katan2(ksqrt(1.0 - cv * cv), cv);
            wc = bone_world(in, (int32_t)ch);
            cur = katan2(wc[5] - A[5], wc[4] - A[4]);
            ksincos((float)kwrap(want - cur), &sn, &cs);
            ax = A[0] * cs - A[1] * sn; ay = A[0] * sn + A[1] * cs;
            la[2] = (float)aim_rotation(in, a, A[4] + ax, A[5] + ay, 0);
            touch_bone(in, a);
        }
        lc[2] = (float)aim_rotation(in, ch, tx, ty, 0);
        if (mix != 1.0) {
            la[2] = (float)(r0 + kwrap(la[2] - r0) * mix);
            lc[2] = (float)(rc0 + kwrap(lc[2] - rc0) * mix);
        }
        touch_bone(in, a);
        touch_bone(in, ch);
    }
}

static void apply_transform(UgoInstance *in, const KCons *c, const float *mx)
{
    uint32_t i = (uint32_t)c->bone, k;
    const float *of = c->off, *tw, *bw;
    double T[6], w[6];
    if (mx[0] == 0.0f && mx[1] == 0.0f && mx[2] == 0.0f && mx[3] == 0.0f && mx[4] == 0.0f && mx[5] == 0.0f) return; /* no effect */
    tw = bone_world(in, c->target); bw = bone_world(in, (int32_t)i);
    for (k = 0; k < 6; k++) { T[k] = tw[k]; w[k] = bw[k]; }
    if (c->flags & TC_LOCAL) {
        float t[7], *l = &in->local[7 * i];
        for (k = 0; k < 7; k++) t[k] = in->local[7 * (uint32_t)c->target + k];
        if (c->flags & TC_RELATIVE) {
            l[2] += (t[2] + of[0]) * mx[0];
            l[0] += (t[0] + of[1]) * mx[1]; l[1] += (t[1] + of[2]) * mx[2];
            l[3] *= (t[3] - 1.0f + of[3]) * mx[3] + 1.0f; l[4] *= (t[4] - 1.0f + of[4]) * mx[4] + 1.0f;
            l[6] += (t[6] + of[5]) * mx[5];
        } else {
            l[2] += (float)kwrap(t[2] - l[2] + of[0]) * mx[0];
            l[0] += (t[0] - l[0] + of[1]) * mx[1]; l[1] += (t[1] - l[1] + of[2]) * mx[2];
            if (l[3] != 0.0f) l[3] += (t[3] - l[3] + of[3]) * mx[3];
            if (l[4] != 0.0f) l[4] += (t[4] - l[4] + of[4]) * mx[4];
            l[6] += (float)kwrap(t[6] - l[6] + of[5]) * mx[5];
        }
        touch_bone(in, i);
        return;
    }
    {
        int rel = (c->flags & TC_RELATIVE) != 0;
        double refl = (T[0] * T[3] - T[2] * T[1]) < 0.0 ? -1.0 : 1.0, s, ts, r;
        if (mx[0] != 0.0f) {
            float sn, cs;
            double x0 = w[0], x1 = w[1], y0 = w[2], y1 = w[3];
            r = rel ? katan2(T[1], T[0]) + of[0] * refl : katan2(T[1], T[0]) - katan2(w[1], w[0]) + of[0] * refl;
            ksincos((float)(kwrap(r) * mx[0]), &sn, &cs);
            w[0] = cs * x0 - sn * x1; w[1] = sn * x0 + cs * x1;
            w[2] = cs * y0 - sn * y1; w[3] = sn * y0 + cs * y1;
        }
        if (mx[1] != 0.0f || mx[2] != 0.0f) {
            double px = T[0] * of[1] + T[2] * of[2] + T[4], py = T[1] * of[1] + T[3] * of[2] + T[5];
            if (rel) { w[4] += (px - T[4]) * mx[1]; w[5] += (py - T[5]) * mx[2]; }
            else { w[4] += (px - w[4]) * mx[1]; w[5] += (py - w[5]) * mx[2]; }
        }
        if (mx[3] != 0.0f) {
            s = ksqrt(w[0] * w[0] + w[1] * w[1]);
            if (s > 1e-5) {
                double f;
                ts = ksqrt(T[0] * T[0] + T[1] * T[1]);
                f = rel ? (ts - 1.0 + of[3]) * mx[3] + 1.0 : (s + (ts - s + of[3]) * mx[3]) / s;
                w[0] *= f; w[1] *= f;
            }
        }
        if (mx[4] != 0.0f) {
            s = ksqrt(w[2] * w[2] + w[3] * w[3]);
            if (s > 1e-5) {
                double f;
                ts = ksqrt(T[2] * T[2] + T[3] * T[3]);
                f = rel ? (ts - 1.0 + of[4]) * mx[4] + 1.0 : (s + (ts - s + of[4]) * mx[4]) / s;
                w[2] *= f; w[3] *= f;
            }
        }
        if (mx[5] != 0.0f) {
            double bx = katan2(w[1], w[0]), by = katan2(w[3], w[2]);
            double tsh = kwrap(katan2(T[3], T[2]) - katan2(T[1], T[0]));
            float sn, cs;
            r = rel ? tsh - K_HALF_PI : kwrap(tsh - (by - bx));
            r = by + (kwrap(r) + of[5]) * mx[5];
            s = ksqrt(w[2] * w[2] + w[3] * w[3]);
            ksincos((float)r, &sn, &cs);
            w[2] = cs * s; w[3] = sn * s;
        }
        set_world(in, i, w);
    }
}

/* Swaying bone chains (after the pose and constraints, before warp grids).
 * Verlet points at the joints, fixed 1/120 s steps; the root joint follows
 * the animated pose, the others are pulled back to it by a spring, slowed,
 * pulled by gravity, kept at the animated bone lengths, and left behind when
 * the character moves on screen. Then each bone turns toward its next point. */
/* The wind's gusts at time t (seconds): a sum of slow waves, -1..1, the same on every machine. */
static float wind_noise(double t)
{
    float s1, c1, s2, c2, s3, c3;
    ksincos((float)(1.3 * t - 6.28318530717958647692 * kfloor(1.3 * t / 6.28318530717958647692)), &s1, &c1);
    ksincos((float)(3.1 * t + 1.0 - 6.28318530717958647692 * kfloor((3.1 * t + 1.0) / 6.28318530717958647692)), &s2, &c2);
    ksincos((float)(7.7 * t + 2.0 - 6.28318530717958647692 * kfloor((7.7 * t + 2.0) / 6.28318530717958647692)), &s3, &c3);
    (void)c1; (void)c2; (void)c3;
    return 0.5f * s1 + 0.3f * s2 + 0.2f * s3;
}

void ugo_get_wind(const UgoInstance *in, float *wind) { if (wind) { wind[0] = in->wind[0]; wind[1] = in->wind[1]; wind[2] = in->wind[2]; } }
double ugo_wind_time(const UgoInstance *in) { return in->windTime; }
void ugo_set_wind_time(UgoInstance *in, double t) { if (t == t && t >= 0.0 && t < 1e15) in->windTime = t; }

void ugo_set_wind(UgoInstance *in, float x, float y, float gust)
{
    if (!is_finite(x) || !is_finite(y) || !is_finite(gust)) return;
    in->wind[0] = x; in->wind[1] = y; in->wind[2] = gust < 0.0f ? 0.0f : gust;
}

static void step_chains(UgoInstance *in, float dt)
{
    const UgoModel *m = in->m;
    const float *M = in->frame;
    float *move = in->chain + 4 * (m->n[KC_CHAINBONES] + m->n[KC_CHAINS]) + m->n[KC_CHAINS];
    double dmx = 0.0, dmy = 0.0, det;
    uint32_t steps = 0, s, c, k, j;
    float h;
    if (dt > 0.0f) {
        if (dt > 0.25f) dt = 0.25f;
        steps = (uint32_t)(dt * UGO_PHYSICS_HZ);
        if ((float)steps < dt * UGO_PHYSICS_HZ) steps++;
        if (steps > 32) steps = 32;
    }
    h = steps ? dt / (float)steps : 0.0f;
    /* the character's move on screen since the last update, in model space */
    det = (double)M[0] * M[3] - (double)M[2] * M[1];
    if (move[2] != 0.0f && (det > 1e-12 || det < -1e-12)) {
        double sx = (double)M[4] - move[0], sy = (double)M[5] - move[1];
        dmx = (M[3] * sx - M[2] * sy) / det;
        dmy = (-M[1] * sx + M[0] * sy) / det;
    }
    move[0] = M[4]; move[1] = M[5]; move[2] = 1.0f;
    for (c = 0; c < m->n[KC_CHAINS]; c++) {
        const KChain *ch = &m->chains[c];
        const uint32_t *cb = m->chainBones + ch->firstBone;
        uint32_t n = ch->boneCount + 1; /* joints */
        float *X = in->chain + 4 * (ch->firstBone + c), *started = in->chain + 4 * (m->n[KC_CHAINBONES] + m->n[KC_CHAINS]) + c;
        float T[2 * (UGO_CHAIN_MAX + 1)], len[UGO_CHAIN_MAX + 1];
        if (n > UGO_CHAIN_MAX + 1) n = UGO_CHAIN_MAX + 1;
        for (k = 0; k < n; k++) { /* the animated joints: bone roots, then the last bone's tip */
            const float *W = bone_world(in, (int32_t)cb[k < n - 1 ? k : n - 2]);
            if (k < n - 1) { T[2 * k] = W[4]; T[2 * k + 1] = W[5]; }
            else {
                float L = m->bones[cb[n - 2]].length;
                T[2 * k] = W[4] + W[0] * L; T[2 * k + 1] = W[5] + W[1] * L;
            }
            if (k > 0) {
                double ex = (double)T[2 * k] - T[2 * k - 2], ey = (double)T[2 * k + 1] - T[2 * k - 1];
                len[k] = (float)ksqrt(ex * ex + ey * ey);
            }
        }
        if (*started == 0.0f) {
            for (k = 0; k < n; k++) { X[4 * k] = X[4 * k + 2] = T[2 * k]; X[4 * k + 1] = X[4 * k + 3] = T[2 * k + 1]; }
            *started = 1.0f;
        } else for (k = 1; k < n; k++) { /* left behind by the character's move */
            float ox = (float)(dmx * ch->inertia), oy = (float)(dmy * ch->inertia);
            X[4 * k] -= ox; X[4 * k + 1] -= oy; X[4 * k + 2] -= ox; X[4 * k + 3] -= oy;
        }
        for (s = 0; s < steps; s++) {
            float keep = 1.0f - ch->damping * h, gust = 1.0f;
            if (in->wind[2] != 0.0f) gust = 1.0f + in->wind[2] * wind_noise(in->windTime + (double)h * s);
            if (keep < 0.0f) keep = 0.0f;
            X[0] = X[2] = T[0]; X[1] = X[3] = T[1];
            for (k = 1; k < n; k++) {
                float *P = X + 4 * k, x = P[0], y = P[1];
                float ax = ch->gx + in->wind[0] * gust + ch->stiffness * (T[2 * k] - x), ay = ch->gy + in->wind[1] * gust + ch->stiffness * (T[2 * k + 1] - y);
                P[0] = x + (x - P[2]) * keep + ax * h * h;
                P[1] = y + (y - P[3]) * keep + ay * h * h;
                P[2] = x; P[3] = y;
            }
            for (j = 0; j < 2; j++) /* keep the bone lengths, root to tip */
                for (k = 1; k < n; k++) {
                    float *A = X + 4 * (k - 1), *P = X + 4 * k;
                    double ex = (double)P[0] - A[0], ey = (double)P[1] - A[1], d = ksqrt(ex * ex + ey * ey);
                    if (d > 1e-6) { P[0] = (float)(A[0] + ex * len[k] / d); P[1] = (float)(A[1] + ey * len[k] / d); }
                }
        }
        for (k = 1; k < n; k++) /* a blow-up (e.g. huge stiffness and dt) starts over from the pose */
            if (!is_finite(X[4 * k]) || !is_finite(X[4 * k + 1]) || !is_finite(X[4 * k + 2]) || !is_finite(X[4 * k + 3])) { *started = 0.0f; break; }
        if (*started == 0.0f || ch->mix == 0.0f) continue;
        for (k = 0; k + 1 < n; k++) { /* turn each bone toward its next point */
            uint32_t b = cb[k];
            float *l = &in->local[7 * b];
            if (k + 1 == n - 1 && m->bones[b].length == 0.0f) break; /* no tip to aim with */
            l[2] = (float)(l[2] + kwrap(aim_rotation(in, b, X[4 * (k + 1)], X[4 * (k + 1) + 1], 0) - l[2]) * ch->mix);
            touch_bone(in, b);
        }
    }
    in->windTime += (double)h * steps; /* (the gusts go on in time whether or not there is wind) */
}

void ugo_update(UgoInstance *in, float dt)
{
    const UgoModel *m = in->m;
    float *fr = in->frame;
    uint32_t i, j, nb, keep;

    if (!is_finite(dt)) dt = 0.0f;
    step_physics(in, dt);
    for (i = 0; i < m->n[KC_PARAMS]; i++)
        in->params[i] = clampf(in->params[i], m->params[i].min, m->params[i].max);

    /* region weights (product of tents over the region's axes) */
    for (i = 0; i < m->n[KC_REGIONS]; i++) {
        const KRegion *r = &m->regions[i];
        float w = 1.0f;
        for (j = 0; j < r->axisCount && w != 0.0f; j++)
            w *= tent(in->params[r->axis[j].param], r->axis[j].start, r->axis[j].peak, r->axis[j].end);
        in->regionW[i] = w;
    }
    for (i = 0; i < m->n[KC_MORPHS]; i++)
        fr[m->morphOff + i] = (m->morphs[i] == UGO_NO_REGION ? 0.0f : in->regionW[m->morphs[i]]) + in->animMorph[i];

    /* bones: rest pose + animation offsets + weighted driver deltas */
    for (i = 0; i < m->n[KC_BONES]; i++) {
        const KBone *b = &m->bones[i];
        const float *a = &in->animBone[7 * i];
        float *l = &in->local[7 * i];
        l[0] = b->x + a[1]; l[1] = b->y + a[2]; l[2] = b->rot + a[0];
        l[3] = b->sx + a[3]; l[4] = b->sy + a[4]; l[5] = b->shx + a[5]; l[6] = b->shy + a[6];
    }
    for (i = 0; i < m->n[KC_BDRIVERS]; i++) {
        const KBoneDriver *d = &m->bdrv[i];
        float w = in->regionW[d->region];
        float *l = &in->local[7 * d->bone];
        if (w == 0.0f) continue;
        l[2] += w * d->drot; l[0] += w * d->dx; l[1] += w * d->dy; l[3] += w * d->dsx; l[4] += w * d->dsy;
    }
    /* A bone whose local values have the same bits as when its world was last computed,
     * under a parent that is kept too, keeps last update's world (see compose_bone):
     * stamp i + 1, above its parent's and below every stamp given from here on. The
     * others are stale: stamp 0, local changed at 1. */
    nb = m->n[KC_BONES];
    keep = in->prevValid;
    for (i = 0; i < nb; i++) {
        int32_t p = m->bones[i].parent;
        uint32_t same = keep && (p < 0 || in->stamp[3 * (uint32_t)p] != 0) && !local_differs(&in->local[7 * i], &in->memo[14 * i]);
        in->stamp[3 * i] = same ? i + 1 : 0;
        in->stamp[3 * i + 1] = same ? 0 : 1;
    }
    /* constraints compute the worlds they read, the rest follows once (parents come first) */
    in->gen = nb + 1;
    in->lastTouch = 0;
    for (i = 0; i < m->n[KC_CONS]; i++) {
        if (m->cons[i].type == CONS_IK) apply_ik(in, &m->cons[i], &in->animCons[8 * i]);
        else apply_transform(in, &m->cons[i], &in->animCons[8 * i]);
    }
    if (m->n[KC_CHAINS]) step_chains(in, dt);
    for (i = 0; i < m->n[KC_BONES]; i++) {
        if (bone_stale(in, i)) compose_bone(in, i);
        if (!in->memo[14 * i + 13]) continue; /* the world did not change: nor does the skin matrix */
        in->memo[14 * i + 13] = 0;
        mat_mul(&fr[m->skinOff + 8 * i], &in->world[6 * i], m->bones[i].bindInv);
        fr[m->skinOff + 8 * i + 6] = 0.0f;
        fr[m->skinOff + 8 * i + 7] = 0.0f;
    }
    /* worlds can be kept next time; not those of bones in warp grids and below them: rewritten below, and
     * their memo made to differ from any local values there */
    in->prevValid = 1;

    /* part opacity */
    for (i = 0; i < m->n[KC_PARTS]; i++) /* keyed opacity replaces the part's own */
        fr[m->opOff + i] = in->animOpacity[i] >= 0.0f ? in->animOpacity[i] : m->parts[i].opacity;
    for (i = 0; i < m->n[KC_ODRIVERS]; i++) {
        const KOpDriver *d = &m->odrv[i];
        fr[m->opOff + d->part] += in->regionW[d->region] * d->dop;
    }
    for (i = 0; i < m->n[KC_PARTS]; i++) fr[m->opOff + i] = clampf(fr[m->opOff + i], 0.0f, 1.0f);
    if (m->n[KC_ORDERS]) update_draw_order(in);

    /* colour slots: a, b (+ driver deltas) -> X, Y with rgb = C * X + alpha * Y */
    for (i = 0; i < m->n[KC_COLORS]; i++) {
        float *c = &fr[m->colorOff + 8 * i];
        for (j = 0; j < 3; j++) { c[j] = in->animColor[8 * i + j]; c[4 + j] = in->animColor[8 * i + 3 + j]; }
    }
    for (i = 0; i < m->n[KC_CDRIVERS]; i++) {
        const KColorDriver *d = &m->cdrv[i];
        float w = in->regionW[d->region], *c = &fr[m->colorOff + 8 * d->slot];
        if (w == 0.0f) continue;
        for (j = 0; j < 3; j++) { c[j] += w * d->da[j]; c[4 + j] += w * d->db[j]; }
    }
    for (i = 0; i < m->n[KC_COLORS]; i++) {
        float *c = &fr[m->colorOff + 8 * i];
        for (j = 0; j < 3; j++) {
            float a = clampf(c[j], 0.0f, 1.0f), b = clampf(c[4 + j], 0.0f, 1.0f);
            c[j] = m->colors[i].mode == COLOR_TINT_DARK ? a - b : a * (1.0f - b);
            c[4 + j] = b;
        }
        c[3] = c[7] = 0.0f;
    }

    /* warp grids: rest points + driver deltas, placed by the parent warp or the bone, then the outer ring.
     * A grid's points depend only on its drivers' region weights and on its parent's points or its bone's
     * skin matrix: when those have the same bits as last time (and its parent was not placed again), its
     * points in the frame block are what placing them again would give, and are kept. */
    {
        uint32_t off = m->warpOff, nw = m->n[KC_WARPS], *wm = in->warpMemo, *dm = in->warpMemo + 6 * nw;
        for (i = 0; i < nw; i++) in->warpNew[i] = (uint8_t)!keep;
        for (i = 0; i < m->n[KC_WDRIVERS]; i++) {
            union { float f; uint32_t u; } x;
            x.f = in->regionW[m->wdrv[i].region];
            if (x.u != dm[i]) { dm[i] = x.u; in->warpNew[m->wdrv[i].warp] = 1; }
        }
        for (i = 0; i < nw; i++) {
            const KWarp *w = &m->warps[i];
            if (w->parent != UGO_NONE) { if (in->warpNew[w->parent]) in->warpNew[i] = 1; } /* (parents come first) */
            else {
                const float *S = &fr[m->skinOff + 8 * w->bone];
                uint32_t k;
                for (k = 0; k < 6; k++) {
                    union { float f; uint32_t u; } x;
                    x.f = S[k];
                    if (x.u != wm[6 * i + k]) { wm[6 * i + k] = x.u; in->warpNew[i] = 1; }
                }
            }
        }
        for (i = 0; i < nw; i++) {
            const KWarp *w = &m->warps[i];
            uint32_t W = w->cols + 3, n = (w->cols + 1) * (w->rows + 1), k;
            float *E = fr + off;
            if (!in->warpNew[i]) { off += warp_frame_floats(w); continue; }
            for (k = 0; k < n; k++) {
                float *P = E + 2 * ((k / (w->cols + 1) + 1) * W + k % (w->cols + 1) + 1);
                P[0] = m->wpoints[2 * (w->firstPoint + k)]; P[1] = m->wpoints[2 * (w->firstPoint + k) + 1];
            }
            off += warp_frame_floats(w);
        }
        for (i = 0; i < m->n[KC_WDRIVERS]; i++) {
            const KWarpDriver *d = &m->wdrv[i];
            const KWarp *w = &m->warps[d->warp];
            float rw = in->regionW[d->region], *E;
            uint32_t W = w->cols + 3, n = (w->cols + 1) * (w->rows + 1), k, o = m->warpOff;
            if (rw == 0.0f || !in->warpNew[d->warp]) continue;
            for (k = 0; k < d->warp; k++) o += warp_frame_floats(&m->warps[k]);
            E = fr + o;
            for (k = 0; k < n; k++) {
                float *P = E + 2 * ((k / (w->cols + 1) + 1) * W + k % (w->cols + 1) + 1);
                P[0] += rw * m->wdeltas[2 * (d->firstDelta + k)]; P[1] += rw * m->wdeltas[2 * (d->firstDelta + k) + 1];
            }
        }
        off = m->warpOff;
        for (i = 0; i < m->n[KC_WARPS]; i++) {
            const KWarp *w = &m->warps[i];
            uint32_t W = w->cols + 3, H = w->rows + 3, a, b, k;
            float *E = fr + off;
            const float *PE = 0;
            if (!in->warpNew[i]) { off += warp_frame_floats(w); continue; }
            if (w->parent != UGO_NONE) { /* the parent's net is final already (parents come first) */
                uint32_t o = m->warpOff;
                for (k = 0; k < w->parent; k++) o += warp_frame_floats(&m->warps[k]);
                PE = fr + o;
            }
            for (b = 1; b < H - 1; b++)
                for (a = 1; a < W - 1; a++) {
                    float *P = E + 2 * (b * W + a), q[2];
                    if (PE) {
                        warp_eval(PE, m->warps[w->parent].cols, m->warps[w->parent].rows, P[0], P[1], q);
                    } else {
                        const float *S = &fr[m->skinOff + 8 * w->bone];
                        q[0] = S[0] * P[0] + S[2] * P[1] + S[4];
                        q[1] = S[1] * P[0] + S[3] * P[1] + S[5];
                    }
                    P[0] = q[0]; P[1] = q[1];
                }
            for (b = 1; b < H - 1; b++) { /* outer ring: P[-1] = 2 P[0] - P[1] */
                float *R = E + 2 * b * W;
                R[0] = 2.0f * R[2] - R[4]; R[1] = 2.0f * R[3] - R[5];
                R[2 * (W - 1)] = 2.0f * R[2 * (W - 2)] - R[2 * (W - 3)]; R[2 * (W - 1) + 1] = 2.0f * R[2 * (W - 2) + 1] - R[2 * (W - 3) + 1];
            }
            for (a = 0; a < W; a++) {
                float *T = E + 2 * a, *B = E + 2 * ((H - 1) * W + a);
                T[0] = 2.0f * T[2 * W] - T[4 * W]; T[1] = 2.0f * T[2 * W + 1] - T[4 * W + 1];
                B[0] = 2.0f * B[-2 * (int32_t)W] - B[-4 * (int32_t)W]; B[1] = 2.0f * B[-2 * (int32_t)W + 1] - B[-4 * (int32_t)W + 1];
            }
            off += warp_frame_floats(w);
        }
    }

    /* bones in warp grids: the root sits on the grid's surface and turns with it, then its descendants follow */
    if (m->n[KC_BWARPS]) {
        uint32_t *inside = in->stamp + 2, k; /* stamp[3j+2]: scratch, 1 for bones below a bone in a grid */
        for (j = 0; j < m->n[KC_BONES]; j++) inside[3 * j] = 0;
        for (k = 0; k < m->n[KC_BWARPS]; k++) {
            const KBoneWarp *q = &m->bwarps[k];
            float *W = &in->world[6 * q->bone], c[2], p0[2], p1[2], sn, cs, L[4];
            uint32_t info[3];
            ugo_warp_info(m, q->warp, info);
            { /* (its world is its local: no parent) */
                float dx = W[4] - q->ox, dy = W[5] - q->oy;
                c[0] = dx * q->a + dy * q->c; c[1] = dx * q->b + dy * q->d;
            }
            warp_eval(fr + info[2], info[0], info[1], c[0], c[1], p0);
            warp_eval(fr + info[2], info[0], info[1], c[0] + 0.01f, c[1], p1); /* the grid's x direction there */
            { /* turned back by the grid's direction at rest (0.8: a grid may be turned) */
                double ex = (double)p1[0] - p0[0], ey = (double)p1[1] - p0[1];
                ksincos((float)katan2(ey * q->rc - ex * q->rs, ex * q->rc + ey * q->rs), &sn, &cs);
            }
            L[0] = W[0]; L[1] = W[1]; L[2] = W[2]; L[3] = W[3];
            W[0] = cs * L[0] - sn * L[1]; W[1] = sn * L[0] + cs * L[1];
            W[2] = cs * L[2] - sn * L[3]; W[3] = sn * L[2] + cs * L[3];
            W[4] = p0[0]; W[5] = p0[1];
            inside[3 * q->bone] = 1;
        }
        for (j = 0; j < m->n[KC_BONES]; j++) {
            int32_t p = m->bones[j].parent;
            if (!inside[3 * j] && p >= 0 && inside[3 * p]) {
                inside[3 * j] = 1;
                compose(&in->world[6 * p], &in->local[7 * j], m->bones[j].inherit, &in->world[6 * j], &in->sincos[6 * j]);
            }
            if (inside[3 * j]) {
                mat_mul(&fr[m->skinOff + 8 * j], &in->world[6 * j], m->bones[j].bindInv);
                in->memo[14 * j] = 0xffffffffu; /* (a NaN no local value has): computed afresh next time */
            }
        }
    }
}

void ugo_bone_pose(const UgoInstance *in, uint32_t i, float *pose)
{
    const float *l;
    if (i >= in->m->n[KC_BONES]) return;
    l = &in->local[7 * i];
    pose[0] = l[0]; pose[1] = l[1]; pose[2] = l[2]; pose[3] = l[3]; pose[4] = l[4];
}

void ugo_bone_world(const UgoInstance *in, uint32_t i, float *world)
{
    uint32_t k;
    if (i >= in->m->n[KC_BONES]) return;
    for (k = 0; k < 6; k++) world[k] = in->world[6 * i + k];
}

/* One vertex deformed (morphs, then its warp grid or its bones), written to out[2]. */
static void place_vertex(const UgoModel *m, const float *fr, uint32_t v, const KWarp *warp, uint32_t warpAt, float *out)
{
    float px = m->pos[2 * v], py = m->pos[2 * v + 1], ox = 0.0f, oy = 0.0f;
    uint32_t e, j;
    for (e = m->csr[v]; e < m->csr[v + 1]; e++) {
        float w = fr[m->morphOff + m->entries[e].morph];
        px += w * m->entries[e].dx;
        py += w * m->entries[e].dy;
    }
    if (warp) { /* vertices in a warp grid: the grid places them, bones don't */
        warp_eval(fr + warpAt, warp->cols, warp->rows, px, py, out);
        return;
    }
    for (j = 0; j < 4; j++) {
        float w = m->weights[4 * v + j];
        const float *S;
        if (w == 0.0f) continue;
        S = &fr[m->skinOff + 8 * m->joints[4 * v + j]];
        ox += w * (S[0] * px + S[2] * py + S[4]);
        oy += w * (S[1] * px + S[3] * py + S[5]);
    }
    for (e = m->xstart[v]; e < m->xstart[v + 1]; e++) { /* influences beyond four */
        float w = m->xweights[e].weight;
        const float *S = &fr[m->skinOff + 8 * m->xweights[e].bone];
        ox += w * (S[0] * px + S[2] * py + S[4]);
        oy += w * (S[1] * px + S[3] * py + S[5]);
    }
    out[0] = ox;
    out[1] = oy;
}

/* The warp grid of part p (or 0) and where its net starts in the frame block. */
static const KWarp *part_warp(const UgoModel *m, uint32_t p, uint32_t *warpAt)
{
    uint32_t pw = m->parts[p].warp, k;
    if (pw == UGO_NONE) return 0;
    for (*warpAt = m->warpOff, k = 0; k < pw; k++) *warpAt += warp_frame_floats(&m->warps[k]);
    return &m->warps[pw];
}

/* Vertices from..to-1 deformed into out (indexed by vertex, like the whole). */
static void deform_range(const UgoInstance *in, float *out, uint32_t from, uint32_t to)
{
    const UgoModel *m = in->m;
    uint32_t v, lastPart = UGO_NONE, warpAt = 0;
    const KWarp *warp = 0;
    for (v = from; v < to; v++) {
        if (m->vparts[v] != lastPart) { lastPart = m->vparts[v]; warp = part_warp(m, lastPart, &warpAt); }
        place_vertex(m, in->frame, v, warp, warpAt, out + 2 * v);
    }
}

/* Vertex v's place: from deformed positions if given, else worked out now (the same numbers). */
static void vertex_at(const UgoInstance *in, const float *deformed, uint32_t v, float *out)
{
    uint32_t warpAt = 0;
    const KWarp *warp;
    if (deformed) { out[0] = deformed[2 * v]; out[1] = deformed[2 * v + 1]; return; }
    warp = part_warp(in->m, in->m->vparts[v], &warpAt);
    place_vertex(in->m, in->frame, v, warp, warpAt, out);
}

void ugo_deform_cpu(const UgoInstance *in, float *out) { deform_range(in, out, 0, in->m->n[KC_VERTS]); }

void ugo_deform_part_cpu(const UgoInstance *in, uint32_t part, float *out)
{
    const KPart *q;
    if (part >= in->m->n[KC_PARTS] || !out) return;
    q = &in->m->parts[part];
    deform_range(in, out, q->firstVert, q->firstVert + q->vertCount);
}

/* Is (x, y) on one of the part's triangles (deformed positions)? Edges count as inside. */
static int part_covers(const UgoInstance *in, uint32_t part, const float *deformed, float x, float y)
{
    const UgoModel *m = in->m;
    const KPart *q = &m->parts[part];
    uint32_t t;
    for (t = q->firstIndex; t < q->firstIndex + q->indexCount; t += 3) { /* (a multiple of 3: checked at load) */
        float a[2], b[2], c[2];
        vertex_at(in, deformed, m->indices[t], a);
        vertex_at(in, deformed, m->indices[t + 1], b);
        vertex_at(in, deformed, m->indices[t + 2], c);
        {
        double d1 = ((double)b[0] - a[0]) * ((double)y - a[1]) - ((double)b[1] - a[1]) * ((double)x - a[0]);
        double d2 = ((double)c[0] - b[0]) * ((double)y - b[1]) - ((double)c[1] - b[1]) * ((double)x - b[0]);
        double d3 = ((double)a[0] - c[0]) * ((double)y - c[1]) - ((double)a[1] - c[1]) * ((double)x - c[0]);
        if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) {
            if (d1 == 0 && d2 == 0 && d3 == 0) continue; /* a triangle of no area */
            return 1;
        }
        }
    }
    return 0;
}

int ugo_pick_part(const UgoInstance *in, const float *deformed, float x, float y, float min_opacity)
{
    const UgoModel *m = in->m;
    uint32_t k, n = m->n[KC_PARTS];
    if (!is_finite(x) || !is_finite(y)) return -1;
    for (k = n; k-- > 0;) { /* from the front */
        uint32_t p = in->drawList[k];
        const KPart *q = &m->parts[p];
        if ((q->flags & PART_HIDDEN) || !(in->frame[m->opOff + p] > min_opacity)) continue;
        if (!part_covers(in, p, deformed, x, y)) continue;
        if (q->mask != UGO_NONE) {
            const KMask *mk = &m->masks[q->mask];
            uint32_t j, inside = 0;
            for (j = 0; j < mk->refCount && !inside; j++) inside = (uint32_t)part_covers(in, m->maskrefs[mk->firstRef + j], deformed, x, y);
            if (!inside == !(q->flags & PART_MASK_INVERT)) continue; /* cut away there */
        }
        return (int)p;
    }
    return -1;
}

int ugo_pick_area(const UgoInstance *in, const float *deformed, float x, float y, const uint8_t *only)
{
    const UgoModel *m = in->m;
    uint32_t k;
    if (!only || !is_finite(x) || !is_finite(y)) return -1;
    for (k = m->n[KC_PARTS]; k-- > 0;) { /* from the front; drawn or not, any opacity */
        uint32_t p = in->drawList[k];
        if (only[p] && part_covers(in, p, deformed, x, y)) return (int)p;
    }
    return -1;
}

int ugo_bounds(const UgoInstance *in, const float *deformed, int part, float *box)
{
    const UgoModel *m = in->m;
    uint32_t p, v, from = 0, to = m->n[KC_PARTS], seen = 0;
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    if (!box) return 0;
    if (part >= 0) { if ((uint32_t)part >= to) return 0; from = (uint32_t)part; to = from + 1; }
    for (p = from; p < to; p++) {
        const KPart *q = &m->parts[p];
        if (part < 0 && ((q->flags & PART_HIDDEN) || !(in->frame[m->opOff + p] > 0.0f))) continue; /* the whole: what is drawn */
        for (v = q->firstVert; v < q->firstVert + q->vertCount; v++) {
            float xy[2], x, y;
            vertex_at(in, deformed, v, xy);
            x = xy[0]; y = xy[1];
            if (!seen++) { x0 = x1 = x; y0 = y1 = y; continue; }
            x0 = x < x0 ? x : x0; x1 = x > x1 ? x : x1;
            y0 = y < y0 ? y : y0; y1 = y > y1 ? y : y1;
        }
    }
    box[0] = x0; box[1] = y0; box[2] = x1; box[3] = y1;
    return seen > 0;
}

/* Each bone's box of the rest vertices it moves (x0, y0, x1, y1) and how far a morph at weight 1
 * can move one of them (the sum of |dx| + |dy| of its morphs); empty boxes have x0 > x1. Made once
 * per instance. Vertices in warp grids are left to the grids' nets. */
static void make_bone_boxes(UgoInstance *in)
{
    const UgoModel *m = in->m;
    uint32_t v, j, e, b;
    float *B = in->boneBox;
    for (b = 0; b < m->n[KC_BONES]; b++) { B[5 * b] = B[5 * b + 1] = 3.0e38f; B[5 * b + 2] = B[5 * b + 3] = -3.0e38f; B[5 * b + 4] = 0.0f; }
    for (v = 0; v < m->n[KC_VERTS]; v++) {
        float r = 0.0f, x = m->pos[2 * v], y = m->pos[2 * v + 1];
        uint32_t nx = m->xstart[v + 1] - m->xstart[v];
        if (m->parts[m->vparts[v]].warp != UGO_NONE) continue;
        for (e = m->csr[v]; e < m->csr[v + 1]; e++)
            r += (m->entries[e].dx < 0 ? -m->entries[e].dx : m->entries[e].dx) + (m->entries[e].dy < 0 ? -m->entries[e].dy : m->entries[e].dy);
        for (j = 0; j < 4 + nx; j++) {
            float *q;
            if (j < 4) { if (m->weights[4 * v + j] == 0.0f) continue; b = m->joints[4 * v + j]; }
            else b = m->xweights[m->xstart[v] + j - 4].bone;
            q = B + 5 * b;
            q[0] = x < q[0] ? x : q[0]; q[1] = y < q[1] ? y : q[1];
            q[2] = x > q[2] ? x : q[2]; q[3] = y > q[3] ? y : q[3];
            q[4] = r > q[4] ? r : q[4];
        }
    }
    in->boneBoxReady = 1;
}

int ugo_bounds_estimate(UgoInstance *in, float *box)
{
    const UgoModel *m = in->m;
    const float *fr = in->frame;
    uint32_t b, i, k, at, seen = 0;
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0, most = 0.0f;
    if (!box) return 0;
    if (!in->boneBoxReady) make_bone_boxes(in);
    for (i = 0; i < m->n[KC_MORPHS]; i++) { float w = fr[m->morphOff + i]; w = w < 0 ? -w : w; most = w > most ? w : most; }
#define UGO_SEE(px, py) do { float sx_ = (px), sy_ = (py); \
        if (!seen++) { x0 = x1 = sx_; y0 = y1 = sy_; } \
        else { x0 = sx_ < x0 ? sx_ : x0; x1 = sx_ > x1 ? sx_ : x1; y0 = sy_ < y0 ? sy_ : y0; y1 = sy_ > y1 ? sy_ : y1; } } while (0)
    /* skinning blends the bones' moves with weights summing to 1: each vertex lies in the hull of its
     * bones' moved boxes, so the moved corners of every bone's box (widened by its morph reach) hold it */
    for (b = 0; b < m->n[KC_BONES]; b++) {
        const float *q = in->boneBox + 5 * b, *S = fr + m->skinOff + 8 * b;
        float r = q[4] * most;
        if (q[0] > q[2]) continue;
        for (k = 0; k < 4; k++) {
            float x = (k & 1) ? q[2] + r : q[0] - r, y = (k & 2) ? q[3] + r : q[1] - r;
            UGO_SEE(S[0] * x + S[2] * y + S[4], S[1] * x + S[3] * y + S[5]);
        }
    }
    for (at = m->warpOff, i = 0; i < m->n[KC_WARPS]; at += warp_frame_floats(&m->warps[i]), i++) { /* a B-spline stays in its net's hull */
        uint32_t np = (m->warps[i].cols + 3) * (m->warps[i].rows + 3);
        for (k = 0; k < np; k++) UGO_SEE(fr[at + 2 * k], fr[at + 2 * k + 1]);
    }
#undef UGO_SEE
    box[0] = x0; box[1] = y0; box[2] = x1; box[3] = y1;
    return seen > 0;
}

void ugo_bone_world_placed(const UgoInstance *in, uint32_t bone, float *world)
{
    const float *P = in->frame, *W;
    if (bone >= in->m->n[KC_BONES] || !world) return;
    W = &in->world[6 * bone];
    world[0] = P[0] * W[0] + P[2] * W[1]; world[1] = P[1] * W[0] + P[3] * W[1];
    world[2] = P[0] * W[2] + P[2] * W[3]; world[3] = P[1] * W[2] + P[3] * W[3];
    world[4] = P[0] * W[4] + P[2] * W[5] + P[4]; world[5] = P[1] * W[4] + P[3] * W[5] + P[5];
}

int ugo_find_bone(const UgoModel *m, const char *name)
{
    uint32_t i;
    if (!name) return -1;
    for (i = 0; i < m->n[KC_BONES]; i++) if (str_eq(m->strings + m->bones[i].name, name)) return (int)i;
    return -1;
}

int ugo_find_part(const UgoModel *m, const char *name)
{
    uint32_t i;
    if (!name) return -1;
    for (i = 0; i < m->n[KC_PARTS]; i++) if (str_eq(m->strings + m->parts[i].name, name)) return (int)i;
    return -1;
}

void ugo_settle_physics(UgoInstance *in, float seconds)
{
    float t;
    if (!is_finite(seconds) || seconds <= 0.0f) return;
    if (seconds > 10.0f) seconds = 10.0f;
    for (t = 0.0f; t < seconds; t += 1.0f / 30.0f) ugo_update(in, 1.0f / 30.0f);
}
