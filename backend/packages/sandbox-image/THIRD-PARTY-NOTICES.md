# Third-party notices (sandbox image)

## Pilot design adaptation

The `files/agent-browser` helper adapts the native-accessibility / native-input design of Pilot's page-control module (`lib/cdp.ts` in the Pilot checkout): snapshot via Chrome's native accessibility roles and names, click via scrolled-into-view box model plus `Input` mouse events, type via focus plus `Input.insertText` with exact text, and refusing to act when the target is not visible.

Nothing is imported from the Pilot checkout and no Pilot code runs in production here. The helper is a self-contained reimplementation (standard library plus `websocket-client`); only the ideas above shaped its design, and it deliberately omits Pilot's local-Chrome extension plumbing, chat daemon, on-page cursor overlay, and fixed visual sleeps.

Pilot is MIT licensed, (c) 2026 nigelleong0703:

```
MIT License

Copyright (c) 2026 nigelleong0703

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The upstream browser observation and scroll geometry functions in `agent_browser_jev_scripts.py`
are extracted verbatim from Ying-Kai-Liao/jev-browser commit
74592bac3fa78407ea1571b8233ead8540d531f3, MIT, Copyright (c) 2026 Ying-Kai Liao.
The complete license is distributed as `agent_browser_jev.LICENSE`.

## jev-browser MCP server (explicit opt-in only)

The image installs the full `jev-browser@0.2.1` package from the pinned npm tarball
(SHA256 `c2abbbb83d175a559f12001286ed518766232c21f2ccd0bd450a8f29a94687c0`)
under `/opt/juno/jev-browser/upstream` with the exact git HEAD `package-lock.json`
(`@modelcontextprotocol/sdk@1.30.0`, `playwright@1.63.0`, `zod@4.6.5`) via `npm ci`.
Source `src/`, `bin/` and skills stay unmodified. The production wrapper
`/opt/juno/jev-browser/juno-jev-mcp.mjs` only replaces browser launch with
`connectOverCDP` to the existing agent Chromium and relays native decisions
through the private `juno/jev` stdio channel. Upstream is MIT,
Copyright (c) 2026 Ying-Kai Liao.

## Vexa Google Meet join layer (adapted selectors and join sequence)

`files/agent-meet` adapts the Google Meet guest-join knowledge of Vexa
(https://github.com/vexa-ai/vexa, Apache License 2.0, commit
f1a62fbbdfd2c98cb162582d82c31fe8102acc89), from
`core/meetings/modules/join/src/googlemeet/`: `selectors.ts` (join button, name input,
mic/camera, waiting-room and rejection texts, leave controls), `join.ts` (step order: pinned
`?hl=` locale, lobby settle, mute mic/camera, name by click plus real keystrokes, substring
"Ask to join" button, real OS click), `admission.ts` (waiting vs. denied vs. visible-captcha
classification) and `humanized/` (real X11 pointer path and keystrokes instead of synthetic
input), plus `browser-args.ts` (pinned locale, `--disable-blink-features=AutomationControlled`).
The code is a Python reimplementation over CDP and xdotool; no Vexa source is copied verbatim.
The full license text is at https://www.apache.org/licenses/LICENSE-2.0 and the upstream
repository's LICENSE file applies to the adapted material.

The `audio_read` action of `files/agent-meet` also adapts Vexa's speaker detection
(`core/meetings/modules/join/src/googlemeet/gmeet-speakers.ts`, same commit): participant tiles
`[data-participant-id]`, the name in `span.notranslate` or the `data-self-name` marker, the local
tile excluded by that marker, the list of known speaking glow classes, and the finding that Meet's
remote audio lives in `audio`/`video` elements with an audio-track `srcObject`. The recorder is a
fresh JavaScript implementation; no Vexa source is copied verbatim.

## Agent Reach and bilibili-cli (Web & video apps, read-only platform content)

The image installs Agent Reach (https://github.com/Panniantong/Agent-Reach, commit
14c213405669414492bda0f8d52cc6531d062c45, version 1.6.0) unmodified into `/opt/juno/reach/venv`, from the
archive of that commit (SHA256 `fcd21410d817ce4829bb028824d54e5288dc036d21ad2076a3f9ef72f58ba539`), with the
dependency set pinned in `files/reach/constraints-agent-reach.txt` (`yt-dlp` is the Unlicense, public
domain). `files/reach/agent-reach` is our own entry point that passes only the read actions through.
Agent Reach is MIT licensed:

```
MIT License

Copyright (c) 2025 Agent Eyes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Bilibili channel calls `bilibili-cli` 0.6.2 (https://github.com/jackwener/bilibili-cli, Apache License
2.0, https://www.apache.org/licenses/LICENSE-2.0), installed unmodified into `/opt/juno/reach/bili` from
PyPI with the dependencies frozen in `files/reach/constraints-bili-cli.txt`. The how-to text served to
agents for these apps (`files/skills/_reach/`) adapts Agent Reach's own `SKILL_en.md` (MIT, same notice).
