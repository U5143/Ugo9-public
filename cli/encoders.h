/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Animated image writers used by ugo_export (GIF, APNG). */
#ifndef UGO_ENCODERS_H
#define UGO_ENCODERS_H

#include <stdint.h>
#include <stdio.h>

/* frames: count images of w*h RGBA8 (straight alpha), back to back.
 * GIF has 1-bit transparency: pixels with alpha < 128 become transparent.
 * Composite onto a background first for smooth edges. */
int ugo_write_gif(FILE *f, const uint8_t *frames, uint32_t count, uint32_t w, uint32_t h,
                  double fps, int dither);

/* Streaming APNG writer. */
typedef struct {
    FILE *f;
    uint32_t w, h, count, seq, written;
    uint16_t delay_num, delay_den;
} UgoApng;

/* 30 for 29.97 (30000 / 1001), 24 for 23.976, ...; 0 when fps is not an NTSC rate */
int ugo_ntsc_rate(double fps);
int ugo_apng_begin(UgoApng *a, FILE *f, uint32_t w, uint32_t h, uint32_t frame_count, double fps);
int ugo_apng_frame(UgoApng *a, const uint8_t *rgba);
int ugo_apng_end(UgoApng *a);

#endif
