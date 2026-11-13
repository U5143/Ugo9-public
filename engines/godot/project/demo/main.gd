# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Ugo9 demo: a crowd drawn by one UgoBatch (one draw call for all of them)
# and a large character in a conversation, using the helpers (no code of its own
# for looking, blinking or the mouth).
#   Up / Down: double / halve the crowd    mouse: the character looks at it
#   1-9: expressions (preset demo/basic.ug9x, then the model's; 0: none)
#   hold Space: talk (the mouth follows a made-up voice)    A: next animation, mixed in 0.3 s
# (An exported game needs "*.ug9x" in the export preset's non-resource filters.)
extends Node2D

const MODEL_PATH := "res://samples/basic/model.ug9"
const PRESET_PATH := "res://demo/basic.ug9x"

var model: UgoModel
var batch: UgoBatch
var hero: UgoCharacter
var label: Label
var count := 50
var expressions: PackedStringArray = []
var expr := -1
var anim := 0
var voice_t := 0.0

func _ready() -> void:
	RenderingServer.set_default_clear_color(Color(0.93, 0.92, 0.89))
	model = load(MODEL_PATH)
	if model == null:
		push_error("Build the extension first (it copies samples/basic into this project).")
		return
	batch = UgoBatch.new()
	add_child(batch)
	hero = UgoCharacter.new()
	hero.model = model
	hero.animation = "idle"
	hero.auto_blink = true
	add_child(hero)
	# expressions: a preset's (names in its JSON) first, then the model's own
	if FileAccess.file_exists(PRESET_PATH):
		var json := FileAccess.get_file_as_string(PRESET_PATH)
		for missing in hero.load_expressions(json):
			push_warning("Ugo9 demo: the model has no parameter " + missing)
		var preset = JSON.parse_string(json)
		if preset is Dictionary:
			for e in preset.get("expressions", []):
				expressions.append(e["id"])
	for n in hero.get_expression_names():
		if not expressions.has(n):
			expressions.append(n)
	label = Label.new()
	label.position = Vector2(12, 8)
	label.add_theme_color_override("font_color", Color.BLACK)
	add_child(label)
	_rebuild_crowd()

func _rebuild_crowd() -> void:
	for c in batch.get_children():
		c.queue_free()
	var size := get_viewport_rect().size
	var cols := int(ceil(sqrt(count * size.x / size.y)))
	var rows := int(ceil(float(count) / cols))
	var cell := Vector2(size.x / cols, size.y / rows)
	var s: float = min(cell.x / 420.0, cell.y / 600.0) * 0.9
	for i in count:
		var c := UgoCharacter.new()
		c.model = model
		c.play("idle", randf() * 6.0)
		c.speed = randf_range(0.8, 1.2)
		c.position = Vector2((i % cols + 0.5) * cell.x, (i / cols + 1.0) * cell.y - cell.y * 0.05)
		c.scale = Vector2(s, s)
		batch.add_child(c)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_up"):
		count = min(count * 2, 6400)
		_rebuild_crowd()
	elif event.is_action_pressed("ui_down"):
		count = max(count / 2, 1)
		_rebuild_crowd()
	elif event is InputEventKey and event.pressed and not event.echo:
		if event.keycode >= KEY_0 and event.keycode <= KEY_9:
			var i: int = event.keycode - KEY_0
			if i == 0 or i > expressions.size():
				hero.only_expressions([])
				expr = -1
			else:
				hero.only_expressions([expressions[i - 1]])
				expr = i - 1
		elif event.keycode == KEY_A:
			var names: PackedStringArray = model.get_animation_names()
			if names.size() > 0:
				anim = (anim + 1) % names.size()
				hero.play(names[anim], 0.0, 0.3)

func _process(delta: float) -> void:
	if model == null:
		return
	var size := get_viewport_rect().size
	hero.position = Vector2(size.x * 0.5, size.y)
	hero.scale = Vector2.ONE * size.y / 620.0
	# looking: the helper turns face, eyes and body, easing in and out by itself
	hero.look_at_point(get_global_mouse_position())
	# talking: a made-up voice while Space is held; negative gives the mouth back to the animation
	if Input.is_key_pressed(KEY_SPACE):
		voice_t += delta
		hero.set_mouth_level(clamp(0.55 + 0.45 * sin(voice_t * 31.0) * sin(voice_t * 7.3), 0.0, 1.0))
	else:
		hero.set_mouth_level(-1.0)
	label.text = "%d fps   crowd %d   draw calls for the crowd: %d   (Up/Down: more/fewer)\nexpression: %s (1-%d, 0: none)   animation: %s (A: next)   hold Space: talk   mouse: look" % [
		Engine.get_frames_per_second(), batch.get_character_count(), batch.get_draw_count(),
		expressions[expr] if expr >= 0 else "none", mini(9, expressions.size()), hero.animation]
