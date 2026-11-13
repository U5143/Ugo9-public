/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/*
 * ugo_export: renders a .ug9 model (or a .ugo, its name before) on the CPU and writes PNG frames, APNG,
 * GIF, a sprite sheet, raw RGBA, or (through ffmpeg) MP4 / WebM.
 *
 *   ugo_export model.ug9 --anim idle --out idle.gif
 *   ugo_export model.ug9 --anim talk --seconds 4 --size 300x400 --out talk.apng
 *   ugo_export model.ug9 --param AngleX=20 --frames 1 --out still.png
 *   ugo_export model.ug9 --anim idle --camera 0:1 --camera 2:2.5:120,80 --out zoom.mp4
 *   ugo_export model.ug9 --preset pv.json --out pv.mp4
 *   ugo_export pixel.ug9 --nearest --ss 1 --size 640x640 --out big.png
 */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L /* popen */
#endif
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "encoders.h"
#include "preset.h"
#include "ugo.h"
#include "ugo_raster.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_WINDOWS_UTF8
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBIW_WINDOWS_UTF8
#include "stb_image_write.h"

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <io.h>
#include <fcntl.h>
#define popen _popen
#define pclose _pclose
#define POPEN_WRITE "wb"
#else
#define POPEN_WRITE "w"
#include <pthread.h>
#include <unistd.h>
#endif

/* ---- UTF-8 file names on every OS ----------------------------------------- */

static FILE *open_file(const char *path, const char *mode)
{
#ifdef _WIN32
    wchar_t wpath[1024], wmode[8];
    if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, 1024)) return NULL;
    if (!MultiByteToWideChar(CP_UTF8, 0, mode, -1, wmode, 8)) return NULL;
    return _wfopen(wpath, wmode);
#else
    return fopen(path, mode);
#endif
}

static void *read_file(const char *path, uint32_t *size)
{
    FILE *f = open_file(path, "rb");
    long n;
    void *p;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    p = n > 0 ? malloc((size_t)n + 16) : NULL;
    if (p && fread(p, 1, (size_t)n, f) != (size_t)n) { free(p); p = NULL; }
    fclose(f);
    *size = (uint32_t)n;
    return p;
}

static void *aligned_alloc16(size_t n)
{
    /* malloc is at least 8-aligned; over-allocate and align by hand */
    uint8_t *raw = (uint8_t *)malloc(n + 16 + sizeof(void *));
    uint8_t *p;
    if (!raw) return NULL;
    p = (uint8_t *)(((uintptr_t)(raw + sizeof(void *)) + 15u) & ~(uintptr_t)15u);
    ((void **)p)[-1] = raw;
    return p;
}

static void aligned_free16(void *p)
{
    if (p) free(((void **)p)[-1]);
}

static const char *ext_of(const char *path)
{
    const char *dot = strrchr(path, '.');
    const char *slash1 = strrchr(path, '/'), *slash2 = strrchr(path, '\\');
    if (!dot || (slash1 && slash1 > dot) || (slash2 && slash2 > dot)) return "";
    return dot + 1;
}

static int ieq(const char *a, const char *b)
{
    while (*a && *b) {
        char x = *a, y = *b;
        if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
        if (y >= 'A' && y <= 'Z') y = (char)(y - 'A' + 'a');
        if (x != y) return 0;
        a++; b++;
    }
    return *a == *b;
}

static void usage(void)
{
    fprintf(stderr,
            "usage: ugo_export MODEL.ug9 --out FILE [--out FILE ...] [options]\n"
            "  --out FILE         .gif .apng/.png .webm .mp4 .mov .rgba .jpg, or a folder with --format frames\n"
            "                     (PNG) or jpeg (JPEG: NAME.jpg for one frame, NAME_00000.jpg... for more,\n"
            "                     or frame_00000.jpg... in a folder);\n"
            "                     repeat to write several formats from one drawing\n"
            "  --format F         gif | apng | frames | jpeg | sheet | mp4 | webm | mov | raw for the last --out\n"
            "                     (mov: ProRes 4444 with its transparency, for video editors; mp4, webm and mov need ffmpeg)\n"
            "                     (or the next one; default: from the file name)\n"
            "  --anim NAME        animation to play (default: the first one); repeat to layer\n"
            "                     more on top (each overrides only what its tracks drive)\n"
            "  --seconds S        length (default: the animation's duration)\n"
            "  --start S          time of the first frame (default 0)\n"
            "  --frames N         number of frames (overrides --seconds)\n"
            "  --fps N            frames per second (default 30)\n"
            "  --size WxH         output size (default: the model's canvas)\n"
            "  --pad P            widen the canvas by P model pixels on every side\n"
            "  --ss N             supersampling for smooth edges (default 2)\n"
            "  --threads N        draw N frames at once (default: the processors, up to 8; 1: one at a time).\n"
            "                     The picture is the same for any N\n"
            "  --max-held MB      gif and sheet hold every frame until the end; stop before drawing when they would\n"
            "                     hold more than MB (default 4096; 0: no limit)\n"
            "  --bg #RRGGBB       background colour (default: transparent; mp4 uses white)\n"
            "  --backdrop FILE[:X,Y,W,H]  a picture (PNG / JPEG) behind the model, moving with it and the camera; by\n"
            "                     default it covers the canvas (its shape kept), else at X,Y W x H in model px\n"
            "  --param NAME=V     hold a parameter at a value (repeatable)\n"
            "  --warmup S         seconds of physics before recording (default: one loop)\n"
            "  --seamless         loop without a jump: after the warmup, the physics runs one more loop at a time\n"
            "                     until the pose at the loop's start stops changing (said on stderr with the seam\n"
            "                     left: the largest change of a pose value between two loops)\n"
            "  --seamless-loops N at most N loops for --seamless (default 50; only the physics runs, nothing is drawn)\n"
            "  --no-dither        GIF without ordered dithering\n"
            "  --quality Q        JPEG quality 1..100 (default 90); JPEG has no transparency: over --bg\n"
            "                     (default white)\n"
            "  --crop X,Y,W,H     keep only this part of the picture (pixels of the --size picture)\n"
            "  --hold N           draw on N's (2: a new pose every second frame, as hand-drawn\n"
            "                     animation on twos); the file keeps --fps\n"
            "  --each-anim        one export per animation: {anim} in an --out is its name (else\n"
            "                     _NAME goes before the extension)\n"
            "  --matte #RRGGBB    GIF: the colour of the page it goes on; half-transparent edges are mixed\n"
            "                     with it (no dark rim); pixels under a quarter opaque stay transparent\n"
            "  --nearest          take each texture's nearest texel (pixel art: dots stay sharp\n"
            "                     when scaled up; add --ss 1 to keep the edges sharp too)\n"
            "  --preset FILE      export settings from a preset (.json, the same as the editor's):\n"
            "                     fps, size, scale, background, anim, seconds, pinned, camera,\n"
            "                     sampling;\n"
            "                     options written after it win over its values\n"
            "  --camera T:ZOOM[:X,Y]  a camera key: at T seconds from the first frame, ZOOM times\n"
            "                     closer, the model point X,Y (model pixels) in the middle\n"
            "                     (default: the canvas's middle). Repeat for more keys; between\n"
            "                     keys it eases in and out, before the first and after the last\n"
            "                     it holds; :cut at the end jumps to the key at its time (a cut)\n");
}

/* writes s as the inside of a JSON string */
static void json_text(FILE *f, const char *s)
{
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') fprintf(f, "\\%c", *s);
        else if ((unsigned char)*s < 0x20) fprintf(f, "\\u%04x", (unsigned char)*s);
        else fputc(*s, f);
    }
}

typedef struct { int index; float value; } Hold;

/* why a .ug9 did not load, in words (the error code at the end, for reports). A version that is not read: the file's
   format against what this build reads, and what to do */
static void say_load_error(const char *path, const void *data, uint32_t size, int err)
{
    const unsigned char *b = (const unsigned char *)data;
    unsigned fmaj = size >= 8 ? (unsigned)(b[4] | b[5] << 8) : 0, fmin = size >= 8 ? (unsigned)(b[6] | b[7] << 8) : 0;
    unsigned me = (unsigned)ugo_version(), mmaj = me >> 16, mmin = me & 0xffff;
    if (err == UGO_ERR_MAGIC) fprintf(stderr, "%s: not a .ug9 file (it does not start with UGO9; export the model as .ug9 first)", path);
    else if (err == UGO_ERR_VERSION && (fmaj > mmaj || (fmaj == mmaj && fmin > mmin)))
        fprintf(stderr, "%s: made with a newer Ugo9: the file is format %u.%u and needs a newer ugo_export (this one reads %u.0 to %u.%u)", path, fmaj, fmin, mmaj, mmaj, mmin);
    else if (err == UGO_ERR_VERSION) fprintf(stderr, "%s: made with an old Ugo9 (format %u.%u; this reads %u.x): compile it again from its working file", path, fmaj, fmin, mmaj);
    else if (err == UGO_ERR_SIZE) fprintf(stderr, "%s: the file is cut short or its size does not match its header (copied only in part?)", path);
    else if (err == UGO_ERR_LIMIT) fprintf(stderr, "%s: a count in the file is over the format's limits", path);
    else if (err == UGO_ERR_RANGE || err == UGO_ERR_VALUE || err == UGO_ERR_ALIGN) fprintf(stderr, "%s: the file is broken (a table points outside the file or holds a value that cannot be)", path);
    else fprintf(stderr, "%s: not a valid .ug9 file", path);
    fprintf(stderr, " (error %d)\n", err);
}

/* "T:ZOOM" or "T:ZOOM:X,Y" -> key; 0 if it does not read */
static int parse_camera(const char *v, CamKey *c)
{
    char tail[64] = "";
    size_t n;
    int k = sscanf(v, "%lf:%lf:%63s", &c->t, &c->zoom, tail);
    if (k < 2 || c->t < 0 || !(c->zoom > 0) || c->zoom > 1000) return 0;
    c->has_xy = 0;
    c->cut = 0;
    n = strlen(tail);
    if (n >= 3 && !strcmp(tail + n - 3, "cut") && (n == 3 || tail[n - 4] == ':')) { /* "...:cut": jump to this key */
        c->cut = 1;
        tail[n == 3 ? 0 : n - 4] = 0;
    }
    if (tail[0]) {
        char rest = 0;
        if (sscanf(tail, "%lf,%lf%c", &c->x, &c->y, &rest) != 2) return 0;
        c->has_xy = 1;
    }
    return 1;
}

/* the camera at time t (keys sorted by time): zoom and the model point in the middle */
static void camera_at(const CamKey *keys, int n, double t, double *zoom, double *x, double *y)
{
    int i = 0;
    double u;
    if (t <= keys[0].t || n == 1) { *zoom = keys[0].zoom; *x = keys[0].x; *y = keys[0].y; return; }
    if (t >= keys[n - 1].t) { *zoom = keys[n - 1].zoom; *x = keys[n - 1].x; *y = keys[n - 1].y; return; }
    while (i + 1 < n && keys[i + 1].t <= t) i++;
    if (keys[i + 1].cut) { *zoom = keys[i].zoom; *x = keys[i].x; *y = keys[i].y; return; } /* held until the cut */
    u = (t - keys[i].t) / (keys[i + 1].t - keys[i].t);
    u = u * u * (3 - 2 * u); /* ease in and out */
    /* zoom between keys on a log scale, so 1 -> 4 passes 2 halfway */
    *zoom = exp(log(keys[i].zoom) + (log(keys[i + 1].zoom) - log(keys[i].zoom)) * u);
    *x = keys[i].x + (keys[i + 1].x - keys[i].x) * u;
    *y = keys[i].y + (keys[i + 1].y - keys[i].y) * u;
}
typedef struct { const char *path, *format; FILE *f; int piped; UgoApng apng; } Output; /* one --out */

/* The steps that make each frame's pose: the warmup, --seamless, then one step per drawn frame. With --threads every
   drawing thread's instance takes all the same steps in the same order (they are cheap; the drawing is not), so its
   poses are the same bits as a single instance's and the picture does not depend on the number of threads. */
typedef struct {
    const UgoModel *model;
    const int *anims;
    int nanims, nparams, anim, hold, seamless, seamless_loops;
    const Hold *holds;
    double fps, start, warmup;
} PoseSteps;

static void pose_at(const PoseSteps *p, UgoInstance *inst, double t, double dt)
{
    int i;
    ugo_reset_params(inst);
    for (i = 0; i < p->nanims; i++) ugo_apply_animation(inst, (uint32_t)p->anims[i], (float)t, 1.0f); /* loops wrap negative times */
    for (i = 0; i < p->nparams; i++) ugo_set_param(inst, (uint32_t)p->holds[i].index, p->holds[i].value);
    ugo_update(inst, (float)dt);
}

/* warm up physics so loops start in a settled state (and, with --seamless, until the loop's start settles).
   say: print what --seamless did. -> 0, or 1 when out of memory */
static int pose_warm(const PoseSteps *p, UgoInstance *inst, int say)
{
    double t = p->start - p->warmup, dt = 1.0 / p->fps;
    for (; t < p->start - 1e-9; t += dt) pose_at(p, inst, t, dt);
    if (p->seamless) { /* more loops until the pose at the loop's start settles */
        double len = p->anim >= 0 ? ugo_animation_duration(p->model, (uint32_t)p->anim) : 0;
        uint32_t nf = ugo_frame_float_count(p->model), steps = len > 0 ? (uint32_t)(len * p->fps + 0.5) : 0, j, q;
        float *prev = (float *)malloc(sizeof(float) * (nf ? nf : 1));
        double seam = -1;
        int loops = 0;
        if (!steps) { if (say) fprintf(stderr, "--seamless: no animation to loop (left as it is)\n"); }
        else if (!prev) { fprintf(stderr, "out of memory\n"); return 1; }
        else {
            memcpy(prev, ugo_frame(inst), sizeof(float) * nf);
            for (loops = 1; loops <= p->seamless_loops; loops++) {
                const float *cur;
                for (j = 0; j < steps; j++) pose_at(p, inst, p->start - len + j * dt, dt); /* the same steps as the warmup's, one loop of them */
                cur = ugo_frame(inst);
                seam = 0;
                for (q = 0; q < nf; q++) { double d = fabs((double)cur[q] - prev[q]); if (d > seam) seam = d; }
                memcpy(prev, cur, sizeof(float) * nf);
                if (seam < 1e-3) break;
            }
            if (loops > p->seamless_loops) loops = p->seamless_loops;
            if (say) fprintf(stderr, seam < 1e-3 ? "seamless: settled after %d more loop(s) (seam %.5f)\n" : "seamless: not settled after %d more loops (seam %.5f; try more with --seamless-loops)\n", loops, seam);
        }
        free(prev);
    }
    return 0;
}

/* one drawn frame's pose */
static void pose_frame(const PoseSteps *p, UgoInstance *inst, uint32_t fi)
{
    pose_at(p, inst, p->start + fi / p->fps, fi == 0 && p->warmup <= 0 ? 0.0 : (double)p->hold / p->fps);
}

/* How a frame is drawn: the same for every thread */
typedef struct {
    const UgoImage *tex;
    uint32_t ntex;
    int out_w, out_h, ss, ncams, has_bg, nearest;
    const CamKey *cams;
    float view[6], scale, bg_rgb[3];
    const UgoImage *backdrop; /* a picture behind the model (--backdrop), or 0 */
    float backdrop_rect[4];   /* where it lies, model px: x, y, w, h (it moves with the camera) */
} DrawSetup;

/* the backdrop over what is in accum (the background colour or transparent): each pixel's point in the model, looked up
   in the picture (bilinear, straight alpha made premultiplied) */
static void draw_backdrop(const DrawSetup *d, const float *view, float *accum, uint32_t W, uint32_t H)
{
    const UgoImage *im = d->backdrop;
    const float *r = d->backdrop_rect;
    uint32_t x, y;
    int k;
    if (!im || view[0] == 0 || view[3] == 0 || r[2] <= 0 || r[3] <= 0) return;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        float mx = ((float)x + 0.5f - view[4]) / view[0], my = ((float)y + 0.5f - view[5]) / view[3];
        float u = (mx - r[0]) / r[2] * (float)im->width - 0.5f, v = (my - r[1]) / r[3] * (float)im->height - 0.5f;
        float c[4] = { 0, 0, 0, 0 }, fu, fv, a, *o;
        int x0, y0;
        if (u < -0.5f || v < -0.5f || u > (float)im->width - 0.5f || v > (float)im->height - 0.5f) continue;
        x0 = (int)floorf(u); y0 = (int)floorf(v); fu = u - (float)x0; fv = v - (float)y0;
        for (k = 0; k < 4; k++) {
            int sx = x0 + (k & 1), sy = y0 + (k >> 1), ch;
            float w = ((k & 1) ? fu : 1 - fu) * ((k >> 1) ? fv : 1 - fv);
            const uint8_t *px;
            sx = sx < 0 ? 0 : sx >= (int)im->width ? (int)im->width - 1 : sx;
            sy = sy < 0 ? 0 : sy >= (int)im->height ? (int)im->height - 1 : sy;
            px = im->rgba + 4 * ((size_t)sy * im->width + (size_t)sx);
            for (ch = 0; ch < 3; ch++) c[ch] += w * (float)px[ch] / 255.0f * (float)px[3] / 255.0f; /* premultiplied */
            c[3] += w * (float)px[3] / 255.0f;
        }
        a = c[3];
        o = accum + 4 * ((size_t)y * W + x);
        for (k = 0; k < 4; k++) o[k] = c[k] + o[k] * (1 - a);
    }
}

/* draws the posed instance for frame fi into out (RGBA8, straight alpha); accum, scratch, mask: this drawer's own */
static void draw_frame(const DrawSetup *d, const UgoInstance *inst, uint32_t fi, double fps, float *accum, float *scratch, float *mask, uint8_t *out)
{
    float view[6];
    uint32_t W = (uint32_t)d->out_w * (uint32_t)d->ss, H = (uint32_t)d->out_h * (uint32_t)d->ss;
    memcpy(view, d->view, sizeof(view));
    if (d->ncams) { /* the camera: scale about the model point it looks at, put in the middle */
        double z, cx, cy, s;
        camera_at(d->cams, d->ncams, fi / fps, &z, &cx, &cy);
        s = d->scale * z * d->ss;
        view[0] = view[3] = (float)s;
        view[4] = (float)(d->out_w * 0.5 * d->ss - cx * s);
        view[5] = (float)(d->out_h * 0.5 * d->ss - cy * s);
    }
    if (d->has_bg) ugo_raster_clear(accum, W, H, d->bg_rgb[0], d->bg_rgb[1], d->bg_rgb[2], 1.0f);
    else ugo_raster_clear(accum, W, H, 0, 0, 0, 0);
    draw_backdrop(d, view, accum, W, H);
    ugo_raster_instance_ex(inst, d->tex, d->ntex, accum, W, H, view, scratch, mask, d->nearest ? UGO_RASTER_NEAREST : 0u);
    ugo_raster_resolve(accum, (uint32_t)d->out_w, (uint32_t)d->out_h, (uint32_t)d->ss, out);
}

/* one drawing thread: its own instance (posed by the same steps) and buffers; each round it takes the steps up to its
   frame and draws it */
typedef struct {
    const PoseSteps *ps;
    const DrawSetup *ds;
    void *mem;
    UgoInstance *inst;
    float *accum, *scratch, *mask;
    uint8_t *out;
    uint32_t next, target; /* the next frame whose step it has not taken; the frame it draws this round */
    int warmed, say, fail;
} Drawer;

static void drawer_run(Drawer *w)
{
    uint32_t f, step = w->ps->hold > 1 ? (uint32_t)w->ps->hold : 1u;
    if (!w->warmed) { w->warmed = 1; if (pose_warm(w->ps, w->inst, w->say)) { w->fail = 1; return; } }
    for (f = w->next; f <= w->target; f += step) pose_frame(w->ps, w->inst, f);
    w->next = w->target + step;
    draw_frame(w->ds, w->inst, w->target, w->ps->fps, w->accum, w->scratch, w->mask, w->out);
}

#ifdef _WIN32
static DWORD WINAPI drawer_main(LPVOID a) { drawer_run((Drawer *)a); return 0; }
#else
static void *drawer_main(void *a) { drawer_run((Drawer *)a); return NULL; }
#endif

/* runs drawers 0..n-1 at once (the last on this thread) and waits for them. -> 0, or 1 when a thread could not start */
static int run_drawers(Drawer *w, int n)
{
    int k, bad = 0;
#ifdef _WIN32
    HANDLE th[64];
    for (k = 0; k < n - 1; k++) { th[k] = CreateThread(NULL, 0, drawer_main, &w[k], 0, NULL); if (!th[k]) { drawer_run(&w[k]); } }
    drawer_run(&w[n - 1]);
    for (k = 0; k < n - 1; k++) if (th[k]) { WaitForSingleObject(th[k], INFINITE); CloseHandle(th[k]); }
#else
    pthread_t th[64];
    int ok[64];
    for (k = 0; k < n - 1; k++) { ok[k] = pthread_create(&th[k], NULL, drawer_main, &w[k]) == 0; if (!ok[k]) drawer_run(&w[k]); }
    drawer_run(&w[n - 1]);
    for (k = 0; k < n - 1; k++) if (ok[k]) pthread_join(th[k], NULL);
#endif
    for (k = 0; k < n; k++) bad |= w[k].fail;
    return bad;
}

/* the computer's processors */
static int cpu_count(void)
{
#ifdef _WIN32
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return (int)si.dwNumberOfProcessors;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? (int)n : 1;
#endif
}

static int export_once(int argc, char **argv)
{
    const char *model_path = NULL, *anim_names[8], *bg = NULL, *pending_format = NULL, *matte = NULL, *backdrop_spec = NULL;
    UgoImage backdrop = { 0, 0, 0 };
    float backdrop_rect[4] = { 0, 0, 0, 0 };
    Output outs[8];
    int nouts = 0, any_buffered = 0, any_opaque = 0, any_sheet = 0;
    double max_held = 4096;
    double seconds = -1, fps = 30, warmup = -1, pad = 0, start = 0;
    int seamless = 0, seamless_loops = 50, threads = 0, ndrawers = 0;
    Drawer *drawers = NULL;
    PoseSteps ps;
    DrawSetup ds;
    int frames_n = -1, ss = 2, dither = 1, out_w = 0, out_h = 0, i, anim = -1, nanims = 0, anims[8];
    char *param_specs[64];
    int nparams = 0;
    Hold holds[64];
    CamKey cams[32];
    int ncams = 0, cams_from_preset = 0, anims_from_preset = 0, size_mode = 0, long_side = 0; /* size_mode: 0 --size/canvas, 2 long side, 3 scale */
    double size_scale = 1;
    static UgoPreset preset;
    /* where each setting was last given (argv index), and the preset: a perAnim value is used unless a flag after the preset set it */
    int preset_at = -1, at_fps = -1, at_len = -1, at_seamless = -1, at_sloops = -1, at_hold = -1;
    static char pinned_specs[64][192]; /* the preset's pinned values as NAME=V */
    int rc = 0, nearest = 0, hold = 1, quality = 90, has_crop = 0, crop[4] = { 0, 0, 0, 0 }, has_region = 0;
    double region[4] = { 0, 0, 0, 0 }; /* the preset's region (model pixels), made a crop once the view is known */
    uint32_t size = 0, k, nfr;
    void *data = NULL, *model_mem = NULL, *inst_mem = NULL;
    UgoModel *model;
    UgoInstance *inst;
    UgoImage tex[16];
    uint32_t ntex = 0;
    float canvas[4], view[6], scale, *accum = NULL, *scratch = NULL, *maskbuf = NULL, bg_rgb[3] = { 1, 1, 1 };
    int has_bg = 0;
    uint8_t *frame = NULL, *all = NULL, *opaque = NULL, *matted = NULL;
    int has_matte = 0;
    unsigned matte_rgb = 0;
    char dir[1024];
    size_t dl;

#ifdef _WIN32
    { /* get UTF-8 arguments */
        int wc, j;
        wchar_t **wargv = CommandLineToArgvW(GetCommandLineW(), &wc);
        static char *uargv[256];
        for (j = 0; j < wc && j < 256; j++) {
            int n = WideCharToMultiByte(CP_UTF8, 0, wargv[j], -1, NULL, 0, NULL, NULL);
            uargv[j] = (char *)malloc((size_t)n);
            WideCharToMultiByte(CP_UTF8, 0, wargv[j], -1, uargv[j], n, NULL, NULL);
        }
        argc = wc < 256 ? wc : 256;
        argv = uargv;
    }
#endif

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
#define NEXT() do { if (!v) { usage(); return 2; } i++; } while (0)
        if (!strcmp(a, "--out")) {
            NEXT();
            if (nouts == 8) { fprintf(stderr, "at most 8 --out\n"); return 2; }
            memset(&outs[nouts], 0, sizeof(outs[nouts]));
            outs[nouts].path = v;
            outs[nouts++].format = pending_format;
            pending_format = NULL;
        }
        else if (!strcmp(a, "--format")) { NEXT(); if (nouts && !outs[nouts - 1].format) outs[nouts - 1].format = v; else pending_format = v; }
        else if (!strcmp(a, "--anim")) { NEXT(); if (anims_from_preset) { nanims = 0; anims_from_preset = 0; } if (nanims < 8) anim_names[nanims++] = v; }
        else if (!strcmp(a, "--seconds")) { NEXT(); seconds = atof(v); at_len = i; }
        else if (!strcmp(a, "--start")) { NEXT(); start = atof(v); }
        else if (!strcmp(a, "--frames")) { NEXT(); frames_n = atoi(v); at_len = i; }
        else if (!strcmp(a, "--fps")) { NEXT(); fps = atof(v); at_fps = i; }
        else if (!strcmp(a, "--size")) { NEXT(); if (sscanf(v, "%dx%d", &out_w, &out_h) != 2) { usage(); return 2; } size_mode = 0; }
        else if (!strcmp(a, "--pad")) { NEXT(); pad = atof(v); }
        else if (!strcmp(a, "--ss")) { NEXT(); ss = atoi(v); }
        else if (!strcmp(a, "--max-held")) { NEXT(); max_held = atof(v); if (max_held < 0) { fprintf(stderr, "--max-held must be 0 or more\n"); return 2; } }
        else if (!strcmp(a, "--threads")) { NEXT(); threads = atoi(v); if (threads < 1 || threads > 64) { fprintf(stderr, "--threads must be 1..64\n"); return 2; } }
        else if (!strcmp(a, "--bg")) { NEXT(); bg = v; }
        else if (!strcmp(a, "--backdrop")) { NEXT(); backdrop_spec = v; }
        else if (!strcmp(a, "--param")) { NEXT(); if (nparams < 64) param_specs[nparams++] = (char *)v; }
        else if (!strcmp(a, "--warmup")) { NEXT(); warmup = atof(v); }
        else if (!strcmp(a, "--seamless")) { seamless = 1; at_seamless = i; }
        else if (!strcmp(a, "--seamless-loops")) { NEXT(); seamless_loops = atoi(v); at_sloops = i; if (seamless_loops < 1 || seamless_loops > 1000) { fprintf(stderr, "--seamless-loops must be 1..1000\n"); return 2; } }
        else if (!strcmp(a, "--no-dither")) dither = 0;
        else if (!strcmp(a, "--quality")) { NEXT(); quality = atoi(v); if (quality < 1 || quality > 100) { fprintf(stderr, "--quality must be 1..100\n"); return 2; } }
        else if (!strcmp(a, "--hold")) { NEXT(); hold = atoi(v); at_hold = i; if (hold < 1 || hold > 12) { fprintf(stderr, "--hold must be 1..12\n"); return 2; } }
        else if (!strcmp(a, "--crop")) { NEXT(); if (sscanf(v, "%d,%d,%d,%d", &crop[0], &crop[1], &crop[2], &crop[3]) != 4 || crop[0] < 0 || crop[1] < 0 || crop[2] < 1 || crop[3] < 1) { fprintf(stderr, "--crop needs X,Y,W,H (W, H at least 1)\n"); return 2; } has_crop = 1;  has_region = 0; }
        else if (!strcmp(a, "--matte")) { NEXT(); matte = v; }
        else if (!strcmp(a, "--nearest")) nearest = 1;
        else if (!strcmp(a, "--preset")) {
            uint32_t pn = 0;
            char *text, err[160];
            int j;
            NEXT();
            text = (char *)read_file(v, &pn);
            if (!text) { fprintf(stderr, "cannot read %s\n", v); return 1; }
            j = ugo_read_preset(text, pn, &preset, err, sizeof(err));
            free(text);
            if (j) { fprintf(stderr, "%s: %s\n", v, err); return 2; }
            preset_at = i;
            if (preset.has_fps) fps = preset.fps;
            if (preset.has_seconds) { seconds = preset.seconds; frames_n = -1; }
            if (preset.size_kind == 1) { out_w = preset.width; out_h = preset.height; size_mode = 0; }
            else if (preset.size_kind == 2) { size_mode = 2; long_side = preset.long_side; }
            else if (preset.size_kind == 3) { size_mode = 3; size_scale = preset.scale; }
            if (preset.has_bg) bg = preset.bg[0] ? preset.bg : NULL;
            if (preset.has_matte) matte = preset.matte[0] ? preset.matte : NULL;
            if (preset.has_anim) { anim_names[0] = preset.anim; nanims = 1; anims_from_preset = 1; }
            for (j = 0; j < preset.npinned && nparams < 64; j++) { /* held like --param NAME=V */
                snprintf(pinned_specs[nparams], sizeof(pinned_specs[nparams]), "%s=%.17g", preset.pinned_name[j], preset.pinned_value[j]);
                param_specs[nparams] = pinned_specs[nparams];
                nparams++;
            }
            if (preset.has_sampling) nearest = preset.nearest;
            if (preset.has_quality) quality = preset.quality;
            if (preset.has_hold) hold = preset.hold;
            if (preset.has_seamless) seamless = preset.seamless;
            if (preset.seamless_loops) seamless_loops = preset.seamless_loops;
            if (preset.has_region) { memcpy(region, preset.region, sizeof(region)); has_region = 1; has_crop = 0; } /* an earlier --crop gives way */
            if (preset.has_backdrop) { /* the picture beside the preset unless its path is absolute */
                static char spec[2200];
                const char *f = preset.backdrop, *slash = strrchr(v, '/'), *bs = strrchr(v, '\\');
                size_t dl2 = slash || bs ? (size_t)((slash > bs ? slash : bs) - v) + 1 : 0;
                int absolute = f[0] == '/' || f[0] == '\\' || (f[0] && f[1] == ':');
                int at = snprintf(spec, sizeof(spec), "%.*s%s", absolute ? 0 : (int)dl2, v, f);
                if (preset.has_backdrop_rect && at > 0 && at < (int)sizeof(spec))
                    snprintf(spec + at, sizeof(spec) - (size_t)at, ":%.9g,%.9g,%.9g,%.9g", preset.backdrop_rect[0], preset.backdrop_rect[1], preset.backdrop_rect[2], preset.backdrop_rect[3]);
                backdrop_spec = spec;
            }
            if (preset.ncams >= 0) { memcpy(cams, preset.cams, sizeof(CamKey) * (size_t)preset.ncams); ncams = preset.ncams; cams_from_preset = 1; }
        }
        else if (!strcmp(a, "--camera")) {
            NEXT();
            if (cams_from_preset) { ncams = 0; cams_from_preset = 0; } /* the command's keys replace the preset's */
            if (ncams >= 32 || !parse_camera(v, &cams[ncams])) { fprintf(stderr, "--camera needs T:ZOOM, T:ZOOM:X,Y, and :cut at the end to jump (T >= 0, ZOOM > 0; at most 32 keys): %s\n", v); return 2; }
            ncams++;
        }
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(); return 0; }
        else if (a[0] == '-') { fprintf(stderr, "unknown option %s\n", a); usage(); return 2; }
        else model_path = a;
#undef NEXT
    }
    if (!model_path || !nouts) { usage(); return 2; }
    if (fps <= 0 || fps > 240) { fprintf(stderr, "--fps must be 1..240\n"); return 2; }
    if (ss < 1 || ss > 8) ss = 2;
    for (i = 0; i < nouts; i++) {
        Output *o = &outs[i];
        if (!o->format) {
            const char *e = ext_of(o->path);
            if (ieq(e, "gif")) o->format = "gif";
            else if (ieq(e, "png") || ieq(e, "apng")) o->format = "apng";
            else if (ieq(e, "mp4")) o->format = "mp4";
            else if (ieq(e, "webm")) o->format = "webm";
            else if (ieq(e, "mov")) o->format = "mov";
            else if (ieq(e, "rgba") || ieq(e, "raw")) o->format = "raw";
            else if (ieq(e, "jpg") || ieq(e, "jpeg")) o->format = "jpeg";
            else o->format = "frames";
        }
        if (ieq(o->format, "gif") || ieq(o->format, "sheet")) any_buffered = 1;
        if (ieq(o->format, "sheet")) any_sheet = 1;
        if (ieq(o->format, "mp4") || ieq(o->format, "jpeg")) any_opaque = 1;
    }
    if (matte) {
        if (sscanf(matte[0] == '#' ? matte + 1 : matte, "%6x", &matte_rgb) != 1) { fprintf(stderr, "bad --matte\n"); return 2; }
        has_matte = 1;
    }
    if (bg) {
        unsigned rgb;
        if (sscanf(bg[0] == '#' ? bg + 1 : bg, "%6x", &rgb) != 1) { fprintf(stderr, "bad --bg\n"); return 2; }
        bg_rgb[0] = (float)((rgb >> 16) & 0xff) / 255.0f;
        bg_rgb[1] = (float)((rgb >> 8) & 0xff) / 255.0f;
        bg_rgb[2] = (float)(rgb & 0xff) / 255.0f;
        has_bg = 1;
    }
    /* H.264 has no alpha: with one output it is drawn on white; next to others (which keep
       their transparency) its frames are put over --bg, or white */
    if (nouts == 1 && any_opaque) has_bg = 1;

    /* model */
    data = read_file(model_path, &size);
    if (!data) { fprintf(stderr, "cannot read %s\n", model_path); rc = 1; goto done; }
    { /* a 1.1 file (curve keys) needs more than ugo_model_mem_size(): its keys are expanded at load */
        uint32_t need = ugo_model_mem_size_for(data, size);
        model_mem = need ? aligned_alloc16(need) : NULL;
        model = model_mem ? ugo_model_init_sized(model_mem, need, data, size) : NULL;
    }
    if (!model) { say_load_error(model_path, data, size, ugo_last_error()); rc = 1; goto done; }
    inst_mem = aligned_alloc16(ugo_instance_mem_size(model));
    inst = ugo_instance_init(inst_mem, model);

    /* textures next to the model */
    strncpy(dir, model_path, sizeof(dir) - 1);
    dir[sizeof(dir) - 1] = 0;
    dl = strlen(dir);
    while (dl > 0 && dir[dl - 1] != '/' && dir[dl - 1] != '\\') dl--;
    dir[dl] = 0;
    ntex = ugo_texture_count(model);
    if (ntex == 0 || ntex > 16) { fprintf(stderr, "model needs 1..16 textures\n"); ntex = 0; rc = 1; goto done; }
    memset(tex, 0, sizeof(tex));
    for (k = 0; k < ntex; k++) {
        char path[2048];
        int w, h, n;
        snprintf(path, sizeof(path), "%s%s", dir, ugo_texture_name(model, k));
        tex[k].rgba = stbi_load(path, &w, &h, &n, 4);
        if (!tex[k].rgba) { fprintf(stderr, "cannot load texture %s\n", path); rc = 1; goto done; }
        tex[k].width = (uint32_t)w;
        tex[k].height = (uint32_t)h;
    }

    /* animation, held parameters */
    for (i = 0; i < nanims; i++) {
        anims[i] = ugo_find_animation(model, anim_names[i]);
        if (anims[i] < 0) { fprintf(stderr, "no animation named %s\n", anim_names[i]); rc = 1; goto done; }
    }
    if (!nanims && ugo_animation_count(model) > 0) anims[nanims++] = 0;
    if (nanims) anim = anims[0]; /* the first one sets the length */
    if (preset_at >= 0 && anim >= 0) { /* the preset's settings for this animation (perAnim), unless a later flag says */
        const PresetAnim *pa = ugo_preset_anim(&preset, ugo_animation_name(model, (uint32_t)anim));
        if (pa) {
            if (pa->has_fps && at_fps < preset_at) fps = pa->fps;
            if (at_len < preset_at) {
                if (pa->has_seconds) { seconds = pa->seconds; frames_n = -1; }
                else if (pa->has_loops && ugo_animation_duration(model, (uint32_t)anim) > 0) { seconds = pa->loops * ugo_animation_duration(model, (uint32_t)anim); frames_n = -1; }
            }
            if (pa->has_seamless && at_seamless < preset_at) seamless = pa->seamless;
            if (pa->seamless_loops && at_sloops < preset_at) seamless_loops = pa->seamless_loops;
            if (pa->has_hold && at_hold < preset_at) hold = pa->hold;
        }
    }
    for (i = 0; i < nparams; i++) {
        char *eq = strchr(param_specs[i], '=');
        if (!eq) { fprintf(stderr, "--param needs NAME=VALUE\n"); rc = 2; goto done; }
        *eq = 0;
        holds[i].index = ugo_find_param(model, param_specs[i]);
        holds[i].value = (float)atof(eq + 1);
        if (holds[i].index < 0) { fprintf(stderr, "no parameter named %s\n", param_specs[i]); rc = 1; goto done; }
    }
    if (seconds < 0) seconds = anim >= 0 && ugo_animation_duration(model, (uint32_t)anim) > 0 ? ugo_animation_duration(model, (uint32_t)anim) : 3.0;
    nfr = frames_n > 0 ? (uint32_t)frames_n : (uint32_t)(seconds * fps + 0.5);
    if (nfr < 1) nfr = 1;
    if (warmup < 0) warmup = anim >= 0 ? ugo_animation_duration(model, (uint32_t)anim) : 0;

    /* view: fit the canvas into the output, centred */
    for (k = 0; k < 4; k++) canvas[k] = ugo_canvas(model)[k] + (float)pad * (k < 2 ? 2 : 1);
    if (size_mode == 2) { /* the long side */
        double f = (double)long_side / (canvas[0] > canvas[1] ? canvas[0] : canvas[1]);
        out_w = (int)(canvas[0] * f + 0.5); out_h = (int)(canvas[1] * f + 0.5);
    } else if (size_mode == 3) { out_w = (int)(canvas[0] * size_scale + 0.5); out_h = (int)(canvas[1] * size_scale + 0.5); }
    if (out_w < 1 && size_mode) out_w = 1;
    if (out_h < 1 && size_mode) out_h = 1;
    if (out_w <= 0 || out_h <= 0) { out_w = (int)(canvas[0] + 0.5f); out_h = (int)(canvas[1] + 0.5f); }
    scale = (float)out_w / canvas[0] < (float)out_h / canvas[1] ? (float)out_w / canvas[0] : (float)out_h / canvas[1];
    view[0] = scale * (float)ss; view[1] = 0; view[2] = 0; view[3] = scale * (float)ss;
    view[4] = ((float)out_w - canvas[0] * scale) * 0.5f * (float)ss + canvas[2] * scale * (float)ss;
    view[5] = ((float)out_h - canvas[1] * scale) * 0.5f * (float)ss + canvas[3] * scale * (float)ss;
    if (has_region) { /* the preset's region, model pixels -> the picture's pixels (whole pixels that cover it) */
        double x0 = region[0] * scale + view[4] / ss, y0 = region[1] * scale + view[5] / ss;
        double x1 = (region[0] + region[2]) * scale + view[4] / ss, y1 = (region[1] + region[3]) * scale + view[5] / ss;
        crop[0] = (int)floor(x0 + 1e-6); crop[1] = (int)floor(y0 + 1e-6);
        crop[2] = (int)ceil(x1 - 1e-6) - crop[0]; crop[3] = (int)ceil(y1 - 1e-6) - crop[1];
        if (crop[0] < 0 || crop[1] < 0 || crop[2] < 1 || crop[3] < 1) { fprintf(stderr, "the preset's region %g,%g %gx%g is outside the %dx%d picture\n", region[0], region[1], region[2], region[3], out_w, out_h); rc = 2; goto done; }
        has_crop = 1;
    }
    if (has_crop) { /* keep a part of the picture: the same view, moved, drawn on a smaller picture */
        if (crop[0] + crop[2] > out_w || crop[1] + crop[3] > out_h) { fprintf(stderr, "--crop %d,%d,%d,%d is outside the %dx%d picture\n", crop[0], crop[1], crop[2], crop[3], out_w, out_h); rc = 2; goto done; }
        view[4] -= (float)crop[0] * (float)ss; view[5] -= (float)crop[1] * (float)ss;
        out_w = crop[2]; out_h = crop[3];
    }
    if (ncams) { /* sort the keys by time; a key without X,Y looks at the canvas's middle */
        int a, b;
        for (a = 1; a < ncams; a++) for (b = a; b > 0 && cams[b - 1].t > cams[b].t; b--) { CamKey tmp = cams[b]; cams[b] = cams[b - 1]; cams[b - 1] = tmp; }
        for (a = 0; a < ncams; a++) if (!cams[a].has_xy) { cams[a].x = canvas[0] * 0.5 - canvas[2]; cams[a].y = canvas[1] * 0.5 - canvas[3]; }
    }

    accum = (float *)malloc(sizeof(float) * 4 * (size_t)out_w * ss * (size_t)out_h * ss);
    scratch = (float *)malloc(sizeof(float) * 2 * (ugo_vertex_count(model) + 1));
    maskbuf = (float *)malloc(sizeof(float) * (size_t)out_w * ss * (size_t)out_h * ss); /* one mask's coverage at a time */
    frame = (uint8_t *)malloc(4 * (size_t)out_w * (size_t)out_h);
    if (!accum || !scratch || !maskbuf || !frame) { fprintf(stderr, "out of memory\n"); rc = 1; goto done; }
    if (any_buffered) {
        /* every frame held (the sheet: a second copy laid out); past the limit the system would likely end the
           process part way, so say it now, with what to do instead */
        double held = 4.0 * out_w * out_h * nfr * (any_sheet ? 2 : 1) / (1024.0 * 1024.0);
        if (max_held > 0 && held > max_held) {
            fprintf(stderr, "gif and sheet hold every frame: %dx%d x %u frames needs about %.0f MB, more than --max-held %.0f MB.\n"
                    "Use mp4, webm, mov, apng or frames (written frame by frame), fewer frames, a smaller --size, or --max-held 0\n",
                    out_w, out_h, nfr, held, max_held);
            rc = 2; goto done;
        }
        all = (uint8_t *)malloc(4 * (size_t)out_w * (size_t)out_h * nfr);
        if (!all) { fprintf(stderr, "out of memory (%u frames)\n", nfr); rc = 1; goto done; }
    }
    if (any_opaque && !has_bg) {
        opaque = (uint8_t *)malloc(4 * (size_t)out_w * (size_t)out_h);
        if (!opaque) { fprintf(stderr, "out of memory\n"); rc = 1; goto done; }
    }

    /* outputs that stream */
    for (i = 0; i < nouts; i++) {
        Output *o = &outs[i];
        if (ieq(o->format, "apng") || ieq(o->format, "raw")) {
            o->f = open_file(o->path, "wb");
            if (!o->f) { fprintf(stderr, "cannot write %s\n", o->path); rc = 1; goto done; }
            if (ieq(o->format, "apng") && !ugo_apng_begin(&o->apng, o->f, (uint32_t)out_w, (uint32_t)out_h, nfr, fps)) { fprintf(stderr, "write failed\n"); rc = 1; goto done; }
        } else if (ieq(o->format, "mp4") || ieq(o->format, "webm") || ieq(o->format, "mov")) {
            char cmd[4096], rate[32];
            /* 29.97 as 30000/1001, the rate editing software expects (not 2997/100) */
            if (ugo_ntsc_rate(fps)) snprintf(rate, sizeof(rate), "%d000/1001", ugo_ntsc_rate(fps));
            else snprintf(rate, sizeof(rate), "%g", fps);
            if (ieq(o->format, "mp4"))
                snprintf(cmd, sizeof(cmd), "ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba -s %dx%d -r %s -i - "
                         "-vf \"pad=ceil(iw/2)*2:ceil(ih/2)*2\" -c:v libx264 -pix_fmt yuv420p -crf 18 \"%s\"", out_w, out_h, rate, o->path);
            else if (ieq(o->format, "mov")) /* ProRes 4444 keeps the transparency (straight alpha, 16 bits) and the full colour */
                snprintf(cmd, sizeof(cmd), "ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba -s %dx%d -r %s -i - "
                         "-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 16 -vendor apl0 \"%s\"", out_w, out_h, rate, o->path);
            else
                snprintf(cmd, sizeof(cmd), "ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba -s %dx%d -r %s -i - "
                         "-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 \"%s\"", out_w, out_h, rate, o->path);
            o->f = popen(cmd, POPEN_WRITE);
            if (!o->f) { fprintf(stderr, "ffmpeg not found (needed for %s)\n", o->format); rc = 1; goto done; }
            o->piped = 1;
        } else if (!ieq(o->format, "frames") && !ieq(o->format, "gif") && !ieq(o->format, "sheet") && !ieq(o->format, "jpeg")) {
            fprintf(stderr, "unknown format %s\n", o->format);
            rc = 2; goto done;
        }
    }

    /* the backdrop (--backdrop FILE[:X,Y,W,H]): a picture behind the model, in model px; by default covering the canvas */
    if (backdrop_spec) {
        char file[2048];
        const char *colon = strrchr(backdrop_spec, ':');
        int bw, bh, bn, given = colon && sscanf(colon + 1, "%f,%f,%f,%f", &backdrop_rect[0], &backdrop_rect[1], &backdrop_rect[2], &backdrop_rect[3]) == 4;
        size_t len = given ? (size_t)(colon - backdrop_spec) : strlen(backdrop_spec);
        if (len >= sizeof(file)) len = sizeof(file) - 1;
        memcpy(file, backdrop_spec, len); file[len] = 0;
        if (given && (backdrop_rect[2] <= 0 || backdrop_rect[3] <= 0)) { fprintf(stderr, "--backdrop: the width and height are above 0\n"); rc = 2; goto done; }
        backdrop.rgba = stbi_load(file, &bw, &bh, &bn, 4);
        if (!backdrop.rgba) { fprintf(stderr, "--backdrop: cannot load %s\n", file); rc = 1; goto done; }
        backdrop.width = (uint32_t)bw; backdrop.height = (uint32_t)bh;
        if (!given) { /* cover the canvas, the picture's shape kept, centred */
            float cw = canvas[0], ch = canvas[1], k2 = cw / (float)bw > ch / (float)bh ? cw / (float)bw : ch / (float)bh;
            backdrop_rect[2] = (float)bw * k2; backdrop_rect[3] = (float)bh * k2;
            backdrop_rect[0] = -canvas[2] + (cw - backdrop_rect[2]) * 0.5f; backdrop_rect[1] = -canvas[3] + (ch - backdrop_rect[3]) * 0.5f;
        }
    }

    /* the steps that pose each frame, and how it is drawn */
    ps.model = model; ps.anims = anims; ps.nanims = nanims; ps.holds = holds; ps.nparams = nparams; ps.anim = anim;
    ps.hold = hold; ps.seamless = seamless; ps.seamless_loops = seamless_loops; ps.fps = fps; ps.start = start; ps.warmup = warmup;
    ds.tex = tex; ds.ntex = ntex; ds.out_w = out_w; ds.out_h = out_h; ds.ss = ss; ds.ncams = ncams; ds.cams = cams;
    ds.has_bg = has_bg; ds.nearest = nearest; ds.scale = scale;
    ds.backdrop = backdrop.rgba ? &backdrop : NULL; memcpy(ds.backdrop_rect, backdrop_rect, sizeof(ds.backdrop_rect));
    memcpy(ds.view, view, sizeof(ds.view)); memcpy(ds.bg_rgb, bg_rgb, sizeof(ds.bg_rgb));

    /* drawing threads: by default one per processor (up to 8), no more than the frames drawn, and no more than
       about 1.5 GB of drawing buffers in all */
    {
        uint32_t step = hold > 1 ? (uint32_t)hold : 1u, drawn = (nfr + step - 1) / step;
        double per = (5.0 * sizeof(float) + 4.0 / ((double)ss * ss)) * (double)out_w * ss * out_h * ss + ugo_instance_mem_size(model);
        int n = threads ? threads : cpu_count();
        if (!threads) { if (n > 8) n = 8; while (n > 1 && per * n > 1.5e9) n--; }
        if ((uint32_t)n > drawn) n = (int)drawn;
        if (n > 64) n = 64;
        if (n > 1) {
            drawers = (Drawer *)calloc((size_t)n, sizeof(Drawer));
            if (!drawers) { fprintf(stderr, "out of memory\n"); rc = 1; goto done; }
            ndrawers = n;
            for (i = 0; i < n; i++) {
                Drawer *w = &drawers[i];
                w->ps = &ps; w->ds = &ds; w->say = i == 0;
                w->mem = aligned_alloc16(ugo_instance_mem_size(model));
                w->inst = w->mem ? ugo_instance_init(w->mem, model) : NULL;
                w->accum = (float *)malloc(sizeof(float) * 4 * (size_t)out_w * ss * (size_t)out_h * ss);
                w->scratch = (float *)malloc(sizeof(float) * 2 * (ugo_vertex_count(model) + 1));
                w->mask = (float *)malloc(sizeof(float) * (size_t)out_w * ss * (size_t)out_h * ss);
                w->out = (uint8_t *)malloc(4 * (size_t)out_w * (size_t)out_h);
                if (!w->inst || !w->accum || !w->scratch || !w->mask || !w->out) { fprintf(stderr, "out of memory (%d drawing threads: try --threads 1)\n", n); rc = 1; goto done; }
            }
        }
    }

    if (ndrawers) { free(accum); accum = NULL; free(maskbuf); maskbuf = NULL; } /* the threads draw with their own */
    if (!ndrawers && pose_warm(&ps, inst, 1)) { rc = 1; goto done; }
    {
        uint32_t fi, nbatch = 0, b;
        for (fi = 0; fi < nfr; fi++) {
            if (hold > 1 && fi % (uint32_t)hold) goto emit; /* on N's: the frame before, again */
            if (ndrawers) { /* the frames drawn a round ahead, one per thread; this one is the next not yet drawn */
                for (b = 0; b < nbatch && drawers[b].target != fi; b++) {}
                if (b == nbatch) {
                    uint32_t f, step = hold > 1 ? (uint32_t)hold : 1u;
                    for (nbatch = 0, f = fi; f < nfr && nbatch < (uint32_t)ndrawers; f += step) drawers[nbatch++].target = f;
                    if (run_drawers(drawers, (int)nbatch)) { rc = 1; goto done; }
                    b = 0;
                }
                memcpy(frame, drawers[b].out, 4 * (size_t)out_w * out_h);
            } else {
                pose_frame(&ps, inst, fi);
                draw_frame(&ds, inst, fi, fps, accum, scratch, maskbuf, frame);
            }

            if (opaque) { /* the frame over the background, for H.264 */
                size_t p, np = (size_t)out_w * out_h;
                for (p = 0; p < np; p++) {
                    float a = frame[4 * p + 3] / 255.0f;
                    for (k = 0; k < 3; k++) opaque[4 * p + k] = (uint8_t)(frame[4 * p + k] * a + 255.0f * bg_rgb[k] * (1.0f - a) + 0.5f);
                    opaque[4 * p + 3] = 255;
                }
            }
        emit:
            if (all) memcpy(all + 4 * (size_t)out_w * out_h * fi, frame, 4 * (size_t)out_w * out_h);
            for (i = 0; i < nouts; i++) {
                Output *o = &outs[i];
                const uint8_t *src = opaque && (ieq(o->format, "mp4") || ieq(o->format, "jpeg")) ? opaque : frame;
                if (ieq(o->format, "apng")) { if (!ugo_apng_frame(&o->apng, src)) { fprintf(stderr, "write failed\n"); rc = 1; goto done; } }
                else if (ieq(o->format, "jpeg")) { /* one frame to a .jpg file; several to frame_00000.jpg... in a folder */
                    char path[2048];
                    const char *e = ext_of(o->path);
                    if (nfr == 1 && (ieq(e, "jpg") || ieq(e, "jpeg"))) snprintf(path, sizeof(path), "%s", o->path);
                    else if (ieq(e, "jpg") || ieq(e, "jpeg")) snprintf(path, sizeof(path), "%.*s_%05u.%s", (int)(e - 1 - o->path), o->path, fi, e); /* NAME_00000.jpg... */
                    else snprintf(path, sizeof(path), "%s%sframe_%05u.jpg", o->path, (o->path[strlen(o->path) - 1] == '/' || o->path[strlen(o->path) - 1] == '\\') ? "" : "/", fi);
                    if (!stbi_write_jpg(path, out_w, out_h, 4, src, quality)) { fprintf(stderr, "cannot write %s (does the folder exist?)\n", path); rc = 1; goto done; }
                }
                else if (ieq(o->format, "frames")) {
                    char path[2048];
                    snprintf(path, sizeof(path), "%s%sframe_%05u.png", o->path, (o->path[strlen(o->path) - 1] == '/' || o->path[strlen(o->path) - 1] == '\\') ? "" : "/", fi);
                    if (!stbi_write_png(path, out_w, out_h, 4, src, out_w * 4)) { fprintf(stderr, "cannot write %s (does the folder exist?)\n", path); rc = 1; goto done; }
                } else if (o->f && fwrite(src, 1, 4 * (size_t)out_w * out_h, o->f) != 4 * (size_t)out_w * out_h) {
                    fprintf(stderr, "write failed\n");
                    rc = 1; goto done;
                }
            }
        }
    }

    for (i = 0; i < nouts; i++) {
        Output *o = &outs[i];
        const char *out = o->path, *format = o->format;
        FILE *f;
        if (ieq(format, "apng")) { if (!ugo_apng_end(&o->apng)) { fprintf(stderr, "write failed\n"); rc = 1; goto done; } fclose(o->f); o->f = NULL; }
        else if (ieq(format, "raw")) { fclose(o->f); o->f = NULL; }
        else if (o->piped) { int pc = pclose(o->f); o->f = NULL; if (pc != 0) { fprintf(stderr, "ffmpeg failed\n"); rc = 1; goto done; } }
        else if (ieq(format, "gif")) {
            if (has_matte && !matted) { /* half-transparent edges mixed with the page colour, made opaque; under a quarter: transparent */
                size_t n = (size_t)out_w * out_h * nfr, q;
                const int mr = (matte_rgb >> 16) & 0xff, mg = (matte_rgb >> 8) & 0xff, mb = matte_rgb & 0xff;
                matted = (uint8_t *)calloc(n, 4);
                if (!matted) { fprintf(stderr, "out of memory\n"); rc = 1; goto done; }
                for (q = 0; q < n; q++) {
                    const uint8_t *s = all + 4 * q;
                    uint8_t *d = matted + 4 * q;
                    int a = s[3];
                    if (a < 64) continue;
                    d[0] = (uint8_t)((s[0] * a + mr * (255 - a) + 127) / 255);
                    d[1] = (uint8_t)((s[1] * a + mg * (255 - a) + 127) / 255);
                    d[2] = (uint8_t)((s[2] * a + mb * (255 - a) + 127) / 255);
                    d[3] = 255;
                }
            }
            f = open_file(out, "wb");
            if (!f || !ugo_write_gif(f, matted ? matted : all, nfr, (uint32_t)out_w, (uint32_t)out_h, fps, dither)) { if (f) fclose(f); fprintf(stderr, "cannot write %s\n", out); rc = 1; goto done; }
            fclose(f);
        } else if (ieq(format, "sheet")) {
            /* frames in a grid + a small JSON description next to it */
            uint32_t cols = (uint32_t)ceil(sqrt((double)nfr)), rows = (nfr + cols - 1) / cols, fi, y;
            size_t sw = (size_t)out_w * cols, shh = (size_t)out_h * rows;
            uint8_t *sheet = (uint8_t *)calloc(4 * sw * shh, 1);
            char json_path[2048];
            FILE *jf;
            if (!sheet) { fprintf(stderr, "out of memory\n"); rc = 1; goto done; }
            for (fi = 0; fi < nfr; fi++)
                for (y = 0; y < (uint32_t)out_h; y++)
                    memcpy(sheet + 4 * (((fi / cols) * (size_t)out_h + y) * sw + (fi % cols) * (size_t)out_w),
                           all + 4 * ((size_t)fi * out_w * out_h + (size_t)y * out_w), 4 * (size_t)out_w);
            if (!stbi_write_png(out, (int)sw, (int)shh, 4, sheet, (int)sw * 4)) { free(sheet); fprintf(stderr, "cannot write %s\n", out); rc = 1; goto done; }
            snprintf(json_path, sizeof(json_path), "%s.json", out);
            jf = open_file(json_path, "wb");
            if (jf) {
                /* the "JSON (Hash)" sprite sheet layout that TexturePacker and Aseprite write and
                   game engines' importers read (Phaser, PixiJS, Godot and Unity add-ons), with
                   the animation as an Aseprite frame tag; the grid is in "meta" too */
                const char *image = out + strlen(out), *tag = anim >= 0 && ugo_animation_name(model, (uint32_t)anim) ? ugo_animation_name(model, (uint32_t)anim) : "frames";
                while (image > out && image[-1] != '/' && image[-1] != '\\') image--;
                fprintf(jf, "{\"frames\":{");
                for (fi = 0; fi < nfr; fi++) {
                    fprintf(jf, "%s\n \"", fi ? "," : "");
                    json_text(jf, tag);
                    fprintf(jf, "_%04u\":{\"frame\":{\"x\":%u,\"y\":%u,\"w\":%d,\"h\":%d},\"rotated\":false,\"trimmed\":false,"
                            "\"spriteSourceSize\":{\"x\":0,\"y\":0,\"w\":%d,\"h\":%d},\"sourceSize\":{\"w\":%d,\"h\":%d},\"duration\":%d}",
                            fi, (fi % cols) * (uint32_t)out_w, (fi / cols) * (uint32_t)out_h, out_w, out_h, out_w, out_h, out_w, out_h, (int)(1000.0 / fps + 0.5));
                }
                fprintf(jf, "},\n\"meta\":{\"app\":\"Ugo9 ugo_export\",\"version\":\"1\",\"image\":\"");
                json_text(jf, image);
                fprintf(jf, "\",\"format\":\"RGBA8888\",\"size\":{\"w\":%u,\"h\":%u},\"scale\":\"1\",\"frameTags\":[{\"name\":\"", (uint32_t)sw, (uint32_t)shh);
                json_text(jf, tag);
                fprintf(jf, "\",\"from\":0,\"to\":%u,\"direction\":\"forward\"}],"
                        "\"frameWidth\":%d,\"frameHeight\":%d,\"columns\":%u,\"rows\":%u,\"frameCount\":%u,\"fps\":%g}}\n",
                        nfr - 1, out_w, out_h, cols, rows, nfr, fps);
                fclose(jf);
            }
            free(sheet);
        }
        fprintf(stderr, "%s: %u frames, %dx%d, %s\n", out, nfr, out_w, out_h, format);
    }
done: /* every way out after the model is read: close what is open, free what was taken */
    for (i = 0; i < nouts; i++) {
        if (!outs[i].f) continue;
        if (outs[i].piped) pclose(outs[i].f); else fclose(outs[i].f);
    }
    free(opaque); free(all); free(matted); free(frame); free(maskbuf); free(scratch); free(accum);
    for (i = 0; i < ndrawers; i++) {
        aligned_free16(drawers[i].mem); free(drawers[i].accum); free(drawers[i].scratch); free(drawers[i].mask); free(drawers[i].out);
    }
    free(drawers);
    for (k = 0; k < ntex; k++) if (tex[k].rgba) stbi_image_free((void *)tex[k].rgba);
    if (backdrop.rgba) stbi_image_free((void *)backdrop.rgba);
    aligned_free16(inst_mem); aligned_free16(model_mem); free(data);
    return rc;
}

/* --each-anim: the export once per animation, each with --anim NAME and {anim} in its --out names (else _NAME
   before the extension); the --anim options given are dropped. The model is read once here for the names. */
int main(int argc, char **argv)
{
    int i, each = 0, rc = 0;
    const char *model_path = NULL;
    static UgoPreset pp; /* the last --preset: its eachAnim, and the animations it skips */
    int has_pp = 0;
    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seamless")) continue; /* a flag without a value */
        if (!strcmp(argv[i], "--each-anim")) each = 1;
        else if (!strcmp(argv[i], "--preset") && i + 1 < argc) { /* a preset's eachAnim */
            uint32_t pn; char *text = (char *)read_file(argv[++i], &pn), err[256];
            ugo_preset_quiet(1);
            has_pp = 0;
            if (text && !ugo_read_preset(text, pn, &pp, err, sizeof(err))) { each = pp.each_anim; has_pp = 1; }
            ugo_preset_quiet(0);
            free(text);
        }
        else if (argv[i][0] == '-' && i + 1 < argc && strcmp(argv[i], "--nearest") && strcmp(argv[i], "--no-dither") && strcmp(argv[i], "-h") && strcmp(argv[i], "--help")) i++; /* an option's value */
        else if (argv[i][0] != '-') model_path = argv[i];
    }
    if (!each) return export_once(argc, argv);
    if (!model_path) { usage(); return 2; }
    {
        uint32_t size;
        void *data = read_file(model_path, &size), *mem = NULL;
        UgoModel *model = NULL;
        uint32_t n, a;
        uint32_t need = data ? ugo_model_mem_size_for(data, size) : 0;
        char **names = NULL;
        if (!data) { fprintf(stderr, "cannot read %s\n", model_path); return 1; }
        mem = need ? aligned_alloc16(need) : NULL;
        model = mem ? ugo_model_init_sized(mem, need, data, size) : NULL;
        if (!model) { fprintf(stderr, "not a model: %s\n", model_path); aligned_free16(mem); free(data); return 1; }
        n = ugo_animation_count(model);
        if (!n) { fprintf(stderr, "%s has no animations\n", model_path); aligned_free16(mem); free(data); return 1; }
        names = (char **)calloc(n, sizeof(char *));
        for (a = 0; a < n && names; a++) { const char *nm = ugo_animation_name(model, a); names[a] = (char *)malloc(strlen(nm ? nm : "") + 1); if (names[a]) strcpy(names[a], nm ? nm : ""); }
        aligned_free16(mem); free(data);
        for (a = 0; a < n && !rc && names; a++) {
            const PresetAnim *pa = has_pp ? ugo_preset_anim(&pp, names[a]) : NULL;
            if (pa && pa->skip) { fprintf(stderr, "%s: skipped (the preset's perAnim)\n", names[a]); continue; }
            {
            char **args = (char **)calloc((size_t)argc + 3, sizeof(char *)), outs[16][2048];
            int m = 0, no = 0;
            args[m++] = argv[0];
            for (i = 1; i < argc; i++) {
                if (!strcmp(argv[i], "--each-anim")) continue;
                if (!strcmp(argv[i], "--anim") && i + 1 < argc) { i++; continue; }
                if (!strcmp(argv[i], "--out") && i + 1 < argc && no < 16) { /* the name with {anim}, or _NAME before the extension */
                    const char *o = argv[++i], *at = strstr(o, "{anim}"), *e = ext_of(o);
                    if (at) snprintf(outs[no], sizeof(outs[no]), "%.*s%s%s", (int)(at - o), o, names[a], at + 6);
                    else if (*e) snprintf(outs[no], sizeof(outs[no]), "%.*s_%s.%s", (int)(e - 1 - o), o, names[a], e);
                    else snprintf(outs[no], sizeof(outs[no]), "%s_%s", o, names[a]);
                    args[m++] = argv[i - 1]; args[m++] = outs[no++];
                    continue;
                }
                args[m++] = argv[i];
            }
            args[m++] = "--anim"; args[m++] = names[a];
            rc = export_once(m, args);
            free(args);
            }
        }
        for (a = 0; a < n && names; a++) free(names[a]);
        free(names);
    }
    return rc;
}
