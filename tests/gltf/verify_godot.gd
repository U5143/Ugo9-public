# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Godot import check for docs/検証_glTF.md:
#   godot --headless --path <empty project> --script verify_godot.gd -- model.glb expected.json
# Imports the .glb at runtime with GLTFDocument, then compares bones, blend
# shapes and animation values against the Ugo9 core (expected.json).
extends SceneTree

func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var expected = JSON.parse_string(FileAccess.get_file_as_string(args[1]))
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_file(args[0], state)
	var report := {"godot": Engine.get_version_info().string, "append_error": err}
	if err != OK:
		print("REPORT " + JSON.stringify(report))
		quit(1)
		return
	var keep_constant := args.size() > 2 and args[2] == "keep"
	report["remove_immutable_tracks"] = not keep_constant
	var scene := doc.generate_scene(state, 30.0, false, not keep_constant)
	root.add_child(scene)
	var skel: Skeleton3D = _find(scene, "Skeleton3D")
	var mi: MeshInstance3D = _find(scene, "MeshInstance3D")
	var ap: AnimationPlayer = _find(scene, "AnimationPlayer")
	report["bones"] = skel.get_bone_count()
	var bone_names := []
	for i in skel.get_bone_count():
		bone_names.append(skel.get_bone_name(i))
	report["bone_names"] = bone_names
	var mesh := mi.mesh
	report["surfaces"] = mesh.get_surface_count()
	report["vertices"] = mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX].size()
	report["blend_shapes"] = mesh.get_blend_shape_count()
	var mat = mi.get_active_material(0)
	report["material"] = {"class": mat.get_class(), "transparency": mat.transparency, "shading_mode": mat.shading_mode, "cull_mode": mat.cull_mode}
	report["animations"] = {}
	for anim_name in ap.get_animation_list():
		var a := ap.get_animation(anim_name)
		var types := {}
		for t in a.get_track_count():
			var ty := str(a.track_get_type(t))
			types[ty] = types.get(ty, 0) + 1
		report["animations"][anim_name] = {"length": a.length, "tracks": a.get_track_count(), "track_types": types}
	var checks := {}
	for key in expected.keys():
		var e = expected[key]
		ap.play(key.split("@")[0])
		ap.seek(e["time"], true)
		var max_bs := 0.0
		var missing := []
		for n in e["morph"].keys():
			var idx := mi.find_blend_shape_by_name(n)
			if idx < 0:
				missing.append(n)
				continue
			max_bs = max(max_bs, abs(mi.get_blend_shape_value(idx) - e["morph"][n]))
		var max_pos := 0.0
		var max_ang := 0.0
		for bn in e["bones"].keys():
			var bi := skel.find_bone(bn)
			if bi < 0:
				missing.append(bn)
				continue
			var p := skel.get_bone_pose_position(bi)
			max_pos = max(max_pos, abs(p.x - e["bones"][bn]["tx"]), abs(p.y - e["bones"][bn]["ty"]))
			max_ang = max(max_ang, abs(angle_difference(skel.get_bone_pose_rotation(bi).get_euler().z, e["bones"][bn]["angleZ"])))
		var vis := {}
		for pn in e["opacity"].keys():
			var vb := -1
			for cand in ["vis:" + pn, "vis_" + pn]:
				if vb < 0:
					vb = skel.find_bone(cand)
			if vb >= 0:
				vis[pn] = [snapped(e["opacity"][pn], 0.001), skel.get_bone_pose_scale(vb).x]
		checks[key] = {"blend_shape_max_error": max_bs, "bone_position_max_error_m": max_pos, "bone_angle_max_error_rad": max_ang, "visibility_opacity_vs_scale": vis, "missing": missing}
	report["checks"] = checks
	print("REPORT " + JSON.stringify(report))
	quit(0)

func _find(n: Node, cls: String) -> Node:
	if n.get_class() == cls:
		return n
	for c in n.get_children():
		var r := _find(c, cls)
		if r:
			return r
	return null
