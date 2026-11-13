// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for Godot: every vertex is deformed here, from the per-character frame
// blocks (one RGBA32F texture for all characters drawn by one MultiMesh).
// Same math as web/ugo.js. The extension embeds this file at build time and
// compiles it once per kind of draw, with one of these defined:
//   (none)         normal and add parts (add = premultiplied with alpha 0)
//   UGO_MULTIPLY   multiply parts: rgb = s * d + d * (1 - sa)
//   UGO_SCREEN     screen parts, exact: reads the screen, rgb = s + d * (1 - s)
//   UGO_SCREEN_APPROX  screen parts without reading the screen (faster, approximate)
//   UGO_MASK       the mask pass: draws mask parts into 3 mask channels (rgb; blend_add
//                  scales rgb by alpha, so alpha stays 1 and carries no channel)
shader_type canvas_item;
// format numbers, as in core/include/ugo.h (UGO_PART_*, UGO_BLEND_*); tests/constants_test.mjs compares them
#define UGO_PART_HIDDEN 2
#define UGO_PART_SOLID 4
#define UGO_BLEND_ADD 1
#if defined(UGO_MULTIPLY)
render_mode blend_mul, unshaded;
#elif defined(UGO_SCREEN)
render_mode blend_disabled, unshaded;
#elif defined(UGO_MASK)
render_mode blend_add, unshaded;
#else
render_mode blend_premul_alpha, unshaded;
#endif

uniform sampler2D ugo_frame : filter_nearest, repeat_disable;    // frame blocks, ugo_stride texels per instance
uniform sampler2D ugo_vertices : filter_nearest, repeat_disable; // 4 texels per vertex: joints, weights,
                                                                 // (part, first morph entry, count, 0), (first extra weight, count, 0, 0)
uniform sampler2D ugo_entries : filter_nearest, repeat_disable;  // sparse morph deltas: (morph, dx, dy, 0)
uniform sampler2D ugo_xweights : filter_nearest, repeat_disable; // influences beyond four: (bone, weight, 0, 0)
uniform sampler2D ugo_parts : filter_nearest, repeat_disable;    // 2 texels per part: (mask channels written, mask read,
                                                                 // flags + blend * 256 + texture * 65536, colour slot + 1),
                                                                 // (warp points' first frame texel + 1 or 0, cols, rows, 0)
uniform sampler2DArray ugo_atlas : filter_linear_mipmap, repeat_disable; // one layer per texture, premultiplied
uniform bool ugo_nearest;
uniform vec2 ugo_tex_scale[64];  // each texture's size over the layer size
uniform vec2 ugo_atlas_size;     // layer size in texels
uniform sampler2D ugo_mask0 : filter_nearest, repeat_disable;    // mask channels 0-2 in rgb (screen sized)
uniform sampler2D ugo_mask1 : filter_nearest, repeat_disable;    // 3-5
uniform sampler2D ugo_mask2 : filter_nearest, repeat_disable;    // 6-8
uniform sampler2D ugo_mask3 : filter_nearest, repeat_disable;    // 9-11
uniform sampler2D ugo_mask4 : filter_nearest, repeat_disable;    // 12-14
uniform sampler2D ugo_mask5 : filter_nearest, repeat_disable;    // 15
uniform int ugo_mask_group;      // mask pass: which 3 channels this draw writes
uniform int ugo_frame_w;
uniform int ugo_vertex_w;
uniform int ugo_entry_w;
uniform int ugo_parts_w;
uniform int ugo_stride;
uniform int ugo_instance_base;   // the first character of this draw (draws of a group of characters with one draw order)
uniform int ugo_skin_t;
uniform int ugo_op_f;
uniform int ugo_morph_f;
uniform int ugo_color_f;
#ifdef UGO_SCREEN
uniform sampler2D ugo_screen : hint_screen_texture, filter_nearest;
#endif

varying float v_opacity;
varying flat vec4 v_info;
varying flat vec3 v_x;
varying flat vec3 v_y;
varying flat float v_layer;
varying flat vec2 v_uv_max;

vec4 frame_texel(int t) { return texelFetch(ugo_frame, ivec2(t % ugo_frame_w, t / ugo_frame_w), 0); }
float frame_float(int base, int f) {
	vec4 v = frame_texel(base + (f >> 2));
	int c = f & 3;
	return c == 0 ? v.x : (c == 1 ? v.y : (c == 2 ? v.z : v.w));
}
vec4 table(sampler2D s, int w, int t) { return texelFetch(s, ivec2(t % w, t / w), 0); }

// a warp grid's surface at cell coordinates p: uniform cubic B-spline over
// the (cols+3) x (rows+3) points (2 per texel) from texel t, straight on outside
vec2 warp_point(int t, int k) {
	vec4 v = frame_texel(t + (k >> 1));
	return (k & 1) == 0 ? v.xy : v.zw;
}
vec4 bspline(float t) {
	float s = 1.0 - t;
	float t2 = t * t;
	float t3 = t2 * t;
	return vec4(s * s * s, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0;
}
vec4 bspline_d(float t) {
	float s = 1.0 - t;
	float t2 = t * t;
	return vec4(-0.5 * s * s, -2.0 * t + 1.5 * t2, 0.5 + t - 1.5 * t2, 0.5 * t2);
}
vec2 warp_at(int t, vec2 size, vec2 p) {
	vec2 q = clamp(p, vec2(0.0), size);
	vec2 c = min(floor(q), size - 1.0);
	vec2 f = q - c;
	vec2 e = p - q;
	vec4 bu = bspline(f.x);
	vec4 bv = bspline(f.y);
	vec4 du = bspline_d(f.x);
	vec4 dv = bspline_d(f.y);
	int w = int(size.x) + 3;
	int k0 = int(c.y) * w + int(c.x);
	vec2 o = vec2(0.0);
	for (int j = 0; j < 4; j++) {
		for (int i = 0; i < 4; i++) {
			o += (bu[i] * bv[j] + du[i] * bv[j] * e.x + bu[i] * dv[j] * e.y) * warp_point(t, k0 + j * w + i);
		}
	}
	return o;
}
vec2 skin(int base, int bone, vec2 p) {
	int t = base + ugo_skin_t + 2 * bone;
	vec4 m0 = frame_texel(t);
	vec4 m1 = frame_texel(t + 1);
	return vec2(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
}

void vertex() {
	int base = (INSTANCE_ID + ugo_instance_base) * ugo_stride;
	vec4 joints = table(ugo_vertices, ugo_vertex_w, 4 * VERTEX_ID);
	vec4 weights = table(ugo_vertices, ugo_vertex_w, 4 * VERTEX_ID + 1);
	vec4 info = table(ugo_vertices, ugo_vertex_w, 4 * VERTEX_ID + 2);
	vec4 xinfo = table(ugo_vertices, ugo_vertex_w, 4 * VERTEX_ID + 3);
	int part = int(info.x);
	v_info = table(ugo_parts, ugo_parts_w, 2 * part);
	vec4 warp = table(ugo_parts, ugo_parts_w, 2 * part + 1);

	vec2 p = VERTEX;
	int first = int(info.y);
	int count = int(info.z);
	for (int e = 0; e < count; e++) {
		vec4 en = table(ugo_entries, ugo_entry_w, first + e);
		p += frame_float(base, ugo_morph_f + int(en.x)) * en.yz;
	}
	vec2 o = vec2(0.0);
	if (warp.x > 0.0) {
		o = warp_at(base + int(warp.x) - 1, warp.yz, p); // in a warp grid: no bones
	} else {
		for (int j = 0; j < 4; j++) {
			if (weights[j] > 0.0) o += weights[j] * skin(base, int(joints[j]), p);
		}
		int xfirst = int(xinfo.x);
		int xcount = int(xinfo.y);
		for (int e = 0; e < xcount; e++) {
			vec4 xw = table(ugo_xweights, ugo_entry_w, xfirst + e);
			o += xw.y * skin(base, int(xw.x), p);
		}
	}
	vec4 x0 = frame_texel(base);
	vec4 x1 = frame_texel(base + 1);

	int bits = int(v_info.z);
	int tex = min(bits >> 16, 63);
	v_layer = float(tex);
	UV = UV * ugo_tex_scale[tex];
	v_uv_max = ugo_tex_scale[tex] - 0.5 / ugo_atlas_size; // a smaller page stops at its own last texel
#ifdef UGO_MASK
	v_opacity = 1.0; // masks ignore opacity (and hidden parts are masks too)
#else
	v_opacity = frame_float(base, ugo_op_f + part);
	if ((bits & UGO_PART_HIDDEN) != 0) v_opacity = 0.0; // hidden: only a mask
#endif
	v_x = vec3(1.0);
	v_y = vec3(0.0);
	if (v_info.w > 0.0) {
		int c = base + (ugo_color_f >> 2) + 2 * (int(v_info.w) - 1);
		v_x = frame_texel(c).xyz;
		v_y = frame_texel(c + 1).xyz;
	}
#ifndef UGO_MASK
	// the whole character's colour (header floats 6, 7; 0, 0 = white, opaque): modulate under a batch
	float dark = x1.z;
	float dr = floor(dark / 65536.0);
	float dg = floor((dark - dr * 65536.0) / 256.0);
	vec3 tint = vec3(1.0) - vec3(dr, dg, dark - dr * 65536.0 - dg * 256.0) / 255.0;
	v_x *= tint;
	v_y *= tint;
	v_opacity *= 1.0 - x1.w;
#endif
	// a part that is not drawn collapses to one point (no pixels)
	VERTEX = v_opacity > 0.0 ? vec2(x0.x * o.x + x0.z * o.y + x1.x, x0.y * o.x + x0.w * o.y + x1.y) : vec2(0.0);
}

float mask_at(int ch, vec2 uv) {
	int g = ch / 3;
	vec4 m = g == 0 ? texture(ugo_mask0, uv) : g == 1 ? texture(ugo_mask1, uv) : g == 2 ? texture(ugo_mask2, uv)
			: g == 3 ? texture(ugo_mask3, uv) : g == 4 ? texture(ugo_mask4, uv) : texture(ugo_mask5, uv);
	int c = ch - 3 * g;
	return c == 0 ? m.r : (c == 1 ? m.g : m.b);
}

void fragment() {
	int bits = int(v_info.z);
	// pixel art reads the texel under the point (texelFetch); the same texture is not bound a second time with
	// filter_nearest: in the Compatibility renderer that filter would apply to both, losing the mipmaps
	vec4 c = ugo_nearest ? texelFetch(ugo_atlas, ivec3(ivec2(min(UV, v_uv_max) * ugo_atlas_size), int(v_layer)), 0)
			: texture(ugo_atlas, vec3(min(UV, v_uv_max), v_layer));
#ifdef UGO_MASK
	float a = (bits & UGO_PART_SOLID) != 0 ? 1.0 : c.a; // solid: the whole mesh
	int written = int(v_info.x) >> (3 * ugo_mask_group);
	COLOR = vec4(vec3(float(written & 1), float((written >> 1) & 1), float((written >> 2) & 1)) * a, 1.0);
#else
	c.rgb = c.rgb * v_x + c.a * v_y;
	float k = v_opacity;
	int read = int(v_info.y);
	if ((read & 32) != 0) {
		float m = mask_at(read & 15, SCREEN_UV);
		k *= (read & 16) != 0 ? 1.0 - m : m;
	}
	c *= k;
	int blend = (bits >> 8) & 255;
#if defined(UGO_MULTIPLY)
	COLOR = vec4(c.rgb + (1.0 - c.a), 1.0); // with blend_mul: d * (s + 1 - sa), alpha kept
#elif defined(UGO_SCREEN)
	vec4 d = texture(ugo_screen, SCREEN_UV);
	COLOR = vec4(c.rgb + d.rgb * (1.0 - c.rgb), c.a + d.a * (1.0 - c.a));
#elif defined(UGO_SCREEN_APPROX)
	COLOR = vec4(c.rgb, max(max(c.r, c.g), c.b)); // premultiplied: s + d * (1 - max(s))
#else
	if (blend == UGO_BLEND_ADD) c.a = 0.0; // add: rgb = s + d, alpha unchanged
	COLOR = c;
#endif
#endif
}
