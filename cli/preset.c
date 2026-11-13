/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* A small JSON reader for export presets (see preset.h). */
#include "preset.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const char *s, *end; int depth, bad; } Json;

static void ws(Json *j) { while (j->s < j->end && (*j->s == ' ' || *j->s == '\t' || *j->s == '\n' || *j->s == '\r')) j->s++; }
static int peek(Json *j) { ws(j); return j->s < j->end ? (unsigned char)*j->s : -1; }
static int eat(Json *j, char c) { if (peek(j) == c) { j->s++; return 1; } return 0; }

static void put_utf8(char *out, size_t cap, size_t *len, unsigned cp)
{
    unsigned char b[4];
    size_t n, k;
    if (cp < 0x80) { b[0] = (unsigned char)cp; n = 1; }
    else if (cp < 0x800) { b[0] = (unsigned char)(0xc0 | (cp >> 6)); b[1] = (unsigned char)(0x80 | (cp & 63)); n = 2; }
    else if (cp < 0x10000) { b[0] = (unsigned char)(0xe0 | (cp >> 12)); b[1] = (unsigned char)(0x80 | ((cp >> 6) & 63)); b[2] = (unsigned char)(0x80 | (cp & 63)); n = 3; }
    else { b[0] = (unsigned char)(0xf0 | (cp >> 18)); b[1] = (unsigned char)(0x80 | ((cp >> 12) & 63)); b[2] = (unsigned char)(0x80 | ((cp >> 6) & 63)); b[3] = (unsigned char)(0x80 | (cp & 63)); n = 4; }
    for (k = 0; k < n; k++) { if (out && *len + 1 < cap) out[*len] = (char)b[k]; (*len)++; }
}

static unsigned hex4(Json *j)
{
    unsigned v = 0;
    int k;
    for (k = 0; k < 4; k++) {
        int c = j->s < j->end ? *j->s++ : 0;
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else { j->bad = 1; return 0; }
    }
    return v;
}

/* a string into out (cut to cap - 1 bytes; *full = 0 if it was cut); out may be NULL to skip */
static int str(Json *j, char *out, size_t cap, int *full)
{
    size_t len = 0;
    if (!eat(j, '"')) { j->bad = 1; return 0; }
    while (j->s < j->end && *j->s != '"') {
        unsigned char c = (unsigned char)*j->s++;
        if (c < 0x20) { j->bad = 1; return 0; }
        if (c != '\\') { if (out && len + 1 < cap) out[len] = (char)c; len++; continue; }
        if (j->s >= j->end) break;
        c = (unsigned char)*j->s++;
        switch (c) {
        case '"': case '\\': case '/': if (out && len + 1 < cap) out[len] = (char)c; len++; break;
        case 'b': c = '\b'; goto one;
        case 'f': c = '\f'; goto one;
        case 'n': c = '\n'; goto one;
        case 'r': c = '\r'; goto one;
        case 't': c = '\t';
        one: if (out && len + 1 < cap) out[len] = (char)c; len++; break;
        case 'u': {
            unsigned cp = hex4(j);
            if (cp >= 0xd800 && cp < 0xdc00 && j->end - j->s >= 6 && j->s[0] == '\\' && j->s[1] == 'u') {
                unsigned lo;
                j->s += 2;
                lo = hex4(j);
                if (lo >= 0xdc00 && lo < 0xe000) cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                else cp = 0xfffd;
            } else if (cp >= 0xd800 && cp < 0xe000) cp = 0xfffd;
            put_utf8(out, cap, &len, cp);
            break;
        }
        default: j->bad = 1; return 0;
        }
    }
    if (!eat(j, '"')) { j->bad = 1; return 0; }
    if (out && cap) out[len < cap ? len : cap - 1] = 0;
    if (full) *full = len < cap;
    return !j->bad;
}

static int number(Json *j, double *v)
{
    char buf[64], *e;
    size_t n = 0;
    ws(j);
    while (j->s + n < j->end && n < sizeof(buf) - 1 && j->s[n] && strchr("+-0123456789.eE", j->s[n])) n++;
    if (!n) return 0;
    memcpy(buf, j->s, n);
    buf[n] = 0;
    *v = strtod(buf, &e);
    if (e != buf + n || !isfinite(*v)) { j->bad = 1; return 0; }
    j->s += n;
    return 1;
}

static int word(Json *j, const char *w)
{
    size_t n = strlen(w);
    ws(j);
    if ((size_t)(j->end - j->s) >= n && !memcmp(j->s, w, n)) { j->s += n; return 1; }
    return 0;
}

static void skip(Json *j)
{
    int c = peek(j);
    double d;
    if (++j->depth > 64) { j->bad = 1; return; }
    if (c == '"') str(j, NULL, 0, NULL);
    else if (c == '{') {
        j->s++;
        if (!eat(j, '}')) do { str(j, NULL, 0, NULL); if (!eat(j, ':')) { j->bad = 1; break; } skip(j); } while (!j->bad && eat(j, ','));
        if (!j->bad && !eat(j, '}')) j->bad = 1;
    } else if (c == '[') {
        j->s++;
        if (!eat(j, ']')) do skip(j); while (!j->bad && eat(j, ','));
        if (!j->bad && !eat(j, ']')) j->bad = 1;
    } else if (!word(j, "null") && !word(j, "true") && !word(j, "false") && !number(j, &d)) j->bad = 1;
    j->depth--;
}

static int quiet; /* ugo_preset_quiet: no lines on stderr (a preset read twice says each thing once) */
void ugo_preset_quiet(int on) { quiet = on; }
static void drop(const char *key, const char *why) { if (!quiet) fprintf(stderr, "preset: dropped %s (%s)\n", key, why); }

/* a value that should be a number: 1 if it is one (else it is skipped) */
static int num_value(Json *j, double *v)
{
    if (peek(j) == '-' || (peek(j) >= '0' && peek(j) <= '9')) return number(j, v);
    skip(j);
    return 0;
}

/* { "width": W, "height": H } or { "long": L } */
static void read_size(Json *j, UgoPreset *p)
{
    double w = -1, h = -1, l = -1, v;
    char key[32];
    if (peek(j) != '{') { skip(j); drop("size", "not an object"); return; }
    j->s++;
    if (!eat(j, '}')) do {
        if (!str(j, key, sizeof(key), NULL) || !eat(j, ':')) { j->bad = 1; return; }
        if (!strcmp(key, "width") && num_value(j, &v)) w = v;
        else if (!strcmp(key, "height") && num_value(j, &v)) h = v;
        else if (!strcmp(key, "long") && num_value(j, &v)) l = v;
        else if (strcmp(key, "width") && strcmp(key, "height") && strcmp(key, "long")) skip(j);
    } while (!j->bad && eat(j, ','));
    if (j->bad || !eat(j, '}')) { j->bad = 1; return; }
#define SIDE(x) ((x) >= 1 && (x) <= 16384 && (x) == floor(x))
    if (l != -1) { if (SIDE(l)) { p->size_kind = 2; p->long_side = (int)l; } else drop("size", "long must be 1..16384"); }
    else if (SIDE(w) && SIDE(h)) { p->size_kind = 1; p->width = (int)w; p->height = (int)h; }
    else drop("size", "width and height must be 1..16384");
#undef SIDE
}

static void read_region(Json *j, UgoPreset *p) /* { x, y, width, height } in model pixels */
{
    char key[64];
    int full, n = 0;
    double v, r[4] = { 0, 0, 0, 0 };
    if (!eat(j, '{')) { skip(j); drop("region", "must be { x, y, width, height }"); return; }
    if (!eat(j, '}')) do {
        if (!str(j, key, sizeof(key), &full) || !eat(j, ':')) { j->bad = 1; return; }
        if (!strcmp(key, "x") && num_value(j, &v)) { r[0] = v; n |= 1; }
        else if (!strcmp(key, "y") && num_value(j, &v)) { r[1] = v; n |= 2; }
        else if (!strcmp(key, "width") && num_value(j, &v)) { r[2] = v; n |= 4; }
        else if (!strcmp(key, "height") && num_value(j, &v)) { r[3] = v; n |= 8; }
        else if (strcmp(key, "x") && strcmp(key, "y") && strcmp(key, "width") && strcmp(key, "height")) skip(j);
    } while (!j->bad && eat(j, ','));
    if (j->bad || !eat(j, '}')) { j->bad = 1; return; }
    if (n != 15 || r[2] <= 0 || r[3] <= 0) { drop("region", "needs x, y and a width and height above 0"); return; }
    memcpy(p->region, r, sizeof(r)); p->has_region = 1;
}

static void read_backdrop(Json *j, UgoPreset *p) /* "file", or { "file", "x", "y", "width", "height" } (the four together or none) */
{
    char key[64];
    int full, n = 0, got = 0;
    double v, r[4] = { 0, 0, 0, 0 };
    if (peek(j) == '"') {
        if (!str(j, p->backdrop, sizeof(p->backdrop), &full)) return;
        if (full && p->backdrop[0]) p->has_backdrop = 1; else drop("backdrop", "needs a file name");
        return;
    }
    if (!eat(j, '{')) { skip(j); drop("backdrop", "must be a file name or { file, x, y, width, height }"); return; }
    if (!eat(j, '}')) do {
        if (!str(j, key, sizeof(key), &full) || !eat(j, ':')) { j->bad = 1; return; }
        if (!strcmp(key, "file") && peek(j) == '"') { if (!str(j, p->backdrop, sizeof(p->backdrop), &full)) return; got = full && p->backdrop[0]; }
        else if (!strcmp(key, "x") && num_value(j, &v)) { r[0] = v; n |= 1; }
        else if (!strcmp(key, "y") && num_value(j, &v)) { r[1] = v; n |= 2; }
        else if (!strcmp(key, "width") && num_value(j, &v)) { r[2] = v; n |= 4; }
        else if (!strcmp(key, "height") && num_value(j, &v)) { r[3] = v; n |= 8; }
        else if (strcmp(key, "x") && strcmp(key, "y") && strcmp(key, "width") && strcmp(key, "height")) skip(j);
    } while (!j->bad && eat(j, ','));
    if (j->bad || !eat(j, '}')) { j->bad = 1; return; }
    if (!got) { drop("backdrop", "needs a file name"); return; }
    if (n && (n != 15 || r[2] <= 0 || r[3] <= 0)) { drop("backdrop", "x, y, width and height go together, the width and height above 0"); return; }
    p->has_backdrop = 1;
    if (n) { memcpy(p->backdrop_rect, r, sizeof(r)); p->has_backdrop_rect = 1; }
}

static void read_pinned(Json *j, UgoPreset *p)
{
    char key[128];
    double v;
    int full;
    if (peek(j) != '{') { skip(j); drop("pinned", "not an object"); return; }
    j->s++;
    if (!eat(j, '}')) do {
        if (!str(j, key, sizeof(key), &full) || !eat(j, ':')) { j->bad = 1; return; }
        if (!num_value(j, &v)) { if (!j->bad) drop("a pinned value", key); continue; }
        if (!full || p->npinned >= PRESET_MAX_PINNED) { drop("a pinned value", "name too long or too many"); continue; }
        memcpy(p->pinned_name[p->npinned], key, strlen(key) + 1);
        p->pinned_value[p->npinned++] = v;
    } while (!j->bad && eat(j, ','));
    if (!j->bad && !eat(j, '}')) j->bad = 1;
}

static void read_camera(Json *j, UgoPreset *p)
{
    if (peek(j) != '[') { skip(j); drop("camera", "not a list"); return; }
    j->s++;
    p->ncams = 0;
    if (!eat(j, ']')) do {
        CamKey k = { -1, -1, 0, 0, 0, 0 };
        int hx = 0, hy = 0;
        char key[16];
        double v;
        if (peek(j) != '{') { skip(j); drop("a camera key", "not an object"); continue; }
        j->s++;
        if (!eat(j, '}')) do {
            if (!str(j, key, sizeof(key), NULL) || !eat(j, ':')) { j->bad = 1; return; }
            if (!strcmp(key, "t") && num_value(j, &v)) k.t = v;
            else if (!strcmp(key, "zoom") && num_value(j, &v)) k.zoom = v;
            else if (!strcmp(key, "x") && num_value(j, &v)) { k.x = v; hx = 1; }
            else if (!strcmp(key, "y") && num_value(j, &v)) { k.y = v; hy = 1; }
            else if (!strcmp(key, "cut")) { if (word(j, "true")) k.cut = 1; else if (!word(j, "false")) { skip(j); drop("a camera key's cut", "must be true or false"); } }
            else if (strcmp(key, "t") && strcmp(key, "zoom") && strcmp(key, "x") && strcmp(key, "y")) skip(j);
        } while (!j->bad && eat(j, ','));
        if (j->bad || !eat(j, '}')) { j->bad = 1; return; }
        k.has_xy = hx && hy;
        if (k.t < 0 || !(k.zoom > 0) || k.zoom > 1000 || hx != hy || p->ncams >= PRESET_MAX_CAMS) { drop("a camera key", "needs t >= 0, 0 < zoom <= 1000, x and y together, at most 32"); continue; }
        p->cams[p->ncams++] = k;
    } while (!j->bad && eat(j, ','));
    if (!j->bad && !eat(j, ']')) j->bad = 1;
}

static void read_per_anim(Json *j, UgoPreset *p) /* { "NAME": { seconds, loops, seamless, seamlessLoops, holdFrames, fps, skip } } */
{
    char name[128], key[32];
    int full;
    double v;
    if (peek(j) != '{') { skip(j); drop("perAnim", "not an object"); return; }
    j->s++;
    if (!eat(j, '}')) do {
        PresetAnim a;
        if (!str(j, name, sizeof(name), &full) || !eat(j, ':')) { j->bad = 1; return; }
        if (peek(j) != '{') { skip(j); drop("a perAnim entry", "not an object"); continue; }
        j->s++;
        memset(&a, 0, sizeof(a));
        if (!eat(j, '}')) do {
            if (!str(j, key, sizeof(key), NULL) || !eat(j, ':')) { j->bad = 1; return; }
            if (!strcmp(key, "seconds")) { if (num_value(j, &v) && v > 0 && v <= 3600) { a.seconds = v; a.has_seconds = 1; } else if (!j->bad) drop("perAnim seconds", "must be above 0, at most 3600"); }
            else if (!strcmp(key, "loops")) { if (num_value(j, &v) && v >= 1e-3 && v <= 100) { a.loops = v; a.has_loops = 1; } else if (!j->bad) drop("perAnim loops", "must be 0.001..100"); }
            else if (!strcmp(key, "fps")) { if (num_value(j, &v) && v >= 1 && v <= 240) { a.fps = v; a.has_fps = 1; } else if (!j->bad) drop("perAnim fps", "must be 1..240"); }
            else if (!strcmp(key, "holdFrames")) { if (num_value(j, &v) && v >= 1 && v <= 12 && v == floor(v)) { a.hold = (int)v; a.has_hold = 1; } else if (!j->bad) drop("perAnim holdFrames", "must be a whole number 1..12"); }
            else if (!strcmp(key, "seamlessLoops")) { if (num_value(j, &v) && v >= 1 && v <= 1000 && v == floor(v)) a.seamless_loops = (int)v; else if (!j->bad) drop("perAnim seamlessLoops", "must be a whole number 1..1000"); }
            else if (!strcmp(key, "seamless")) { if (word(j, "true")) { a.seamless = 1; a.has_seamless = 1; } else if (word(j, "false")) { a.seamless = 0; a.has_seamless = 1; } else { skip(j); drop("perAnim seamless", "must be true or false"); } }
            else if (!strcmp(key, "skip")) { if (word(j, "true")) a.skip = 1; else if (!word(j, "false")) { skip(j); drop("perAnim skip", "must be true or false"); } }
            else skip(j); /* a setting this version does not know */
        } while (!j->bad && eat(j, ','));
        if (j->bad || !eat(j, '}')) { j->bad = 1; return; }
        if (!full || p->nper >= PRESET_MAX_ANIMS) { drop("a perAnim entry", "name too long or more than 64"); continue; }
        memcpy(a.name, name, strlen(name) + 1);
        p->per[p->nper++] = a;
    } while (!j->bad && eat(j, ','));
    if (!j->bad && !eat(j, '}')) j->bad = 1;
}

const PresetAnim *ugo_preset_anim(const UgoPreset *p, const char *name)
{
    int i;
    for (i = p->nper - 1; i >= 0; i--) if (name && !strcmp(p->per[i].name, name)) return &p->per[i]; /* the last of the same name */
    return NULL;
}

int ugo_read_preset(const char *text, size_t n, UgoPreset *p, char *err, size_t errn)
{
    Json j;
    char key[64];
    int version = 0;
    double v;
    memset(p, 0, sizeof(*p));
    p->ncams = -1;
    j.s = text; j.end = text + n; j.depth = 0; j.bad = 0;
    if (n >= 3 && (unsigned char)text[0] == 0xef && (unsigned char)text[1] == 0xbb && (unsigned char)text[2] == 0xbf) j.s += 3; /* BOM */
    if (!eat(&j, '{')) { snprintf(err, errn, "not an export preset (not a JSON object)"); return 1; }
    if (!eat(&j, '}')) do {
        int full;
        if (!str(&j, key, sizeof(key), &full) || !eat(&j, ':')) break;
        if (!strcmp(key, "ugo9ExportPreset")) { if (num_value(&j, &v) && v >= 1 && v == floor(v)) version = (int)v; }
        else if (!strcmp(key, "fps")) { if (num_value(&j, &v) && v >= 1 && v <= 240) { p->fps = v; p->has_fps = 1; } else if (!j.bad) drop("fps", "must be 1..240"); }
        else if (!strcmp(key, "seconds")) { if (num_value(&j, &v) && v > 0 && v <= 3600) { p->seconds = v; p->has_seconds = 1; } else if (!j.bad) drop("seconds", "must be above 0, at most 3600"); }
        else if (!strcmp(key, "scale")) { if (num_value(&j, &v) && v >= 1e-3 && v <= 16) { if (p->size_kind != 1 && p->size_kind != 2) { p->size_kind = 3; p->scale = v; } } else if (!j.bad) drop("scale", "must be 0.001..16"); }
        else if (!strcmp(key, "size")) read_size(&j, p);
        else if (!strcmp(key, "background")) {
            if (word(&j, "null")) { p->bg[0] = 0; p->has_bg = 1; }
            else if (peek(&j) == '"') {
                char b[16];
                int k, ok;
                if (!str(&j, b, sizeof(b), &full)) break;
                ok = full && strlen(b) == 7 && b[0] == '#';
                for (k = 1; ok && k < 7; k++) ok = strchr("0123456789abcdefABCDEF", b[k]) != NULL;
                if (ok) { memcpy(p->bg, b, 8); p->has_bg = 1; } else drop("background", "must be \"#rrggbb\" or null");
            } else { skip(&j); drop("background", "must be \"#rrggbb\" or null"); }
        }
        else if (!strcmp(key, "matte")) { /* GIF: the colour of the page it goes on (as --matte), or null */
            if (word(&j, "null")) { p->matte[0] = 0; p->has_matte = 1; }
            else if (peek(&j) == '"') {
                char b[16];
                int k, ok;
                if (!str(&j, b, sizeof(b), &full)) break;
                ok = full && strlen(b) == 7 && b[0] == '#';
                for (k = 1; ok && k < 7; k++) ok = strchr("0123456789abcdefABCDEF", b[k]) != NULL;
                if (ok) { memcpy(p->matte, b, 8); p->has_matte = 1; } else drop("matte", "must be \"#rrggbb\" or null");
            } else { skip(&j); drop("matte", "must be \"#rrggbb\" or null"); }
        }
        else if (!strcmp(key, "anim")) {
            if (peek(&j) == '"') { if (!str(&j, p->anim, sizeof(p->anim), &full)) break; if (full) p->has_anim = 1; else drop("anim", "name too long"); }
            else { skip(&j); drop("anim", "not a name"); }
        }
        else if (!strcmp(key, "sampling")) {
            char b[16];
            if (peek(&j) == '"') {
                if (!str(&j, b, sizeof(b), &full)) break;
                if (full && !strcmp(b, "nearest")) { p->nearest = 1; p->has_sampling = 1; }
                else if (full && !strcmp(b, "linear")) { p->nearest = 0; p->has_sampling = 1; }
                else drop("sampling", "must be \"nearest\" or \"linear\"");
            } else { skip(&j); drop("sampling", "must be \"nearest\" or \"linear\""); }
        }
        else if (!strcmp(key, "pinned")) read_pinned(&j, p);
        else if (!strcmp(key, "jpegQuality")) { if (num_value(&j, &v) && v >= 1 && v <= 100 && v == floor(v)) { p->quality = (int)v; p->has_quality = 1; } else if (!j.bad) drop("jpegQuality", "must be a whole number 1..100"); }
        else if (!strcmp(key, "seamless")) { if (word(&j, "true")) { p->seamless = 1; p->has_seamless = 1; } else if (word(&j, "false")) { p->seamless = 0; p->has_seamless = 1; } else { skip(&j); drop("seamless", "must be true or false"); } }
        else if (!strcmp(key, "seamlessLoops")) { if (num_value(&j, &v) && v >= 1 && v <= 1000 && v == floor(v)) p->seamless_loops = (int)v; else if (!j.bad) drop("seamlessLoops", "must be a whole number 1..1000"); }
        else if (!strcmp(key, "holdFrames")) { if (num_value(&j, &v) && v >= 1 && v <= 12 && v == floor(v)) { p->hold = (int)v; p->has_hold = 1; } else if (!j.bad) drop("holdFrames", "must be a whole number 1..12"); }
        else if (!strcmp(key, "eachAnim")) { if (word(&j, "true")) p->each_anim = 1; else if (word(&j, "false")) p->each_anim = 0; else { skip(&j); drop("eachAnim", "must be true or false"); } }
        else if (!strcmp(key, "region")) read_region(&j, p);
        else if (!strcmp(key, "backdrop")) read_backdrop(&j, p);
        else if (!strcmp(key, "camera")) read_camera(&j, p);
        else if (!strcmp(key, "perAnim")) read_per_anim(&j, p);
        else skip(&j); /* name, formats, fileName, and fields this version does not know */
    } while (!j.bad && eat(&j, ','));
    if (j.bad || !eat(&j, '}')) { snprintf(err, errn, "not an export preset (the JSON does not read)"); return 1; }
    if (!version) { snprintf(err, errn, "not an export preset (no \"ugo9ExportPreset\" version)"); return 1; }
    if (version > 1 && !quiet) fprintf(stderr, "preset: made by a newer version (%d): reading the settings this one knows\n", version);
    if (p->size_kind == 3 && p->scale <= 0) p->size_kind = 0;
    return 0;
}
