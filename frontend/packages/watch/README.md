# Juno Watch

A standalone Apple Watch app: it talks to the backend directly (Wi-Fi or cellular), no iPhone needed while it runs.
It does not import the iPhone app's code; it has its own small client (`JunoWatch/Client.swift`).

- **Pairing** — the watch shows an 8-character code (Better Auth device authorization, `client_id` `juno-watch`).
  On the iPhone: Settings > Add Apple Watch, type the code, Allow. The watch then holds its own session in its keychain.
- **Companion** — no text: the agent's animated character (same art as the iPhone app, from the most recently active
  direct chat) and one mic button. Tap, speak, tap again: the audio is transcribed (`POST /v1/transcriptions`) and sent
  to the chat; the reply is spoken aloud with a haptic. The glow shows the mood (listening, thinking, speaking).
  Press and hold the character to sign out. The atlases are HEIC because watchOS cannot decode WebP:
  `scripts/make-characters.sh` regenerates `Characters/` from the iPhone art.
- **Server** — `JUNO_SERVER_URL` in `Config/Watch.xcconfig` (override in the gitignored `Config/Watch.local.xcconfig`).
  The simulator reaches the Mac at `127.0.0.1`; a real watch needs the Mac's LAN / Tailscale address, or the https server.

```sh
cd packages/watch && xcodegen generate
xcodebuild -project JunoWatch.xcodeproj -scheme JunoWatch -destination 'generic/platform=watchOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

Not built yet: push for messages that arrive while the app is closed, a complication, a first-chat
screen for accounts that have no chat.
