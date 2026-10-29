#!/bin/sh
# Image build step for Spaces (BACKEND 5.12): installs the pinned official Bun binary and fills the shared Bun install
# cache with the dependencies of the app template, so `bun install --frozen-lockfile --offline` works without network
# when an agent creates an app. Runs as root, once, at image build time (template_debian.py); nothing here runs later.
set -eu

BUN_VERSION=1.3.14
case "$(uname -m)" in
  x86_64) arch=x64; sha256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f ;;
  aarch64) arch=aarch64; sha256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;;
  *) echo "spaces: no Bun build pinned for $(uname -m)" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip"
echo "${sha256}  ${work}/bun.zip" | sha256sum -c -
unzip -q "$work/bun.zip" -d "$work"
install -m 0755 "$work/bun-linux-${arch}/bun" /usr/local/bin/bun

# The cache is world-readable but not writable, and Bun writes to its cache while installing: spaces_tool.py copies it into
# each agent's own ~/.bun/install/cache the first time (about a second), then `bun install --frozen-lockfile --offline` works.
export BUN_INSTALL_CACHE_DIR=/opt/juno/bun-cache
mkdir -p "$BUN_INSTALL_CACHE_DIR" "$work/app"
cp -a /opt/juno/skills/spaces/templates/app/. "$work/app/"
(cd "$work/app" && bun install --frozen-lockfile)
chmod -R a+rX "$BUN_INSTALL_CACHE_DIR"
bun --version
