// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Ugo9 for GameMaker: a model (Ugo9Model) and characters of it (Ugo9Character). Put this in a script
// asset, the extension (README.md) and the shader shd_ugo9 in the project.
//
//   // Create:
//   model = new Ugo9Model(working_directory + "ugo9/hero/model.ug9");   // its PNGs next to it
//   hero = new Ugo9Character(model);
//   hero.play("idle");
//   // Step:
//   hero.x = x; hero.y = y; hero.xscale = 0.5; hero.yscale = 0.5;
//   hero.step(delta_time / 1000000);
//   // Draw:
//   hero.draw();
//   // Clean Up:
//   hero.destroy(); model.destroy();
//
// The core runs in the extension; this builds the triangles there each step and draws one vertex
// buffer per run of parts that share a blend mode and an atlas page. Masks are not drawn yet.

function __ugo9_format() {
	static fmt = undefined;
	if (fmt == undefined) {
		vertex_format_begin();
		vertex_format_add_position();  // x, y (room pixels)
		vertex_format_add_normal();    // the part's screen-add colour (r, g, b)
		vertex_format_add_colour();    // the part's multiply colour and its opacity
		vertex_format_add_texcoord();  // u, v on the model's atlas page
		fmt = vertex_format_end();
	}
	return fmt;
}

/// A .ug9 file and its atlas pages (the PNGs next to it, by the names the editor wrote).
function Ugo9Model(_path) constructor {
	handle = ugo9_model_load(_path);
	ok = handle > 0;
	if (!ok) show_debug_message(ugo9_error());
	sprites = [];
	textures = [];
	uvs = [];
	animations = [];
	if (ok) {
		var _dir = filename_path(_path);
		for (var i = 0; i < ugo9_texture_count(handle); i++) {
			var _spr = sprite_add(_dir + ugo9_texture_name(handle, i), 1, false, true, 0, 0);
			sprites[i] = _spr;
			textures[i] = sprite_get_texture(_spr, 0);
			uvs[i] = sprite_get_uvs(_spr, 0); // where the image sits on its texture page
		}
		for (var j = 0; j < ugo9_animation_count(handle); j++) animations[j] = ugo9_animation_name(handle, j);
	}

	static destroy = function() {
		for (var i = 0; i < array_length(sprites); i++) sprite_delete(sprites[i]);
		if (ok) ugo9_model_free(handle);
		ok = false;
	}
}

/// One character of a model.
function Ugo9Character(_model) constructor {
	model = _model;
	handle = _model.ok ? ugo9_create(_model.handle) : 0;
	buffer = buffer_create(max(32, ugo9_buffer_size(_model.handle)), buffer_fixed, 4);
	vertices = 0;
	x = 0; y = 0; xscale = 1; yscale = 1; angle = 0;   // where the model's origin goes (room), its scale and turn
	animation = array_length(_model.animations) > 0 ? _model.animations[0] : "";
	time = 0; speed = 1; playing = true;
	params = {};            // name -> value, kept over the animation
	expressions = {};       // name -> { w: weight now, target: 0 or 1, fade: seconds }
	wind_x = 0; wind_y = 0; wind_gust = 0;
	__from = ""; __from_time = 0; __fade = 0; __fade_t = 0;

	/// Plays an animation from from_time (seconds); fade > 0 blends from the one playing now (as Godot's play).
	static play = function(_name, _from_time = 0, _fade = 0) {
		if (_fade > 0 && animation != "") { __from = animation; __from_time = time; __fade = _fade; __fade_t = 0; } else __from = "";
		animation = _name; time = _from_time; playing = true;
	}
	static stop = function() { playing = false; }
	static set_param = function(_name, _value) { params[$ _name] = _value; }
	static clear_param = function(_name) { variable_struct_remove(params, _name); }
	static clear_params = function() { params = {}; }
	static get_param = function(_name) { return ugo9_get_param(handle, _name); }
	/// The model's expressions, faded in and out over fade seconds (as Godot's show_expression).
	static show_expression = function(_name, _fade = 0.3) {
		var _e = expressions[$ _name];
		if (_e == undefined) { _e = { w: 0, target: 1, fade: _fade }; expressions[$ _name] = _e; }
		_e.target = 1; _e.fade = _fade;
	}
	static hide_expression = function(_name, _fade = 0.3) {
		var _e = expressions[$ _name];
		if (_e != undefined) { _e.target = 0; _e.fade = _fade; }
	}
	/// Shows only these (an array of names; the others fade out).
	static only_expressions = function(_names, _fade = 0.3) {
		var _shown = variable_struct_get_names(expressions);
		for (var i = 0; i < array_length(_shown); i++) if (!array_contains(_names, _shown[i])) hide_expression(_shown[i], _fade);
		for (var j = 0; j < array_length(_names); j++) show_expression(_names[j], _fade);
	}
	static get_expression_weight = function(_name) { var _e = expressions[$ _name]; return _e == undefined ? 0 : _e.w; }

	/// Runs the character by dt seconds (the Step event) and makes its triangles.
	static step = function(_dt) {
		if (handle <= 0) return;
		if (playing) time += _dt * speed;
		ugo9_reset(handle);
		if (__from != "" && __fade_t < __fade) {
			__from_time += _dt * speed; __fade_t += _dt;
			ugo9_play(handle, __from, __from_time, 1);
			ugo9_play(handle, animation, time, min(1, __fade_t / __fade));
		} else if (animation != "") ugo9_play(handle, animation, time, 1);
		var _names = variable_struct_get_names(params);
		for (var i = 0; i < array_length(_names); i++) ugo9_set_param(handle, _names[i], params[$ _names[i]]);
		var _ex = variable_struct_get_names(expressions);
		for (var k = 0; k < array_length(_ex); k++) {
			var _e = expressions[$ _ex[k]];
			var _step = _e.fade > 0 ? _dt / _e.fade : 1;
			_e.w = _e.target > _e.w ? min(_e.target, _e.w + _step) : max(_e.target, _e.w - _step);
			if (_e.w <= 0 && _e.target <= 0) { variable_struct_remove(expressions, _ex[k]); continue; }
			ugo9_expression(handle, _ex[k], _e.w);
		}
		ugo9_set_wind(handle, wind_x, wind_y, wind_gust);
		ugo9_place(handle, x, y, xscale, yscale, angle);
		ugo9_update(handle, _dt);
		vertices = ugo9_build(handle, buffer_get_address(buffer), buffer_get_size(buffer));
	}

	/// Draws the character (the Draw event), one vertex buffer per run.
	static draw = function() {
		if (handle <= 0 || vertices <= 0) return;
		var _fmt = __ugo9_format(), _uvs = shader_get_uniform(shd_ugo9, "u_uvs");
		shader_set(shd_ugo9);
		for (var r = 0; r < ugo9_run_count(handle); r++) {
			var _page = ugo9_run_texture(handle, r), _blend = ugo9_run_blend(handle, r);
			if (_page >= array_length(model.textures)) _page = 0;
			var _uv = model.uvs[_page];
			shader_set_uniform_f(_uvs, _uv[0], _uv[1], _uv[2], _uv[3]);
			switch (_blend) {
				case 1: gpu_set_blendmode_ext(bm_one, bm_one); break;                    // add
				case 2: gpu_set_blendmode_ext(bm_dest_colour, bm_inv_src_alpha); break; // multiply
				case 3: gpu_set_blendmode_ext(bm_one, bm_inv_src_colour); break;        // screen
				default: gpu_set_blendmode_ext(bm_one, bm_inv_src_alpha); break;       // normal (premultiplied)
			}
			var _vb = vertex_create_buffer_from_buffer_ext(buffer, _fmt, ugo9_run_first(handle, r) * 32, ugo9_run_vertices(handle, r));
			vertex_submit(_vb, pr_trianglelist, model.textures[_page]);
			vertex_delete_buffer(_vb);
		}
		gpu_set_blendmode(bm_normal);
		shader_reset();
	}

	/// The name of the part drawn in front at a room point ("" if none), as of the last step.
	static part_at = function(_x, _y) {
		var _p = ugo9_pick(handle, _x, _y);
		return _p >= 0 ? ugo9_part_name(model.handle, _p) : "";
	}

	static destroy = function() {
		if (handle > 0) ugo9_destroy(handle);
		handle = 0;
		buffer_delete(buffer);
	}
}
