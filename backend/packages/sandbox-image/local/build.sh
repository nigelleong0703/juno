#!/usr/bin/env bash
# Build the local Docker Desktop image from the canonical recipe and assets.
#
# Disposable build context: the generated Dockerfile plus the canonical
# sandbox-assets.tar built by ../prepare_assets.py (same mapping the E2B
# template uses). Nothing is written into this directory; the context lives
# in a temp dir removed on exit. Tags juno-desktop:local for the local
# Docker Linux VM (linux/arm64). Never touches remote E2B hosts, Docker
# contexts, or user containers: plain `docker build` only, no volumes and
# no Mac filesystem mounts (the image CMD idles for `docker exec` sessions).
#
# Actual image builds run by the lead during integration; workers do not
# run this script against live infra.
set -euo pipefail
cd "$(dirname "$0")"
CTX="$(mktemp -d)"
cleanup() { rm -rf "$CTX"; }
trap cleanup EXIT
# The computer link daemon (BACKEND 7.11), compiled for this machine's Docker architecture (needs Bun: BUN=/path/to/bun).
sh ../../juno-link/build.sh
python3 generate_dockerfile.py > "$CTX/Dockerfile"
python3 ../prepare_assets.py --output "$CTX/sandbox-assets.tar"
docker build -t juno-desktop:local "$CTX"
