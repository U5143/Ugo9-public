/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* GIF and APNG writers for ugo_export. */
#include "encoders.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "stb_image_write.h"

/* ---- CRC32 (PNG chunks) -------------------------------------------------- */

static uint32_t crc_table[256];
static int crc_ready;

static uint32_t crc32_update(uint32_t c, const uint8_t *p, size_t n)
{
    size_t i;
    if (!crc_ready) {
        uint32_t k, v;
        for (k = 0; k < 256; k++) {
            v = k;
            for (i = 0; i < 8; i++) v = (v & 1) ? 0xedb88320u ^ (v >> 1) : v >> 1;
            crc_table[k] = v;
        }
        crc_ready = 1;
    }
    for (i = 0; i < n; i++) c = crc_table[(c ^ p[i]) & 0xff] ^ (c >> 8);
    return c;
}

static void be32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }

static int write_chunk(FILE *f, const char *type, const uint8_t *a, size_t an, const uint8_t *b, size_t bn)
{
    uint8_t hdr[8], tail[4];
    uint32_t c;
    be32(hdr, (uint32_t)(an + bn));
    memcpy(hdr + 4, type, 4);
    c = crc32_update(0xffffffffu, (const uint8_t *)type, 4);
    if (an) c = crc32_update(c, a, an);
    if (bn) c = crc32_update(c, b, bn);
    be32(tail, c ^ 0xffffffffu);
    if (fwrite(hdr, 1, 8, f) != 8) return 0;
    if (an && fwrite(a, 1, an, f) != an) return 0;
    if (bn && fwrite(b, 1, bn, f) != bn) return 0;
    return fwrite(tail, 1, 4, f) == 4;
}

/* ---- APNG ------------------------------------------------------------------ */

typedef struct { uint8_t *data; size_t len, cap; } Buf;

static void buf_put(void *ctx, void *data, int size)
{
    Buf *b = (Buf *)ctx;
    if (size <= 0) return;
    if (b->len + (size_t)size > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 65536;
        uint8_t *p;
        while (cap < b->len + (size_t)size) cap *= 2;
        p = (uint8_t *)realloc(b->data, cap);
        if (!p) return;
        b->data = p;
        b->cap = cap;
    }
    memcpy(b->data + b->len, data, (size_t)size);
    b->len += (size_t)size;
}

/* 24 for 23.976, 30 for 29.97, 60 for 59.94 ... (k * 1000 / 1001), else 0 */
int ugo_ntsc_rate(double fps)
{
    int k = (int)(fps * 1.001 + 0.5);
    if (fps <= 0 || (double)(int)fps == fps) return 0;
    return k > 0 && fabs(fps - k * 1000.0 / 1001.0) < 1e-3 ? k : 0;
}

int ugo_apng_begin(UgoApng *a, FILE *f, uint32_t w, uint32_t h, uint32_t count, double fps)
{
    static const uint8_t sig[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
    uint8_t ihdr[13], actl[8];
    memset(a, 0, sizeof(*a));
    a->f = f; a->w = w; a->h = h; a->count = count;
    /* delay as a fraction: 1/fps, kept within 16 bits; the NTSC rates exactly (29.97: 1001/30000) */
    if (fps > 0 && fps <= 65535 && (double)(int)fps == fps) { a->delay_num = 1; a->delay_den = (uint16_t)fps; }
    else if (ugo_ntsc_rate(fps) && ugo_ntsc_rate(fps) * 1000 <= 65535) { a->delay_num = 1001; a->delay_den = (uint16_t)(ugo_ntsc_rate(fps) * 1000); }
    else { a->delay_num = (uint16_t)(1000.0 / (fps > 0 ? fps : 30) + 0.5); a->delay_den = 1000; }
    be32(ihdr, w); be32(ihdr + 4, h);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    be32(actl, count); be32(actl + 4, 0); /* loop forever */
    return fwrite(sig, 1, 8, f) == 8 && write_chunk(f, "IHDR", ihdr, 13, 0, 0) && write_chunk(f, "acTL", actl, 8, 0, 0);
}

int ugo_apng_frame(UgoApng *a, const uint8_t *rgba)
{
    Buf png = { 0, 0, 0 };
    uint8_t fctl[26], seq[4];
    size_t off = 8;
    int ok = 1;
    if (!stbi_write_png_to_func(buf_put, &png, (int)a->w, (int)a->h, 4, rgba, (int)a->w * 4) || !png.data) {
        free(png.data);
        return 0;
    }
    be32(fctl, a->seq++);
    be32(fctl + 4, a->w); be32(fctl + 8, a->h);
    be32(fctl + 12, 0); be32(fctl + 16, 0);
    fctl[20] = (uint8_t)(a->delay_num >> 8); fctl[21] = (uint8_t)a->delay_num;
    fctl[22] = (uint8_t)(a->delay_den >> 8); fctl[23] = (uint8_t)a->delay_den;
    fctl[24] = 0; /* dispose: none */
    fctl[25] = 0; /* blend: source (each frame is complete) */
    ok = write_chunk(a->f, "fcTL", fctl, 26, 0, 0);
    /* copy the IDAT chunks of the encoded PNG; later frames use fdAT */
    while (ok && off + 12 <= png.len) {
        uint32_t len = ((uint32_t)png.data[off] << 24) | ((uint32_t)png.data[off + 1] << 16) | ((uint32_t)png.data[off + 2] << 8) | png.data[off + 3];
        const uint8_t *type = png.data + off + 4, *data = png.data + off + 8;
        if (off + 12 + len > png.len) { ok = 0; break; }
        if (memcmp(type, "IDAT", 4) == 0) {
            if (a->written == 0) ok = write_chunk(a->f, "IDAT", data, len, 0, 0);
            else { be32(seq, a->seq++); ok = write_chunk(a->f, "fdAT", seq, 4, data, len); }
        }
        off += 12 + len;
    }
    free(png.data);
    a->written++;
    return ok;
}

int ugo_apng_end(UgoApng *a)
{
    return a->written == a->count && write_chunk(a->f, "IEND", 0, 0, 0, 0);
}

/* ---- GIF ------------------------------------------------------------------- */

typedef struct { int lo, hi; } Box; /* range in the sample array */

static uint32_t *g_samples; /* 0x00RRGGBB */
static int g_axis;

static int cmp_axis(const void *a, const void *b)
{
    int sa = 16 - 8 * g_axis;
    uint32_t ua = *(const uint32_t *)a, ub = *(const uint32_t *)b;
    int va = (int)((ua >> sa) & 0xff), vb = (int)((ub >> sa) & 0xff);
    /* equal on the axis: the whole value decides, so every C library sorts the same way
     * (qsort is not stable, and glibc and msvcrt order equal elements differently) */
    if (va != vb) return va - vb;
    return ua < ub ? -1 : ua > ub;
}

/* Median cut over sampled colours. Returns the number of palette entries. */
static int median_cut(uint32_t *s, int n, int want, uint8_t *pal)
{
    Box boxes[256];
    int nb = 1, i, k;
    boxes[0].lo = 0; boxes[0].hi = n;
    g_samples = s;
    while (nb < want) {
        int best = -1, best_range = 0, best_axis = 0;
        for (i = 0; i < nb; i++) {
            int mn[3] = { 255, 255, 255 }, mx[3] = { 0, 0, 0 };
            if (boxes[i].hi - boxes[i].lo < 2) continue;
            for (k = boxes[i].lo; k < boxes[i].hi; k++) {
                int c;
                for (c = 0; c < 3; c++) {
                    int v = (int)((s[k] >> (16 - 8 * c)) & 0xff);
                    if (v < mn[c]) mn[c] = v;
                    if (v > mx[c]) mx[c] = v;
                }
            }
            for (k = 0; k < 3; k++) {
                int r = mx[k] - mn[k];
                if (r > best_range) { best_range = r; best = i; best_axis = k; }
            }
        }
        if (best < 0 || best_range == 0) break;
        g_axis = best_axis;
        qsort(s + boxes[best].lo, (size_t)(boxes[best].hi - boxes[best].lo), sizeof(uint32_t), cmp_axis);
        {
            int mid = (boxes[best].lo + boxes[best].hi) / 2;
            boxes[nb].lo = mid; boxes[nb].hi = boxes[best].hi;
            boxes[best].hi = mid;
            nb++;
        }
    }
    for (i = 0; i < nb; i++) {
        double acc[3] = { 0, 0, 0 };
        int cnt = boxes[i].hi - boxes[i].lo;
        for (k = boxes[i].lo; k < boxes[i].hi; k++) {
            acc[0] += (s[k] >> 16) & 0xff; acc[1] += (s[k] >> 8) & 0xff; acc[2] += s[k] & 0xff;
        }
        for (k = 0; k < 3; k++) pal[3 * i + k] = (uint8_t)(cnt ? acc[k] / cnt + 0.5 : 0);
    }
    return nb;
}

typedef struct {
    FILE *f;
    uint8_t block[256];
    int block_len;
    uint32_t bits;
    int nbits;
} BitOut;

static void bit_flush_block(BitOut *o)
{
    if (o->block_len) {
        fputc(o->block_len, o->f);
        fwrite(o->block, 1, (size_t)o->block_len, o->f);
        o->block_len = 0;
    }
}

static void bit_write(BitOut *o, uint32_t code, int size)
{
    o->bits |= code << o->nbits;
    o->nbits += size;
    while (o->nbits >= 8) {
        o->block[o->block_len++] = (uint8_t)(o->bits & 0xff);
        o->bits >>= 8;
        o->nbits -= 8;
        if (o->block_len == 255) bit_flush_block(o);
    }
}

/* LZW as in the GIF89a spec, 8-bit pixels. */
static void lzw_write(FILE *f, const uint8_t *idx, size_t n, uint16_t *tree /* 4096*256 */)
{
    const int min_code = 8, clear = 256, eoi = 257;
    int code_size = min_code + 1, max_code = eoi, cur = -1;
    size_t i;
    BitOut o;
    memset(&o, 0, sizeof(o));
    o.f = f;
    fputc(min_code, f);
    memset(tree, 0, sizeof(uint16_t) * 4096 * 256);
    bit_write(&o, (uint32_t)clear, code_size);
    for (i = 0; i < n; i++) {
        int k = idx[i];
        if (cur < 0) { cur = k; continue; }
        if (tree[cur * 256 + k]) { cur = tree[cur * 256 + k]; continue; }
        bit_write(&o, (uint32_t)cur, code_size);
        tree[cur * 256 + k] = (uint16_t)(++max_code);
        if (max_code >= (1 << code_size)) code_size++;
        if (max_code == 4095) {
            bit_write(&o, (uint32_t)clear, code_size);
            memset(tree, 0, sizeof(uint16_t) * 4096 * 256);
            code_size = min_code + 1;
            max_code = eoi;
        }
        cur = k;
    }
    if (cur >= 0) bit_write(&o, (uint32_t)cur, code_size);
    bit_write(&o, (uint32_t)eoi, code_size);
    if (o.nbits > 0) bit_write(&o, 0, 8 - o.nbits);
    bit_flush_block(&o);
    fputc(0, f); /* block terminator */
}

static const int bayer4[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };

int ugo_write_gif(FILE *f, const uint8_t *frames, uint32_t count, uint32_t w, uint32_t h, double fps, int dither)
{
    size_t npx = (size_t)w * h, total = npx * count, step, i, ns = 0;
    uint32_t *samples;
    uint8_t pal[256 * 3], *idx;
    int16_t *lut;
    uint16_t *tree;
    int ncol, has_transparent = 0, t_index, fr;
    double t_prev = 0;
    if (!count || !w || !h || w > 65535 || h > 65535) return 0;

    /* sample opaque colours from all frames (at most ~256k) */
    step = total / 262144 + 1;
    samples = (uint32_t *)malloc(sizeof(uint32_t) * (total / step + 1));
    if (!samples) return 0;
    for (i = 0; i < total; i += step) {
        const uint8_t *p = frames + 4 * i;
        if (p[3] >= 128) samples[ns++] = ((uint32_t)p[0] << 16) | ((uint32_t)p[1] << 8) | p[2];
    }
    for (i = 0; i < total && !has_transparent; i++) if (frames[4 * i + 3] < 128) has_transparent = 1;
    ncol = ns ? median_cut(samples, (int)ns, has_transparent ? 255 : 256, pal) : 1;
    if (!ns) pal[0] = pal[1] = pal[2] = 0;
    free(samples);
    t_index = has_transparent ? ncol : -1;
    if (has_transparent) { pal[3 * ncol] = pal[3 * ncol + 1] = pal[3 * ncol + 2] = 0; ncol++; }
    while (ncol < 256) { pal[3 * ncol] = pal[3 * ncol + 1] = pal[3 * ncol + 2] = 0; ncol++; }

    lut = (int16_t *)malloc(sizeof(int16_t) * 32768);
    idx = (uint8_t *)malloc(npx);
    tree = (uint16_t *)malloc(sizeof(uint16_t) * 4096 * 256);
    if (!lut || !idx || !tree) { free(lut); free(idx); free(tree); return 0; }
    for (i = 0; i < 32768; i++) lut[i] = -1;

    /* header, global palette, loop forever */
    fwrite("GIF89a", 1, 6, f);
    fputc((int)(w & 0xff), f); fputc((int)(w >> 8), f);
    fputc((int)(h & 0xff), f); fputc((int)(h >> 8), f);
    fputc(0xf7, f); fputc(t_index >= 0 ? t_index : 0, f); fputc(0, f);
    fwrite(pal, 1, 256 * 3, f);
    fwrite("\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00", 1, 19, f);

    for (fr = 0; fr < (int)count; fr++) {
        const uint8_t *src = frames + 4 * npx * (size_t)fr;
        double t_next = 100.0 * (fr + 1) / (fps > 0 ? fps : 30);
        int delay = (int)(t_next + 0.5) - (int)(t_prev + 0.5);
        uint32_t x, y;
        t_prev = t_next;
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
            const uint8_t *p = src + 4 * ((size_t)y * w + x);
            int r = p[0], g = p[1], b = p[2], key, best, k, bd;
            if (t_index >= 0 && p[3] < 128) { idx[(size_t)y * w + x] = (uint8_t)t_index; continue; }
            if (dither) {
                int d = (bayer4[(y & 3) * 4 + (x & 3)] - 8) / 2; /* -4..3 */
                r += d; g += d; b += d;
                r = r < 0 ? 0 : (r > 255 ? 255 : r);
                g = g < 0 ? 0 : (g > 255 ? 255 : g);
                b = b < 0 ? 0 : (b > 255 ? 255 : b);
            }
            key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            if (lut[key] < 0) {
                int cr = (r & ~7) | 4, cg = (g & ~7) | 4, cb = (b & ~7) | 4;
                best = 0; bd = 1 << 30;
                for (k = 0; k < 256; k++) {
                    int dr, dg, db, dd;
                    if (k == t_index) continue;
                    dr = cr - pal[3 * k]; dg = cg - pal[3 * k + 1]; db = cb - pal[3 * k + 2];
                    dd = dr * dr * 2 + dg * dg * 4 + db * db * 3;
                    if (dd < bd) { bd = dd; best = k; }
                }
                lut[key] = (int16_t)best;
            }
            idx[(size_t)y * w + x] = (uint8_t)lut[key];
        }
        /* graphic control extension: delay, disposal, transparency */
        fputc(0x21, f); fputc(0xf9, f); fputc(4, f);
        fputc((t_index >= 0 ? 0x01 : 0) | ((t_index >= 0 ? 2 : 1) << 2), f);
        if (delay < 1) delay = 1;
        fputc(delay & 0xff, f); fputc((delay >> 8) & 0xff, f);
        fputc(t_index >= 0 ? t_index : 0, f); fputc(0, f);
        /* image descriptor (full frame, global palette) */
        fputc(0x2c, f);
        fputc(0, f); fputc(0, f); fputc(0, f); fputc(0, f);
        fputc((int)(w & 0xff), f); fputc((int)(w >> 8), f);
        fputc((int)(h & 0xff), f); fputc((int)(h >> 8), f);
        fputc(0, f);
        lzw_write(f, idx, npx, tree);
    }
    fputc(0x3b, f);
    free(lut); free(idx); free(tree);
    return !ferror(f);
}
