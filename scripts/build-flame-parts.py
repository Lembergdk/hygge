"""Render the flame as registered full-canvas layers for the SwiftUI rig.

Run: blender -b scene-left.blend -P build_parts.py
Outputs parts/*.png (720x900) — body, limbs, and face variants, all in the
same fixed framing so they composite by simple stacking.
"""
import bpy
import os
from math import radians
from mathutils import Vector

OUT = os.path.join(os.path.dirname(bpy.data.filepath), "parts")
os.makedirs(OUT, exist_ok=True)

sc = bpy.context.scene
sc.frame_set(48)
# Neutral pose: undo the walk swing on every pivot.
for name in ("ArmLeftPivot", "ArmRightPivot", "LegLeftPivot", "LegRightPivot",
             "InnerPivot", "OuterPivot"):
    bpy.data.objects[name].rotation_euler = (0, 0, 0)

sc.render.resolution_x = 720
sc.render.resolution_y = 900
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.film_transparent = True

ALL = [o for o in bpy.data.objects if o.type in ("MESH", "CURVE")]
FACE_BASE = {o.name for o in ALL if o.name.startswith(("Eye", "Blush"))}
FACE_BASE.update(("Smile", "Highlight"))
BLUSH = {n for n in FACE_BASE if n.startswith("Blush")}


def show_only(names):
    for o in ALL:
        o.hide_render = o.name not in names


def render(names, filename):
    show_only(set(names))
    sc.render.filepath = os.path.join(OUT, filename)
    bpy.ops.render.render(write_still=True)
    print("RENDERED", filename)


def render_with_temps(base_names, temps, filename):
    show_only(set(base_names))
    for o in temps:
        o.hide_render = False
    sc.render.filepath = os.path.join(OUT, filename)
    bpy.ops.render.render(write_still=True)
    for o in temps:
        bpy.data.objects.remove(o, do_unlink=True)
    print("RENDERED", filename)


# --- Body & limbs -------------------------------------------------------
render(["OuterFlame", "InnerFlame"], "FlameRigBody.png")
render(["ArmLeft"], "FlameRigArmScreenRight.png")
render(["ArmRight"], "FlameRigArmScreenLeft.png")
render(["LegLeft"], "FlameRigLegScreenRight.png")
render(["LegRight"], "FlameRigLegScreenLeft.png")

# --- Face construction helpers -----------------------------------------
INK = bpy.data.materials["FaceBrown"]
BLUE = bpy.data.materials.new("TearBlue")
BLUE.diffuse_color = (0.35, 0.65, 1.0, 1.0)

EYE_R = Vector((0.261, -0.30, 0.769))    # screen-right eye (world)
EYE_L = Vector((-0.531, -0.30, 0.769))   # screen-left eye
MOUTH = Vector((-0.145, -0.31, 0.665))


def blob(center, scale, mat=INK, rot_y=0.0):
    bpy.ops.mesh.primitive_uv_sphere_add(location=center)
    o = bpy.context.object
    o.scale = scale
    o.rotation_euler = (0, radians(rot_y), 0)
    o.data.materials.append(mat)
    return o


def eye_dot(c, sx=0.060, sz=0.080):
    return blob(c, (sx, 0.02, sz))


def eye_closed(c):
    return blob(c, (0.068, 0.02, 0.016))


def mouth_arc(width=0.39, depth=0.10, flip=False, dy=0.0, dz=0.0):
    cu = bpy.data.curves.new("Arc", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 0.019
    cu.materials.append(INK)
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(2)
    mid_z = MOUTH.z + (depth if flip else -depth) + dz
    pts = [(MOUTH.x - width / 2, MOUTH.y + dy, MOUTH.z + dz),
           (MOUTH.x, MOUTH.y + dy, mid_z),
           (MOUTH.x + width / 2, MOUTH.y + dy, MOUTH.z + dz)]
    for bp, co in zip(sp.bezier_points, pts):
        bp.co = co
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    o = bpy.data.objects.new("ArcObj", cu)
    bpy.context.collection.objects.link(o)
    return o


# --- Faces --------------------------------------------------------------
render(FACE_BASE, "FlameRigFaceNormal.png")

render_with_temps(
    BLUSH | {"Highlight"},
    [eye_dot(EYE_L, sz=0.058), eye_dot(EYE_R, sz=0.058), mouth_arc(0.46, 0.13)],
    "FlameRigFaceHappy.png")

render_with_temps(
    BLUSH | {"Highlight"},
    [eye_closed(EYE_L), eye_closed(EYE_R),
     blob((MOUTH.x, MOUTH.y, MOUTH.z - 0.03), (0.125, 0.02, 0.095))],
    "FlameRigFaceLaugh.png")

render_with_temps(
    {"Highlight"},
    [eye_closed(EYE_L), eye_closed(EYE_R), mouth_arc(0.30, 0.08, flip=True),
     blob((EYE_L.x - 0.03, -0.31, EYE_L.z - 0.20), (0.042, 0.02, 0.075), BLUE),
     blob((EYE_R.x + 0.03, -0.31, EYE_R.z - 0.20), (0.042, 0.02, 0.075), BLUE)],
    "FlameRigFaceCry.png")

render_with_temps(
    {"Highlight"},
    [blob(EYE_L, (0.060, 0.02, 0.030)), blob(EYE_R, (0.060, 0.02, 0.030)),
     mouth_arc(0.24, 0.06, flip=True),
     blob((0.48, -0.30, 1.02), (0.045, 0.02, 0.075), BLUE)],
    "FlameRigFaceSick.png")

render_with_temps(
    {"Highlight"},
    [blob(EYE_L, (0.070, 0.02, 0.015), rot_y=38), blob(EYE_R, (0.070, 0.02, 0.015), rot_y=-38),
     blob(MOUTH, (0.048, 0.02, 0.060))],
    "FlameRigFaceDizzy.png")

render_with_temps(
    BLUSH | {"Highlight"},
    [eye_dot(EYE_L, 0.080, 0.105), eye_dot(EYE_R, 0.080, 0.105),
     blob(MOUTH, (0.055, 0.02, 0.072))],
    "FlameRigFaceSurprised.png")

render_with_temps(
    BLUSH | {"Highlight"},
    [eye_closed(EYE_L), eye_closed(EYE_R), mouth_arc(0.20, 0.05)],
    "FlameRigFaceSleepy.png")

print("PARTS DONE")
