// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for GameMaker: premultiplied colour, as every Ugo9 runtime draws (the blend modes in Ugo9.gml expect it).
varying vec2 v_uv;
varying vec4 v_mul;
varying vec3 v_add;

void main() {
	vec4 t = texture2D(gm_BaseTexture, v_uv);
	vec3 rgb = t.rgb * t.a * v_mul.rgb + t.a * v_add;
	gl_FragColor = vec4(rgb, t.a) * v_mul.a;
}
