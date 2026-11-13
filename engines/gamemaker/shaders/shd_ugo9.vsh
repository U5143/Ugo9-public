// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for GameMaker (shader shd_ugo9, GLSL ES): the vertices are placed already (the extension);
// the atlas page's place on its texture page maps the model's UVs.
attribute vec3 in_Position;
attribute vec3 in_Normal;       // the part's screen-add colour
attribute vec4 in_Colour;       // the part's multiply colour, and its opacity in alpha
attribute vec2 in_TextureCoord;

uniform vec4 u_uvs;             // sprite_get_uvs: left, top, right, bottom

varying vec2 v_uv;
varying vec4 v_mul;
varying vec3 v_add;

void main() {
	gl_Position = gm_Matrices[MATRIX_WORLD_VIEW_PROJECTION] * vec4(in_Position.xy, 0.0, 1.0);
	v_uv = mix(u_uvs.xy, u_uvs.zw, in_TextureCoord);
	v_mul = in_Colour;
	v_add = in_Normal;
}
