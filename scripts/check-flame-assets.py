# Regression check: flame APNGs must use FULL-CANVAS frames only.
#
# ffmpeg's APNG muxer writes partial subframes with dispose ops;
# ImageIO (CGImageSourceCreateImageAtIndex) renders those
# uncomposited/miscomposited on device — the laptop flame showed up
# pale with a clipped glyph (Oct 31 device recording). Full-canvas
# frames render identically under every decoder.
#
# Run: python3 scripts/check-flame-assets.py
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = ["App/FlameWalk.png", "App/FlameLaptop.png", "App/FlameNotify.png"]

failed = False
for rel in ASSETS:
    path = os.path.join(ROOT, rel)
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", rel
    off, canvas, frames, partial = 8, None, 0, 0
    while off < len(data):
        ln, typ = struct.unpack(">I4s", data[off:off + 8])
        typ = typ.decode()
        if typ == "IHDR":
            canvas = struct.unpack(">II", data[off + 8:off + 16])
        elif typ == "fcTL":
            _seq, w, h, x, y = struct.unpack(">IIIII", data[off + 8:off + 28])
            frames += 1
            if (w, h) != canvas or (x, y) != (0, 0):
                partial += 1
        off += 12 + ln
        if typ == "IEND":
            break
    status = "OK " if partial == 0 and frames > 1 else "FAIL"
    if partial:
        failed = True
    print(f"{status} {rel}: {frames} frames, {partial} partial (canvas {canvas})")

sys.exit(1 if failed else 0)
