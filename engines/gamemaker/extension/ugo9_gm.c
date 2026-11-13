/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* Ugo9 for GameMaker: the native side of the extension (a DLL / .so / .dylib with the Ugo9 core in
 * it). GameMaker passes only numbers (double) and strings (char *) to extension functions, so
 * models and characters are numbers (handles), names are strings, and the triangles go into a
 * GameMaker buffer whose address (buffer_get_address) is passed as a string argument.
 *
 * Each frame, for each character, gml/Ugo9.gml: ugo9_reset, ugo9_play / ugo9_set_param /
 * ugo9_expression, ugo9_place, ugo9_update, then ugo9_build into a buffer and one draw per run
 * (ugo9_run_*): runs are consecutive triangles that share a blend mode and an atlas page, in draw
 * order. Vertices are 32 bytes, matching the GML vertex format: position x, y (2 floats, room
 * pixels), "normal" = the part's screen-add colour r, g, b (3 floats), colour = the part's multiply
 * colour and opacity (4 bytes r, g, b, a), texture u, v (2 floats).
 * Not here yet: masks (masked parts draw unclipped). */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ugo.h"

#if defined(_WIN32)
#define GM_EXPORT __declspec(dllexport)
#else
#define GM_EXPORT __attribute__((visibility("default")))
#endif

#define UGO9_MAX 1024
#define UGO9_VERTEX_BYTES 32

typedef struct {
	void *mem;
	void *data;
	UgoModel *m;
} Gm9Model;

typedef struct {
	uint32_t blend, texture, first, count; /* vertices */
} Gm9Run;

typedef struct {
	int model;
	void *mem;
	UgoInstance *in;
	float a, b, c, d, tx, ty;
	float *deformed;
	Gm9Run *runs;
	uint32_t run_count;
} Gm9Char;

static Gm9Model models[UGO9_MAX];
static Gm9Char chars[UGO9_MAX];
static char error_text[512];
static char name_text[512];

static void *aligned_alloc16(size_t n, void **raw) {
	*raw = malloc(n + 16);
	if (!*raw) return NULL;
	return (void *)(((uintptr_t)*raw + 15) & ~(uintptr_t)15);
}

static Gm9Model *model_at(double h) {
	const int i = (int)h;
	return i >= 1 && i < UGO9_MAX && models[i].m ? &models[i] : NULL;
}
static Gm9Char *char_at(double h) {
	const int i = (int)h;
	return i >= 1 && i < UGO9_MAX && chars[i].in ? &chars[i] : NULL;
}

/* The last error (empty: none). */
GM_EXPORT const char *ugo9_error(void) { return error_text; }

/* Loads a .ug9 file. Returns the model's handle (>= 1), or 0 (ugo9_error says why). */
GM_EXPORT double ugo9_model_load(const char *path) {
	error_text[0] = 0;
	FILE *f = fopen(path, "rb");
	if (!f) { snprintf(error_text, sizeof error_text, "Ugo9: cannot open %s", path); return 0; }
	fseek(f, 0, SEEK_END);
	const long size = ftell(f);
	fseek(f, 0, SEEK_SET);
	int slot = 1;
	while (slot < UGO9_MAX && models[slot].m) slot++;
	if (size <= 0 || slot == UGO9_MAX) { fclose(f); snprintf(error_text, sizeof error_text, "Ugo9: %s is empty, or too many models", path); return 0; }
	void *raw_data, *data = aligned_alloc16((size_t)size, &raw_data);
	if (!data || fread(data, 1, (size_t)size, f) != (size_t)size) { fclose(f); free(raw_data); snprintf(error_text, sizeof error_text, "Ugo9: cannot read %s", path); return 0; }
	fclose(f);
	const uint32_t need = ugo_model_mem_size_for(data, (uint32_t)size);
	void *raw_mem, *mem = need ? aligned_alloc16(need, &raw_mem) : NULL;
	UgoModel *m = mem ? ugo_model_init_sized(mem, need, data, (uint32_t)size) : NULL;
	if (!m) {
		static const char *const why[] = { "", "the file is cut short", "not a .ug9 file", "another major version: update the plugin, or write the file again with this version",
			"bad alignment", "a count is over the format's limits", "an index points outside its table", "a value is not a number" };
		const int e = ugo_last_error();
		snprintf(error_text, sizeof error_text, "Ugo9: %s: %s", path, e > 0 && e < 8 ? why[e] : "cannot be read");
		free(raw_data);
		if (mem) free(raw_mem);
		return 0;
	}
	models[slot].data = raw_data;
	models[slot].mem = raw_mem;
	models[slot].m = m;
	return slot;
}

GM_EXPORT double ugo9_model_free(double model) {
	Gm9Model *M = model_at(model);
	if (!M) return 0;
	for (int i = 1; i < UGO9_MAX; i++)
		if (chars[i].in && chars[i].model == (int)model) return 0; /* still used */
	free(M->mem); free(M->data);
	memset(M, 0, sizeof *M);
	return 1;
}

/* ---- names (strings stay valid until the next call that returns a string) ---- */
static const char *copy_name(const char *s) { snprintf(name_text, sizeof name_text, "%s", s ? s : ""); return name_text; }
GM_EXPORT double ugo9_texture_count(double model) { Gm9Model *M = model_at(model); return M ? ugo_texture_count(M->m) : 0; }
GM_EXPORT const char *ugo9_texture_name(double model, double i) {
	Gm9Model *M = model_at(model);
	return copy_name(M && i >= 0 && i < ugo_texture_count(M->m) ? ugo_texture_name(M->m, (uint32_t)i) : "");
}
GM_EXPORT double ugo9_animation_count(double model) { Gm9Model *M = model_at(model); return M ? ugo_animation_count(M->m) : 0; }
GM_EXPORT const char *ugo9_animation_name(double model, double i) {
	Gm9Model *M = model_at(model);
	return copy_name(M && i >= 0 && i < ugo_animation_count(M->m) ? ugo_animation_name(M->m, (uint32_t)i) : "");
}
GM_EXPORT double ugo9_animation_duration(double model, const char *name) {
	Gm9Model *M = model_at(model);
	const int a = M ? ugo_find_animation(M->m, name) : -1;
	return a >= 0 ? ugo_animation_duration(M->m, (uint32_t)a) : 0;
}
GM_EXPORT double ugo9_animation_loops(double model, const char *name) {
	Gm9Model *M = model_at(model);
	const int a = M ? ugo_find_animation(M->m, name) : -1;
	return a >= 0 ? ugo_animation_loop(M->m, (uint32_t)a) : 0;
}
GM_EXPORT const char *ugo9_part_name(double model, double i) {
	Gm9Model *M = model_at(model);
	return copy_name(M && i >= 0 && i < ugo_part_count(M->m) ? ugo_part_name(M->m, (uint32_t)i) : "");
}
GM_EXPORT double ugo9_canvas(double model, double which) { /* 0 width, 1 height, 2 origin x, 3 origin y */
	Gm9Model *M = model_at(model);
	return M && which >= 0 && which < 4 ? ugo_canvas(M->m)[(int)which] : 0;
}

/* ---- characters ---- */
GM_EXPORT double ugo9_create(double model) {
	Gm9Model *M = model_at(model);
	if (!M) return 0;
	int slot = 1;
	while (slot < UGO9_MAX && chars[slot].in) slot++;
	if (slot == UGO9_MAX) return 0;
	Gm9Char *C = &chars[slot];
	memset(C, 0, sizeof *C);
	void *raw, *mem = aligned_alloc16(ugo_instance_mem_size(M->m), &raw);
	if (!mem) return 0;
	C->mem = raw;
	C->in = ugo_instance_init(mem, M->m);
	C->model = (int)model;
	C->a = C->d = 1;
	C->deformed = (float *)malloc(sizeof(float) * 2 * (ugo_vertex_count(M->m) + 1));
	C->runs = (Gm9Run *)malloc(sizeof(Gm9Run) * (ugo_part_count(M->m) + 1));
	return slot;
}

GM_EXPORT double ugo9_destroy(double ch) {
	Gm9Char *C = char_at(ch);
	if (!C) return 0;
	free(C->mem); free(C->deformed); free(C->runs);
	memset(C, 0, sizeof *C);
	return 1;
}

static const UgoModel *model_of(const Gm9Char *C) { return models[C->model].m; }

GM_EXPORT double ugo9_reset(double ch) { Gm9Char *C = char_at(ch); if (C) ugo_reset_params(C->in); return C != NULL; }
GM_EXPORT double ugo9_play(double ch, const char *name, double time, double weight) {
	Gm9Char *C = char_at(ch);
	const int a = C ? ugo_find_animation(model_of(C), name) : -1;
	if (a >= 0) ugo_apply_animation(C->in, (uint32_t)a, (float)time, (float)weight);
	return a >= 0;
}
GM_EXPORT double ugo9_set_param(double ch, const char *name, double value) {
	Gm9Char *C = char_at(ch);
	const int p = C ? ugo_find_param(model_of(C), name) : -1;
	if (p >= 0) ugo_set_param(C->in, (uint32_t)p, (float)value);
	return p >= 0;
}
GM_EXPORT double ugo9_get_param(double ch, const char *name) {
	Gm9Char *C = char_at(ch);
	const int p = C ? ugo_find_param(model_of(C), name) : -1;
	return p >= 0 ? ugo_get_param(C->in, (uint32_t)p) : 0;
}
GM_EXPORT double ugo9_expression(double ch, const char *name, double weight) {
	Gm9Char *C = char_at(ch);
	if (!C) return 0;
	const UgoModel *m = model_of(C);
	for (uint32_t e = 0, n = ugo_expression_count(m); e < n; e++)
		if (strcmp(ugo_expression_name(m, e), name) == 0) { ugo_apply_expression(C->in, e, (float)weight); return 1; }
	return 0;
}
GM_EXPORT double ugo9_set_wind(double ch, double x, double y, double gust) {
	Gm9Char *C = char_at(ch);
	if (C) ugo_set_wind(C->in, (float)x, (float)y, (float)gust);
	return C != NULL;
}
/* Where the model's origin goes in the room, its scale and turn (degrees, counter-clockwise like
 * GameMaker's image_angle); swaying chains feel the move. Call before ugo9_update. */
GM_EXPORT double ugo9_place(double ch, double x, double y, double xscale, double yscale, double angle) {
	Gm9Char *C = char_at(ch);
	if (!C) return 0;
	const double r = -angle * 3.14159265358979323846 / 180.0, cs = cos(r), sn = sin(r);
	C->a = (float)(cs * xscale); C->b = (float)(sn * xscale);
	C->c = (float)(-sn * yscale); C->d = (float)(cs * yscale);
	C->tx = (float)x; C->ty = (float)y;
	ugo_set_transform(C->in, C->a, C->b, C->c, C->d, C->tx, C->ty);
	return 1;
}
GM_EXPORT double ugo9_update(double ch, double dt) { Gm9Char *C = char_at(ch); if (C) ugo_update(C->in, (float)dt); return C != NULL; }

/* The part drawn in front at a room point, or -1 (after ugo9_update). */
GM_EXPORT double ugo9_pick(double ch, double x, double y) {
	Gm9Char *C = char_at(ch);
	if (!C) return -1;
	const float det = C->a * C->d - C->b * C->c;
	if (fabsf(det) < 1e-12f) return -1;
	const float px = (float)x - C->tx, py = (float)y - C->ty;
	const float mx = (C->d * px - C->c * py) / det, my = (-C->b * px + C->a * py) / det;
	return ugo_pick_part(C->in, NULL, mx, my, 0.01f);
}

/* Bytes the triangles of this model need at most (size the buffer with it once). */
GM_EXPORT double ugo9_buffer_size(double model) {
	Gm9Model *M = model_at(model);
	return M ? (double)ugo_index_count(M->m) * UGO9_VERTEX_BYTES : 0;
}

static uint8_t byte01(float v) { return (uint8_t)(v <= 0 ? 0 : v >= 1 ? 255 : (int)(v * 255.0f + 0.5f)); }

/* Writes this frame's triangles (after ugo9_update) at the address (buffer_get_address, as a string)
 * of a buffer of `size` bytes. Returns the vertices written, or -1 if the buffer is too small. */
GM_EXPORT double ugo9_build(double ch, const char *address, double size) {
	Gm9Char *C = char_at(ch);
	if (!C || !address) return -1;
	const UgoModel *m = model_of(C);
	uint8_t *out = (uint8_t *)(uintptr_t)address;
	const uint32_t np = ugo_part_count(m), *indices = ugo_indices(m);
	if ((double)ugo_index_count(m) * UGO9_VERTEX_BYTES > size) return -1;
	ugo_deform_cpu(C->in, C->deformed);
	const float *frame = ugo_frame(C->in), *uvs = ugo_uvs(m);
	const uint32_t opf = ugo_frame_opacity_offset(m), colf = ugo_frame_color_offset(m);
	const uint32_t *order = ugo_has_draw_order(m) ? ugo_draw_order(C->in) : NULL;
	uint32_t written = 0;
	C->run_count = 0;
	for (uint32_t j = 0; j < np; j++) {
		const uint32_t i = order ? order[j] : j;
		uint32_t range[4];
		ugo_part_range(m, i, range);
		if (range[3] == 0 || (ugo_part_flags(m, i) & UGO_PART_HIDDEN)) continue;
		const float opacity = frame[opf + i];
		if (opacity <= 0) continue;
		const uint32_t blend = ugo_part_blend(m, i);
		const uint32_t tex = ugo_part_texture(m, i);
		float mul[3] = { 1, 1, 1 }, add[3] = { 0, 0, 0 };
		const int slot = ugo_part_color(m, i);
		if (slot >= 0) for (int k = 0; k < 3; k++) { mul[k] = frame[colf + 8 * slot + k]; add[k] = frame[colf + 8 * slot + 4 + k]; }
		if (C->run_count == 0 || C->runs[C->run_count - 1].blend != blend || C->runs[C->run_count - 1].texture != tex) {
			Gm9Run *R = &C->runs[C->run_count++];
			R->blend = blend; R->texture = tex; R->first = written; R->count = 0;
		}
		for (uint32_t k = 0; k < range[3]; k++) {
			const uint32_t v = indices[range[2] + k];
			const float x = C->deformed[2 * v], y = C->deformed[2 * v + 1];
			float f[7] = { C->a * x + C->c * y + C->tx, C->b * x + C->d * y + C->ty, add[0], add[1], add[2], 0, 0 };
			uint8_t *o = out + (size_t)written * UGO9_VERTEX_BYTES;
			memcpy(o, f, 5 * sizeof(float));
			o[20] = byte01(mul[0]); o[21] = byte01(mul[1]); o[22] = byte01(mul[2]); o[23] = byte01(opacity);
			memcpy(o + 24, &uvs[2 * v], 2 * sizeof(float));
			written++;
		}
		C->runs[C->run_count - 1].count += range[3];
	}
	return written;
}

/* The runs of the last ugo9_build: blend (0 normal, 1 add, 2 multiply, 3 screen), atlas page, first vertex, vertices. */
GM_EXPORT double ugo9_run_count(double ch) { Gm9Char *C = char_at(ch); return C ? C->run_count : 0; }
static const Gm9Run *run_at(double ch, double r) {
	Gm9Char *C = char_at(ch);
	return C && r >= 0 && r < C->run_count ? &C->runs[(int)r] : NULL;
}
GM_EXPORT double ugo9_run_blend(double ch, double r) { const Gm9Run *R = run_at(ch, r); return R ? R->blend : 0; }
GM_EXPORT double ugo9_run_texture(double ch, double r) { const Gm9Run *R = run_at(ch, r); return R ? R->texture : 0; }
GM_EXPORT double ugo9_run_first(double ch, double r) { const Gm9Run *R = run_at(ch, r); return R ? R->first : 0; }
GM_EXPORT double ugo9_run_vertices(double ch, double r) { const Gm9Run *R = run_at(ch, r); return R ? R->count : 0; }
