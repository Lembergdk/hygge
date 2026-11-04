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
import zlib

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

# The typing-arm and laptop exports used to contain two isolated eyes.
# Once these rigid layers rotate independently, those become extra faces.
# Decode RGBA PNG scanlines with the stdlib so this check also runs in CI.
def rgba_rows(path):
    data = open(path, "rb").read()
    off, compressed = 8, bytearray()
    while off < len(data):
        length, kind = struct.unpack(">I4s", data[off:off + 8])
        chunk = data[off + 8:off + 8 + length]
        if kind == b"IHDR":
            width, height, bits, color, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            assert (width, height, bits, color, interlace) == (720, 900, 8, 6, 0), path
        if kind == b"IDAT":
            compressed.extend(chunk)
        off += length + 12
    raw = zlib.decompress(compressed)
    stride, previous = width * 4, bytearray(width * 4)
    for y in range(height):
        start = y * (stride + 1)
        filter_type = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            left = row[x - 4] if x >= 4 else 0
            up = previous[x]
            upper_left = previous[x - 4] if x >= 4 else 0
            if filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = up
            elif filter_type == 3:
                predictor = (left + up) // 2
            elif filter_type == 4:
                value = left + up - upper_left
                distances = [abs(value - left), abs(value - up), abs(value - upper_left)]
                predictor = [left, up, upper_left][distances.index(min(distances))]
            else:
                assert filter_type == 0, path
                predictor = 0
            row[x] = (row[x] + predictor) & 255
        yield y, row
        previous = row


for name in ["Laptop", "TypingArmScreenLeft", "TypingArmScreenRight"]:
    rel = f"App/FlameRig{name}.png"
    duplicate_eye_pixels = sum(
        row[x * 4 + 3] > 0
        for y, row in rgba_rows(os.path.join(ROOT, rel)) if 490 <= y < 532
        for lo, hi in [(260, 294), (403, 437)] for x in range(lo, hi)
    )
    if duplicate_eye_pixels:
        failed = True
    print(f"{'FAIL' if duplicate_eye_pixels else 'OK '} {rel}: {duplicate_eye_pixels} duplicate eye pixels")

sys.exit(1 if failed else 0)
