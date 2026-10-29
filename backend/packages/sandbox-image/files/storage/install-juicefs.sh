#!/bin/sh
# Image build step for durable storage (BACKEND 7.10): installs the pinned official JuiceFS client at /usr/local/bin/juicefs.
# fuse3 comes from the template's apt list. Runs as root at image build time (template_debian.py); nothing here runs later.
set -eu

JUICEFS_VERSION=1.4.1
case "$(uname -m)" in
  x86_64) arch=amd64; sha256=01ee09a21a9351a465e09906f113845e1c6a19bea70f530e5e2b2125b2dd3b82 ;;
  aarch64) arch=arm64; sha256=1015ade83a7a93180a29f6c93ee5780a3eda52522331934ef2ef0cc0921995fd ;;
  *) echo "storage: no JuiceFS build pinned for $(uname -m)" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/juicefs.tar.gz" "https://github.com/juicedata/juicefs/releases/download/v${JUICEFS_VERSION}/juicefs-${JUICEFS_VERSION}-linux-${arch}.tar.gz"
echo "${sha256}  ${work}/juicefs.tar.gz" | sha256sum -c -
tar -xzf "$work/juicefs.tar.gz" -C "$work" juicefs
install -m 0755 "$work/juicefs" /usr/local/bin/juicefs
juicefs version
