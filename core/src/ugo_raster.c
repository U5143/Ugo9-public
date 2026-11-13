/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Ugo9 software renderer. See core/include/ugo_raster.h. */
#include "ugo_raster.h"
#include "ugo_internal.h"

static float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }
static float minf(float a, float b) { return a < b ? a : b; }
static float maxf(float a, float b) { return a > b ? a : b; }

/* Bilinear sample, clamped to the edge, returned premultiplied. */
static void sample(const UgoImage *img, float u, float v, float out[4])
{
    float x = u * (float)img->width - 0.5f, y = v * (float)img->height - 0.5f;
    int x0, y0, x1, y1, k, c;
    float fx, fy, wgt[4];
    const uint8_t *px[4];
    x = maxf(0.0f, minf(x, (float)img->width - 1.0f));
    y = maxf(0.0f, minf(y, (float)img->height - 1.0f));
    x0 = (int)x; y0 = (int)y;
    x1 = x0 + 1 < (int)img->width ? x0 + 1 : x0;
    y1 = y0 + 1 < (int)img->height ? y0 + 1 : y0;
    fx = x - (float)x0; fy = y - (float)y0;
    px[0] = img->rgba + 4 * ((uint32_t)y0 * img->width + (uint32_t)x0);
    px[1] = img->rgba + 4 * ((uint32_t)y0 * img->width + (uint32_t)x1);
    px[2] = img->rgba + 4 * ((uint32_t)y1 * img->width + (uint32_t)x0);
    px[3] = img->rgba + 4 * ((uint32_t)y1 * img->width + (uint32_t)x1);
    wgt[0] = (1.0f - fx) * (1.0f - fy); wgt[1] = fx * (1.0f - fy);
    wgt[2] = (1.0f - fx) * fy; wgt[3] = fx * fy;
    for (c = 0; c < 4; c++) out[c] = 0.0f;
    for (k = 0; k < 4; k++) {
        float a = (float)px[k][3] * (1.0f / 255.0f);
        float w = wgt[k] * a;
        out[0] += w * (float)px[k][0] * (1.0f / 255.0f);
        out[1] += w * (float)px[k][1] * (1.0f / 255.0f);
        out[2] += w * (float)px[k][2] * (1.0f / 255.0f);
        out[3] += w;
    }
}

/* Nearest sample (the texel the point falls in, clamped to the edge), returned premultiplied: for pixel art. */
static void sample_nearest(const UgoImage *img, float u, float v, float out[4])
{
    float x = maxf(0.0f, minf(u * (float)img->width, (float)img->width - 1.0f));
    float y = maxf(0.0f, minf(v * (float)img->height, (float)img->height - 1.0f));
    const uint8_t *px = img->rgba + 4 * ((uint32_t)y * img->width + (uint32_t)x);
    float a = (float)px[3] * (1.0f / 255.0f);
    out[0] = a * (float)px[0] * (1.0f / 255.0f);
    out[1] = a * (float)px[1] * (1.0f / 255.0f);
    out[2] = a * (float)px[2] * (1.0f / 255.0f);
    out[3] = a;
}

/* Edge ownership for pixels exactly on an edge, so shared edges are drawn once. */
static int owns_edge(float dx, float dy) { return dy > 0.0f || (dy == 0.0f && dx < 0.0f); }

/* What a triangle does with each covered pixel. */
typedef struct {
    const UgoImage *img;
    float opacity;
    const float *color;   /* X.rgb, 0, Y.rgb, 0 from the frame block, or 0 */
    uint32_t blend;
    const float *mask;    /* coverage of the part's mask (w*h), or 0 */
    int invert;
    float *maskout;      /* mask drawing: max() the coverage here instead of drawing colour */
    int solid;
    int nearest;         /* UGO_RASTER_NEAREST: texels as they are, not blended */
} Shade;

static void shade_sample(const Shade *sh, float u, float v, float out[4])
{
    if (sh->nearest) sample_nearest(sh->img, u, v, out);
    else sample(sh->img, u, v, out);
}

static void shade_pixel(const Shade *sh, float u, float v, float *d, uint32_t at)
{
    float col[4], k, a;
    int c;
    if (sh->maskout) {
        if (sh->solid) a = 1.0f;
        else { shade_sample(sh, u, v, col); a = col[3]; }
        if (a > sh->maskout[at]) sh->maskout[at] = a;
        return;
    }
    shade_sample(sh, u, v, col);
    k = sh->opacity;
    if (sh->mask) k *= sh->invert ? 1.0f - sh->mask[at] : sh->mask[at];
    if (sh->color) for (c = 0; c < 3; c++) col[c] = col[c] * sh->color[c] + col[3] * sh->color[4 + c];
    for (c = 0; c < 4; c++) col[c] *= k;
    a = col[3];
    if (a <= 0.0f && sh->blend != UGO_BLEND_ADD) return;
    switch (sh->blend) {
    case UGO_BLEND_ADD: /* rgb = s + d, alpha unchanged */
        for (c = 0; c < 3; c++) d[c] += col[c];
        break;
    case UGO_BLEND_MULTIPLY: /* rgb = s * d + d * (1 - sa), alpha unchanged */
        for (c = 0; c < 3; c++) d[c] = col[c] * d[c] + d[c] * (1.0f - a);
        break;
    case UGO_BLEND_SCREEN: /* rgb = s + d * (1 - s) */
        for (c = 0; c < 3; c++) d[c] = col[c] + d[c] * (1.0f - col[c]);
        d[3] = a + d[3] * (1.0f - a);
        break;
    default:
        for (c = 0; c < 3; c++) d[c] = col[c] + d[c] * (1.0f - a);
        d[3] = a + d[3] * (1.0f - a);
        break;
    }
}

static void draw_triangle(const float *p0, const float *p1, const float *p2,
                          const float *t0, const float *t1, const float *t2,
                          const Shade *sh, float *target, uint32_t w, uint32_t h)
{
    float area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    const float *P[3], *T[3];
    float bx0, bx1, by0, by1, inv, ex[3], ey[3], edx[3], edy[3];
    int x, y, xa, xb, ya, yb, e, own[3];
    if (area == 0.0f || !(area == area)) return;
    P[0] = p0; T[0] = t0;
    if (area > 0.0f) { P[1] = p1; T[1] = t1; P[2] = p2; T[2] = t2; }
    else { P[1] = p2; T[1] = t2; P[2] = p1; T[2] = t1; area = -area; }
    inv = 1.0f / area;
    bx0 = minf(P[0][0], minf(P[1][0], P[2][0])); bx1 = maxf(P[0][0], maxf(P[1][0], P[2][0]));
    by0 = minf(P[0][1], minf(P[1][1], P[2][1])); by1 = maxf(P[0][1], maxf(P[1][1], P[2][1]));
    if (bx1 < 0.0f || by1 < 0.0f || bx0 > (float)w || by0 > (float)h) return;
    xa = (int)maxf(0.0f, bx0 - 1.0f); xb = (int)minf((float)w - 1.0f, bx1 + 1.0f);
    ya = (int)maxf(0.0f, by0 - 1.0f); yb = (int)minf((float)h - 1.0f, by1 + 1.0f);
    /* the edges (edge e runs from P[e+1] to P[e+2]), set up once per triangle; each pixel's edge value
     * is computed with the same operations as before (the same bits), dx (py - ay) once per row */
    for (e = 0; e < 3; e++) {
        const float *A = P[(e + 1) % 3], *B = P[(e + 2) % 3];
        ex[e] = A[0]; ey[e] = A[1]; edx[e] = B[0] - A[0]; edy[e] = B[1] - A[1];
        own[e] = owns_edge(edx[e], edy[e]);
    }
    for (y = ya; y <= yb; y++) {
        float py = (float)y + 0.5f, row[3];
        int seen = 0;
        for (e = 0; e < 3; e++) row[e] = edx[e] * (py - ey[e]);
        for (x = xa; x <= xb; x++) {
            float px = (float)x + 0.5f, bc[3], u, v;
            uint32_t at = (uint32_t)y * w + (uint32_t)x;
            int inside = 1;
            for (e = 0; e < 3 && inside; e++) {
                float ev = row[e] - edy[e] * (px - ex[e]);
                if (ev < 0.0f || (ev == 0.0f && !own[e])) inside = 0;
                bc[e] = ev;
            }
            /* each edge value only moves one way along a row (px - ex, the product and the difference
             * are monotonic in float too), so the covered pixels of a row are one run: past it, stop */
            if (!inside) { if (seen) break; continue; }
            seen = 1;
            u = (bc[0] * T[0][0] + bc[1] * T[1][0] + bc[2] * T[2][0]) * inv;
            v = (bc[0] * T[0][1] + bc[1] * T[1][1] + bc[2] * T[2][1]) * inv;
            shade_pixel(sh, u, v, target + 4 * at, at);
        }
    }
}

static const UgoImage *part_image(const KPart *part, const UgoImage *textures, uint32_t texture_count)
{
    return &textures[part->texture < texture_count ? part->texture : 0];
}

static void draw_part(const UgoModel *m, const KPart *part, const float *xy, const Shade *sh, float *target, uint32_t w, uint32_t h)
{
    uint32_t i;
    for (i = 0; i < part->indexCount; i += 3) {
        const uint32_t *t = m->indices + part->firstIndex + i;
        uint32_t a = t[0], b = t[1], c = t[2];
        draw_triangle(xy + 2 * a, xy + 2 * b, xy + 2 * c, m->uv + 2 * a, m->uv + 2 * b, m->uv + 2 * c, sh, target, w, h);
    }
}

void ugo_raster_instance_masked(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                                float *target, uint32_t w, uint32_t h, const float *view, float *scratch, float *mask)
{
    ugo_raster_instance_ex(in, textures, texture_count, target, w, h, view, scratch, mask, 0);
}

void ugo_raster_instance_ex(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                            float *target, uint32_t w, uint32_t h, const float *view, float *scratch, float *mask,
                            uint32_t flags)
{
    const UgoModel *m = in->m;
    const float *fr = in->frame;
    float M[6];
    uint32_t v, di, i, cached = UGO_NONE;
    if (texture_count == 0) return;
    /* M = view * instance transform */
    M[0] = view[0] * fr[0] + view[2] * fr[1];
    M[1] = view[1] * fr[0] + view[3] * fr[1];
    M[2] = view[0] * fr[2] + view[2] * fr[3];
    M[3] = view[1] * fr[2] + view[3] * fr[3];
    M[4] = view[0] * fr[4] + view[2] * fr[5] + view[4];
    M[5] = view[1] * fr[4] + view[3] * fr[5] + view[5];
    ugo_deform_cpu(in, scratch);
    for (v = 0; v < m->n[KC_VERTS]; v++) {
        float x = scratch[2 * v], y = scratch[2 * v + 1];
        scratch[2 * v] = M[0] * x + M[2] * y + M[4];
        scratch[2 * v + 1] = M[1] * x + M[3] * y + M[5];
    }
    for (di = 0; di < m->n[KC_PARTS]; di++) { /* in the instance's draw order (0.8) */
        uint32_t pi = in->drawList[di];
        const KPart *part = &m->parts[pi];
        Shade sh;
        float op = fr[m->opOff + pi];
        if (op <= 0.0f || (part->flags & PART_HIDDEN)) continue;
        sh.img = part_image(part, textures, texture_count);
        sh.opacity = op;
        sh.color = part->color == UGO_NONE ? 0 : fr + m->colorOff + 8 * part->color;
        sh.blend = part->blend;
        sh.mask = 0;
        sh.invert = (part->flags & PART_MASK_INVERT) != 0;
        sh.maskout = 0;
        sh.solid = 0;
        sh.nearest = (flags & UGO_RASTER_NEAREST) != 0;
        if (mask && part->mask != UGO_NONE) {
            if (cached != part->mask) { /* draw the mask's coverage */
                const KMask *k = &m->masks[part->mask];
                Shade ms = sh;
                for (i = 0; i < w * h; i++) mask[i] = 0.0f;
                ms.maskout = mask;
                for (i = k->firstRef; i < k->firstRef + k->refCount; i++) {
                    const KPart *mp = &m->parts[m->maskrefs[i]];
                    ms.img = part_image(mp, textures, texture_count);
                    ms.solid = (mp->flags & PART_SOLID) != 0;
                    draw_part(m, mp, scratch, &ms, target, w, h);
                }
                cached = part->mask;
            }
            sh.mask = mask;
        }
        draw_part(m, part, scratch, &sh, target, w, h);
    }
}

void ugo_raster_instance(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                         float *target, uint32_t w, uint32_t h, const float *view, float *scratch)
{
    ugo_raster_instance_masked(in, textures, texture_count, target, w, h, view, scratch, 0);
}

void ugo_raster_clear(float *target, uint32_t w, uint32_t h, float r, float g, float b, float a)
{
    uint32_t i;
    for (i = 0; i < w * h; i++) {
        target[4 * i] = r * a; target[4 * i + 1] = g * a; target[4 * i + 2] = b * a; target[4 * i + 3] = a;
    }
}

void ugo_raster_resolve(const float *src, uint32_t w, uint32_t h, uint32_t factor, uint8_t *out)
{
    uint32_t x, y, i, j, c, sw = w * factor;
    float norm = 1.0f / (float)(factor * factor);
    for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
            float acc[4] = { 0.0f, 0.0f, 0.0f, 0.0f };
            uint8_t *d = out + 4 * (y * w + x);
            for (j = 0; j < factor; j++)
                for (i = 0; i < factor; i++)
                    for (c = 0; c < 4; c++) acc[c] += src[4 * ((y * factor + j) * sw + x * factor + i) + c];
            for (c = 0; c < 4; c++) acc[c] *= norm;
            if (acc[3] > 0.0f) {
                for (c = 0; c < 3; c++) d[c] = (uint8_t)(clamp01(acc[c] / acc[3]) * 255.0f + 0.5f);
            } else {
                d[0] = d[1] = d[2] = 0;
            }
            d[3] = (uint8_t)(clamp01(acc[3]) * 255.0f + 0.5f);
        }
    }
}
