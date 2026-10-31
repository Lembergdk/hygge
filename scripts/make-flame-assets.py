# Build every in-app flame asset from the approved LEFT-facing Blender art.
#
# Source: ~/hygge-flame-animation
#   render-left.png          static reference (matches anim-left frame 13)
#   anim-left/frame_*.png    48 transparent frames, 960x1200
#
# Outputs:
#   App/Assets.xcassets/FlameCharacter.imageset/flame-character.png
#   App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
#   App/FlameWalk.png                         (APNG, 480x600, 40ms/frame)
#   App/FlameLaptop.png                       (APNG from anim-laptop, working)
#   App/FlameNotify.png                       (APNG from anim-notification)
#   docs/design/flame-character-source.png    (the approved left reference)
#
# Run: python3 scripts/make-flame-assets.py [source-dir]
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/hygge-flame-animation")

STATIC_FRAME = os.path.join(SRC, "anim-left", "frame_0013.png")
REFERENCE = os.path.join(SRC, "render-left.png")
ANIM_DIR = os.path.join(SRC, "anim-left")

for required in (STATIC_FRAME, REFERENCE, ANIM_DIR):
    if not os.path.exists(required):
        raise SystemExit(f"missing approved left-facing source: {required}")


def write_static_and_icon() -> None:
    # render-left.png is frame 13 composited on paper; use the transparent
    # source frame so the static mark and animation are pixel-consistent.
    static = Image.open(STATIC_FRAME).convert("RGBA").resize((800, 1000), Image.LANCZOS)
    static_path = os.path.join(
        ROOT, "App", "Assets.xcassets", "FlameCharacter.imageset", "flame-character.png"
    )
    static.save(static_path, optimize=True)

    paper = (250, 246, 239, 255)  # Warm Nordic paper, #FAF6EF
    icon = Image.new("RGBA", (1024, 1024), paper)
    scale = min(880 / static.width, 880 / static.height)
    resized = static.resize(
        (round(static.width * scale), round(static.height * scale)), Image.LANCZOS
    )
    icon.alpha_composite(
        resized, ((1024 - resized.width) // 2, (1024 - resized.height) // 2)
    )
    icon_path = os.path.join(
        ROOT, "App", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.png"
    )
    icon.convert("RGB").save(icon_path, optimize=True)

    reference_path = os.path.join(ROOT, "docs", "design", "flame-character-source.png")
    Image.open(REFERENCE).convert("RGB").save(reference_path, optimize=True)
    print(f"static: {static_path} ({os.path.getsize(static_path) // 1024} KB)")
    print(f"icon:   {icon_path} ({os.path.getsize(icon_path) // 1024} KB)")


def write_animation(anim_dir: str, expected: int, out_name: str) -> None:
    files = sorted(name for name in os.listdir(anim_dir) if name.endswith(".png"))
    if len(files) != expected:
        raise SystemExit(f"expected {expected} frames in {anim_dir}, found {len(files)}")
    frames = []
    for name in files:
        frame = Image.open(os.path.join(anim_dir, name)).convert("RGBA")
        frames.append(frame.resize((480, 600), Image.LANCZOS))

    out = os.path.join(ROOT, "App", out_name)
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=40,
        loop=0,
        disposal=2,
        optimize=True,
    )
    print(f"anim:   {out} ({len(frames)} frames, {os.path.getsize(out) // 1024} KB)")


write_static_and_icon()
write_animation(ANIM_DIR, 48, "FlameWalk.png")
write_animation(os.path.join(SRC, "anim-laptop"), 72, "FlameLaptop.png")
write_animation(os.path.join(SRC, "anim-notification"), 60, "FlameNotify.png")
