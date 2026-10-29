#!/usr/bin/env python3
"""Generate build/icon.icns and build/Assets.car.

icon.icns comes from build/icon-1024.png (the cream macOS squircle icon) and is the fallback for
macOS < 26. Assets.car is compiled by actool from build/AppIcon.icon (Icon Composer bundle with
light / dark / tinted full-bleed layers) so macOS 26+ switches the icon with the theme;
scripts/after-pack.cjs copies it into the app (electron-builder reads no .icon yet, #9254).
Run: python3 packages/desktop/scripts/make-icon.py
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

BUILD = Path(__file__).resolve().parents[1] / "build"


def main() -> int:
    icon = Image.open(BUILD / "icon-1024.png")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            icon.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)
        out = Path(tmp) / "out"
        out.mkdir()
        subprocess.run(
            ["xcrun", "actool", "--compile", str(out), "--platform", "macosx", "--minimum-deployment-target", "11.0",
             "--app-icon", "AppIcon", "--output-partial-info-plist", str(Path(tmp) / "p.plist"), str(BUILD / "AppIcon.icon")],
            check=True, capture_output=True,
        )
        (BUILD / "Assets.car").write_bytes((out / "Assets.car").read_bytes())
    print(f"wrote {BUILD / 'icon.icns'} and Assets.car")
    return 0


if __name__ == "__main__":
    sys.exit(main())
