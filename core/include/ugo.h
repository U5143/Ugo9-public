/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/*
 * Ugo9 runtime core (C99, freestanding).
 *
 * The core never allocates, never does I/O and never touches the GPU.
 * Each frame it turns parameter values into a small "frame block"
 * (bone skin matrices, part opacities, morph weights: a few KB per
 * character). Vertex deformation is done by the host's GPU shader from that
 * block; ugo_deform_cpu() is the reference / fallback path that computes
 * the same result on the CPU.
 *
 * Coordinates: model space is in pixels, x to the right, y downwards.
 */
#ifndef UGO_H
#define UGO_H

#include <stdint.h>

/* Windows: UGO_BUILD_DLL when building ugo.dll, UGO_DLL when using it from C/C++
 * (not needed for C# P/Invoke or the static library). */
#if defined(_WIN32) && defined(UGO_BUILD_DLL)
#define UGO_API __declspec(dllexport)
#elif defined(_WIN32) && defined(UGO_DLL)
#define UGO_API __declspec(dllimport)
#elif defined(__GNUC__) || defined(__clang__)
#define UGO_API __attribute__((visibility("default")))
#else
#define UGO_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define UGO_VERSION_MAJOR 1
#define UGO_VERSION_MINOR 1

typedef struct UgoModel UgoModel;
typedef struct UgoInstance UgoInstance;

/* Load errors (ugo_model_init returns NULL and ugo_last_error tells why). */
enum {
    UGO_OK = 0,
    UGO_ERR_SIZE = 1,      /* buffer too small / size mismatch */
    UGO_ERR_MAGIC = 2,     /* not a .ug9 file */
    UGO_ERR_VERSION = 3,   /* another major version (compile again), or a later 1.x that needs a newer core */
    UGO_ERR_ALIGN = 4,     /* data or memory not 4-byte aligned */
    UGO_ERR_LIMIT = 5,     /* a count is over the format limits */
    UGO_ERR_RANGE = 6,     /* an index or offset points outside its table */
    UGO_ERR_VALUE = 7      /* a float is NaN/Inf or a value is invalid */
};

/* What a model from a later 1.x had that this core skipped (ugo_model_warnings).
 * Files of any 1.x are read: unknown tables and track kinds are skipped. These
 * say the picture may differ from what a newer core draws. */
#define UGO_WARN_SKIPPED_TABLE 1u  /* a table this core does not know, marked as changing the picture */
#define UGO_WARN_SKIPPED_TRACKS 2u /* animation tracks of kinds this core does not know */

/* ---- model (immutable, shared by instances) ---------------------------- */

/* Bytes the caller must provide (aligned to 16) for ugo_model_init: enough for
 * a 1.0 file. A 1.1 file with tables 41-43 (curve keys or not) needs more:
 * see ugo_model_mem_size_for, which works for every file. */
UGO_API uint32_t ugo_model_mem_size(void);
/* Bytes this file needs (1.1: its tracks and keys are expanded into the model's
 * memory), and room for the animations' tracks grouped into runs, which play
 * faster (a model given less plays them one by one: the same results, bit for
 * bit). Reads only the header, the table of contents, the animation, track and
 * key tables; 0 if those are broken (ugo_last_error says why). Never less than
 * ugo_model_mem_size(). */
UGO_API uint32_t ugo_model_mem_size_for(const void *data, uint32_t size);

/* Validates the whole file (safe on hostile input) and returns a model that
 * points into `data`. `data` must stay alive and be 4-byte aligned. `mem` is
 * ugo_model_mem_size() bytes: a file that needs more fails with UGO_ERR_SIZE. */
UGO_API UgoModel *ugo_model_init(void *mem, const void *data, uint32_t size);
/* The same with `mem_size` bytes at `mem` (ugo_model_mem_size_for(data, size) is enough). */
UGO_API UgoModel *ugo_model_init_sized(void *mem, uint32_t mem_size, const void *data, uint32_t size);
/* After ugo_model_init: UGO_WARN_* bits (0 for a file of this version or earlier). */
UGO_API uint32_t ugo_model_warnings(const UgoModel *m);
/* The file's format version: major << 16 | minor (any minor of this core's major is read). */
UGO_API uint32_t ugo_model_format(const UgoModel *m);
UGO_API int ugo_last_error(void);
/* the format version this core reads: major << 16 | minor */
UGO_API uint32_t ugo_version(void);

UGO_API uint32_t ugo_param_count(const UgoModel *m);
UGO_API uint32_t ugo_bone_count(const UgoModel *m);
UGO_API uint32_t ugo_part_count(const UgoModel *m);
UGO_API uint32_t ugo_vertex_count(const UgoModel *m);
UGO_API uint32_t ugo_index_count(const UgoModel *m);
UGO_API uint32_t ugo_morph_count(const UgoModel *m);
UGO_API uint32_t ugo_entry_count(const UgoModel *m);
UGO_API uint32_t ugo_animation_count(const UgoModel *m);
UGO_API uint32_t ugo_texture_count(const UgoModel *m);
/* Constraint records (IK / transform; a transform constraint on several bones counts once per bone). */
UGO_API uint32_t ugo_constraint_count(const UgoModel *m);
/* 1 when the skeleton only needs plain parent-child transforms (every bone
 * inherits normally, no shear in the rest pose or any track, no constraints,
 * no bones in warp grids, no swaying chains):
 * then ugo_bone_pose values rebuild the world matrices in any engine. */
UGO_API int ugo_skeleton_is_simple(const UgoModel *m);

/* Numbers from names (-1: none). Look them up once, not every frame (a linear search). */
UGO_API int ugo_find_param(const UgoModel *m, const char *name);
UGO_API int ugo_find_animation(const UgoModel *m, const char *name);
UGO_API int ugo_find_bone(const UgoModel *m, const char *name);
UGO_API int ugo_find_part(const UgoModel *m, const char *name);
UGO_API const char *ugo_param_name(const UgoModel *m, uint32_t i);
UGO_API float ugo_param_min(const UgoModel *m, uint32_t i);
UGO_API float ugo_param_max(const UgoModel *m, uint32_t i);
UGO_API float ugo_param_default(const UgoModel *m, uint32_t i);
UGO_API const char *ugo_animation_name(const UgoModel *m, uint32_t i);
UGO_API float ugo_animation_duration(const UgoModel *m, uint32_t i);
UGO_API int ugo_animation_loop(const UgoModel *m, uint32_t i); /* 1 if it loops, 0 if not (or out of range) */
/* Reading an animation's tracks (editors, tools). info[4] = kind (0 parameter, 1-5 bone rotate,
 * x, y, scaleX, scaleY, 6 opacity, 7 morph, 8-9 shear, 10 constraint, 11 colour, 12 draw order:
 * as docs/形式.md), index, key count (0: no keys, one value), smooth (1: smoothstep between keys).
 * Keys are [time in seconds, value] after loading (a 1.1 curve as its straight pieces); values in
 * the track's units (bone angles in radians, offsets from the rest pose). The value at a time is
 * the track alone (what ugo_apply_animation mixes in). Each returns 0 for a bad number. */
UGO_API uint32_t ugo_animation_track_count(const UgoModel *m, uint32_t anim);
UGO_API int ugo_animation_track(const UgoModel *m, uint32_t anim, uint32_t k, uint32_t *info);
UGO_API int ugo_animation_track_key(const UgoModel *m, uint32_t anim, uint32_t k, uint32_t key, float *tv);
UGO_API float ugo_animation_track_value(const UgoModel *m, uint32_t anim, uint32_t k, float time);
UGO_API const char *ugo_texture_name(const UgoModel *m, uint32_t i);
UGO_API const char *ugo_part_name(const UgoModel *m, uint32_t i);
/* canvas[4] = width, height, originX, originY (where model (0,0) sits). */
UGO_API const float *ugo_canvas(const UgoModel *m);

/* Static mesh data for building GPU buffers once at load time.
 * Parts are stored in draw order; indices are global vertex numbers. */
UGO_API const float *ugo_positions(const UgoModel *m);    /* 2 per vertex */
UGO_API const float *ugo_uvs(const UgoModel *m);          /* 2 per vertex */
UGO_API const uint16_t *ugo_joints(const UgoModel *m);    /* 4 per vertex */
UGO_API const float *ugo_weights(const UgoModel *m);      /* 4 per vertex */
UGO_API const uint32_t *ugo_vertex_parts(const UgoModel *m);
UGO_API const uint32_t *ugo_csr_starts(const UgoModel *m); /* vertexCount+1 */
UGO_API const float *ugo_entries(const UgoModel *m);      /* 3 per entry: morph(u32 bits), dx, dy */
UGO_API const uint32_t *ugo_indices(const UgoModel *m);
/* Bone influences beyond a vertex's first four (0.4): vertex v uses entries
 * starts[v] .. starts[v+1] of ugo_extra_weights (2 per entry: bone as u32 bits, weight). */
UGO_API uint32_t ugo_extra_weight_count(const UgoModel *m);
UGO_API const uint32_t *ugo_extra_weight_starts(const UgoModel *m); /* vertexCount+1 */
UGO_API const float *ugo_extra_weights(const UgoModel *m);
UGO_API uint32_t ugo_part_texture(const UgoModel *m, uint32_t part);
/* range[4] = first vertex, vertex count, first index, index count */
UGO_API void ugo_part_range(const UgoModel *m, uint32_t part, uint32_t *range);

/* ---- masks, blending and colours (0.4) ---------------------------------
 * A mask is the union of some parts' shapes (texture alpha, or the whole mesh
 * for UGO_PART_SOLID parts). A masked part is drawn only inside its mask
 * (outside with UGO_PART_MASK_INVERT). Masks don't depend on draw order and
 * ignore the mask parts' opacity. Each mask has a channel (< 16): renderers
 * draw every mask of every character into channels of screen-sized images
 * first, then draw the characters once, reading their mask channel there. */
enum { UGO_BLEND_NORMAL = 0, UGO_BLEND_ADD = 1, UGO_BLEND_MULTIPLY = 2, UGO_BLEND_SCREEN = 3 };
#define UGO_PART_MASK_INVERT 1u /* drawn only outside its mask */
#define UGO_PART_HIDDEN 2u      /* not drawn; only used as (part of) a mask, e.g. a Spine clipping polygon */
#define UGO_PART_SOLID 4u       /* as a mask, covers its whole mesh (texture ignored) */
UGO_API uint32_t ugo_part_blend(const UgoModel *m, uint32_t part);
UGO_API uint32_t ugo_part_flags(const UgoModel *m, uint32_t part);
UGO_API int ugo_part_mask(const UgoModel *m, uint32_t part);  /* mask clipping the part, or -1 */
UGO_API int ugo_part_color(const UgoModel *m, uint32_t part); /* colour slot of the part, or -1 */
UGO_API uint32_t ugo_mask_count(const UgoModel *m);
UGO_API uint32_t ugo_mask_channel_count(const UgoModel *m); /* highest channel + 1 (0: no masks) */
UGO_API uint32_t ugo_mask_channel(const UgoModel *m, uint32_t mask);
UGO_API const uint32_t *ugo_mask_parts(const UgoModel *m, uint32_t mask, uint32_t *count);
UGO_API uint32_t ugo_color_count(const UgoModel *m);

/* ---- expressions (0.8) ---------------------------------------------------
 * An expression changes parameters by name (a smile, anger, ...), like
 * Live2D's: each item sets, adds to or multiplies a parameter, at a weight
 * (0..1) the host fades in and out (the fade times are stored for it). Apply
 * them after the animations and tracking (set_param) and before ugo_update,
 * so physics and everything parameters drive follow them. Each item:
 *   set:      v <- v + (value - v) * w
 *   add:      v <- v + value * w
 *   multiply: v <- v * (1 + (value - 1) * w)
 * Expressions applied one after another stack in that order. */
enum { UGO_EXPR_SET = 0, UGO_EXPR_ADD = 1, UGO_EXPR_MULTIPLY = 2 };
UGO_API uint32_t ugo_expression_count(const UgoModel *m);
UGO_API const char *ugo_expression_name(const UgoModel *m, uint32_t expr);
UGO_API void ugo_expression_fade(const UgoModel *m, uint32_t expr, float *fade); /* fade[2] = in, out (seconds) */
/* The expression's items, 3 floats each: parameter (u32 bits), op (u32 bits), value. */
UGO_API const float *ugo_expression_items(const UgoModel *m, uint32_t expr, uint32_t *count);
UGO_API void ugo_apply_expression(UgoInstance *in, uint32_t expr, float weight);
/* Expressions from elsewhere (a preset written for another model): parameter
 * names -> numbers once (out_index[i] = -1 when the model has no such
 * parameter; returns how many were missing), then each frame apply the items
 * (index -1 is skipped, as are unknown ops and values that are not finite). */
UGO_API uint32_t ugo_resolve_params(const UgoModel *m, const char *const *names, uint32_t n, int32_t *out_index);
UGO_API void ugo_apply_params(UgoInstance *in, const int32_t *index, const uint32_t *ops, const float *values, uint32_t n, float weight);

/* ---- draw order (0.8) ----------------------------------------------------
 * Parts are stored in draw order, but a model may change it: each part has a
 * value, parameters and animations change it, and the parts are drawn by
 * value (smallest first; equal values in the stored order). Without it
 * (ugo_has_draw_order 0) the order is always the stored one. */
UGO_API int ugo_has_draw_order(const UgoModel *m);
UGO_API float ugo_part_draw_order(const UgoModel *m, uint32_t part); /* the part's own value (0 without draw order) */
/* After ugo_update: the part numbers in the order to draw them (part count of them). */
UGO_API const uint32_t *ugo_draw_order(const UgoInstance *in);
/* After ugo_update: 0 while the order is the stored one, otherwise a hash of
 * the list that changes when the list does. Renderers can keep one index
 * buffer per key and draw characters with the same key together (compare the
 * lists too: two different lists may share a key). */
UGO_API uint32_t ugo_draw_order_key(const UgoInstance *in);

/* ---- warp grids (0.5) ---------------------------------------------------
 * A part may live in a warp grid instead of on bones: its vertices (and its
 * morph deltas) are in the grid's cell coordinates, 0..cols x 0..rows, and
 * the grid bends them with a uniform cubic B-spline (straight on outside).
 * The frame block holds each grid's control points in model space with one
 * extra ring: (cols+3) x (rows+3) points, 2 floats each, rows top to bottom;
 * point (x, y) uses the 4 x 4 points from (floor(x), floor(y)) with the
 * cubic B-spline weights of the fractions (see the format spec in docs/). */
UGO_API uint32_t ugo_warp_count(const UgoModel *m);
UGO_API int ugo_part_warp(const UgoModel *m, uint32_t part); /* warp grid of the part, or -1 */
/* info[3] = cols, rows, offset of its points in the frame block (floats) */
UGO_API void ugo_warp_info(const UgoModel *m, uint32_t warp, uint32_t *info);
UGO_API const char *ugo_warp_name(const UgoModel *m, uint32_t warp);

/* ---- swaying bone chains (0.6) -------------------------------------------
 * params[6] = stiffness (1/s^2), damping (1/s), gravity x, gravity y (model
 * px/s^2), inertia, mix. Chains have no names in the .ug9 (use the bones'). */
UGO_API uint32_t ugo_chain_count(const UgoModel *m);
UGO_API void ugo_chain_info(const UgoModel *m, uint32_t chain, float *params, uint32_t *bone_count);
UGO_API const uint32_t *ugo_chain_bones(const UgoModel *m, uint32_t chain); /* bone_count bones, root to tip */
UGO_API const char *ugo_chain_name(const UgoModel *m, uint32_t chain);     /* the chain's id ("" if it has none; 0.7) */
UGO_API int ugo_warp_parent(const UgoModel *m, uint32_t warp); /* parent warp, or -1 */
UGO_API int ugo_warp_bone(const UgoModel *m, uint32_t warp);   /* bone of an outermost warp, or -1 */
/* (cols+1) x (rows+1) rest control points, 2 floats each: model space, or the parent's cells */
UGO_API const float *ugo_warp_rest_points(const UgoModel *m, uint32_t warp);
/* After ugo_update: where the warp puts cell coordinates (x, y), in model space (before the instance transform). */
UGO_API void ugo_warp_eval(const UgoInstance *in, uint32_t warp, float x, float y, float *out);
/* After ugo_update: the (cols+1) x (rows+1) control points in model space, 2 floats each. */
UGO_API void ugo_warp_points(const UgoInstance *in, uint32_t warp, float *out);
UGO_API const char *ugo_bone_name(const UgoModel *m, uint32_t bone);
UGO_API int ugo_bone_parent(const UgoModel *m, uint32_t bone);
UGO_API float ugo_bone_length(const UgoModel *m, uint32_t bone); /* along its x axis (0: none) */
/* pose[5] = x, y, rotation (radians), scaleX, scaleY of the rest pose, relative to the parent
 * (shear, transform inheritance and constraints are not included; see ugo_bone_world) */
UGO_API void ugo_bone_rest(const UgoModel *m, uint32_t bone, float *pose);

/* ---- frame block layout (floats; every section starts on a multiple of 4) */
/*  [0..8)               instance transform a,b,c,d,tx,ty (set by host), then 2 floats the
 *                       core never reads and keeps 0 (ugo_set_transform writes 0): the host's own.
 *                       The engines use them for a whole-character colour in batched drawing:
 *                       [6] = (255-r)*65536 + (255-g)*256 + (255-b), [7] = 1 - opacity (0, 0 =
 *                       white, opaque); write them after ugo_set_transform
 *  [skin ..)            8 floats per bone: a,b,c,d,tx,ty,0,0
 *  [opacity ..)         1 float per part
 *  [morph ..)           1 float per morph
 *  [color ..)           8 floats per colour slot: X.rgb,0, Y.rgb,0. A part
 *                       with a slot is shaded rgb = C.rgb * X + C.a * Y
 *                       (C premultiplied texel); parts without one use C.
 *  [warp ..)            per warp grid: its control points with the outer ring,
 *                       2 floats per point (see the warp grids section) (0.5)
 *  A 2x3 matrix maps (x,y) to (a*x + c*y + tx, b*x + d*y + ty).            */
UGO_API uint32_t ugo_frame_float_count(const UgoModel *m);
UGO_API uint32_t ugo_frame_skin_offset(const UgoModel *m);
UGO_API uint32_t ugo_frame_opacity_offset(const UgoModel *m);
UGO_API uint32_t ugo_frame_morph_offset(const UgoModel *m);
UGO_API uint32_t ugo_frame_color_offset(const UgoModel *m);
UGO_API uint32_t ugo_frame_warp_offset(const UgoModel *m);

/* ---- instance (one character on screen) ------------------------------- */

UGO_API uint32_t ugo_instance_mem_size(const UgoModel *m);
UGO_API UgoInstance *ugo_instance_init(void *mem, const UgoModel *m);

/* Typical frame: reset_params -> apply_animation(s) -> set_param (tracking,
 * game logic) -> set_transform -> update(dt) -> upload ugo_frame() and draw.
 * Call ugo_set_transform before update: chains take their inertia from how
 * the placement moved since the last update. It writes 0 to frame floats 6 and 7
 * (the host's whole-character colour): write those after it.
 * reset_params also clears what animation tracks set directly (bone offsets
 * from the rest pose, part opacity, morph weights, constraint mixes, colours,
 * draw order values). A keyed opacity or draw order value replaces the part's
 * own; parameter-driven changes still add on top. */
UGO_API void ugo_reset_params(UgoInstance *in);
UGO_API void ugo_set_param(UgoInstance *in, uint32_t i, float value);
/* Pose (for an editor's pose mode, or a game moving a bone itself): a bone's offsets from its
 * rest pose, pose[7] = rotation, x, y, scaleX, scaleY (added to the rest scale), shearX, shearY,
 * angles in radians; the same values animation tracks set. Set mixes towards them by weight (1:
 * replace), after ugo_reset_params and the animations, before ugo_update; get reads them. */
UGO_API void ugo_set_bone_offset(UgoInstance *in, uint32_t bone, const float *pose, float weight);
UGO_API void ugo_get_bone_offset(const UgoInstance *in, uint32_t bone, float *pose);
/* Drag a bone's tip (its end, or its origin without a length) towards (x, y), in the space of
 * ugo_bone_world: turns the bone and up to count - 1 of its parents (cyclic coordinate descent,
 * `iterations` rounds, at most 64) from last ugo_update's pose, adding the turns to their
 * rotation offsets. Call ugo_update again to see it (and again for constraints to settle).
 * Returns the distance left, or -1 for a bad call. */
UGO_API float ugo_solve_ik_to(UgoInstance *in, uint32_t bone, uint32_t count, float x, float y, uint32_t iterations);
/* Puts the bone at world matrix W[6] (a, b, c, d, tx, ty, the space of ugo_bone_world) by
 * changing its offsets, under its parent's pose of the last ugo_update (editors: keep a child
 * where it is while its parent moves, or values typed in world space). Shear goes to shearY.
 * Update again to see it; parents first if several bones are placed. */
UGO_API void ugo_set_bone_world(UgoInstance *in, uint32_t bone, const float *world);
UGO_API float ugo_get_param(const UgoInstance *in, uint32_t i);
UGO_API float *ugo_params(UgoInstance *in);
/* Blends the animation's values into what its tracks target (parameters,
 * bone offsets, part opacity, morph weights, constraint mixes, colours, draw order values):
 * v = v + (anim - v) * weight. */
UGO_API void ugo_apply_animation(UgoInstance *in, uint32_t anim, float time, float weight);
/* The same, with choices (for layers): flags UGO_ANIM_ADD adds the animation's change from
 * the rest pose (times weight) on top of what is there, instead of mixing towards it; a mask
 * (or NULL) applies only some of the tracks: each list has one byte per bone / part / parameter /
 * morph / constraint / colour slot, nonzero to apply; a NULL list applies all of that kind. A
 * part's tracks are its opacity and draw order; a bone's are rotate, x, y, scale and shear. */
#define UGO_ANIM_ADD 1u
/* The mask's lists are read only during the call (the core keeps no pointer to them). */
typedef struct UgoAnimMask { const uint8_t *bones, *parts, *params, *morphs, *constraints, *colors; } UgoAnimMask;
UGO_API void ugo_apply_animation_ex(UgoInstance *in, uint32_t anim, float time, float weight, uint32_t flags, const UgoAnimMask *mask);
/* Steps physics by dt seconds (fixed 1/120 s substeps) and fills the frame block. */
UGO_API void ugo_update(UgoInstance *in, float dt);
/* Clears physics state (e.g. after a teleport or when seeking an export). */
UGO_API void ugo_reset_physics(UgoInstance *in);
/* Physics and chain state, e.g. to carry it into an instance of an edited
 * model. A physics record's state is 3 floats (its output parameter says which
 * it is); a chain's is ugo_chain_state_floats floats (its bones say which). */
UGO_API uint32_t ugo_physics_count(const UgoModel *m);
UGO_API uint32_t ugo_physics_output(const UgoModel *m, uint32_t i);
UGO_API void ugo_get_physics_state(const UgoInstance *in, uint32_t i, float *state);
UGO_API void ugo_set_physics_state(UgoInstance *in, uint32_t i, const float *state);
UGO_API uint32_t ugo_chain_state_floats(const UgoModel *m, uint32_t chain);
UGO_API void ugo_get_chain_state(const UgoInstance *in, uint32_t chain, float *state);
UGO_API void ugo_set_chain_state(UgoInstance *in, uint32_t chain, const float *state);
/* Where the character was on screen at the last update: x, y, and 1 once known (for the chains' inertia). */
UGO_API void ugo_get_last_placement(const UgoInstance *in, float *xy_known);
UGO_API void ugo_set_last_placement(UgoInstance *in, const float *xy_known);
UGO_API void ugo_set_transform(UgoInstance *in, float a, float b, float c, float d, float tx, float ty);
UGO_API const float *ugo_frame(const UgoInstance *in);

/* Reference path: writes 2 floats per vertex (model space, before the
 * instance transform). Same math as the shader. */
UGO_API void ugo_deform_cpu(const UgoInstance *in, float *out_positions);
/* The same for one part's vertices only (an editor showing the selected part): written at
 * their places in out_positions (2 floats per vertex of the whole model, the rest untouched). */
UGO_API void ugo_deform_part_cpu(const UgoInstance *in, uint32_t part, float *out_positions);
/* Lets the physics (swaying parameters and chains) settle under the current parameters and
 * pose for up to `seconds` (at most 10): ugo_update in steps of 1/30 s. For a first frame
 * without a swing in from the rest pose; set the parameters and animations first. */
UGO_API void ugo_settle_physics(UgoInstance *in, float seconds);
/* Wind on the swaying chains (a game's or a stream's weather, without changing the model):
 * an acceleration (x, y) in model px/s^2, added to each chain's gravity, times 1 + gust * a slow
 * wave (-1..1) of the time the instance has run, so the same times sway the same. gust 0: steady.
 * Stays until set again (0, 0, 0 for none). */
UGO_API void ugo_set_wind(UgoInstance *in, float x, float y, float gust);
/* The wind as set (wind[3] = x, y, gust) and its clock (seconds run; gusts are a function of it):
 * saved and put back with the physics state, so a replay sways the same. */
UGO_API void ugo_get_wind(const UgoInstance *in, float *wind);
UGO_API double ugo_wind_time(const UgoInstance *in);
UGO_API void ugo_set_wind_time(UgoInstance *in, double seconds);
/* Picking and boxes. Coordinates are model space (pixels, y down), before ugo_set_transform's
 * placement: map a screen point back through the inverse of your transform first. deformed is the
 * output of ugo_deform_cpu for this update, or NULL: then the core places only the vertices it
 * needs from the frame block (the same values; cheaper when you don't deform on the CPU anyway).
 *
 * ugo_pick_part (editor): the part drawn in front at (x, y): by draw order, inside its mask
 * (outside for UGO_PART_MASK_INVERT), skipping hidden parts and parts at min_opacity or below. The
 * texture's transparent pixels count as covered (check them yourself if needed). -1: none. */
UGO_API int ugo_pick_part(const UgoInstance *in, const float *deformed, float x, float y, float min_opacity);
/* Hit areas (apps: did the user touch the head?): of the parts with only[part] != 0, the one in
 * front at (x, y) on its mesh, whether drawn or not and at any opacity (masks not applied), or -1.
 * By convention an area is a part that is not drawn (maskOnly) named "hit:<name>" or
 * "当たり:<name>" (full-width ：too); the Web player and the engines read the names. */
UGO_API int ugo_pick_area(const UgoInstance *in, const float *deformed, float x, float y, const uint8_t *only);
/* The box (x0, y0, x1, y1) around a part's deformed vertices, or with part -1 around every part
 * drawn (not hidden, opacity above 0). Returns 0 when there is nothing. */
UGO_API int ugo_bounds(const UgoInstance *in, const float *deformed, int part, float *box);
/* A box sure to hold every vertex (drawn or not) after the last ugo_update, without placing them:
 * each bone's rest box (made once, on the first call, in the instance's memory) moved by its skin
 * matrix and widened by how far its morphs can reach, and the warp grids' nets. Larger than
 * ugo_bounds, cheap for culling (about 4 points per bone). Returns 0 when there is nothing. */
UGO_API int ugo_bounds_estimate(UgoInstance *in, float *box);

/* The bone's pose after the last ugo_update (rest pose + animation + driver
 * deltas, after constraints), relative to its parent, in the same layout as
 * ugo_bone_rest. Exact for bones without shear that inherit normally. */
UGO_API void ugo_bone_pose(const UgoInstance *in, uint32_t bone, float *pose);
/* The bone's world matrix (model space, a,b,c,d,tx,ty) after the last ugo_update. */
UGO_API void ugo_bone_world(const UgoInstance *in, uint32_t bone, float *world);
/* The same with the instance's placement (ugo_set_transform) applied: where the bone is on screen,
 * e.g. to attach a sword or an effect in an engine. */
UGO_API void ugo_bone_world_placed(const UgoInstance *in, uint32_t bone, float *world);

#ifdef __cplusplus
}
#endif

#endif
