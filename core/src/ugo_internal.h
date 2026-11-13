/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Binary layout of a compiled .ug9 file (version 1.x). See the format spec in docs/. */
#ifndef UGO_INTERNAL_H
#define UGO_INTERNAL_H

#include <stdint.h>

/* Every multiplication and addition is rounded on its own, never fused into one
 * (a*b+c as one instruction rounds once: other bits). Some compilers fuse them by
 * default where the processor can (clang and GCC on ARM64, or with -mfma): turned
 * off here, so every platform gives the same bits. (MSVC does not fuse unless told;
 * WebAssembly has no fused instruction, and there the pragma only slows clang's code.) */
#if defined(__clang__) && !defined(__wasm__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__) && (defined(__aarch64__) || defined(__FP_FAST_FMA) || defined(UGO_GCC_NO_CONTRACT_TEST))
#pragma GCC optimize("fp-contract=off")
#endif

#define UGO_PHYSICS_HZ 120.0f

/* Header (1.0): magic "UGO9", major u16, minor u16, file size, header size,
 * canvas[4] (byte 16), table of contents count (byte 32), flags (byte 36,
 * reserved). A later 1.x may make the header longer: bytes past the ones
 * known here are skipped (the header size says where the contents start). */
#define UGO_HEADER_SIZE 40   /* the header this core knows */
#define UGO_TOC_ENTRY 16     /* kind, offset, count, record size (u16), flags (u16) */
#define UGO_TOC_MAX 256
/* Table kinds, as the table of contents names them. The numbers never change;
 * a later 1.x only adds kinds (and the compiler's TABLE_KIND agrees: checked by
 * tests/constants_test.mjs). A table's records never change shape either:
 * fields are added as another table with as many records. */
enum {
    TB_PARAMS = 1, TB_BONES = 2, TB_CONS = 3, TB_PARTS = 4, TB_TEXTURES = 5,
    TB_POSITIONS = 6, TB_UVS = 7, TB_JOINTS = 8, TB_WEIGHTS = 9, TB_VPARTS = 10,
    TB_CSR = 11, TB_ENTRIES = 12, TB_INDICES = 13, TB_REGIONS = 14, TB_MORPHS = 15,
    TB_BDRIVERS = 16, TB_ODRIVERS = 17, TB_PHYS = 18, TB_PHYSIN = 19, TB_ANIMS = 20,
    TB_TRACKS = 21, TB_KEYS = 22, TB_STRINGS = 23, TB_MASKS = 24, TB_MASKREFS = 25,
    TB_COLORS = 26, TB_CDRIVERS = 27, TB_XSTART = 28, TB_XWEIGHTS = 29, TB_WARPS = 30,
    TB_WPOINTS = 31, TB_WDRIVERS = 32, TB_WDELTAS = 33, TB_BWARPS = 34, TB_CHAINS = 35,
    TB_CHAINBONES = 36, TB_ORDERS = 37, TB_ORDRIVERS = 38, TB_EXPRS = 39, TB_EXPRITEMS = 40,
    TB_TRACKS11 = 41, TB_KEYS11 = 42, TB_CURVES = 43, /* 1.1: in place of 21 and 22 (expanded at load) */
    TB_KNOWN = 44 /* kinds below this are known to this core */
};
/* What a core that does not know a table's kind does with it (the low 2 bits
 * of its flags; the writer decides): */
enum { TOC_SKIP = 0,   /* skip it: the picture is the same (names, editor data) */
       TOC_WARN = 1,   /* skip it, but the picture may differ: ugo_model_warnings says so */
       TOC_NEED = 2 }; /* do not load the file (UGO_ERR_VERSION): it needs a newer core */
#define TOC_ACTION_MASK 3u

/* Counts kept per model (the tables' record counts; the vertex count is the
 * positions table's). */
enum {
    KC_PARAMS, KC_BONES, KC_CONS, KC_PARTS, KC_TEXTURES,
    KC_VERTS, KC_INDICES, KC_ENTRIES, KC_REGIONS, KC_MORPHS,
    KC_BDRIVERS, KC_ODRIVERS, KC_PHYS, KC_PHYSIN,
    KC_ANIMS, KC_TRACKS, KC_KEYS, KC_STRINGS,
    KC_MASKS, KC_MASKREFS, KC_COLORS, KC_CDRIVERS, KC_XWEIGHTS, /* 0.4 */
    KC_WARPS, KC_WPOINTS, KC_WDRIVERS, KC_WDELTAS, KC_BWARPS, /* 0.5 */
    KC_CHAINS, KC_CHAINBONES, /* 0.6 */
    KC_ORDERS, KC_ORDRIVERS, /* 0.8 */
    KC_EXPRS, KC_EXPRITEMS, /* 0.8 */
    KC_COUNT_FIELDS
};
#define UGO_CANVAS_WORD 4 /* header word index of canvas[4] (byte 16) */

typedef struct { float min, def, max; uint32_t name; } KParam;
/* Rest pose relative to the parent; angles in radians. shx / shy turn the
 * x / y axis (shear); inherit says what the bone takes from its parent. */
typedef struct {
    int32_t parent; float x, y, rot, sx, sy; uint32_t name; float bindInv[6];
    float shx, shy, length; uint32_t inherit;
} KBone;
/* numbers shared with tools/compile.mjs (checked by tests/constants_test.mjs) */
enum { INHERIT_NORMAL = 0, INHERIT_ONLY_TRANSLATION = 1, INHERIT_NO_ROTATION = 2, INHERIT_NO_SCALE = 3, INHERIT_NO_SCALE_OR_REFLECTION = 4, INHERIT_COUNT = 5 };
/* A constraint, applied in table order after the bones are posed.
 * IK: bone (and bone2 for two bones) aims at target; mix[0] = mix, off[0] = bend (+1/-1).
 * Transform: bone follows target; mix and off are rotation, x, y, scaleX, scaleY, shearY. */
typedef struct { uint32_t type, flags; int32_t bone, bone2, target; float mix[6], off[6]; } KCons;
enum { CONS_IK, CONS_TRANSFORM, CONS_COUNT };
#define IK_COMPRESS 1u
#define IK_STRETCH 2u
#define IK_UNIFORM 4u
#define TC_LOCAL 1u
#define TC_RELATIVE 2u
/* A part. mask: mask record that clips it (UGO_NONE: none); color: colour slot (UGO_NONE: none). */
typedef struct {
    uint32_t firstVert, vertCount, firstIndex, indexCount; float opacity; uint32_t blend, texture, name;
    uint32_t mask, flags, color, warp; /* warp: the warp grid its vertices live in (UGO_NONE: bones) */
} KPart;
enum { BLEND_NORMAL, BLEND_ADD, BLEND_MULTIPLY, BLEND_SCREEN, BLEND_COUNT };
#define PART_MASK_INVERT 1u /* drawn only outside the mask */
#define PART_HIDDEN 2u      /* never drawn itself; only used as (part of) a mask */
#define PART_SOLID 4u       /* as a mask, covers its whole mesh (texture alpha ignored) */
#define PART_FLAGS_ALL 7u
#define UGO_NONE 0xffffffffu
/* A mask: the union of the listed parts' shapes (refs[first .. first+count)), drawn into one channel. */
typedef struct { uint32_t firstRef, refCount, channel; } KMask;
#define UGO_MASK_CHANNELS 16
/* A colour slot shared by parts. mode 0: a = multiply, b = screen (Live2D);
 * mode 1: a = tint (light), b = dark colour (Spine two-colour tint).
 * Either way the shader computes rgb = C * X + alpha * Y (premultiplied C). */
typedef struct { uint32_t mode; float a[3], b[3]; uint32_t reserved; } KColor;
enum { COLOR_MULTIPLY_SCREEN = 0, COLOR_TINT_DARK = 1, COLOR_MODE_COUNT = 2 }; /* as COLOR_MODES in tools/compile.mjs */
/* Parameter-driven change of a colour slot: region weight x (da, db) is added. */
typedef struct { uint32_t region, slot; float da[3], db[3]; } KColorDriver;
typedef struct { uint32_t morph; float dx, dy; } KEntry;
typedef struct { uint32_t param; float start, peak, end; } KAxis;
typedef struct { uint32_t axisCount; KAxis axis[4]; } KRegion;
typedef struct { uint32_t region, bone; float drot, dx, dy, dsx, dsy; } KBoneDriver;
typedef struct { uint32_t region, part; float dop; } KOpDriver;
typedef struct { uint32_t firstInput, inputCount, output; float stiffness, damping, gain, outMin, outMax; } KPhys;
typedef struct { uint32_t param; float weight; } KPhysIn;
/* tick: seconds per step of the key times (the last key time / 65535; 0.7) */
typedef struct { uint32_t name; float duration; uint32_t loop, firstTrack, trackCount; float tick; } KAnim;
/* A track's target: kind in the top 8 bits, index (param, bone, part or
 * morph) in the low 24. Kind 0 is a parameter, so v0.1 files read as-is. */
/* value of key k = base + k.v * step; a track with one key has no key: its value is base (0.7) */
typedef struct { uint32_t target, firstKey, keyCount; float base, step; } KTrack;
enum { /* the kinds as TRACK_KIND in tools/compile.mjs numbers them (checked by tests/constants_test.mjs) */
    TK_PARAM = 0,                                              /* parameter value */
    TK_BONE_ROT = 1, TK_BONE_X = 2, TK_BONE_Y = 3, TK_BONE_SX = 4, TK_BONE_SY = 5, /* offsets from the rest pose */
    TK_PART_OPACITY = 6,                                       /* replaces the part's opacity */
    TK_MORPH = 7,                                              /* weight added to the morph */
    TK_BONE_SHX = 8, TK_BONE_SHY = 9,                          /* shear offsets (0.3) */
    TK_CONS = 10,  /* constraint value: index = record * 8 + channel (0-5 mix, 6 IK bend) (0.3) */
    TK_COLOR = 11, /* colour slot value: index = slot * 8 + channel (0-2 a.rgb, 3-5 b.rgb) (0.4) */
    TK_PART_ORDER = 12, /* replaces the part's draw order value (0.8) */
    TK_COUNT = 13
};
#define TRACK_KIND(t) (((t) >> 24) & 0x7fu)
#define TRACK_EASED(t) ((t) >> 31) /* every piece eased: smoothstep between keys (0.7) */
#define TRACK_INDEX(t) ((t) & 0xffffffu)
#define UGO_NO_REGION 0xffffffffu /* a morph driven only by animation tracks */
/* t: the time in ticks of the animation, v: 0..65535 in the track's range. Straight lines
 * between keys, or eased ones (smoothstep) on a track marked TRACK_EASED; the compiler
 * writes a step as a second key at the next key's time, and eased pieces on a track that
 * also has straight ones as short straight pieces (0.7) */
typedef struct { uint16_t t, v; } KKey;
/* 1.1 (tables 41-43, written in place of 21 and 22; the core expands them into
 * KTrack and KKey in the model's memory, see ugo_model_mem_size_for):
 * a track of 12 bytes, step 0 = no keys (its value is base); the keys table is
 * 4-byte words: for each track with keys, a count word (2 or more) then its keys;
 * a curve turns the segment from key `key` (an index in the keys table) to the
 * next key of the same track into n straight pieces along a cubic Bezier from
 * (0, v0) over (cx1 / 65535, cy1), (cx2 / 65535, cy2) to (1, v1): x the fraction of
 * the segment's time, y in key value units. Computed exactly in integers
 * (tools/curve_keys.mjs does the same). */
typedef struct { uint32_t target; float base, step; } KTrack11;
/* Not in the file: an animation's tracks as runs, made at load when the model's memory has room
 * (ugo_model_mem_size_for counts it). A run is tracks first .. first + count - 1 of one kind:
 * the single-key tracks a kind starts with (const: their offsets and values in cOff / cVal from
 * const on), or the rest of the kind (const = UGO_NONE), or all of a part-opacity or unknown kind. */
typedef struct { uint32_t kind, first, count, cfirst; } KRun;
typedef struct { uint32_t key; uint16_t n, cx1, cy1, cx2, cy2, reserved; } KCurve;
#define UGO_CURVE_MAX_PIECES 256
#define KEY_TIME(k) ((float)(k).t)
/* A warp grid (0.5): cols x rows cells, (cols+1) x (rows+1) control points from
 * points[firstPoint]. Rest points are in model space, or in the parent warp's
 * cell coordinates when parent != UGO_NONE (then bone is unused). Vertices
 * and child points inside are in this warp's cell coordinates (0..cols, 0..rows). */
typedef struct { uint32_t cols, rows, parent, bone, firstPoint, name; } KWarp;
#define UGO_WARP_MAX_CELLS 64
/* Parameter-driven change of a warp's points: region weight x deltas[firstDelta ..] (2 per point). */
typedef struct { uint32_t region, warp, firstDelta; } KWarpDriver;
/* A bone placed by a warp grid (Live2D's rotation deformer inside a warp): its
 * root follows the grid's surface and turns with it. Model space -> the grid's
 * cells: dx = x - ox, dy = y - oy, cells (dx * a + dy * c, dx * b + dy * d).
 * rc, rs: cos and sin of the grid's x direction in the rest pose, so a turned
 * grid (0.8) doesn't turn the bone at rest. The bone has no parent;
 * constraints and warp grids don't use it or its descendants. */
typedef struct { uint32_t bone, warp; float ox, oy, a, b, c, d, rc, rs; } KBoneWarp;
/* A chain of bones that sways (0.6): bones chainBones[firstBone ..] from root
 * to tip, each the child of the one before. Their joints are Verlet points
 * pulled back to the animated pose (stiffness, 1/s^2), slowed (damping, 1/s),
 * pulled by gravity (model px/s^2) and left behind when the character moves
 * on screen (inertia 0..1); the bones then turn toward them (mix). */
typedef struct { uint32_t firstBone, boneCount; float stiffness, damping, gx, gy, inertia, mix; uint32_t name; } KChain; /* name: 0.7 */
#define UGO_CHAIN_MAX 64 /* bones per chain */
/* Draw order (0.8): orders[part] is each part's own value (n[KC_ORDERS] is 0
 * or the part count). Parts are drawn by value, smallest first, equal values
 * in the parts' order. A parameter-driven change adds region weight x d. */
typedef struct { uint32_t region, part; float d; } KOrderDriver;
#define UGO_ORDER_MAX 1.0e6f /* |value| and |d| at most this */
/* An expression (0.8): items[firstItem ..] change parameters, with fade times
 * (seconds) for the host's fading. Each item: v <- v + (value - v) * w (set),
 * v + value * w (add), v * (1 + (value - 1) * w) (multiply), w the weight. */
typedef struct { uint32_t name, firstItem, itemCount; float fadeIn, fadeOut; } KExpr;
typedef struct { uint32_t param, op; float value; } KExprItem;
enum { EXPR_SET = 0, EXPR_ADD = 1, EXPR_MULTIPLY = 2, EXPR_OP_COUNT = 3 }; /* as EXPR_OPS in tools/expressions.mjs (checked by tests/constants_test.mjs) */
/* A bone influence beyond a vertex's first four (strongest first). */
typedef struct { uint32_t bone; float weight; } KXWeight;

typedef char ugo_check_bone[(sizeof(KBone) == 68) ? 1 : -1];
typedef char ugo_check_cons[(sizeof(KCons) == 68) ? 1 : -1];
typedef char ugo_check_region[(sizeof(KRegion) == 68) ? 1 : -1];
typedef char ugo_check_phys[(sizeof(KPhys) == 32) ? 1 : -1];
typedef char ugo_check_part[(sizeof(KPart) == 48) ? 1 : -1];
typedef char ugo_check_color[(sizeof(KColor) == 32) ? 1 : -1];
typedef char ugo_check_cdrv[(sizeof(KColorDriver) == 32) ? 1 : -1];
typedef char ugo_check_bwarp[(sizeof(KBoneWarp) == 40) ? 1 : -1];
typedef char ugo_check_curve[(sizeof(KTrack11) == 12 && sizeof(KCurve) == 16 && sizeof(KTrack) == 20) ? 1 : -1];
typedef char ugo_check_expr[(sizeof(KExpr) == 20 && sizeof(KExprItem) == 12) ? 1 : -1];


struct UgoModel {
    const uint8_t *base;
    uint32_t size;
    uint32_t n[KC_COUNT_FIELDS];
    float canvas[4];
    const KParam *params;
    const KBone *bones;
    const KCons *cons;
    const KPart *parts;
    const uint32_t *textures;
    const float *pos;
    const float *uv;
    const uint16_t *joints;
    const float *weights;
    const uint32_t *vparts;
    const uint32_t *csr;
    const KEntry *entries;
    const uint32_t *indices;
    const KRegion *regions;
    const uint32_t *morphs;
    const KBoneDriver *bdrv;
    const KOpDriver *odrv;
    const KPhys *phys;
    const KPhysIn *physin;
    const KAnim *anims;
    const KTrack *tracks;
    const KKey *keys;
    const char *strings;
    const KMask *masks;
    const uint32_t *maskrefs;
    const KColor *colors;
    const KColorDriver *cdrv;
    const uint32_t *xstart; /* vertexCount + 1: each vertex's range of extra influences */
    const KXWeight *xweights;
    const KWarp *warps;
    const float *wpoints;  /* 2 per point */
    const KWarpDriver *wdrv;
    const float *wdeltas;  /* 2 per point */
    const KBoneWarp *bwarps;
    const KChain *chains;
    const uint32_t *chainBones;
    const float *orders;         /* 0.8: per part, or none */
    const KOrderDriver *ordrv;   /* 0.8 */
    const KExpr *exprs;          /* 0.8 */
    const KExprItem *exprItems;  /* 0.8 */
    const uint32_t *animRun;     /* per animation + 1: its first run (or 0: no runs, see KRun) */
    const KRun *runs;
    const uint32_t *cOff;        /* per single-key track in a run: where it writes (stride * index) */
    const float *cVal;           /* and its value */
    uint32_t frameFloats, skinOff, opOff, morphOff, colorOff, warpOff;
    uint32_t maskChannels; /* highest mask channel + 1 */
    uint32_t warnings;     /* UGO_WARN_*: what of a later 1.x this core skipped */
    uint32_t format;       /* the file's major << 16 | minor */
};

struct UgoInstance {
    const struct UgoModel *m;
    float *params;  /* current parameter values */
    float *phys;    /* 3 per physics: position, velocity, initialised */
    float *regionW; /* weight of each region this frame */
    float *local;   /* 7 per bone: posed local values x, y, rot, sx, sy, shx, shy */
    float *world;   /* 6 per bone: world matrix */
    float *frame;   /* the frame block handed to the GPU */
    float *animBone;    /* 7 per bone: offsets set by animation tracks (rot, x, y, sx, sy, shx, shy) */
    float *animOpacity; /* 1 per part: opacity keyed by animation tracks, < 0 when not keyed */
    float *animMorph;   /* 1 per morph: weights set by animation tracks */
    uint32_t *stamp;    /* 3 per bone: world computed at, local changed at, scratch (see bone_world) */
    uint32_t gen;       /* counts world computations and local changes during ugo_update */
    uint32_t lastTouch; /* gen of the last change of local values */
    float *sincos;      /* 6 per bone: last x-axis angle, its sin, cos; the same for the y axis */
    uint32_t *memo;      /* 14 per bone: the bits of the local values and the parent's world its world was
                            last computed from, and 1 while its skin matrix is not written yet */
    uint32_t prevValid;  /* worlds from the last update can be kept (see compose_bone, ugo_update) */
    uint32_t *warpMemo;  /* per warp: the bits of its bone's skin matrix (6) its points were last placed with; then
                            per warp driver: the bits of its region weight then (see ugo_update) */
    uint8_t *warpNew;    /* per warp: 1 when its points are placed again this update (else kept from the last) */
    float *chain;       /* per chain joint: x, y, previous x, previous y; then per chain: started; then last instance tx, ty, started */
    float *animCons;    /* 8 per constraint: mix[6], bend, unused (from the model, then tracks) */
    float *animColor;   /* 8 per colour slot: a.rgb, b.rgb, unused x2 (from the model, then tracks) */
    float *animOrder;   /* 1 per part: draw order value (from the model, then tracks; 0.8) */
    float *orderVal;    /* 1 per part: this frame's draw order value */
    uint32_t *drawList; /* 1 per part: the parts in draw order (kept from frame to frame); then as many for sorting (0.8) */
    uint32_t orderKey;  /* 0 when drawList is the parts' order; else a hash of it */
    float *boneBox;     /* 4 per bone: the rest box of the vertices it moves (morphs' reach added), for ugo_bounds_estimate */
    uint32_t boneBoxReady;
    float wind[3];      /* x, y (acceleration, model px/s^2) and gust (0..) for the chains: ugo_set_wind */
    double windTime;    /* seconds the wind has run (its gusts are a function of it) */
};

#endif
