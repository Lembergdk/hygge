"""Render the laptop + typing arms as registered full-canvas layers.

Run: blender -b scene-laptop.blend --python-exit-code 1 -P build_laptop_parts.py
Outputs parts/FlameRigLaptop.png and parts/FlameRigTypingArm*.png
(720x900), in the same fixed framing as the other rig layers so they
composite by simple stacking. Also prints the shoulder-pivot anchors
(normalized, SwiftUI y-down) for the typing arms.
"""
import bpy
import os
from bpy_extras.object_utils import world_to_camera_view

OUT = os.path.join(os.path.dirname(bpy.data.filepath), "parts")
os.makedirs(OUT, exist_ok=True)

sc = bpy.context.scene
sc.frame_set(1)

# Neutral: seated-bob root and typing taps undone, like build_parts.py.
root = bpy.data.objects.get("Root") or bpy.data.objects.get("FlameRoot")
for name in ("ArmLeftPivot", "ArmRightPivot", "InnerPivot", "OuterPivot"):
    o = bpy.data.objects.get(name)
    if o:
        o.rotation_euler = (0, 0, 0)
if root:
    root.location = (0, 0, 0)
    root.rotation_euler = (0, 0, 0)

sc.render.resolution_x = 720
sc.render.resolution_y = 900
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.film_transparent = True

ALL = [o for o in bpy.data.objects if o.type in ("MESH", "CURVE")]
print("OBJECTS:", sorted(o.name for o in ALL))

LAPTOP = ["LaptopLid", "LaptopLidPanel", "ScreenGlow", "LidLogo",
          "LaptopBase", "FingerNotch"]


def show_only(names):
    names = set(names)
    for o in ALL:
        o.hide_render = o.name not in names


def render(names, filename):
    show_only(names)
    sc.render.filepath = os.path.join(OUT, filename)
    bpy.ops.render.render(write_still=True)
    print("RENDERED", filename)


cam = sc.camera
bpy.context.view_layer.update()
for pname in ("ArmLeftPivot", "ArmRightPivot"):
    piv = bpy.data.objects.get(pname)
    if piv and cam:
        v = world_to_camera_view(sc, cam, piv.matrix_world.translation)
        print(f"ANCHOR {pname}: x={v.x:.3f} y_down={1 - v.y:.3f}")

render(LAPTOP, "FlameRigLaptop.png")
render(["ArmLeft"], "FlameRigTypingArmA.png")
render(["ArmRight"], "FlameRigTypingArmB.png")
print("DONE")
