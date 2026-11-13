/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/*
 * Ugo9 software renderer (C99, freestanding, optional).
 *
 * Draws an instance on the CPU with the same math as the GPU path. Used for
 * exporting GIF / APNG / video, for tests, and as a fallback where no GPU
 * is available. Not needed for real-time playback on a GPU.
 */
#ifndef UGO_RASTER_H
#define UGO_RASTER_H

#include "ugo.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const uint8_t *rgba; /* straight (non-premultiplied) alpha, 4 bytes per pixel, rows top to bottom */
    uint32_t width, height;
} UgoImage;

/* Draws `in` (after ugo_update) over `target`, a premultiplied RGBA float
 * image of w*h pixels. `view` is a 2x3 matrix from model space (after the
 * instance transform) to pixel coordinates. `scratch` must hold
 * 2 * ugo_vertex_count() floats. */
UGO_API void ugo_raster_instance(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                                 float *target, uint32_t w, uint32_t h, const float *view, float *scratch);

/* Same, with masks: `mask` must hold w * h floats (scratch for one mask's
 * coverage). ugo_raster_instance draws masked parts without their masks. */
UGO_API void ugo_raster_instance_masked(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                                        float *target, uint32_t w, uint32_t h, const float *view, float *scratch,
                                        float *mask);

/* Same, with options (UGO_RASTER_*; 0 = as ugo_raster_instance_masked). `mask` may be 0 (no masks). */
#define UGO_RASTER_NEAREST 1u /* take each texture's nearest texel instead of blending four (pixel art) */
UGO_API void ugo_raster_instance_ex(const UgoInstance *in, const UgoImage *textures, uint32_t texture_count,
                                    float *target, uint32_t w, uint32_t h, const float *view, float *scratch,
                                    float *mask, uint32_t flags);

/* Fills a premultiplied float image with one colour (alpha 0 = transparent). */
UGO_API void ugo_raster_clear(float *target, uint32_t w, uint32_t h, float r, float g, float b, float a);

/* Box-filters a (w*factor) x (h*factor) premultiplied float image down to
 * w x h RGBA8 with straight alpha. */
UGO_API void ugo_raster_resolve(const float *src, uint32_t w, uint32_t h, uint32_t factor, uint8_t *out_rgba);

#ifdef __cplusplus
}
#endif

#endif
