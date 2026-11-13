# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Ugo9 sample: ordering, colour and clicking (the same points as Unity's step 11-4 and docs/エンジンの使い方.md
# "色と前後" / "クリック・タップでパーツを知る"). Open demo/ordering.tscn and press F6.
#   three characters in a UgoBatch with y_sort_enabled: the lower one is in front; drag one up and down to see it change
#   1 / 2 / 3: bring that character to the front of the others (its z_index), 0: back to y order
#   a Sprite2D (a tree) is another node: it is in front of or behind the UgoBatch as a whole (the batch draws its
#   characters together); T: the batch's z_index 0 <-> 2 puts the characters behind / in front of the tree
#   the right one is tinted (modulate); click a character: its name, the part, and the hit area if any
extends Node2D

const MODEL_PATH := "res://samples/basic/model.ug9"

var model: UgoModel
var batch: UgoBatch
var characters: Array[UgoCharacter] = []
var tree: Sprite2D
var label: Label
var dragging: UgoCharacter = null
var picked := "-"

func _ready() -> void:
	RenderingServer.set_default_clear_color(Color(0.85, 0.9, 0.86))
	model = load(MODEL_PATH)
	if model == null:
		push_error("Build the extension first (it copies samples/basic into this project).")
		return
	batch = UgoBatch.new()
	batch.y_sort_enabled = true # lower on the screen: in front (a top-down game)
	add_child(batch)
	var size := get_viewport_rect().size
	var places := [Vector2(0.3, 0.72), Vector2(0.5, 0.95), Vector2(0.7, 0.8)]
	for i in places.size():
		var c := UgoCharacter.new()
		c.name = "Character%d" % (i + 1)
		c.model = model
		c.play("idle", i * 1.3)
		c.position = places[i] * size
		c.scale = Vector2.ONE * size.y / 1400.0
		batch.add_child(c)
		characters.append(c)
	characters[2].modulate = Color(1.0, 0.7, 0.7) # a tint on the whole character
	# a tree (a plain Sprite2D): in front of the batch (z_index 1 > the batch's 0) until T
	tree = Sprite2D.new()
	var img := Image.create(40, 260, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.35, 0.55, 0.3))
	tree.texture = ImageTexture.create_from_image(img)
	tree.position = Vector2(size.x * 0.4, size.y * 0.62)
	tree.z_index = 1
	add_child(tree)
	label = Label.new()
	label.position = Vector2(12, 8)
	label.add_theme_color_override("font_color", Color.BLACK)
	add_child(label)

## The character drawn in front at a global point, and its part ("" and null when none).
func pick(point: Vector2) -> Array:
	var best: UgoCharacter = null
	var best_key := -INF
	for c in characters:
		var part := c.get_part_at(point)
		if part == "":
			continue
		var key := float(c.z_index) * 100000.0 + c.global_position.y # z_index first, then y (as drawn)
		if key > best_key:
			best_key = key
			best = c
	return [best, best.get_part_at(point) if best else ""]

func bring_to_front(i: int) -> void:
	for k in characters.size():
		characters[k].z_index = 2 if k == i - 1 else 0

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			var hit := pick(get_global_mouse_position())
			dragging = hit[0]
			if hit[0] != null:
				var area: String = hit[0].get_area_at(get_global_mouse_position())
				picked = "%s: %s%s" % [hit[0].name, hit[1], ("  (area %s)" % area) if area != "" else ""]
			else:
				picked = "(nothing)"
		else:
			dragging = null
	elif event is InputEventMouseMotion and dragging != null:
		dragging.position += event.relative
	elif event is InputEventKey and event.pressed and not event.echo:
		if event.keycode >= KEY_0 and event.keycode <= KEY_3:
			bring_to_front(event.keycode - KEY_0)
		elif event.keycode == KEY_T:
			batch.z_index = 0 if batch.z_index == 2 else 2

func _process(_delta: float) -> void:
	if model == null:
		return
	label.text = "drag a character up / down: the lower one is in front (y_sort)   1-3: bring to front (z_index), 0: y order   T: characters %s the tree\nclicked: %s   draw calls: %d" % ["in front of" if batch.z_index == 2 else "behind", picked, batch.get_draw_count()]
