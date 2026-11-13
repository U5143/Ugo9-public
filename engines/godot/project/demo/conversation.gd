# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Ugo9 sample: one character in a conversation scene, using only the parts games need most (no code of
# its own for looking, blinking or the mouth). The same as Unity's "Conversation" sample.
# Open demo/conversation.tscn and press F6.
#   mouse: the character looks at it    1-9: expressions (preset demo/basic.ug9x, then the model's; 0: none)
#   hold Space: talk (the mouth follows a made-up voice; set lip_sync_bus to use a real sound)
#   A: next animation, mixed in 0.3 s
extends Node2D

const MODEL_PATH := "res://samples/basic/model.ug9"
const PRESET_PATH := "res://demo/basic.ug9x"

var model: UgoModel
var hero: UgoCharacter
var label: Label
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
	hero = UgoCharacter.new()
	hero.model = model
	hero.auto_blink = true
	var names: PackedStringArray = model.get_animation_names()
	if names.size() > 0:
		hero.play(names[0])
	add_child(hero)
	# expressions: a preset's (names in its JSON) first, then the model's own
	if FileAccess.file_exists(PRESET_PATH):
		var json := FileAccess.get_file_as_string(PRESET_PATH)
		for missing in hero.load_expressions(json):
			push_warning("Ugo9 sample: the model has no parameter " + missing)
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

## Shows the i-th expression (1-based, as the keys); 0 or past the list: none.
func show_expression_key(i: int) -> void:
	if i == 0 or i > expressions.size():
		hero.only_expressions([])
		expr = -1
	else:
		hero.only_expressions([expressions[i - 1]])
		expr = i - 1

func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey and event.pressed and not event.echo):
		return
	if event.keycode >= KEY_0 and event.keycode <= KEY_9:
		show_expression_key(event.keycode - KEY_0)
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
	label.text = "expression: %s (1-%d, 0: none)   animation: %s (A: next)   hold Space: talk   mouse: look" % [
		expressions[expr] if expr >= 0 else "none", mini(9, expressions.size()), hero.animation]
