#!/bin/sh
# Image build step for the Web & video apps (BACKEND 10.18): installs Agent Reach (https://github.com/Panniantong/Agent-Reach, MIT) at one pinned
# commit and the one tool its Bilibili channel calls (bilibili-cli 0.6.2, Apache-2.0). Runs as root, once, at image build time
# (template_debian.py); nothing here runs later. Agent Reach installs tools into ~/.agent-reach at run time when asked to (`add`, `setup`,
# `update`); the entry point in /usr/local/bin only passes the read actions through, and everything it needs is installed here.
#
# Not from PyPI (another project holds the name `agent-reach` there): the archive of the pinned commit, checked against its SHA-256.
# Dependencies are pinned in the two constraints files (Agent Reach's own tested set, and the freeze of a clean bilibili-cli install).
# Not installed on purpose: cloakbrowser (a stealth browser it downloads at run time). OpenCLI, the login channels, is install-opencli.sh.
set -eu

REACH_COMMIT=14c213405669414492bda0f8d52cc6531d062c45
REACH_SHA256=fcd21410d817ce4829bb028824d54e5288dc036d21ad2076a3f9ef72f58ba539
BILI_VERSION=0.6.2
HERE=/opt/juno/reach

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/agent-reach.tar.gz" "https://github.com/Panniantong/Agent-Reach/archive/${REACH_COMMIT}.tar.gz"
echo "${REACH_SHA256}  ${work}/agent-reach.tar.gz" | sha256sum -c -

python3 -m venv "$HERE/venv"
"$HERE/venv/bin/pip" install --no-cache-dir --disable-pip-version-check --quiet -c "$HERE/constraints-agent-reach.txt" "$work/agent-reach.tar.gz"
# The package's own console script would skip the entry point below.
rm -f "$HERE/venv/bin/agent-reach"

python3 -m venv "$HERE/bili"
"$HERE/bili/bin/pip" install --no-cache-dir --disable-pip-version-check --quiet -c "$HERE/constraints-bili-cli.txt" "bilibili-cli==${BILI_VERSION}"
# bili stays off the PATH: the entry point prepends its directory for its own process only (agent-reach, REACH_PATH).
chmod 0755 "$HERE/agent-reach"
ln -sf "$HERE/agent-reach" /usr/local/bin/agent-reach
chmod -R a+rX "$HERE"

agent-reach channels > /dev/null
"$HERE/bili/bin/bili" --version
test ! -e /usr/local/bin/bili
rm -rf /root/.agent-reach
