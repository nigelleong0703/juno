#!/bin/sh
# Compile the daemon to one static executable with Bun (`bun build --compile`), for the image's architecture:
#   sh build.sh                 # linux, this machine's architecture
#   TARGET=bun-linux-arm64 sh build.sh
#   BUN=/path/to/bun OUT=/tmp/juno-link sh build.sh
# The image recipe (sandbox-image/prepare_assets.py) ships the result as /usr/local/bin/juno-link.
set -eu
cd "$(dirname "$0")"
BUN=${BUN:-bun}
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
TARGET=${TARGET:-bun-linux-$arch}
OUT=${OUT:-../sandbox-image/files/juno-link}
"$BUN" build --compile --target="$TARGET" --minify src/main.ts --outfile "$OUT"
