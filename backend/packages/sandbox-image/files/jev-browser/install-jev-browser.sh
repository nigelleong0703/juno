#!/bin/sh
set -eu
JEV_VERSION="0.2.1"
TARBALL_SHA256="c2abbbb83d175a559f12001286ed518766232c21f2ccd0bd450a8f29a94687c0"
DEST="/opt/juno/jev-browser/upstream"
LOCK_SRC="/opt/juno/jev-browser/package-lock.json"
if ! command -v node >/dev/null 2>&1; then echo "jev-browser: node is required (>=20)" >&2; exit 1; fi
if ! command -v npm >/dev/null 2>&1; then echo "jev-browser: npm is required (install npm with node)" >&2; exit 1; fi
NODE_MAJOR="$(node -p "process.versions.node.split(\".\")[0]")"
case "$NODE_MAJOR" in ''|*[!0-9]*) echo "jev-browser: cannot read node major" >&2; exit 1;; esac
if [ "$NODE_MAJOR" -lt 20 ]; then echo "jev-browser: node >=20 required" >&2; exit 1; fi
echo "jev-browser: using node $(node --version) npm $(npm --version)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/jev.tgz" "https://registry.npmjs.org/jev-browser/-/jev-browser-$JEV_VERSION.tgz"
echo "$TARBALL_SHA256  $work/jev.tgz" | sha256sum -c -
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$work/jev.tgz" -C "$DEST" --strip-components=1
cp "$LOCK_SRC" "$DEST/package-lock.json"
cd "$DEST"
npm ci --omit=dev
ln -sfn "$DEST/node_modules" "/opt/juno/jev-browser/node_modules"
export JEV_BROWSER_NO_INSTALL=1
node --check "/opt/juno/jev-browser/jev-preload.mjs"
python3 -m py_compile "/opt/juno/jev-browser/agent_jev_supervise.py"
python3 -m py_compile "/opt/juno/jev-browser/jev_redact.py"
echo "jev-browser $JEV_VERSION installed"
