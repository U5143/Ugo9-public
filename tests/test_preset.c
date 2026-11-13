/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/*
 * The export preset reader of ugo_export (cli/preset.c) on broken input, meant to run under
 * AddressSanitizer and UBSan (like tests/test_core.c):
 * - good presets read with the right values
 * - every prefix of them (cut anywhere), thousands of byte flips, random bytes, garbage
 *   windows, deep nesting, long strings and escapes: the reader returns 0 or 1 and never
 *   reads outside the text (each text is in its own buffer with no 0 after it)
 *
 *   gcc -std=c99 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all -Icli \
 *       -o test_preset tests/test_preset.c cli/preset.c -lm && ./test_preset
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "preset.h"

static int failures;
#define CHECK(ok, msg) do { if (!(ok)) { failures++; printf("FAIL %s\n", msg); } else printf("ok   %s\n", msg); } while (0)

static UgoPreset P;

/* the text in a buffer of exactly its size, so a read past the end is caught */
static int read_exact(const char *text, size_t n)
{
    char err[160];
    char *buf = (char *)malloc(n ? n : 1);
    int r;
    if (!buf) exit(1);
    if (n) memcpy(buf, text, n);
    r = ugo_read_preset(buf, n, &P, err, sizeof(err));
    free(buf);
    if (r != 0 && r != 1) { failures++; printf("FAIL returned %d\n", r); }
    return r;
}

static unsigned rnd_state = 12345u;
static unsigned rnd(void) { rnd_state = rnd_state * 1103515245u + 12345u; return (rnd_state >> 16) & 0x7fffu; }

static const char *GOOD[] = {
    "{\"ugo9ExportPreset\":1,\"name\":\"PV\",\"formats\":[\"webm-alpha\",\"png-zip\"],\"fps\":60,"
    "\"size\":{\"width\":1920,\"height\":1080},\"background\":null,\"anim\":\"idle\",\"seconds\":4,"
    "\"pinned\":{\"AngleX\":10,\"Eye\\u00e9\":-0.5},\"fileName\":\"{doc}_{anim}\","
    "\"camera\":[{\"t\":0,\"zoom\":1},{\"t\":2,\"zoom\":2.5,\"x\":0,\"y\":-420}],"
    "\"future\":{\"a\":[1,2,{\"b\":\"\\ud83d\\ude00\\n\"}],\"c\":true,\"d\":false}}",
    "{ \"ugo9ExportPreset\" : 2 , \"size\" : { \"long\" : 3840 } , \"background\" : \"#336699\" , \"scale\" : 0.5 }",
    "\xef\xbb\xbf{\"ugo9ExportPreset\":1,\"anim\":\"t\\u0061lk\",\"seconds\":1e1}",
    "{\"ugo9ExportPreset\":1,\"formats\":[\"jpeg\"],\"jpegQuality\":75,\"region\":{\"x\":-40.5,\"y\":-300,\"width\":80,\"height\":120,\"z\":[1]},"
    "\"eachAnim\":true,\"holdFrames\":2,\"seamless\":true,\"seamlessLoops\":80}",
    "{\"ugo9ExportPreset\":1,\"perAnim\":{\"idle\":{\"loops\":3,\"seamless\":true,\"future\":[1,{\"x\":2}]},"
    "\"walk\":{\"seconds\":2.5,\"holdFrames\":2,\"fps\":24,\"seamlessLoops\":9},\"jump\":{\"skip\":true,\"seamless\":false},"
    "\"bad\":{\"loops\":0,\"fps\":999,\"holdFrames\":1.5,\"skip\":3},\"x\":5}}",
};

int main(void)
{
    size_t g, n, k;
    int i, ok, bad;

#ifdef _WIN32
    if (!freopen("NUL", "w", stderr)) return 1; /* the reader's "dropped" lines */
#else
    if (!freopen("/dev/null", "w", stderr)) return 1;
#endif

    /* good presets */
    ok = read_exact(GOOD[0], strlen(GOOD[0])) == 0 && P.has_fps && P.fps == 60 && P.size_kind == 1 && P.width == 1920 && P.height == 1080
      && P.has_bg && P.bg[0] == 0 && P.has_anim && !strcmp(P.anim, "idle") && P.seconds == 4 && P.npinned == 2
      && !strcmp(P.pinned_name[1], "Eye\xc3\xa9") && P.pinned_value[1] == -0.5 && P.ncams == 2 && P.cams[1].has_xy && P.cams[1].y == -420;
    CHECK(ok, "a full preset reads with the right values (unknown fields with nesting, escapes and a surrogate pair skipped)");
    ok = read_exact(GOOD[1], strlen(GOOD[1])) == 0 && P.size_kind == 2 && P.long_side == 3840 && !strcmp(P.bg, "#336699") && P.ncams == -1;
    CHECK(ok, "spaces, a newer version, size { long } wins over a later scale, no camera");
    ok = read_exact(GOOD[2], strlen(GOOD[2])) == 0 && !strcmp(P.anim, "talk") && P.seconds == 10;
    CHECK(ok, "a BOM, \\u escapes in a name, 1e1");
    ok = read_exact("{\"ugo9ExportPreset\":1,\"sampling\":\"nearest\"}", 43) == 0 && P.has_sampling && P.nearest
      && read_exact("{\"ugo9ExportPreset\":1,\"sampling\":\"linear\"}", 42) == 0 && P.has_sampling && !P.nearest
      && read_exact("{\"ugo9ExportPreset\":1,\"sampling\":\"blurry\"}", 42) == 0 && !P.has_sampling
      && read_exact("{\"ugo9ExportPreset\":1,\"sampling\":[1]}", 37) == 0 && !P.has_sampling;
    CHECK(ok, "sampling: nearest and linear read, other values dropped");
    ok = read_exact(GOOD[3], strlen(GOOD[3])) == 0 && P.has_quality && P.quality == 75 && P.has_region && P.region[0] == -40.5 && P.region[1] == -300
      && P.region[2] == 80 && P.region[3] == 120 && P.each_anim && P.has_hold && P.hold == 2 && P.has_seamless && P.seamless == 1 && P.seamless_loops == 80;
    CHECK(ok, "jpegQuality, region (model pixels, an unknown field in it skipped), eachAnim, holdFrames, seamless and seamlessLoops read");
    {
        const char *t = "{\"ugo9ExportPreset\":1,\"jpegQuality\":0,\"holdFrames\":2.5,\"eachAnim\":1,\"region\":{\"x\":0,\"y\":0,\"width\":0,\"height\":5}}";
        const char *u = "{\"ugo9ExportPreset\":1,\"region\":{\"x\":0,\"y\":0,\"width\":5},\"holdFrames\":13,\"jpegQuality\":101}";
        const char *w = "{\"ugo9ExportPreset\":1,\"region\":7,\"eachAnim\":false}";
        const char *z = "{\"ugo9ExportPreset\":1,\"seamless\":1,\"seamlessLoops\":0}";
        const char *z2 = "{\"ugo9ExportPreset\":1,\"seamless\":false,\"seamlessLoops\":1001}";
        ok = read_exact(t, strlen(t)) == 0 && !P.has_quality && !P.has_hold && !P.each_anim && !P.has_region
          && read_exact(u, strlen(u)) == 0 && !P.has_region && !P.has_hold && !P.has_quality
          && read_exact(w, strlen(w)) == 0 && !P.has_region && !P.each_anim
          && read_exact(z, strlen(z)) == 0 && !P.has_seamless && !P.seamless_loops
          && read_exact(z2, strlen(z2)) == 0 && P.has_seamless && !P.seamless && !P.seamless_loops;
        CHECK(ok, "values out of range or of the wrong kind are dropped (quality 0 and 101, hold 2.5 and 13, a region without a height or with width 0, a number)");
    }

    {
        const PresetAnim *i1, *w1, *j1, *b1;
        ok = read_exact(GOOD[4], strlen(GOOD[4])) == 0 && P.nper == 4;
        i1 = ugo_preset_anim(&P, "idle"); w1 = ugo_preset_anim(&P, "walk"); j1 = ugo_preset_anim(&P, "jump"); b1 = ugo_preset_anim(&P, "bad");
        ok = ok && i1 && i1->has_loops && i1->loops == 3 && i1->has_seamless && i1->seamless && !i1->skip
          && w1 && w1->has_seconds && w1->seconds == 2.5 && w1->has_hold && w1->hold == 2 && w1->has_fps && w1->fps == 24 && w1->seamless_loops == 9
          && j1 && j1->skip && j1->has_seamless && !j1->seamless
          && b1 && !b1->has_loops && !b1->has_fps && !b1->has_hold && !b1->skip && !ugo_preset_anim(&P, "x") && !ugo_preset_anim(&P, "none");
        CHECK(ok, "perAnim: each animation's loops, seconds, seamless, seamlessLoops, holdFrames, fps and skip; bad values dropped, a non-object entry skipped");
    }

    {
        const char *t = "{\"ugo9ExportPreset\":1,\"camera\":[{\"t\":0,\"zoom\":1},{\"t\":1,\"zoom\":2,\"cut\":true},{\"t\":2,\"zoom\":1,\"cut\":false},{\"t\":3,\"zoom\":1,\"cut\":7}]}";
        ok = read_exact(t, strlen(t)) == 0 && P.ncams == 4 && !P.cams[0].cut && P.cams[1].cut && !P.cams[2].cut && !P.cams[3].cut;
        CHECK(ok, "camera keys: cut true and false read, another value dropped (the key kept)");
    }

    /* every prefix */
    bad = 0;
    for (g = 0; g < sizeof(GOOD) / sizeof(*GOOD); g++) {
        size_t len = strlen(GOOD[g]);
        for (n = 0; n < len; n++) if (read_exact(GOOD[g], n) == 0) bad++;
    }
    CHECK(bad == 0, "every prefix (cut anywhere before the closing brace) is refused, nothing read outside");

    /* corrupted copies */
    {
        char buf[1024];
        unsigned read = 0;
        for (i = 0; i < 20000; i++) {
            const char *src = GOOD[(unsigned)i % (sizeof(GOOD) / sizeof(*GOOD))];
            size_t len = strlen(src);
            memcpy(buf, src, len);
            switch (rnd() % 4) {
            case 0: for (k = 0, n = 1 + rnd() % 4; k < n; k++) buf[rnd() % len] ^= (char)(1 << (rnd() % 8)); break;
            case 1: for (k = 0, n = 1 + rnd() % 4; k < n; k++) buf[rnd() % len] = "{}[]\":,\\-0123456789eEnulltruefalse \x00\xff"[rnd() % 38]; break;
            case 2: { size_t at = rnd() % len, w = 1 + rnd() % 32; for (k = at; k < at + w && k < len; k++) buf[k] = (char)rnd(); break; }
            default: len = rnd() % (len + 1); break;
            }
            if (read_exact(buf, len) == 0) read++;
        }
        printf("     corrupted presets: 20000 tried, %u still read\n", read);
        CHECK(1, "corrupted presets: no crash, nothing read outside the text");
    }

    /* deep nesting, long strings, many keys */
    {
        static char big[200000];
        size_t at = 0;
        at += (size_t)sprintf(big, "{\"ugo9ExportPreset\":1,\"x\":");
        for (k = 0; k < 10000; k++) big[at++] = '[';
        CHECK(read_exact(big, at) == 1, "10000 nested lists: refused (depth limit), no stack overflow");
        at = (size_t)sprintf(big, "{\"ugo9ExportPreset\":1,\"anim\":\"");
        for (k = 0; k < 100000; k++) big[at++] = 'a';
        at += (size_t)sprintf(big + at, "\",\"pinned\":{");
        for (k = 0; k < 100; k++) at += (size_t)sprintf(big + at, "%s\"p%u\":%u", k ? "," : "", (unsigned)k, (unsigned)k);
        at += (size_t)sprintf(big + at, "},\"camera\":[");
        for (k = 0; k < 40; k++) at += (size_t)sprintf(big + at, "%s{\"t\":%u,\"zoom\":1}", k ? "," : "", (unsigned)k);
        at += (size_t)sprintf(big + at, "]}");
        ok = read_exact(big, at) == 0 && !P.has_anim && P.npinned == PRESET_MAX_PINNED && P.ncams == PRESET_MAX_CAMS;
        CHECK(ok, "a 100000-byte name is dropped, 100 pinned values and 40 camera keys keep the first 64 and 32");
        at = (size_t)sprintf(big, "{\"ugo9ExportPreset\":1,\"name\":\"");
        for (k = 0; k < 20000; k++) at += (size_t)sprintf(big + at, "\\ud800");
        big[at++] = '"'; big[at++] = '}';
        CHECK(read_exact(big, at) == 0, "20000 lone surrogates in a skipped string read");
        CHECK(read_exact("{\"ugo9ExportPreset\":1,\"fps\":1e999}", 34) == 1, "a number too big to be finite: refused");
    }

    { /* "backdrop": a file name, or { file, x, y, width, height } (the four together); wrong ones dropped */
        const char *a1 = "{\"ugo9ExportPreset\":1,\"backdrop\":\"bg/背景.png\"}";
        const char *a2 = "{\"ugo9ExportPreset\":1,\"backdrop\":{\"file\":\"bg.png\",\"x\":-210,\"y\":-590,\"width\":420.5,\"height\":600,\"z\":1}}";
        const char *b1 = "{\"ugo9ExportPreset\":1,\"backdrop\":{\"file\":\"bg.png\",\"x\":0,\"y\":0,\"width\":10}}";
        const char *b2 = "{\"ugo9ExportPreset\":1,\"backdrop\":{\"x\":0,\"y\":0,\"width\":10,\"height\":10}}";
        const char *b3 = "{\"ugo9ExportPreset\":1,\"backdrop\":7,\"fps\":24}";
        ok = read_exact(a1, strlen(a1)) == 0 && P.has_backdrop && !P.has_backdrop_rect && !strcmp(P.backdrop, "bg/背景.png");
        ok = ok && read_exact(a2, strlen(a2)) == 0 && P.has_backdrop && P.has_backdrop_rect && !strcmp(P.backdrop, "bg.png") && P.backdrop_rect[0] == -210 && P.backdrop_rect[2] == 420.5 && P.backdrop_rect[3] == 600;
        CHECK(ok, "backdrop: a file name, or with where it lies (an unknown field in it skipped)");
        ok = read_exact(b1, strlen(b1)) == 0 && !P.has_backdrop && read_exact(b2, strlen(b2)) == 0 && !P.has_backdrop && read_exact(b3, strlen(b3)) == 0 && !P.has_backdrop && P.has_fps;
        CHECK(ok, "backdrop: a part of the rectangle, no file, or not a name nor an object: dropped (the rest read)");
    }
    printf(failures ? "\n%d check(s) failed\n" : "\nall preset reader checks passed\n", failures);
    return failures ? 1 : 0;
}
