#!/usr/bin/env python3
"""Generate LaunchLogo @1x/@2x/@3x — a transparent-background variant of
the app icon shield (no background, just the shield + checkmark).
iOS composites this over LaunchBackground."""
from __future__ import annotations
import os
from PIL import Image

# Reuse icon builder for shield geometry.
import importlib.util
spec = importlib.util.spec_from_file_location(
    "genicon",
    os.path.join(os.path.dirname(__file__), "generate_icon.py"),
)
genicon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(genicon)


def main() -> None:
    MASTER = 512  # 1x @ 1x
    out = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "Assets.xcassets",
        "LaunchLogo.imageset",
    )
    os.makedirs(out, exist_ok=True)

    bg = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    genicon.draw_shield(bg, MASTER)

    # @1x  = 120
    # @2x  = 240
    # @3x  = 360
    for scale, name in [(1, "LaunchLogo@1x.png"),
                         (2, "LaunchLogo@2x.png"),
                         (3, "LaunchLogo@3x.png")]:
        size = 120 * scale
        bg.resize((size, size), Image.LANCZOS).save(
            os.path.join(out, name), "PNG", optimize=True,
        )
    print(f"wrote 3 launch logos to {out}")


if __name__ == "__main__":
    main()
