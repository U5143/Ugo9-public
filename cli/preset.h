/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Export presets for ugo_export --preset: the same JSON as web/export_preset.js
 * ({ "ugo9ExportPreset": 1, "fps": 60, "size": { "width": 1920, "height": 1080 }, ... }).
 * Fields ugo_export does not use (name, formats, fileName) and fields it does not know are
 * skipped; a value that does not read is skipped with a line on stderr. */
#ifndef UGO_PRESET_H
#define UGO_PRESET_H

#include <stddef.h>

typedef struct { double t, zoom, x, y; int has_xy, cut; } CamKey; /* one camera key; cut: jump to it (no easing in) */

#define PRESET_MAX_PINNED 64
#define PRESET_MAX_CAMS 32
#define PRESET_MAX_ANIMS 64

/* "perAnim": { "NAME": { ... } }: one animation's settings, over the preset's own when that animation is written */
typedef struct {
    char name[128];
    int has_seconds, has_loops, has_seamless, has_hold, has_fps, skip;
    double seconds, loops, fps; /* loops: that many times the animation's length (1e-3..100); seconds wins */
    int seamless, seamless_loops, hold; /* seamless_loops 0: not given */
} PresetAnim;

typedef struct {
    int has_fps, has_seconds, has_bg, has_anim, has_sampling, has_matte;
    int nearest;               /* "sampling": "nearest" (1) or "linear" (0) */
    double fps, seconds;
    int size_kind;             /* 0 none, 1 width x height (fitted), 2 long side, 3 scale */
    int width, height, long_side;
    double scale;
    char bg[8];                /* "#rrggbb", or "" for transparent */
    char matte[8];             /* GIF: "#rrggbb" the page colour, or "" for none */
    char anim[256];
    int npinned;
    char pinned_name[PRESET_MAX_PINNED][128];
    double pinned_value[PRESET_MAX_PINNED];
    int has_quality, quality;  /* "jpegQuality": 1..100 */
    int has_region;            /* "region": { x, y, width, height } in model pixels */
    double region[4];
    int each_anim;             /* "eachAnim": true */
    int has_hold, hold;        /* "holdFrames": 1..12 */
    int has_seamless, seamless, seamless_loops; /* "seamless": true / false, "seamlessLoops": 1..1000 (0: not given) */
    int has_backdrop, has_backdrop_rect; /* "backdrop": "file" or { file, x, y, width, height } (model pixels) */
    char backdrop[1024];
    double backdrop_rect[4];
    int ncams;                 /* -1: no camera in the preset */
    CamKey cams[PRESET_MAX_CAMS];
    int nper;                  /* "perAnim" */
    PresetAnim per[PRESET_MAX_ANIMS];
} UgoPreset;

/* Reads the preset from JSON text. 0 on success; on failure, why in err. */
int ugo_read_preset(const char *text, size_t n, UgoPreset *p, char *err, size_t errn);
/* 1: ugo_read_preset writes nothing on stderr (for a first look at a preset that is read again later). */
void ugo_preset_quiet(int on);
/* The animation's own settings in the preset (perAnim), or NULL. */
const PresetAnim *ugo_preset_anim(const UgoPreset *p, const char *name);

#endif
