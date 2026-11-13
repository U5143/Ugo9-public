# SPDX-FileCopyrightText: 2026 U5143
# SPDX-License-Identifier: MIT
# Blender import check for docs/検証_glTF.md (runs with Blender's Python module):
#   python verify_blender.py model.glb out_dir [frame]
# Imports the .glb, reports what Blender built (armature, shape keys, actions,
# material) and renders one frame of "idle" with Cycles to out_dir/blender_idle_<frame>.png.
import json
import sys

import bpy

glb, out_dir = sys.argv[1], sys.argv[2]
frame = int(sys.argv[3]) if len(sys.argv) > 3 else 45

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30  # so glTF seconds land on the same frame numbers as Ugo9 (30 fps)
bpy.ops.import_scene.gltf(filepath=glb)
scene = bpy.context.scene
report = {"blender": bpy.app.version_string}

arm = next((o for o in scene.objects if o.type == "ARMATURE"), None)
mesh = next((o for o in scene.objects if o.type == "MESH"), None)
report["armature_bones"] = len(arm.data.bones) if arm else 0
report["bone_names"] = [b.name for b in arm.data.bones] if arm else []
keys = mesh.data.shape_keys.key_blocks if mesh and mesh.data.shape_keys else []
report["shape_keys"] = [k.name for k in keys]
report["vertices"] = len(mesh.data.vertices) if mesh else 0
report["actions"] = sorted(a.name for a in bpy.data.actions)
mat = mesh.active_material if mesh else None
report["material"] = {
    "name": mat.name if mat else None,
    "render_method": getattr(mat, "surface_render_method", None) if mat else None,
    "backface_culling": mat.use_backface_culling if mat else None,
}
top = next((o for o in scene.objects if "ugo9" in o.keys()), None)
report["extras_on"] = top.name if top else None
report["extras"] = json.loads(json.dumps(top["ugo9"].to_dict())) if top else None

# play "idle": the glTF importer stores each clip as actions; pick the ones named after it
def pick(prefix, target_id):
    for a in bpy.data.actions:
        if a.name.startswith(prefix):
            ad = target_id.animation_data or target_id.animation_data_create()
            ad.action = a
            if hasattr(ad, "action_slot") and a.slots:
                for slot in a.slots:
                    if slot.target_id_type == ("OBJECT" if target_id.bl_rna.identifier == "Object" else "KEY"):
                        ad.action_slot = slot
                        break
            return a.name
    return None

used = []
for o in scene.objects:
    if o.animation_data:
        o.animation_data.action = None
if arm:
    used.append(pick("idle", arm))
if mesh and mesh.data.shape_keys:
    used.append(pick("idle", mesh.data.shape_keys))
for o in scene.objects:
    if o.type == "EMPTY" or (o.type == "MESH" and o != mesh):
        pass
report["actions_used"] = used
fps = scene.render.fps
scene.frame_set(frame)
report["frame"] = frame
report["fps"] = fps

# orthographic camera framing the Ugo9 canvas
cw, ch, ox, oy = report["extras"]["canvas"] if report["extras"] else (420, 600, 210, 590)
unit = report["extras"]["metresPerPixel"] if report["extras"] else 0.01
cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = max(cw, ch) * unit
cam = bpy.data.objects.new("cam", cam_data)
cam.location = ((cw / 2 - ox) * unit, (oy - ch / 2) * unit, 10)
scene.collection.objects.link(cam)
scene.camera = cam
# glTF is y-up; Blender imports it as z-up: put the camera in front of the sheet
cam.location = ((cw / 2 - ox) * unit, -10, (oy - ch / 2) * unit)
cam.rotation_euler = (1.5707963, 0, 0)

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = int(cw), int(ch)
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = "Standard"
scene.render.film_transparent = False
world = bpy.data.worlds.new("bg")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
srgb = (0.95, 0.94, 0.92)
lin = tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in srgb)
bg.inputs[0].default_value = (*lin, 1)
scene.world = world
scene.render.filepath = f"{out_dir}/blender_idle_{frame}.png"
bpy.ops.render.render(write_still=True)
report["render"] = scene.render.filepath
print("REPORT " + json.dumps(report))
