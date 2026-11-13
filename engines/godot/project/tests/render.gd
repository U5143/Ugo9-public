# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Test harness for tests/godot_test.mjs (run by the test, not by hand):
#   godot --path engines/godot/project res://tests/render.tscn -- --spec=<scene.json> --out=<dir>
# Draws each case of the spec, saves <dir>/<case>.png, and writes
# <dir>/results.json with draw call counts and API checks.
extends Node2D

var results := {}

func _ready() -> void:
	var opts := {}
	for a in OS.get_cmdline_user_args():
		var kv := a.trim_prefix("--").split("=", true, 1)
		opts[kv[0]] = kv[1] if kv.size() > 1 else ""
	var spec: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(opts["spec"]))
	var out: String = opts["out"]
	var bg: Array = spec["background"]
	RenderingServer.set_default_clear_color(Color(bg[0], bg[1], bg[2]))
	var model: UgoModel = load(spec["model"])
	var models := { spec["model"]: model }
	results["model_loaded"] = model != null and model.is_loaded()
	results["renderer"] = RenderingServer.get_video_adapter_name()
	results["godot"] = Engine.get_version_info()["string"]
	_api_checks(model)
	# the demo scenes _api_checks opens (playground, conversation, ordering) set their own clear colour in
	# _ready, which stays after they are freed: the pictures and the colour checks need the test's background
	RenderingServer.set_default_clear_color(Color(bg[0], bg[1], bg[2]))
	results["cases"] = {}
	for c in spec["cases"]:
		var root := Node2D.new()
		add_child(root)
		var batch: UgoBatch = null
		var parent: Node = root
		if not c.get("standalone", false):
			batch = UgoBatch.new()
			root.add_child(batch)
			parent = batch
		var path: String = c.get("model", spec["model"])
		if not models.has(path):
			models[path] = load(path)
		models[path].pixel_art = c.get("sampling", "linear") == "nearest" # pixel art cases
		for ch in c["characters"]:
			var u := UgoCharacter.new()
			u.model = models[path]
			u.manual = true
			u.playing = false
			u.animation = ch.get("anim", "")
			u.time = ch.get("time", 0.0)
			for k in ch.get("params", {}):
				u.set_param(k, ch["params"][k])
			u.position = Vector2(ch["x"], ch["y"])
			u.rotation = ch.get("rotation", 0.0)
			u.scale = Vector2(ch.get("scaleX", 1.0), ch.get("scaleY", 1.0))
			parent.add_child(u)
		for i in 3:
			await RenderingServer.frame_post_draw
		var r := {
			"draw_calls": RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME),
			"batch_draws": batch.get_draw_count() if batch else -1,
			"batch_characters": batch.get_character_count() if batch else -1,
		}
		if c.get("save", true):
			get_viewport().get_texture().get_image().save_png(out.path_join(c["name"] + ".png"))
			# the mask images too (internal SubViewports of the drawers), to see what went wrong
			var k := 0
			for vp in root.find_children("*", "SubViewport", true, false):
				vp.get_texture().get_image().save_png(out.path_join("%s_mask%d.png" % [c["name"], k]))
				k += 1
		results["cases"][c["name"]] = r
		root.queue_free()
		await RenderingServer.frame_post_draw
	await _colour_checks(model, Color(bg[0], bg[1], bg[2]))
	var f := FileAccess.open(out.path_join("results.json"), FileAccess.WRITE)
	f.store_string(JSON.stringify(results, "  "))
	f.close()
	get_tree().quit()

# Colour and order under a batch (applied by the shader) and alone: counts of pixels that differ
# from the background, that are greener or bluer than it (a red tint cannot make them), and that
# are mostly red or mostly blue (two characters on top of each other).
func _colour_checks(model: UgoModel, bg: Color) -> void:
	var size := get_viewport().get_visible_rect().size
	var out := {}
	for mode in ["red", "clear", "alone_red", "tree", "z", "y"]:
		var root := Node2D.new()
		add_child(root)
		var parent: Node = root
		if mode != "alone_red":
			parent = UgoBatch.new()
			root.add_child(parent)
		var pair := ["tree", "z", "y"].has(mode)
		for k in (2 if pair else 1):
			var u := UgoCharacter.new()
			u.model = model
			u.manual = true
			u.playing = false
			u.position = Vector2(size.x * 0.5, size.y * 0.95)
			u.scale = Vector2.ONE * size.y / 640.0
			match mode:
				"red": u.modulate = Color(1, 0, 0)
				"clear": u.modulate = Color(1, 1, 1, 0)
				"alone_red": u.self_modulate = Color(1, 0, 0)
				_:
					# the first is red, the second blue: by tree order blue is on top
					u.modulate = Color(1, 0, 0) if k == 0 else Color(0, 0, 1)
					if mode == "z" and k == 0: u.z_index = 1
					if mode == "y" and k == 0: u.position.y += 2.0 # lower: in front
			parent.add_child(u)
		if mode == "y":
			parent.y_sort_enabled = true
		for i in 3:
			await RenderingServer.frame_post_draw
		var img := get_viewport().get_texture().get_image()
		var drawn := 0
		var off := 0
		var reds := 0
		var blues := 0
		for y in range(0, img.get_height(), 3):
			for x in range(0, img.get_width(), 3):
				var p := img.get_pixel(x, y)
				if absf(p.r - bg.r) + absf(p.g - bg.g) + absf(p.b - bg.b) < 0.03:
					continue
				drawn += 1
				if p.g > bg.g + 0.02 or p.b > bg.b + 0.02:
					off += 1
				if p.r > p.b + 0.2:
					reds += 1
				elif p.b > p.r + 0.2:
					blues += 1
		out[mode] = [drawn, off, reds, blues]
		root.queue_free()
		await RenderingServer.frame_post_draw
	results["colour"] = out

func _api_checks(model: UgoModel) -> void:
	var api := {}
	if model == null:
		results["api"] = api
		return
	api["parameters"] = model.get_parameter_names()
	api["animations"] = model.get_animation_names()
	api["idle_length"] = model.get_animation_length("idle")
	api["vertices"] = model.get_vertex_count()
	api["frame_bytes"] = model.get_frame_bytes()
	api["canvas"] = [model.get_canvas_size().x, model.get_canvas_size().y, model.get_canvas_origin().x, model.get_canvas_origin().y]
	var bad := UgoModel.new()
	api["bad_file_rejected"] = bad.load_bytes(PackedByteArray([1, 2, 3, 4, 5, 6, 7, 8]), "") != OK and not bad.is_loaded()
	# set_param persists through updates; get_param reads the core's value
	var u := UgoCharacter.new()
	u.model = model
	u.manual = true
	u.set_param("MouthOpen", 0.75)
	u.update_now()
	u.update_now()
	api["param_after_update"] = u.get_param("MouthOpen")
	u.clear_param("MouthOpen")
	u.update_now()
	api["param_after_clear"] = u.get_param("MouthOpen")
	u.free()
	# expressions (format 0.8): tests/order's "swapped" adds 0.75 to Sw; a preset with a name the model lacks
	var em: UgoModel = load("res://samples/exprs/model.ug9")
	if em != null:
		var e := UgoCharacter.new()
		e.model = em
		e.manual = true
		api["expressions"] = em.get_expression_names()
		e.show_expression("swapped", 1.0)
		e.advance(0.25)
		e.update_now()
		api["expr_quarter"] = e.get_param("Sw")
		e.advance(1.0)
		e.update_now()
		api["expr_full"] = e.get_param("Sw")
		var missing := e.load_expressions('{"format": "ugo9-expressions", "version": 1, "expressions": [{"id": "x", "params": {"Puff": ["set", 1], "Nope": ["set", 1]}}]}')
		api["expr_missing"] = missing
		e.only_expressions(PackedStringArray(["x"]))
		e.advance(5.0)
		e.update_now()
		api["expr_only"] = [e.get_param("Puff"), e.get_param("Sw")]
		e.free()
	# format 1.0: a later 1.x file loads, with a warning in the log (tests/godot_test.mjs looks for it)
	var fm: UgoModel = load("res://samples/future/model.ug9")
	api["future_loaded"] = fm != null and fm.is_loaded()
	# format 1.1: curve keys need more model memory (asked for the file); A eases in over the first second
	var v11: UgoModel = load("res://samples/v11/model.ug9")
	api["v11_loaded"] = v11 != null and v11.is_loaded()
	if api["v11_loaded"]:
		var w := UgoCharacter.new()
		w.model = v11
		w.manual = true
		w.playing = false
		w.animation = "wave"
		w.time = 0.25
		w.update_now()
		api["v11_early"] = w.get_param("A")
		w.free()
	# switching animations: play with a fade, play_next, animation_finished
	var sm: UgoModel = load("res://samples/switch/model.ug9")
	if sm != null:
		var c := UgoCharacter.new()
		c.model = sm
		c.manual = true
		var ended: Array = []
		c.animation_finished.connect(func(n): ended.append(n))
		c.play("once")
		c.advance(0.25)
		c.update_now()
		api["switch_start"] = c.get_param("A")
		c.play("loop", 0.0, 1.0)
		c.advance(0.5)
		c.update_now()
		api["switch_mixed"] = c.get_param("A")
		c.play("once")
		c.play_next("loop")
		c.advance(0.9)
		api["switch_before_end"] = ended.size()
		c.advance(0.2)
		api["switch_ended"] = ended.duplicate()
		api["switch_now"] = c.animation
		c.free()
		# layers above the main animation: masked ("both" only on B), added ("nudge" +0.25 on A), weight, stop, queue
		var l := UgoCharacter.new()
		l.model = sm
		l.manual = true
		var lended: Array = []
		l.layer_finished.connect(func(i, n): lended.append("%d:%s" % [i, n]))
		l.play("once")
		l.play_layer(1, "both", 0.0, false, { "params": ["B"] })
		l.advance(0.5)
		l.update_now()
		var lay := [l.get_param("A"), l.get_param("B")]
		l.play_layer(2, "nudge", 0.0, true)
		l.update_now()
		lay.append(l.get_param("A"))
		l.set_layer_weight(2, 0.5)
		l.update_now()
		lay.append(l.get_param("A"))
		l.stop_layer(1, 0.5)
		l.advance(0.25)
		l.update_now()
		lay.append(l.get_param("B"))
		l.set_layer_weight(2, 1.0)
		l.queue_layer(2, "both", 0.0, false, { "params": ["B"] })
		l.advance(0.9) # nudge (1 s, started 0.25 s ago) ends, both follows
		l.update_now()
		lay.append(l.get_param("B"))
		lay.append(l.get_layer_animation(2))
		lay.append(lended)
		api["layers"] = lay
		l.free()
		# AnimationPlayer drives a character: a parameter track ("parameters/A") and the animation's time
		var holder := Node.new()
		add_child(holder)
		var pc := UgoCharacter.new()
		pc.name = "C"
		pc.model = sm
		pc.manual = true
		pc.playing = false
		holder.add_child(pc)
		var an := Animation.new()
		an.length = 1.0
		var tp := an.add_track(Animation.TYPE_VALUE)
		an.track_set_path(tp, NodePath("C:parameters/B"))
		an.track_insert_key(tp, 0.0, 0.2)
		an.track_insert_key(tp, 1.0, 0.8)
		var tt := an.add_track(Animation.TYPE_VALUE)
		an.track_set_path(tt, NodePath("C:time"))
		an.track_insert_key(tt, 0.0, 0.0)
		an.track_insert_key(tt, 1.0, 1.0)
		var lib := AnimationLibrary.new()
		lib.add_animation("drive", an)
		var ap := AnimationPlayer.new()
		holder.add_child(ap)
		ap.add_animation_library("", lib)
		pc.animation = "once"
		ap.play("drive")
		ap.seek(0.5, true)
		pc.update_now()
		api["anim_player"] = [pc.get_param("A"), pc.get_param("B")]
		holder.free()
	# set in the Inspector: "parameters/<name>" and a starting expression (tests/order: "swapped" adds 0.75 to Sw)
	var im: UgoModel = load("res://samples/exprs/model.ug9")
	if im != null:
		var c := UgoCharacter.new()
		c.model = im
		c.manual = true
		c.set("parameters/Puff", 0.6)
		c.expression = "swapped"
		c.update_now()
		api["inspector"] = [c.get_param("Puff"), c.get_param("Sw"), c.get("parameters/Puff")]
		c.free()
	# helpers: looking (far to the right of the face), the mouth following a level
	var h := UgoCharacter.new()
	h.model = model
	h.manual = true
	h.playing = false
	h.look_at_point(Vector2(5000, -450))
	h.set_mouth_level(1.0)
	h.advance(1.0)
	h.update_now()
	# the standard names where the sample has them, else the older ones
	var hx := "HeadTurnX" if model.find_parameter("HeadTurnX") >= 0 else "AngleX"
	var ex := "PupilX" if model.find_parameter("PupilX") >= 0 else "EyeBallX"
	api["helpers"] = [h.get_param(hx), h.get_param(ex), h.get_param("MouthOpen")]
	h.stop_looking()
	h.advance(1.0)
	h.update_now()
	api["helpers_after"] = h.get_param(hx)
	h.free()
	# catching up with the core: hit areas, bones in the world, reaching, wind (samples/reach; node at (0, 0))
	var rm: UgoModel = load("res://samples/reach/model.ug9")
	if rm != null:
		var r := UgoCharacter.new()
		r.model = rm
		r.manual = true
		add_child(r)
		r.update_now()
		var out := [r.get_area_at(Vector2(50, 50)), r.get_area_at(Vector2(10, 10)), r.get_area_at(Vector2(150, 150)), r.get_area_names().size()]
		var arm1: Transform2D = r.get_bone_transform("arm1")
		out.append(arm1.origin.x)
		out.append(arm1.origin.y)
		r.reach_for("arm2", Vector2(130, 165))
		r.update_now()
		var arm2: Transform2D = r.get_bone_transform("arm2")
		var tip: Vector2 = arm2 * Vector2(40, 0)
		out.append(tip.x)
		out.append(tip.y)
		r.free()
		var hair := []
		for w in [0.0, 600.0]:
			var hw := UgoCharacter.new()
			hw.model = rm
			hw.manual = true
			hw.wind = Vector2(w, 0)
			add_child(hw)
			for i in 120:
				hw.advance(1.0 / 60.0)
				hw.update_now()
			hair.append(hw.get_bone_transform("h2").origin.x)
			hw.free()
		out.append(hair[0])
		out.append(hair[1])
		api["reach"] = out
	# picking by part name: local coordinates are model pixels (here the node sits at (100, 50), scaled 2)
	var pk := UgoCharacter.new()
	pk.model = model
	pk.manual = true
	pk.playing = false
	add_child(pk)
	pk.position = Vector2(100, 50)
	pk.scale = Vector2(2, 2)
	pk.update_now()
	var whole: Rect2 = pk.get_part_rect()
	var face: Rect2 = pk.get_part_rect("face")
	api["pick"] = [pk.get_part_at(Vector2(100, 50 - 660)), pk.get_part_at(Vector2(5000, 5000)), pk.hit_test(Vector2(100, 50 - 660)),
		whole.encloses(face) and face.size.x > 0, pk.get_part_rect("no such part").size.x]
	pk.free()
	# flipped (scale.x = -1): the part under a point matches the mirrored point of an unflipped one
	var plain := UgoCharacter.new()
	var flip := UgoCharacter.new()
	for c in [plain, flip]:
		c.model = model
		c.manual = true
		add_child(c)
	plain.position = Vector2(300, 600)
	flip.position = Vector2(900, 600)
	flip.scale = Vector2(-1, 1)
	plain.update_now()
	flip.update_now()
	var same := 0
	var sided := 0
	var differ := 0
	for dx in range(-150, 151, 5):
		var a: String = plain.get_part_at(Vector2(300 + dx, 300))
		var b: String = flip.get_part_at(Vector2(900 - dx, 300))
		if a == b:
			same += 1
			if a.ends_with("L") or a.ends_with("R"):
				sided += 1
		else:
			differ += 1
	api["flip_pick"] = [same, sided, differ]
	plain.free()
	flip.free()
	# the playground scene (demo/playground.tscn) builds its panel: a slider per parameter, and clicking names a part
	var pgs: PackedScene = load("res://demo/playground.tscn")
	if pgs != null:
		var pg = pgs.instantiate()
		add_child(pg)
		pg._process(0.0)
		pg.hero.update_now()
		api["playground"] = [pg.sliders.size(), model.get_parameter_names().size(), pg.hero.get_part_at(pg.hero.position + Vector2(0, -330) * pg.hero.scale.y)]
		pg.free()
	# the conversation sample (demo/conversation.tscn): the preset's and the model's expressions, a key shows one, the face
	var cvs: PackedScene = load("res://demo/conversation.tscn")
	if cvs != null:
		var cv = cvs.instantiate()
		add_child(cv)
		cv._process(0.0)
		cv.show_expression_key(1)
		cv.hero.update_now()
		api["conversation"] = [cv.expressions.size(), cv.expr, cv.hero.get_part_at(cv.hero.position + Vector2(0, -330) * cv.hero.scale.y)]
		cv.free()
	# the ordering sample (demo/ordering.tscn): three characters, clicking names the one in front and its part, z_index, a tint
	var ors: PackedScene = load("res://demo/ordering.tscn")
	if ors != null:
		var od = ors.instantiate()
		add_child(od)
		od._process(0.0)
		for c in od.characters:
			c.update_now()
		var front: UgoCharacter = od.characters[1]
		var hit: Array = od.pick(front.global_position + Vector2(0, -330) * front.scale.y)
		od.bring_to_front(1)
		api["ordering"] = [od.characters.size(), String(hit[0].name) if hit[0] != null else "", hit[1], od.characters[0].z_index, od.characters[2].modulate.g]
		od.free()
	results["api"] = api
