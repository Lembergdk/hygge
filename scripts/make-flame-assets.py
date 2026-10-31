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
    static = Image.open(STATIC_FRAME).convert("RGBA").resize((480, 600), Image.LANCZOS)
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
    # Palette APNG with FULL-CANVAS frames (PIL, not ffmpeg): shared
    # 255-color palette + index-0 transparency, 360x450 at 40ms.
    # ffmpeg's APNG muxer writes partial subframes with dispose ops,
    # which ImageIO renders miscomposited on device (pale, clipped) —
    # full frames render identically everywhere. Guarded by
    # scripts/check-flame-assets.py.
    files = sorted(name for name in os.listdir(anim_dir) if name.endswith(".png"))
    if len(files) != expected:
        raise SystemExit(f"expected {expected} frames in {anim_dir}, found {len(files)}")

    frames = [
        Image.open(os.path.join(anim_dir, name)).convert("RGBA").resize(
            (360, 450), Image.LANCZOS)
        for name in files
    ]

    # Shared palette from a mosaic of all frames (on black; transparent
    # pixels are remapped to index 0 below, so their RGB is irrelevant).
    mosaic = Image.new("RGB", (360 * 6, 450 * ((len(frames) + 5) // 6)))
    for i, frame in enumerate(frames):
        mosaic.paste(frame.convert("RGB"), ((i % 6) * 360, (i // 6) * 450))
    palette_img = mosaic.quantize(colors=255, method=Image.MEDIANCUT)
    palette = [0, 0, 0] + (palette_img.getpalette() or [])[: 255 * 3]

    quantized = []
    for frame in frames:
        q = frame.convert("RGB").quantize(
            colors=255, palette=palette_img, dither=Image.FLOYDSTEINBERG)
        idx = q.point(lambda i: i + 1)
        alpha = frame.getchannel("A").point(lambda a: 0 if a < 96 else 255)
        idx.paste(0, mask=alpha.point(lambda a: 255 - a))
        idx.putpalette(palette)
        idx.info["transparency"] = 0
        quantized.append(idx)

    out = os.path.join(ROOT, "App", out_name)
    save_apng_full_frames(quantized, palette, out)
    print(f"anim:   {out} ({expected} frames, {os.path.getsize(out) // 1024} KB)")


def save_apng_full_frames(frames, palette, out_path) -> None:
    # Hand-written APNG: both ffmpeg and Pillow crop frames to the
    # changed bounding box, which ImageIO miscomposites on device.
    # Here every fcTL covers the full canvas at (0,0), blend=SOURCE.
    import binascii
    import struct
    import zlib

    w, h = frames[0].size

    def chunk(typ, payload):
        return (struct.pack(">I", len(payload)) + typ + payload
                + struct.pack(">I", binascii.crc32(typ + payload) & 0xFFFFFFFF))

    seq = 0

    def fctl():
        nonlocal seq
        payload = struct.pack(">IIIIIHHBB", seq, w, h, 0, 0, 1, 25, 0, 0)
        seq += 1
        return chunk(b"fcTL", payload)

    parts = [b"\x89PNG\r\n\x1a\n",
             chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0)),
             chunk(b"acTL", struct.pack(">II", len(frames), 0)),
             chunk(b"PLTE", bytes(palette[: 256 * 3])),
             chunk(b"tRNS", bytes([0]))]
    for i, frame in enumerate(frames):
        raw = frame.tobytes()
        scan = b"".join(b"\x00" + raw[y * w:(y + 1) * w] for y in range(h))
        comp = zlib.compress(scan, 9)
        parts.append(fctl())
        if i == 0:
            parts.append(chunk(b"IDAT", comp))
        else:
            parts.append(chunk(b"fdAT", struct.pack(">I", seq) + comp))
            seq += 1
    parts.append(chunk(b"IEND", b""))
    with open(out_path, "wb") as f:
        f.write(b"".join(parts))


write_static_and_icon()
write_animation(ANIM_DIR, 48, "FlameWalk.png")
write_animation(os.path.join(SRC, "anim-laptop"), 72, "FlameLaptop.png")
write_animation(os.path.join(SRC, "anim-notification"), 60, "FlameNotify.png")
