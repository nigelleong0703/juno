# Sandbox image

Backend-owned source for the sandbox desktop image.

- Recipe: `template_debian.py` (with `build_debian.py`) defines the image. Assets live in `files/` (Dock helper, panel and desktop configs, launchers, browser helper).
- Edit: change the recipe or files here. File edits alone change only the source; they do not rebuild anything and do not touch running sandboxes.
- Image build: run `packages/sandbox-image/build.sh`. It syncs this directory to the configured self-hosted E2B host and builds the image there (host via `E2B_BUILD_SSH`, remote template directory via `E2B_BUILD_TEMPLATE_DIR`).
- Existing VMs: building a new image does not reset existing VMs. An older VM that predates an asset only gains it through an explicit, non-destructive asset migration; otherwise recreate the sandbox to pick up the new image.

## Computer-use inputs

Two independent channels drive the sandboxed desktop. They complement each other; neither replaces the other.

- CUA (screen/keyboard/mouse): `xdotool` + `scrot` are installed in the image and remain the channel for pixels, window management, and any app without a structured interface.
- CDP browser helper: `files/agent-browser` is packaged to `/usr/local/bin/agent-browser` by the recipe (with `chmod 0755`). It drives the image's Chromium over its loopback remote-debugging port (127.0.0.1:9222, see the `CHROMIUM_FLAGS` in `template_debian.py`) using Chrome's native accessibility tree and native input events. Its dependencies are `python3-websocket` (apt, provides `websocket-client`) and `python3-cryptography` (apt, secure input); the system `python3` runs it with no other packages. The platform runs it as ROOT (never as the agent's user) with its state in the root-only `/run/juno/browser`, and the CDP port of each screen is root-only in the firewall except for that screen's own agent user (`ownAgentCdpRules` in `isolation.ts`). Trade-off: the agent's own shell can drive its own browser over CDP, so the browser tools' approval gates rely on the agent's instructions, not on the port. Other agents' ports stay refused. The shell gets `JUNO_CDP_PORT` with its screen (9222 + display) for Agent Reach's OpenCLI channels.

Helper interface: `agent-browser --port <loopback CDP port> --request '<JSON>'`. Stdout carries one JSON document: `{ok: true, action, ...}` on success, `{ok: false, error}` with a nonzero exit on any failure. Actions are `tabs` (open tabs with short handles `t1`, `t2`), `new_tab` (optional http/s url), `navigate` (http/s only, truthful post-redirect `{url, title}`), `snapshot` (native AX nodes of the main frame, same-origin iframes and cross-origin iframes, with short refs `e12`; `follow: true` shows the tab the last action moved to), `click`, `type` (exact text, native events), `get_text` (bounded body text), `dialog` (read, or with `accept` true/false answer, the native dialog on a tab; `text` fills a prompt), `notices` (only what happened meanwhile), `point` (the control under a screen point, or without x/y the focused control, for the purchase gate), `bounds`, `attrs`, `secure_key` (the sandbox's public key for end-to-end encrypted secure input) and `fill_secret` (unseals a value a client encrypted to that key, masks the page, types it). `navigate`/`snapshot`/`get_text` take an optional `tab`; without one they use the tab last acted on. The ref map lives in `/tmp/agent-browser/<port>.json` (flock + atomic replace): each ref records its tab, frame, frame document (loader), node and, inside a cross-origin iframe, that iframe's target, so click/type take only a ref, can never act on another tab, and fail as stale once that frame's document changes. No caller-supplied script is evaluated. The request/response schemas live in the agent's computer port (`juno-agent` `ports/computer/browser.ts`); `packages/sandbox-adapters` invokes this helper.

Watcher (`agent_browser_watch.py`): every helper call first makes sure one long-lived watcher runs per CDP port (started detached, one per port via flock, alive = its unix socket answers; it exits with Chromium). It attaches to every tab (explicit `Target.attachToTarget`; browser-level auto-attach stalled `window.open` popups) and keeps the Page domain enabled, because Chromium reports a native dialog, and lets it be answered, only to sessions that had Page enabled when it opened. It accepts a plain `alert()` at once and queues its message; `confirm`/`prompt`/`beforeunload` stay open until the agent answers through `dialog` (the watcher answers over its socket). It records tabs that open (with their opener) and close. Agent-facing results carry `dialog`, `alerts`, `opened`, `closed`; a page blocked by a dialog never hangs a call (the CDP waits poll the watcher's record every 0.25 s).

Cross-origin iframes (`agent_browser_frames.py`): attached as flattened child sessions (`Target.setAutoAttach {flatten: true}` on the tab's session, nested ones too, up to 12); their nodes carry `site`, and input/bounds add the iframe's offset in its parent (DOM.getFrameOwner + box model).

Chromium prompts: `chromium-policies.json` (managed policy) denies notification/location/camera/mic/sensor/clipboard/USB/serial/HID/Bluetooth/font/window-management/file-system requests and turns off password saving, translate, address/card autofill, default-browser, sign-in and promotion prompts; popups are allowed (`DefaultPopupsSetting: 1`) so OAuth popups open. The launch flags add `--deny-permission-prompts` (screen boot in `sandbox-adapters` `chromiumFlags`, the Dock launcher and `chromium.desktop`).

Third-party attribution for the adapted design is in `THIRD-PARTY-NOTICES.md`.

Layout: the helper is split into modules beside the `agent-browser` CLI in `files/` (`agent_browser_cdp.py` transport and tabs, `agent_browser_refs.py` short refs, tab handles and the per-port state file, `agent_browser_nav.py` read actions, `agent_browser_input.py` write actions incl. `fill_secret`, `agent_browser_seal.py` the sandbox's X25519 key (`/etc/juno/secure-input/x25519.key`, 0600 in a 0700 root directory, created on first use) and the unsealing, `agent_browser_mask.py` the isolated-world masking script and the redaction of every result, `agent_browser_bounds.py` screen rects of controls and the control under a point, `agent_browser_frames.py` cross-origin iframes, `agent_browser_watch.py` the per-port watcher, `agent_browser_notices.py` dialogs and tab events for results). The recipe installs all of them to `/usr/local/bin`, where the CLI imports its siblings. `agent_browser_selftest.py` covers short refs, tab handles, tolerant ref spellings, closed-tab / re-snapshot / stale-document rejection, writable checks, the bounds-to-framebuffer mapping and its inverse, that a secret fill never echoes its value, the unsealing against the fixed vector `../public-contracts/src/secure-input-vector.json` (wrong request / field / ref / key / flipped byte rejected), masking and redaction, iframe refs, the watcher's dialog policy and popup notices, without needing a browser (real-Chromium flows: `scripts/verify/sandbox-cdp-image-live.mjs`) (needs `websocket-client` and `cryptography` importable: `uv run --with websocket-client --with cryptography python agent_browser_selftest.py`).

## Home start page and app launcher

Look: the Dock is a floating light pill (all corners rounded, 8px gap to the screen edge, 40px icons, blue-tinted running button) styled by `files/gtk.css` + `files/xfce4-panel.xml`; the transparent panel window and rounded corners need xfwm4 compositing (`use_compositing` in `files/xfwm4.xml`, ARGB panel window). `agent-screen-dock` also starts `xfdesktop` per display with `files/xfce4-desktop-plain.xml`, which paints `files/wallpaper.png` (a quiet light gradient from the VISUAL.md tokens, regenerate with `gen_wallpaper.py`).

Chromium opens `/usr/local/share/agent-home/index.html` (title "Home", clock, search/URL box, app grid; system fonts and the image's own Papirus icons, no network). App tiles link to `juno-app://<name>`. `juno-app.desktop` registers `/usr/local/bin/juno-app-open` as that scheme's handler (`mimeapps.list`); the script runs only the fixed names `terminal`, `editor`, `writer`, `calc`, `impress` (the same commands as the Dock) and rejects everything else, and no part of the URL reaches a command. Chromium passes its environment to `xdg-open`, so the app opens on the same display. `chromium-policies.json` sets `AutoLaunchProtocolsFromOrigins` for `juno-app` from `file://` (no confirm prompt) and `CommandLineFlagSecurityWarningsEnabled: false` (hides the `--no-sandbox` infobar). `fonts-noto-cjk` renders Chinese/Japanese/Korean text.

## Web & video apps: Agent Reach

`files/reach/install-reach.sh` (the last `run_cmd` of `template_debian.py`) installs [Agent Reach](https://github.com/Panniantong/Agent-Reach) (MIT) at one pinned commit, from that commit's archive checked against its SHA-256 (not from PyPI, where another project holds the name), into `/opt/juno/reach/venv`, and `bilibili-cli` 0.6.2 into `/opt/juno/reach/bili` (`/usr/local/bin/bili`). Dependencies are pinned in `files/reach/constraints-*.txt`. cloakbrowser and opencli are not installed. `/usr/local/bin/agent-reach` is `files/reach/agent-reach`, our entry point: it passes through only `channels`, `read <url>` and the github, youtube, bilibili and v2ex actions, so nothing installs, updates, logs in or configures at run time. To bump Agent Reach: change the commit and SHA-256 in the script, re-freeze the constraints from a clean install, run the in-container checks (`agent-reach channels`, one call per channel), rebuild. The skills agents read for these apps are not part of the image: `files/skills/_reach/` is read by agentd when it seeds the app rows (the `_` keeps the platform skill seed away from it).

## Computer link daemon

`/usr/local/bin/juno-link` is the image's start command (`set_start_cmd` in `template_debian.py`; the local Dockerfile's `CMD`). It runs as root, dials OUT to computerd (`JUNO_LINK_URL`, `JUNO_LINK_ID`, `JUNO_LINK_TOKEN` in the environment, or the root-only `/etc/juno/link.json` when the platform cannot inject one) and serves everything the platform does inside the computer: commands as root, files, and byte streams to the VNC, websockify and Spaces gateway ports. The computer opens no inbound port. The binary is built from `packages/juno-link` with `bun build --compile` (`packages/juno-link/build.sh`, called by `build.sh` and `local/build.sh`), written to `files/juno-link` (not committed) and shipped by `prepare_assets.py`.

## Spaces runtime

`files/spaces/install-runtime.sh` (run by the last `run_cmd` of `template_debian.py`) installs the pinned official Bun binary (version and per-arch SHA-256 inside the script) to `/usr/local/bin/bun` and fills `/opt/juno/bun-cache` from the app template's committed `bun.lock`, so `bun install --frozen-lockfile --offline` works without network. `files/skills/spaces/` is the platform skill (`SKILL.md`, `spaces_tool.py`, templates `app` and `static`); `files/spaces/gateway.mjs` is the root-run gateway on port 7090 that computerd starts at runtime. To change a template's dependencies edit its `package.json`, run `bun install` in a throwaway container and commit the new `bun.lock` (and a `migrations/` made by `drizzle-kit generate`). The image gains `unzip` for the Bun archive.

`files/storage/install-juicefs.sh` (the run_cmd after it) installs the pinned official JuiceFS client (version and per-arch SHA-256 inside the script) to `/usr/local/bin/juicefs`; the template adds `fuse3`. Nothing mounts at build time: computerd mounts `/juno` and `/workspace` as root when the computer is created (BACKEND 7.10), and the sandbox needs `/dev/fuse`.

## Verification

- The lead-owned live pin runs this helper against an isolated real headless Chrome on a loopback port (redirect/navigation/title, AX refs, native click/type/text, stale refs, invalid URL). It never touches a user browser, a sandbox, or the network image build.

## Asset packaging (single bundle)

All installable assets in `files/` are bundled by `prepare_assets.py` into one deterministic archive, `files/sandbox-assets.tar`: one member per image destination path (leading slash stripped, sorted for determinism), with bytes and permission bits taken from the source files. Offline build:

```sh
python3 prepare_assets.py --output /tmp/any/sandbox-assets.tar
```

The recipe copies that single archive and installs everything in one RUN (`tar -xpf ... -C /` to the original paths, then the desktop-database, Dock-seed, permission and ownership fixups, and removal of the archive). One COPY plus one RUN replaces the old per-asset COPY series: each COPY used to snapshot another intermediate VM on the build host, which exhausted its disk. `build_debian.py` generates the archive immediately before `Template.build` and deletes it afterwards even on failure; never commit the tar (it is gitignored).

## Build free-space gate

`build.sh` probes the build host first with a single SSH command (`df` on the remote template directory) and refuses the build before uploading anything unless at least `MIN_BUILD_FREE_GIB` GiB are free (default 40, floored from `df -Pk` kibibytes so 39.9GiB does not satisfy 40). Override with `MIN_BUILD_FREE_GIB=<GiB>`. A refusal uploads nothing, prints no credentials, and performs no remote cleanup: free disk space on the build host and retry.

## Local Docker image (Docker Desktop on Mac)

Same Debian 13 desktop as the E2B template, runnable in Docker Desktop's Linux VM (linux/arm64) with no second physical Linux machine. No recipe drift: local/generate_dockerfile.py translates the canonical template_debian.py chain calls (fail-closed on unknown operations) and the prepare_assets.py ASSET_MAP into a Dockerfile on stdout, and local/build.sh builds it in a disposable context.

Build (the lead runs the actual image build during integration):

    bash packages/sandbox-image/local/build.sh        # tags juno-desktop:local

The script prints the generated Dockerfile plus the canonical sandbox-assets.tar into a temp dir and runs docker build there; the context is removed afterwards. The image CMD idles (sleep infinity) so docker exec sessions work; no volumes and no Mac filesystem mounts. Parity beyond literals: python3 packages/sandbox-image/local/parity_test.py requires every canonical package and asset in the generated output and proves the generator follows synthetic recipe edits instead of matching hard-coded strings.
