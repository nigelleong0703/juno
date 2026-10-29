#!/bin/sh
# watchOS cannot decode WebP (UIImage and ImageIO both refuse it), so the iPhone app's character atlases are
# converted to HEIC (keeps the alpha, about the same size) into Characters/. Run after the iOS art changes.
set -eu
cd "$(dirname "$0")/.."
SRC=../ios/Juno/Characters
for clip in idle needs_you thinking happy failed sleeping; do
  for f in "$SRC"/*-"$clip".webp; do
    sips -s format heic -s formatOptions 70 "$f" --out "Characters/$(basename "${f%.webp}").heic" >/dev/null
  done
done
