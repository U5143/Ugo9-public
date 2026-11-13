# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Ugo9 playground: the sample character with a panel to try what the extension does, in one place.
# Open demo/playground.tscn and press F6 (Run Current Scene).
#   left panel: the animation list, a slider per parameter (moved ones override the animation until
#   Reset), blinking on its own, the microphone moving the mouth (lip_sync_bus, through the noise gate)
#   click the character: the name of the part under the mouse
extends Node2D

const MODEL_PATH := "res://samples/basic/model.ug9"
const PANEL_WIDTH := 320.0

var model: UgoModel
var hero: UgoCharacter
var picked: Label
var sliders := {}
var mic_player: AudioStreamPlayer

func _ready() -> void:
	RenderingServer.set_default_clear_color(Color(0.91, 0.9, 0.86))
	model = load(MODEL_PATH)
	if model == null:
		push_error("Build the extension first (it copies samples/basic into this project).")
		return
	hero = UgoCharacter.new()
	hero.model = model
	hero.auto_blink = true
	var names: PackedStringArray = model.get_animation_names()
	if names.size() > 0:
		hero.animation = names[0]
	add_child(hero)
	_build_panel(names)

func _build_panel(names: PackedStringArray) -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	var back := PanelContainer.new()
	back.size = Vector2(PANEL_WIDTH, get_viewport_rect().size.y)
	layer.add_child(back)
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	back.add_child(scroll)
	var box := VBoxContainer.new()
	box.custom_minimum_size = Vector2(PANEL_WIDTH - 24, 0)
	scroll.add_child(box)

	picked = Label.new()
	picked.text = "clicked part: -"
	box.add_child(picked)

	var anims := OptionButton.new()
	anims.add_item("(none)")
	for n in names:
		anims.add_item(n)
	anims.select(1 if names.size() > 0 else 0)
	anims.item_selected.connect(func(i): hero.play("" if i == 0 else names[i - 1], 0.0, 0.3))
	box.add_child(anims)

	var blink := CheckBox.new()
	blink.text = "blink on its own"
	blink.button_pressed = true
	blink.toggled.connect(func(on): hero.auto_blink = on)
	box.add_child(blink)

	var mic := Button.new()
	mic.text = "microphone: move the mouth"
	mic.pressed.connect(func(): _toggle_mic(mic))
	box.add_child(mic)

	var reset := Button.new()
	reset.text = "Reset parameters"
	reset.pressed.connect(_reset_params)
	box.add_child(reset)

	for n in model.get_parameter_names():
		var row := HBoxContainer.new()
		var label := Label.new()
		label.text = n
		label.custom_minimum_size = Vector2(120, 0)
		row.add_child(label)
		var s := HSlider.new()
		s.min_value = model.get_parameter_min(n)
		s.max_value = model.get_parameter_max(n)
		s.step = (s.max_value - s.min_value) / 200.0
		s.value = model.get_parameter_default(n)
		s.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		s.value_changed.connect(func(v): hero.set_param(n, v))
		row.add_child(s)
		box.add_child(row)
		sliders[n] = s

func _reset_params() -> void:
	hero.clear_params()
	for n in sliders:
		sliders[n].set_value_no_signal(model.get_parameter_default(n))

# The microphone plays into a bus the character listens to (lip_sync_bus); that bus sends to a
# silent one, so the voice is measured but not heard back. Needs audio input (project setting
# audio/driver/enable_input, on in this project) and, on desktops, the OS's microphone permission.
func _toggle_mic(button: Button) -> void:
	if mic_player != null:
		mic_player.queue_free()
		mic_player = null
		hero.lip_sync_bus = &""
		hero.set_mouth_level(-1.0)
		button.text = "microphone: move the mouth"
		return
	for bus in ["UgoSilent", "UgoMic"]:
		if AudioServer.get_bus_index(bus) < 0:
			AudioServer.add_bus()
			AudioServer.set_bus_name(AudioServer.bus_count - 1, bus)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("UgoSilent"), -80.0)
	AudioServer.set_bus_send(AudioServer.get_bus_index("UgoMic"), "UgoSilent")
	mic_player = AudioStreamPlayer.new()
	mic_player.stream = AudioStreamMicrophone.new()
	mic_player.bus = "UgoMic"
	add_child(mic_player)
	mic_player.play()
	hero.lip_sync_bus = &"UgoMic"
	button.text = "stop the microphone"

func _unhandled_input(event: InputEvent) -> void:
	if hero == null:
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT and event.position.x > PANEL_WIDTH:
		var part := hero.get_part_at(get_global_mouse_position())
		picked.text = "clicked part: " + (part if part != "" else "(nothing)")

func _process(_delta: float) -> void:
	if hero == null:
		return
	var size := get_viewport_rect().size
	var area := Vector2(size.x - PANEL_WIDTH, size.y)
	hero.scale = Vector2.ONE * area.y * 0.95 / 600.0
	hero.position = Vector2(PANEL_WIDTH + area.x * 0.5, size.y * 0.98)
