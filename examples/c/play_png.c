/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* The core from C, start to end: load a .ug9 and its textures, play an animation, draw a frame on the
 * processor and write it as a PNG. The core allocates nothing and reads no files: the caller gives it the
 * bytes and the memory (see docs/芯のAPI.md).
 *
 *   cc -std=c99 -O2 -Icore/include -Ithird_party examples/c/play_png.c core/src/ugo.c core/src/ugo_raster.c -lm -o play_png
 *   ./play_png samples/basic/model.ug9 idle 0.5 out.png 420 600
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ugo.h"
#include "ugo_raster.h"
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

/* 16-byte aligned memory (the core asks for it); kept with the pointer malloc gave, to free it */
typedef struct { void *raw, *at; } Block;
static Block block(size_t n) { Block b; b.raw = malloc(n + 16); b.at = b.raw ? (void *)(((size_t)b.raw + 15) & ~(size_t)15) : NULL; return b; }

static unsigned char *read_file(const char *path, long *size)
{
    FILE *f = fopen(path, "rb");
    unsigned char *d;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); *size = ftell(f); fseek(f, 0, SEEK_SET);
    d = (unsigned char *)malloc((size_t)*size + 4);
    if (d && fread(d, 1, (size_t)*size, f) != (size_t)*size) { free(d); d = NULL; }
    fclose(f);
    return d;
}

int main(int argc, char **argv)
{
    const char *path = argc > 1 ? argv[1] : "samples/basic/model.ug9", *anim = argc > 2 ? argv[2] : "", *out = argc > 4 ? argv[4] : "out.png";
    float t = argc > 3 ? (float)atof(argv[3]) : 0.0f;
    uint32_t w = argc > 5 ? (uint32_t)atoi(argv[5]) : 420, h = argc > 6 ? (uint32_t)atoi(argv[6]) : 600, k, n;
    long size = 0;
    unsigned char *data = read_file(path, &size);
    Block file, mm, im, target, scratch, mask;
    UgoModel *m;
    UgoInstance *in;
    UgoImage tex[16];
    char dir[1024];
    const float *canvas;
    float s, view[6];
    uint8_t *rgba;
    int a;
    if (!data) { fprintf(stderr, "cannot read %s\n", path); return 1; }
    /* 1. the model: the file's bytes, 4-byte aligned, and the memory the core says it needs */
    file = block((size_t)size); memcpy(file.at, data, (size_t)size); free(data);
    n = ugo_model_mem_size_for(file.at, (uint32_t)size);
    mm = block(n ? n : 16);
    m = n ? ugo_model_init_sized(mm.at, n, file.at, (uint32_t)size) : NULL;
    if (!m) { fprintf(stderr, "%s: not a .ug9 this core reads (error %d)\n", path, ugo_last_error()); return 1; }
    /* 2. its textures, next to it (straight alpha RGBA) */
    snprintf(dir, sizeof(dir), "%s", path);
    { char *slash = strrchr(dir, '/'); if (slash) slash[1] = 0; else dir[0] = 0; }
    n = ugo_texture_count(m) < 16 ? ugo_texture_count(m) : 16;
    for (k = 0; k < n; k++) {
        char tp[2048];
        int tw, th, tc;
        snprintf(tp, sizeof(tp), "%s%s", dir, ugo_texture_name(m, k));
        tex[k].rgba = stbi_load(tp, &tw, &th, &tc, 4);
        if (!tex[k].rgba) { fprintf(stderr, "cannot read texture %s\n", tp); return 1; }
        tex[k].width = (uint32_t)tw; tex[k].height = (uint32_t)th;
    }
    /* 3. one character: reset, play, update */
    im = block(ugo_instance_mem_size(m));
    in = ugo_instance_init(im.at, m);
    ugo_reset_params(in);
    a = ugo_find_animation(m, anim);
    if (a < 0 && ugo_animation_count(m)) a = 0;
    if (a >= 0) ugo_apply_animation(in, (uint32_t)a, t, 1.0f);
    ugo_update(in, 1.0f / 30.0f);
    /* 4. draw it fitted into w x h on the processor, then write the PNG */
    canvas = ugo_canvas(m);
    s = (float)w / canvas[0] < (float)h / canvas[1] ? (float)w / canvas[0] : (float)h / canvas[1];
    view[0] = s; view[1] = 0; view[2] = 0; view[3] = s;
    view[4] = ((float)w - canvas[0] * s) / 2 + canvas[2] * s; view[5] = ((float)h - canvas[1] * s) / 2 + canvas[3] * s;
    target = block(16 * (size_t)w * h); scratch = block(8 * (size_t)ugo_vertex_count(m) + 8); mask = block(4 * (size_t)w * h);
    ugo_raster_clear((float *)target.at, w, h, 0, 0, 0, 0);
    ugo_raster_instance_masked(in, tex, n, (float *)target.at, w, h, view, (float *)scratch.at, (float *)mask.at);
    rgba = (uint8_t *)malloc(4 * (size_t)w * h);
    ugo_raster_resolve((const float *)target.at, w, h, 1, rgba);
    if (!stbi_write_png(out, (int)w, (int)h, 4, rgba, (int)w * 4)) { fprintf(stderr, "cannot write %s\n", out); return 1; }
    printf("%s: %s at %.2f s -> %s (%ux%u)\n", path, a >= 0 ? ugo_animation_name(m, (uint32_t)a) : "(no animation)", t, out, w, h);
    for (k = 0; k < n; k++) stbi_image_free((void *)tex[k].rgba);
    free(rgba); free(target.raw); free(scratch.raw); free(mask.raw); free(im.raw); free(mm.raw); free(file.raw);
    return 0;
}
