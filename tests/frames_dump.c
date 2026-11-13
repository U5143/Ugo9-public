/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Writes the frame blocks of a fixed run of each model (every animation, a second one mixed in,
 * parameters, wind, physics) to a file, for tests/determinism_test.mjs to compare with the same run
 * in WebAssembly: the core must give the same bits on every machine.
 *   frames_dump out.bin model.ug9 ...   (the run is the same as in determinism_test.mjs) */
#include <stdio.h>
#include <stdlib.h>
#include "ugo.h"

static void *alloc16(size_t n)
{
    unsigned char *p = (unsigned char *)malloc(n + 16);
    return p ? (void *)(((size_t)p + 15) & ~(size_t)15) : NULL; /* (never freed: a short-lived tool) */
}

int main(int argc, char **argv)
{
    FILE *out;
    int f;
    if (argc < 3) { fprintf(stderr, "usage: frames_dump out.bin model.ug9 ...\n"); return 2; }
    out = fopen(argv[1], "wb");
    if (!out) return 1;
    for (f = 2; f < argc; f++) {
        FILE *fp = fopen(argv[f], "rb");
        long n;
        unsigned char *d;
        uint32_t need, a, i, k, na;
        UgoModel *m;
        UgoInstance *in;
        if (!fp) return 1;
        fseek(fp, 0, SEEK_END); n = ftell(fp); fseek(fp, 0, SEEK_SET);
        d = (unsigned char *)alloc16((size_t)n);
        if (fread(d, 1, (size_t)n, fp) != (size_t)n) return 1;
        fclose(fp);
        need = ugo_model_mem_size_for(d, (uint32_t)n);
        m = need ? ugo_model_init_sized(alloc16(need), need, d, (uint32_t)n) : NULL;
        if (!m) { fprintf(stderr, "%s: error %d\n", argv[f], ugo_last_error()); return 1; }
        in = ugo_instance_init(alloc16(ugo_instance_mem_size(m)), m);
        ugo_set_wind(in, 250.0f, -40.0f, 1.25f);
        na = ugo_animation_count(m);
        for (a = 0; a < (na ? na : 1); a++)
            for (i = 0; i < 60; i++) {
                ugo_reset_params(in);
                for (k = 0; k < ugo_param_count(m); k++) /* each parameter on a slow wave */
                    if (k % 3 == (i / 20) % 3) ugo_set_param(in, k, ugo_param_min(m, k) + (ugo_param_max(m, k) - ugo_param_min(m, k)) * (float)(i % 20) / 19.0f);
                if (na) {
                    ugo_apply_animation(in, a, (float)i / 30.0f, 1.0f);
                    if (i % 3 == 0) ugo_apply_animation(in, (a + 1) % na, (float)i / 20.0f, 0.4f);
                }
                ugo_set_transform(in, 1.0f, 0.0f, 0.0f, 1.0f, (float)(i % 7) * 3.0f, 0.0f);
                ugo_update(in, 1.0f / 30.0f);
                fwrite(ugo_frame(in), 4, ugo_frame_float_count(m), out);
                fwrite(ugo_draw_order(in), 4, ugo_part_count(m), out);
            }
    }
    fclose(out);
    return 0;
}
