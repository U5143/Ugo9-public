# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Renders the imported .glb in Godot (Compatibility renderer) to PNG files:
#   xvfb-run godot --rendering-driver opengl3 --resolution 420x600 --path <project> \
#     --script render_godot.gd -- model.glb out_dir
# Writes <out>/godot_<mode>_<anim>_<frame>.png for the imported material
# ("import") and with transparency forced to plain alpha ("alpha").
extends SceneTree

const CW := 420.0
const CH := 600.0
const OX := 210.0
const OY := 590.0
const UNIT := 0.01

func _init() -> void:
	call_deferred("_run")

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var out_dir: String = args[1]
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	doc.append_from_file(args[0], state)
	var scene := doc.generate_scene(state, 30.0, false, false)
	root.add_child(scene)
	var mi: MeshInstance3D = _find(scene, "MeshInstance3D")
	var ap: AnimationPlayer = _find(scene, "AnimationPlayer")
	var cam := Camera3D.new()
	cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	cam.keep_aspect = Camera3D.KEEP_HEIGHT
	cam.size = CH * UNIT
	cam.position = Vector3((CW / 2.0 - OX) * UNIT, (OY - CH / 2.0) * UNIT, 5.0)
	root.add_child(cam)
	cam.make_current()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.95, 0.94, 0.92)
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	var we := WorldEnvironment.new()
	we.environment = env
	root.add_child(we)
	var original: StandardMaterial3D = mi.get_active_material(0)
	print("imported transparency mode: ", original.transparency, " depth_draw: ", original.depth_draw_mode)
	for mode in ["import", "alpha"]:
		var mat: StandardMaterial3D = original.duplicate()
		if mode == "alpha":
			mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			mat.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
		mi.material_override = mat
		for shot in [["idle", 45], ["idle", 62]]:
			ap.play(shot[0])
			ap.seek(shot[1] / 30.0, true)
			ap.pause()
			for i in 3:
				await process_frame
			await RenderingServer.frame_post_draw
			var img := root.get_texture().get_image()
			img.save_png("%s/godot_%s_%s_%d.png" % [out_dir, mode, shot[0], shot[1]])
	quit(0)

func _find(n: Node, cls: String) -> Node:
	if n.get_class() == cls:
		return n
	for c in n.get_children():
		var r := _find(c, cls)
		if r:
			return r
	return null
