#!/usr/bin/env bash
# Sync packages/sandbox-image/ to your self-hosted E2B host and build it there.
# Builds must run on that host: with local storage, template file uploads go to
# the orchestrator's disk on that machine. Set E2B_BUILD_SSH to user@host.
#
# Disk preflight: every image layer snapshots on the build host, so a build
# needs ample free space. The remote free-space gate below runs BEFORE any
# upload: when it refuses, nothing is uploaded and no remote cleanup happens.
set -euo pipefail
HOST=${E2B_BUILD_SSH:?set E2B_BUILD_SSH to user@host of the self-hosted E2B machine}
DIR=${E2B_BUILD_TEMPLATE_DIR:-e2b-desktop/template}
MIN_BUILD_FREE_GIB=${MIN_BUILD_FREE_GIB:-40}
if ! [ "$MIN_BUILD_FREE_GIB" -gt 0 ] 2>/dev/null; then
  echo "error: MIN_BUILD_FREE_GIB must be a positive integer of GiB (got '${MIN_BUILD_FREE_GIB}')" >&2
  exit 1
fi
# One remote probe emitting a single integer: free GiB on the template dir's
# filesystem, floored from df -Pk kibibytes (df -BG rounds up, so 39.1GiB
# would wrongly satisfy 40). SSH must succeed and the output must be exactly
# that integer; anything else refuses the build with no upload or cleanup.
if ! FREE_GIB=$(ssh -o BatchMode=yes "$HOST" "df -Pk -- \"$DIR\" 2>/dev/null | awk 'NR==2 {print int(\$4/1048576)}'"); then
  echo "error: free-space probe failed on '${HOST}:${DIR}'; refusing build (no upload attempted, no remote cleanup performed)" >&2
  exit 1
fi
case "$FREE_GIB" in
  ''|*[!0-9]*)
    echo "error: unexpected free-space probe output on '${HOST}:${DIR}'; refusing build (no upload attempted, no remote cleanup performed)" >&2
    exit 1
    ;;
esac
if [ "$FREE_GIB" -lt "$MIN_BUILD_FREE_GIB" ]; then
  echo "error: refusing build: only ${FREE_GIB}GiB free on '${HOST}:${DIR}', need ${MIN_BUILD_FREE_GIB}GiB (override with MIN_BUILD_FREE_GIB=<GiB>); no upload attempted, no remote cleanup performed" >&2
  exit 1
fi
cd "$(dirname "$0")"
# The computer link daemon (BACKEND 7.11) is compiled here (Bun cross-compiles) for the build host; the bundle ships it as /usr/local/bin/juno-link.
TARGET=${JUNO_LINK_TARGET:-bun-linux-x64} sh ../juno-link/build.sh
tar cf - template_debian.py build_debian.py prepare_assets.py files | ssh -o BatchMode=yes "$HOST" "tar xf - -C $DIR"
ssh -o BatchMode=yes "$HOST" "cd $DIR && E2B_API_KEY=\$(cat ~/.e2b-local-key) E2B_API_URL=http://localhost:3000 E2B_SANDBOX_URL=http://localhost:3002 TEMPLATE_ALIAS=${TEMPLATE_ALIAS:-desktop-debian} .venv/bin/python build_debian.py"
