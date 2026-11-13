/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/*
 * Core tests and a small benchmark.
 *
 *   ugo_test model.ug9 [heavy_model.ug9] [--fuzz other.ug9 ...]
 *
 * - loads the model and checks the frame block is finite and deterministic
 * - corrupts the file thousands of ways: loading must fail cleanly or work
 * - shakes the parameters to check physics stays finite
 * - times ugo_update (per-frame CPU work of the GPU path) against
 *   ugo_deform_cpu (CPU vertex work, like Live2D/Spine runtimes do)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>

#include "ugo.h"
#include "ugo_raster.h"

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

static void *alloc16(size_t n)
{
    void *p = malloc(n + 16);
    return p;
}
#define ALIGN16(p) ((void *)(((uintptr_t)(p) + 15u) & ~(uintptr_t)15u))

static uint8_t *read_file(const char *path, uint32_t *size)
{
    FILE *f = fopen(path, "rb");
    long n;
    uint8_t *p;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    p = (uint8_t *)malloc((size_t)n + 16);
    if (fread(p, 1, (size_t)n, f) != (size_t)n) { free(p); p = NULL; }
    fclose(f);
    *size = (uint32_t)n;
    return p;
}

static uint32_t rng_state = 12345u;
static uint32_t rng(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static double now_s(void) { return (double)clock() / CLOCKS_PER_SEC; }

static int frame_finite(const UgoInstance *in, const UgoModel *m)
{
    const float *fr = ugo_frame(in);
    uint32_t i;
    for (i = 0; i < ugo_frame_float_count(m); i++) if (!isfinite(fr[i])) return 0;
    return 1;
}

static void test_basic(const uint8_t *data, uint32_t size)
{
    uint32_t need = ugo_model_mem_size_for(data, size); /* 1.1: more than ugo_model_mem_size() */
    void *mm = alloc16(need ? need : ugo_model_mem_size()), *im1, *im2;
    UgoModel *m = ugo_model_init_sized(ALIGN16(mm), need ? need : ugo_model_mem_size(), data, size);
    UgoInstance *a, *b;
    float *pa, *pb;
    uint32_t i, nv;
    int idle;
    CHECK(m != NULL, "model failed to load (error %d)", ugo_last_error());
    if (!m) return;
    nv = ugo_vertex_count(m);
    printf("model: %u params, %u bones, %u parts, %u vertices, %u triangles, %u morphs, %u morph entries, frame block %u floats (%u bytes)\n",
           ugo_param_count(m), ugo_bone_count(m), ugo_part_count(m), nv, ugo_index_count(m) / 3,
           ugo_morph_count(m), ugo_entry_count(m), ugo_frame_float_count(m), 4 * ugo_frame_float_count(m));
    im1 = alloc16(ugo_instance_mem_size(m));
    im2 = alloc16(ugo_instance_mem_size(m));
    a = ugo_instance_init(ALIGN16(im1), m);
    b = ugo_instance_init(ALIGN16(im2), m);
    CHECK(a && b, "instance init failed");
    CHECK(ugo_find_param(m, "HeadTurnX") >= 0, "HeadTurnX missing");
    CHECK(ugo_find_param(m, "nope") == -1, "unknown name found");
    CHECK(ugo_find_animation(m, "idle") < 0 || ugo_animation_loop(m, (uint32_t)ugo_find_animation(m, "idle")) == 1, "idle should loop");
    CHECK(ugo_animation_loop(m, 1000000u) == 0, "out-of-range animation loops");
    idle = ugo_find_animation(m, "idle");
    pa = (float *)malloc(sizeof(float) * 2 * nv);
    pb = (float *)malloc(sizeof(float) * 2 * nv);

    /* rest pose: deformed positions equal the stored positions */
    ugo_update(a, 0.0f);
    ugo_deform_cpu(a, pa);
    {
        const float *p0 = ugo_positions(m);
        float maxd = 0;
        for (i = 0; i < 2 * nv; i++) { float d = fabsf(pa[i] - p0[i]); if (d > maxd) maxd = d; }
        CHECK(maxd < 1e-3f, "rest pose moved vertices by %g px", maxd);
    }

    /* determinism: same inputs -> same bits */
    for (i = 0; i < 300; i++) {
        float t = (float)i / 60.0f;
        ugo_reset_params(a); ugo_reset_params(b);
        if (idle >= 0) { ugo_apply_animation(a, (uint32_t)idle, t, 1.0f); ugo_apply_animation(b, (uint32_t)idle, t, 1.0f); }
        ugo_update(a, 1.0f / 60.0f); ugo_update(b, 1.0f / 60.0f);
    }
    CHECK(memcmp(ugo_frame(a), ugo_frame(b), 4 * ugo_frame_float_count(m)) == 0, "two instances diverged");
    CHECK(frame_finite(a, m), "frame has NaN/Inf");
    ugo_deform_cpu(a, pa);
    ugo_deform_cpu(b, pb);
    CHECK(memcmp(pa, pb, sizeof(float) * 2 * nv) == 0, "deform diverged");

    /* parameters are clamped, physics stays finite under violent input */
    for (i = 0; i < 20000; i++) {
        uint32_t p = rng() % ugo_param_count(m);
        ugo_set_param(a, p, ((float)(rng() % 2001) - 1000.0f));
        ugo_update(a, (float)(rng() % 100) / 1000.0f);
        if (!frame_finite(a, m)) break;
    }
    CHECK(frame_finite(a, m), "physics blew up");
    for (i = 0; i < ugo_param_count(m); i++)
        CHECK(ugo_get_param(a, i) >= ugo_param_min(m, i) && ugo_get_param(a, i) <= ugo_param_max(m, i), "param %u out of range", i);
    ugo_set_param(a, 0, NAN);
    ugo_update(a, NAN);
    CHECK(frame_finite(a, m), "NaN input leaked into the frame");

    /* names to numbers; picking without deformed positions; the estimated box; placed bones */
    CHECK(ugo_bone_count(m) == 0 || ugo_find_bone(m, ugo_bone_name(m, ugo_bone_count(m) - 1)) == (int)ugo_bone_count(m) - 1, "find_bone");
    CHECK(ugo_part_count(m) == 0 || ugo_find_part(m, ugo_part_name(m, 0)) == 0, "find_part");
    CHECK(ugo_find_bone(m, "nope") == -1 && ugo_find_part(m, "nope") == -1 && ugo_find_bone(m, NULL) == -1, "unknown bone/part found");
    for (i = 0; nv && i < 40; i++) {
        uint32_t p, v;
        float e[4], b0[4], b1[4], x, y;
        ugo_reset_params(a);
        for (p = 0; p < ugo_param_count(m); p++) ugo_set_param(a, p, ugo_param_min(m, p) + (float)(rng() % 1001) / 1000.0f * (ugo_param_max(m, p) - ugo_param_min(m, p)));
        if (idle >= 0) ugo_apply_animation(a, (uint32_t)idle, (float)i * 0.1f, 1.0f);
        ugo_update(a, 1.0f / 60.0f);
        ugo_deform_cpu(a, pa);
        CHECK(ugo_bounds(a, pa, -1, b0) == ugo_bounds(a, NULL, -1, b1) && memcmp(b0, b1, sizeof b0) == 0, "bounds with NULL deformed differ");
        x = pa[2 * (i % nv)]; y = pa[2 * (i % nv) + 1];
        CHECK(ugo_pick_part(a, pa, x, y, 0.0f) == ugo_pick_part(a, NULL, x, y, 0.0f), "pick with NULL deformed differs");
        CHECK(ugo_bounds_estimate(a, e) == (nv > 0), "estimate found nothing");
        for (v = 0; v < nv; v++)
            if (pa[2 * v] < e[0] - 1e-2f || pa[2 * v] > e[2] + 1e-2f || pa[2 * v + 1] < e[1] - 1e-2f || pa[2 * v + 1] > e[3] + 1e-2f) break;
        CHECK(v == nv, "vertex %u outside the estimated box", v);
    }
    if (ugo_bone_count(m)) {
        float w[6], wp[6];
        ugo_set_transform(a, 0.0f, 2.0f, -2.0f, 0.0f, 100.0f, 50.0f);
        ugo_bone_world(a, 0, w);
        ugo_bone_world_placed(a, 0, wp);
        CHECK(fabsf(wp[0] + 2.0f * w[1]) < 1e-4f && fabsf(wp[1] - 2.0f * w[0]) < 1e-4f && fabsf(wp[4] - (100.0f - 2.0f * w[5])) < 1e-3f && fabsf(wp[5] - (50.0f + 2.0f * w[4])) < 1e-3f, "bone_world_placed");
        ugo_set_transform(a, 1, 0, 0, 1, 0, 0);
    }

    free(pa); free(pb); free(im1); free(im2); free(mm);
}

static void test_corrupt(const uint8_t *data, uint32_t size)
{
    uint8_t *buf = (uint8_t *)malloc((size_t)size + 16), *b = (uint8_t *)ALIGN16(buf);
    void *mm = NULL;
    uint32_t round, loaded = 0, need;
    float *scratch = NULL;
    for (round = 0; round < 3000; round++) {
        uint32_t len = size, k, flips;
        UgoModel *m;
        memcpy(b, data, size);
        switch (round % 5) {
        case 0: /* flip random bytes */
            flips = 1 + rng() % 8;
            for (k = 0; k < flips; k++) b[rng() % size] ^= (uint8_t)(1u << (rng() % 8));
            break;
        case 1: /* random words in the header and early tables */
            for (k = 0; k < 4; k++) ((uint32_t *)b)[rng() % (size / 4 < 512 ? size / 4 : 512)] = rng();
            break;
        case 2: /* truncate */
            len = rng() % size;
            break;
        case 3: /* garbage in a random window */
            for (k = rng() % size; k < size && k < 64; k++) b[k] = (uint8_t)rng();
            break;
        default: { /* the table of contents (1.0): an entry's kind, offset, count, size or flags, or two entries swapped */
            const uint32_t *h = (const uint32_t *)b;
            uint32_t hs = h[3], n = h[8];
            if (hs >= 40 && (hs & 3u) == 0 && n > 0 && (uint64_t)hs + 16u * n <= size) {
                uint32_t *e = (uint32_t *)(b + hs + 16u * (rng() % n)), *f = (uint32_t *)(b + hs + 16u * (rng() % n)), t[4];
                switch (rng() % 6) {
                case 0: e[0] = rng() % 300; break;                                      /* another kind, known or not */
                case 1: e[1] += (rng() % 64) - 32; break;                                /* offset moved */
                case 2: e[2] = (rng() & 1) ? e[2] + (rng() % 8) - 4 : rng(); break;       /* count */
                case 3: e[3] = (e[3] & 0xffff0000u) | (rng() % 80); break;               /* record size */
                case 4: e[3] = (e[3] & 0xffffu) | ((rng() % 4) << 16); e[0] = 200 + rng() % 50; break; /* unknown, any flag */
                default: memcpy(t, e, 16); memcpy(e, f, 16); memcpy(f, t, 16); break;   /* order */
                }
            }
            break;
        }
        }
        /* the memory the file says it needs (1.1: its curve keys expanded), then the whole check */
        need = ugo_model_mem_size_for(b, len);
        free(mm);
        mm = alloc16(need ? need : ugo_model_mem_size());
        m = ugo_model_init_sized(ALIGN16(mm), need ? need : ugo_model_mem_size(), b, len);
        CHECK(need || !m, "ugo_model_mem_size_for refused a file that ugo_model_init_sized read");
        if (m) {
            void *im = alloc16(ugo_instance_mem_size(m));
            UgoInstance *in = ugo_instance_init(ALIGN16(im), m);
            uint32_t a;
            loaded++;
            scratch = (float *)realloc(scratch, sizeof(float) * 2 * (ugo_vertex_count(m) + 1));
            for (a = 0; a < ugo_animation_count(m); a++) ugo_apply_animation(in, a, 1.3f, 1.0f);
            { /* layers: added, and masked (every other bone, no parameters) */
                static uint8_t bones[8192], none[8192]; /* (as long as the most of any kind the limits allow that a mask covers here) */
                UgoAnimMask mk;
                uint32_t q;
                for (q = 0; q < 8192; q++) bones[q] = (uint8_t)(q & 1);
                mk.bones = bones; mk.parts = NULL; mk.params = none; mk.morphs = NULL; mk.constraints = NULL; mk.colors = NULL;
                for (a = 0; a < ugo_animation_count(m); a++) {
                    ugo_apply_animation_ex(in, a, 0.7f, 0.5f, UGO_ANIM_ADD, NULL);
                    ugo_apply_animation_ex(in, a, 2.1f, 0.25f, 0, &mk);
                }
            }
            for (a = 0; a < ugo_expression_count(m); a++) ugo_apply_expression(in, a, 0.7f); /* (0.8) */
            ugo_update(in, 1.0f / 60.0f);
            { /* posing and dragging (editor) on whatever loaded */
                static const float pose[7] = { 0.5f, 3.0f, -2.0f, 0.1f, 0.0f, 0.05f, 0.0f };
                uint32_t nb = ugo_bone_count(m);
                ugo_set_bone_offset(in, nb - 1, pose, 0.7f);
                (void)ugo_solve_ik_to(in, nb - 1, 4, 12.0f, -30.0f, 8);
                { static const float w[6] = { 0.0f, 1.0f, -1.0f, 0.0f, 5.0f, -3.0f }; ugo_set_bone_world(in, nb - 1, w); }
                ugo_update(in, 1.0f / 60.0f);
            }
            ugo_deform_cpu(in, scratch);
            { /* reading tracks */
                uint32_t info[4], tk;
                float tv[2];
                for (a = 0; a < ugo_animation_count(m); a++)
                    for (tk = 0; tk < ugo_animation_track_count(m, a); tk++) {
                        if (ugo_animation_track(m, a, tk, info) && info[2]) (void)ugo_animation_track_key(m, a, tk, info[2] - 1, tv);
                        (void)ugo_animation_track_value(m, a, tk, 0.9f);
                    }
            }
            if (ugo_part_count(m)) ugo_deform_part_cpu(in, ugo_part_count(m) - 1, scratch);
            ugo_set_wind(in, 300.0f, -50.0f, 1.0f);
            { float wv[3]; ugo_get_wind(in, wv); ugo_set_wind_time(in, ugo_wind_time(in) + 1.5); }
            ugo_settle_physics(in, 0.2f);
            ugo_deform_cpu(in, scratch);
            { /* picking and boxes (editor) */
                float box[4];
                (void)ugo_pick_part(in, scratch, 3.0f, -7.0f, 0.0f);
                { static uint8_t all[65535]; all[0] = all[1] = 1; (void)ugo_pick_area(in, scratch, 3.0f, -7.0f, all); }
                (void)ugo_bounds(in, scratch, -1, box);
                if (ugo_part_count(m)) (void)ugo_bounds(in, scratch, (int)ugo_part_count(m) - 1, box);
                (void)ugo_pick_part(in, NULL, 3.0f, -7.0f, 0.0f);
                (void)ugo_bounds(in, NULL, -1, box);
                (void)ugo_bounds_estimate(in, box);
                if (ugo_bone_count(m)) { float w6[6]; ugo_bone_world_placed(in, ugo_bone_count(m) - 1, w6); (void)ugo_find_bone(m, "root"); (void)ugo_find_part(m, "x"); }
            }
            { /* draw it small, masks included */
                static const uint8_t px[4] = { 255, 255, 255, 255 };
                static float target[4 * 32 * 32], mask[32 * 32];
                const float view[6] = { 0.05f, 0, 0, 0.05f, 16, 16 };
                UgoImage img;
                img.rgba = px; img.width = 1; img.height = 1;
                ugo_raster_instance_masked(in, &img, 1, target, 32, 32, view, scratch, mask);
                ugo_raster_instance_ex(in, &img, 1, target, 32, 32, view, scratch, mask, UGO_RASTER_NEAREST);
            }
            free(im);
        }
    }
    printf("corrupted files: 3000 tried, %u still valid (ran without crashing)\n", loaded);
    free(scratch); free(mm); free(buf);
}

/* Every animation at many times: the frame block stays finite. */
static void test_finite(const char *label, const uint8_t *data, uint32_t size)
{
    uint32_t need = ugo_model_mem_size_for(data, size); /* (1.1: curve keys need more) */
    void *mm = alloc16(need ? need : 16), *im;
    UgoModel *m = ugo_model_init_sized(ALIGN16(mm), need, data, size);
    UgoInstance *in;
    uint32_t a, k, bad = 0;
    int step;
    if (!m) { CHECK(0, "%s failed to load (error %d)", label, ugo_last_error()); free(mm); return; }
    im = alloc16(ugo_instance_mem_size(m));
    in = ugo_instance_init(ALIGN16(im), m);
    for (a = 0; a < ugo_animation_count(m); a++)
        for (step = 0; step < 240; step++) {
            const float *fr;
            ugo_reset_params(in);
            ugo_apply_animation(in, a, (float)step / 60.0f, 1.0f);
            ugo_update(in, 1.0f / 60.0f);
            fr = ugo_frame(in);
            for (k = 0; k < ugo_frame_float_count(m); k++) if (!isfinite(fr[k])) bad++;
        }
    CHECK(bad == 0, "%s: %u non-finite frame values", label, bad);
    printf("%s: %u bones, %u animations, frame block finite\n", label, ugo_bone_count(m), ugo_animation_count(m));
    free(im); free(mm);
}

/* Masks, blend modes and colours on tests/pose/rig.ug9 (a Spine-style clipping
 * polygon "clip"; "inside" is clipped by it and tinted, "outside" is drawn
 * outside it with additive blending). */
static void test_masks(const uint8_t *data, uint32_t size)
{
    enum { W = 256, H = 256 };
    static const uint8_t white[16] = { 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255 };
    uint32_t need = ugo_model_mem_size_for(data, size);
    void *mm = alloc16(need ? need : ugo_model_mem_size()), *im;
    UgoModel *m = ugo_model_init_sized(ALIGN16(mm), need ? need : ugo_model_mem_size(), data, size);
    UgoInstance *in;
    UgoImage img;
    float *target, *scratch, *mask, view[6] = { 1, 0, 0, 1, 128, 128 };
    const float *px;
    int clip;
    if (!m) { free(mm); return; }
    clip = -1;
    { uint32_t i; for (i = 0; i < ugo_part_count(m); i++) if (strcmp(ugo_part_name(m, i), "clip") == 0) clip = (int)i; }
    if (clip < 0 || ugo_mask_count(m) == 0) { free(mm); return; } /* not the rig */
    CHECK(ugo_part_flags(m, (uint32_t)clip) == (UGO_PART_HIDDEN | UGO_PART_SOLID), "clip part flags %u", ugo_part_flags(m, (uint32_t)clip));
    CHECK(ugo_mask_count(m) == 2 && ugo_mask_channel_count(m) == 2, "rig masks: %u masks, %u channels", ugo_mask_count(m), ugo_mask_channel_count(m));
    im = alloc16(ugo_instance_mem_size(m));
    in = ugo_instance_init(ALIGN16(im), m);
    img.rgba = white; img.width = 2; img.height = 2;
    target = (float *)calloc(4 * W * H, sizeof(float));
    mask = (float *)malloc(sizeof(float) * W * H);
    scratch = (float *)malloc(sizeof(float) * 2 * ugo_vertex_count(m));
    ugo_update(in, 0.0f);
    ugo_raster_instance_masked(in, &img, 1, target, W, H, view, scratch, mask);
    px = target + 4 * ((128 + 10) * W + 128 + 5); /* inside the clip: tint (light 1,0.6,0.5 with dark 0.1,0,0.2 on white) */
    CHECK(fabsf(px[0] - 1.0f) < 1e-3f && fabsf(px[1] - 0.6f) < 1e-3f && fabsf(px[2] - 0.5f) < 1e-3f && fabsf(px[3] - 1.0f) < 1e-3f,
          "tinted, clipped part: %g %g %g %g", px[0], px[1], px[2], px[3]);
    px = target + 4 * ((128 + 10) * W + 128 + 65); /* outside the clip: only the inverted, additive part (alpha stays 0) */
    CHECK(fabsf(px[0] - 1.0f) < 1e-3f && fabsf(px[3]) < 1e-3f, "inverted additive part: %g %g %g %g", px[0], px[1], px[2], px[3]);
    px = target + 4 * ((128 - 25) * W + 128 + 5); /* above the clip polygon: the hidden clip itself draws nothing */
    CHECK(px[3] == 0.0f && px[0] == 0.0f, "hidden clip part was drawn");
    /* without masks the additive part also lands inside the clip */
    ugo_raster_clear(target, W, H, 0, 0, 0, 0);
    ugo_raster_instance(in, &img, 1, target, W, H, view, scratch);
    px = target + 4 * ((128 + 10) * W + 128 + 5);
    CHECK(px[0] > 1.5f, "unmasked raster should add the inverted part (%g)", px[0]);
    printf("masks: clipping polygon, inverted mask, tint/dark and additive blending checked\n");
    free(target); free(mask); free(scratch); free(im); free(mm);
}

static void bench(const char *label, const uint8_t *data, uint32_t size, int instances)
{
    uint32_t need = ugo_model_mem_size_for(data, size);
    void *mm = alloc16(need ? need : ugo_model_mem_size());
    UgoModel *m = ugo_model_init_sized(ALIGN16(mm), need ? need : ugo_model_mem_size(), data, size);
    void **mem;
    UgoInstance **in;
    float *scratch;
    int i, frame, frames = 60, idle;
    double t0, t_update, t_deform;
    if (!m) { CHECK(0, "bench model failed to load"); return; }
    mem = (void **)malloc(sizeof(void *) * (size_t)instances);
    in = (UgoInstance **)malloc(sizeof(UgoInstance *) * (size_t)instances);
    for (i = 0; i < instances; i++) {
        mem[i] = alloc16(ugo_instance_mem_size(m));
        in[i] = ugo_instance_init(ALIGN16(mem[i]), m);
    }
    scratch = (float *)malloc(sizeof(float) * 2 * ugo_vertex_count(m));
    idle = ugo_find_animation(m, "idle");
    if (idle < 0 && ugo_animation_count(m) > 0) idle = 0; /* e.g. Spine imports: the first animation */

    t0 = now_s();
    for (frame = 0; frame < frames; frame++)
        for (i = 0; i < instances; i++) {
            ugo_reset_params(in[i]);
            if (idle >= 0) ugo_apply_animation(in[i], (uint32_t)idle, (float)frame / 60.0f + (float)i * 0.37f, 1.0f);
            ugo_update(in[i], 1.0f / 60.0f);
        }
    t_update = (now_s() - t0) / frames;

    t0 = now_s();
    for (frame = 0; frame < frames; frame++)
        for (i = 0; i < instances; i++) ugo_deform_cpu(in[i], scratch);
    t_deform = (now_s() - t0) / frames;

    printf("%-6s %5u vertices, %u bones, %u constraints x %d characters: update (GPU path CPU work) %.3f ms/frame (%.1f us each), + CPU vertex deform %.3f ms/frame; uploads %u vs %u bytes per character\n",
           label, ugo_vertex_count(m), ugo_bone_count(m), ugo_constraint_count(m), instances, t_update * 1000.0, t_update * 1e6 / instances, t_deform * 1000.0,
           4 * ugo_frame_float_count(m), 8 * ugo_vertex_count(m));
    for (i = 0; i < instances; i++) free(mem[i]);
    free(mem); free(in); free(scratch); free(mm);
}

/* The animations' track runs (made at load when the memory has room, see ugo_model_mem_size_for) play
 * every animation as the tracks walked one by one do (a model loaded with the least memory it takes):
 * the same frame blocks and bone worlds, bit for bit, played alone, two at once and at part weights. */
static void test_runs(const char *name, const uint8_t *data, uint32_t size)
{
    uint32_t need = ugo_model_mem_size_for(data, size), lo = ugo_model_mem_size(), hi, a, k, b, nf, na, differ = 0;
    void *m1 = alloc16(need), *m2 = alloc16(need), *i1, *i2;
    UgoModel *full = ugo_model_init_sized(ALIGN16(m1), need, data, size), *least;
    UgoInstance *x, *y;
    float wx[6], wy[6];
    if (!full) { CHECK(0, "%s: did not load", name); free(m1); free(m2); return; }
    /* the least memory it loads with (16-byte steps) */
    hi = need;
    while (hi - lo > 16u) {
        uint32_t mid = ((lo + hi) / 2u) & ~15u;
        if (mid <= lo) mid = lo + 16u;
        if (ugo_model_init_sized(ALIGN16(m2), mid, data, size)) hi = mid; else lo = mid;
    }
    least = ugo_model_init_sized(ALIGN16(m2), ugo_model_init_sized(ALIGN16(m2), lo, data, size) ? lo : hi, data, size);
    CHECK(least != NULL, "%s: did not load with less memory", name);
    if (!least) { free(m1); free(m2); return; }
    na = ugo_animation_count(full);
    CHECK(na == 0 || hi < need || lo < need, "%s: the track runs take no memory", name);
    i1 = alloc16(ugo_instance_mem_size(full)); i2 = alloc16(ugo_instance_mem_size(least));
    x = ugo_instance_init(ALIGN16(i1), full); y = ugo_instance_init(ALIGN16(i2), least);
    nf = ugo_frame_float_count(full);
    for (a = 0; a < na; a++) {
        float d = ugo_animation_duration(full, a);
        if (d <= 0.0f) d = 1.0f;
        for (k = 0; k < 24; k++) {
            float t = d * ((float)k + 0.37f) / 17.0f, w = k % 3 == 2 ? 0.35f : 1.0f;
            ugo_reset_params(x); ugo_reset_params(y);
            ugo_apply_animation(x, a, t, w); ugo_apply_animation(y, a, t, w);
            if (k % 2) { ugo_apply_animation(x, (a + 1) % na, t * 0.7f, 0.5f); ugo_apply_animation(y, (a + 1) % na, t * 0.7f, 0.5f); }
            ugo_update(x, 1.0f / 60.0f); ugo_update(y, 1.0f / 60.0f);
            if (memcmp(ugo_frame(x), ugo_frame(y), 4u * nf) != 0) differ++;
            for (b = 0; b < ugo_bone_count(full); b++) {
                ugo_bone_world(x, b, wx); ugo_bone_world(y, b, wy);
                if (memcmp(wx, wy, sizeof wx) != 0) { differ++; break; }
            }
        }
    }
    CHECK(differ == 0, "%s: the track runs played %u frame(s) differently", name, differ);
    printf("%s: %u animations played with the track runs as without (model memory %u, least %u bytes)\n", name, na, need, hi);
    free(m1); free(m2); free(i1); free(i2);
}

/* What an update keeps from the last one (bone worlds whose inputs have the same bits, warp grids whose
 * drivers, parent and bone did not change) is what computing everything afresh gives: one instance updated
 * step after step (animations, a second one mixed in, parameters moving, the same step twice, back to an
 * earlier pose) against a fresh instance for each step; frame blocks and bone worlds, bit for bit. dt is 0,
 * so physics and chains (which a fresh instance starts again) stay out of it. */
static void test_kept(const char *name, const uint8_t *data, uint32_t size)
{
    uint32_t need = ugo_model_mem_size_for(data, size), a, k, b, nf, na, np, differ = 0;
    void *mm = alloc16(need), *i1, *i2;
    UgoModel *m = ugo_model_init_sized(ALIGN16(mm), need, data, size);
    UgoInstance *x, *y;
    float wx[6], wy[6];
    if (!m) { CHECK(0, "%s: did not load", name); free(mm); return; }
    i1 = alloc16(ugo_instance_mem_size(m)); i2 = alloc16(ugo_instance_mem_size(m));
    x = ugo_instance_init(ALIGN16(i1), m);
    nf = ugo_frame_float_count(m); na = ugo_animation_count(m); np = ugo_param_count(m);
    for (a = 0; a < (na ? na : 1); a++) {
        for (k = 0; k < 30; k++) {
            uint32_t s = k % 10 == 9 ? k - 5 : k; /* now and then an earlier step again */
            float t = (float)(s / 2) * 0.13f; /* each step twice */
            ugo_reset_params(x);
            if (na) { ugo_apply_animation(x, a, t, 1.0f); if (s % 3 == 0) ugo_apply_animation(x, (a + 1) % na, t * 0.7f, 0.4f); }
            if (np) ugo_set_param(x, (s / 2) % np, (float)(s % 7) / 3.0f - 1.0f);
            ugo_update(x, 0.0f);
            y = ugo_instance_init(ALIGN16(i2), m);
            ugo_reset_params(y);
            if (na) { ugo_apply_animation(y, a, t, 1.0f); if (s % 3 == 0) ugo_apply_animation(y, (a + 1) % na, t * 0.7f, 0.4f); }
            if (np) ugo_set_param(y, (s / 2) % np, (float)(s % 7) / 3.0f - 1.0f);
            ugo_update(y, 0.0f);
            if (memcmp(ugo_frame(x), ugo_frame(y), 4u * nf) != 0) differ++;
            else for (b = 0; b < ugo_bone_count(m); b++) {
                ugo_bone_world(x, b, wx); ugo_bone_world(y, b, wy);
                if (memcmp(wx, wy, sizeof wx) != 0) { differ++; break; }
            }
        }
    }
    CHECK(differ == 0, "%s: %u step(s) differ from computing everything afresh", name, differ);
    printf("%s: what updates keep is what computing afresh gives (%u animations)\n", name, na);
    free(mm); free(i1); free(i2);
}

int main(int argc, char **argv)
{
    uint32_t size = 0, hsize = 0;
    uint8_t *raw, *data, *hraw = NULL, *hdata = NULL;
    void *dbuf, *hbuf = NULL;
    int i;
    if (argc < 2) { fprintf(stderr, "usage: ugo_test model.ug9 [heavy.ug9]\n"); return 2; }
    raw = read_file(argv[1], &size);
    if (!raw) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }
    dbuf = malloc((size_t)size + 16);
    data = (uint8_t *)ALIGN16(dbuf);
    memcpy(data, raw, size);
    test_basic(data, size);
    test_runs(argv[1], data, size);
    test_kept(argv[1], data, size);
    test_corrupt(data, size);
    bench("basic", data, size, 200);
    for (i = 2; i < argc; i++) { /* --fuzz: more models through the corrupted-file runs */
        uint32_t fsize = 0;
        uint8_t *fraw, *fdata;
        void *fbuf;
        if (strcmp(argv[i], "--fuzz") != 0 || i + 1 >= argc) continue;
        fraw = read_file(argv[++i], &fsize);
        if (!fraw) { CHECK(0, "cannot read %s", argv[i]); continue; }
        fbuf = malloc((size_t)fsize + 16);
        fdata = (uint8_t *)ALIGN16(fbuf);
        memcpy(fdata, fraw, fsize);
        test_finite(argv[i], fdata, fsize);
        test_runs(argv[i], fdata, fsize);
        test_kept(argv[i], fdata, fsize);
        test_masks(fdata, fsize);
        test_corrupt(fdata, fsize);
        free(fraw); free(fbuf);
    }
    if (argc > 2 && strcmp(argv[2], "--fuzz") != 0 && (hraw = read_file(argv[2], &hsize)) != NULL) {
        hbuf = malloc((size_t)hsize + 16);
        hdata = (uint8_t *)ALIGN16(hbuf);
        memcpy(hdata, hraw, hsize);
        bench("heavy", hdata, hsize, 200);
    }
    free(raw); free(dbuf); free(hraw); free(hbuf);
    if (failures) { printf("%d check(s) failed\n", failures); return 1; }
    printf("all checks passed\n");
    return 0;
}
