#!/bin/sh
# Image build step for the login channels of the Web & video apps (BACKEND 10.18): OpenCLI (https://github.com/jackwener/opencli,
# Apache-2.0) at one pinned version, with its exact dependency tree from package-lock.json. Runs as root, once, at image build time
# (template_debian.py). Nothing here runs later.
#
# OpenCLI reads the agent's own Chromium through its DevTools port (OPENCLI_CDP_ENDPOINT, set by /usr/local/bin/agent-reach), so
# the Browser Bridge extension and its local daemon are not used. --ignore-scripts skips the package's postinstall (it writes shell
# completions into the home directory) and its fetch-adapters step; the CLI's update check is turned off by the entry point
# (CI=1 is the switch the package reads). It is not linked into /usr/local/bin: the entry point is the only way in.
set -eu

HERE=/opt/juno/reach/opencli
OPENCLI_VERSION=2.0.2

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$HERE"
npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error --cache "$work/npm-cache"
test "$(node -p 'JSON.parse(require("fs").readFileSync("node_modules/@jackwener/opencli/package.json", "utf8")).version')" = "$OPENCLI_VERSION"
# Keep only the commands the channels run (audit item 1): discovery registers manifest entries only, so the rest of the 1,200 site
# commands (and their adapters) are never registered. The entry point also refuses any other command.
node -e '
const fs = require("fs");
const file = "node_modules/@jackwener/opencli/cli-manifest.json";
const keep = new Set(["xiaohongshu/search", "xiaohongshu/note", "xiaohongshu/comments", "bilibili/subtitle"]);
const entries = JSON.parse(fs.readFileSync(file, "utf8"));
const kept = entries.filter((entry) => keep.has(entry.site + "/" + entry.name));
if (kept.length !== keep.size) throw new Error("manifest trim found " + kept.length + " of " + keep.size + " commands");
fs.writeFileSync(file, JSON.stringify(kept, null, 2) + "\n");
'
chmod -R a+rX "$HERE"
"$HERE/node_modules/.bin/opencli" --version > /dev/null
# Build check: the trimmed registry lists the four commands and none of the other sites (audit item 1).
"$HERE/node_modules/.bin/opencli" --help > "$work/help.txt" 2>&1 || true
grep -q "xiaohongshu" "$work/help.txt" && grep -q "bilibili" "$work/help.txt"
if grep -q "hackernews\|zhihu\|twitter" "$work/help.txt"; then echo "opencli --help still lists other sites" >&2; exit 1; fi
