#!/usr/bin/env bash
# Build the desktop template on E2B cloud. The SDK uploads the build context
# to E2B and the build runs there, so nothing needs local disk beyond the
# juno-link binary and the asset archive.
#
# The key comes from E2B_API_KEY or ~/.config/juno/e2b-cloud.env (never the
# repo). TEMPLATE_ALIAS picks the alias (default desktop-debian).
set -euo pipefail
if [ -z "${E2B_API_KEY:-}" ] && [ -f "$HOME/.config/juno/e2b-cloud.env" ]; then
  set -a; . "$HOME/.config/juno/e2b-cloud.env"; set +a
fi
if [ -z "${E2B_API_KEY:-}" ]; then
  echo "error: E2B_API_KEY is not set (export it or put it in ~/.config/juno/e2b-cloud.env)" >&2
  exit 1
fi
# A self-hosted API/sandbox URL in the environment would send the build elsewhere.
unset E2B_API_URL E2B_SANDBOX_URL E2B_DOMAIN
cd "$(dirname "$0")"
# The computer link daemon (BACKEND 7.11) is compiled here (Bun cross-compiles); the bundle ships it as /usr/local/bin/juno-link.
TARGET=${JUNO_LINK_TARGET:-bun-linux-x64} sh ../juno-link/build.sh
TEMPLATE_ALIAS=${TEMPLATE_ALIAS:-desktop-debian} .venv/bin/python build_debian.py
