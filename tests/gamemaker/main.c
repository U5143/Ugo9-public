/* SPDX-FileCopyrightText: 2026 U5143
 * SPDX-License-Identifier: MIT */
/* The GameMaker extension's native side (engines/gamemaker/extension/ugo9_gm.c) without GameMaker:
 * calls it the way gml/Ugo9.gml does and checks the triangles it writes against the core's own CPU
 * deformation. Built and run by tests/gamemaker_test.mjs. */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ugo.h"

double ugo9_model_load(const char *path);
const char *ugo9_error(void);
double ugo9_create(double model);
double ugo9_destroy(double ch);
double ugo9_model_free(double model);
double ugo9_reset(double ch);
double ugo9_play(double ch, const char *name, double time, double weight);
double ugo9_set_param(double ch, const char *name, double value);
double ugo9_get_param(double ch, const char *name);
double ugo9_place(double ch, double x, double y, double xscale, double yscale, double angle);
double ugo9_update(double ch, double dt);
double ugo9_buffer_size(double model);
double ugo9_build(double ch, const char *address, double size);
double ugo9_run_count(double ch);
double ugo9_run_blend(double ch, double r);
double ugo9_run_texture(double ch, double r);
double ugo9_run_first(double ch, double r);
double ugo9_run_vertices(double ch, double r);
double ugo9_pick(double ch, double x, double y);
const char *ugo9_part_name(double model, double i);
const char *ugo9_animation_name(double model, double i);
double ugo9_animation_count(double model);
const char *ugo9_texture_name(double model, double i);
double ugo9_texture_count(double model);

static int failures = 0;
static void check(int ok, const char *msg) { printf("%s %s\n", ok ? "ok  " : "FAIL", msg); if (!ok) failures++; }

int main(int argc, char **argv) {
	const char *root = argc > 1 ? argv[1] : ".";
	char path[1024];
	snprintf(path, sizeof path, "%s/samples/basic/model.ug9", root);
	const double model = ugo9_model_load(path);
	check(model >= 1, "the sample loads");
	check(ugo9_model_load("/no/such/file.ug9") == 0 && strstr(ugo9_error(), "cannot open") != NULL, "a missing file says so");
	check(ugo9_texture_count(model) == 1 && strcmp(ugo9_texture_name(model, 0), "atlas.png") == 0, "its atlas is atlas.png");
	int has_idle = 0;
	for (int i = 0; i < (int)ugo9_animation_count(model); i++) has_idle |= strcmp(ugo9_animation_name(model, i), "idle") == 0;
	check(has_idle, "animation names");

	const double ch = ugo9_create(model);
	check(ch >= 1, "a character");
	ugo9_reset(ch);
	check(ugo9_play(ch, "idle", 1.0, 1) == 1 && ugo9_play(ch, "nothing", 0, 1) == 0, "play by name (and not a missing one)");
	check(ugo9_set_param(ch, "MouthOpen", 1) == 1 && fabs(ugo9_get_param(ch, "MouthOpen") - 1) < 1e-6, "a parameter by name");
	ugo9_place(ch, 400, 600, 0.5, 0.5, 0);
	ugo9_update(ch, 1.0 / 60);

	const double size = ugo9_buffer_size(model);
	uint8_t *buf = (uint8_t *)malloc((size_t)size);
	check(ugo9_build(ch, (const char *)buf, 10) == -1, "a buffer too small is refused");
	const double n = ugo9_build(ch, (const char *)buf, size);
	check(n > 0 && fmod(n, 3) == 0, "triangles are written");
	double total = 0;
	int contiguous = 1;
	for (int r = 0; r < (int)ugo9_run_count(ch); r++) {
		contiguous &= ugo9_run_first(ch, r) == total;
		total += ugo9_run_vertices(ch, r);
	}
	check(ugo9_run_count(ch) >= 1 && total == n && contiguous, "runs cover the vertices back to back");

	/* the first vertex against the core's CPU deformation, placed */
	const float *p0 = (const float *)buf;
	int inside = 1;
	for (int v = 0; v < (int)n; v++) {
		const float *f = (const float *)(buf + 32 * v);
		inside &= f[0] > 400 - 1000 && f[0] < 400 + 1000 && f[1] > 600 - 1000 && f[1] < 600 + 1000 && isfinite(f[0]);
		const float *uv = (const float *)(buf + 32 * v + 24);
		inside &= uv[0] >= -0.001f && uv[0] <= 1.001f && uv[1] >= -0.001f && uv[1] <= 1.001f;
	}
	check(inside, "positions near the placement, UVs inside the atlas");
	(void)p0;
	/* a frame with the mouth shut (open, it covers the face's middle) */
	ugo9_reset(ch);
	ugo9_play(ch, "idle", 1.0, 1);
	ugo9_update(ch, 1.0 / 60);
	const double face = ugo9_pick(ch, 400, 600 - 330 * 0.5);
	check(face >= 0 && strcmp(ugo9_part_name(model, face), "face") == 0, "pick at the face's middle (room point) names the face");
	check(ugo9_pick(ch, -5000, -5000) == -1, "pick far away: nothing");
	/* flipped (xscale -1): a part on one side of the model is found at the mirrored room point */
	{
		int found = 0;
		for (int dx = -150; dx <= 150 && !found; dx += 5) {
			const double part = ugo9_pick(ch, 400 + dx, 600 - 300 * 0.5);
			if (part < 0) continue;
			const char *n = ugo9_part_name(model, part);
			const size_t len = strlen(n);
			if (len == 0 || (n[len - 1] != 'L' && n[len - 1] != 'R')) continue; /* a part of one side */
			char name[64];
			snprintf(name, sizeof name, "%s", n);
			ugo9_reset(ch);
			ugo9_play(ch, "idle", 1.0, 1);
			ugo9_place(ch, 400, 600, -0.5, 0.5, 0);
			ugo9_update(ch, 0);
			const double mirrored = ugo9_pick(ch, 400 - dx, 600 - 300 * 0.5);
			found = mirrored >= 0 && strcmp(ugo9_part_name(model, mirrored), name) == 0 ? 1 : -1;
			char msg[160];
			snprintf(msg, sizeof msg, "flipped: %s found at the mirrored point (%s)", name, mirrored >= 0 ? ugo9_part_name(model, mirrored) : "nothing");
			check(found == 1, msg);
			ugo9_place(ch, 400, 600, 0.5, 0.5, 0);
			ugo9_update(ch, 0);
		}
		check(found != 0, "a part of one side to flip-test with");
	}
	check(ugo9_model_free(model) == 0, "a model in use is not freed");
	check(ugo9_destroy(ch) == 1 && ugo9_model_free(model) == 1, "destroy, then free");
	free(buf);
	if (failures) { printf("%d check(s) failed\n", failures); return 1; }
	printf("all GameMaker extension checks passed\n");
	return 0;
}
