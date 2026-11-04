# Juno Watch

A standalone Apple Watch app: it talks to the backend directly (Wi-Fi or cellular), no iPhone needed while it runs.
It does not import the iPhone app's code; it has its own small client (`JunoWatch/Client.swift`).

- **Pairing** — the watch shows an 8-character code (Better Auth device authorization, `client_id` `juno-watch`).
  On the iPhone: Settings > Add Apple Watch, type the code, Allow. The watch then holds its own session in its keychain.
- **Companion** — one full-screen page per agent (`GET /v1/agents`): the agent's animated character (same art as the
  iPhone app) and its name. Swipe left/right to choose who you talk to; the last page is remembered. Press and hold the
  character to sign out. The atlases are HEIC because watchOS cannot decode WebP:
  `scripts/make-characters.sh` regenerates `Characters/` from the iPhone art. The glow shows the mood (listening,
  thinking, speaking).
- **Talk** (`JunoWatch/Voice.swift`) — the character is the talk button, like Siri. Tap it: the mic opens (AVAudioEngine,
  16 kHz mono) and Silero VAD runs on every 32 ms frame. After 224 ms of silence that follows speech, Smart Turn v3.2 judges
  the last 8 s: p >= 0.5 ends the turn, otherwise it keeps listening and asks again at the next pause (a Smart Turn call that
  takes more than 400 ms counts as "not done yet"). Three seconds of continuous silence also ends it; no speech within 8 s
  gives up quietly; 30 s is the hard cap; tapping again ends it early. A light haptic marks the end and the mic is released
  (audio session deactivated) at once. The audio is encoded as AAC m4a and sent to `POST /v1/transcriptions` (Groq Whisper on
  the server), and the text goes to that agent's direct chat (`POST /v1/conversations/:id/messages`; the chat is created with
  `POST /v1/conversations` if the agent has none). watchOS has no Speech framework and the system dictation sheet is not used.
- **Models** — both CoreML models load in the background when the app launches (`VoiceModels.loading`), never on the first
  tap; the first load after an install can take 15–50 s, a warm one ~0.1 s. A tap before they are ready shows "Getting
  ready…" and starts listening as soon as they are (tap again to cancel). They are bundled from `Models/`:
  `scripts/fetch-models.sh` downloads them (not committed) before the first build. Silero is ~1 ms per frame, Smart Turn
  70–100 ms per call. Licenses ship in the bundle (`Models/LICENSE-silero.txt`, MIT; `Models/LICENSE-smart-turn.txt`, BSD-2-Clause).
  - Silero VAD v6.2.1, MIT (https://huggingface.co/aufklarer/Silero-VAD-v6.2.1-CoreML, from snakers4/silero-vad)
  - Smart Turn v3.2, BSD-2-Clause, (c) Daily (https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML, from pipecat-ai/smart-turn)
- **Speak** (`JunoWatch/Speaker.swift`) — a reply (markdown, links and emoji stripped, at most 2000 characters) goes to
  `POST /v1/speech`, which returns sentence-sized audio parts (Kokoro). Each part is downloaded with the app's own
  authenticated client (relative urls, same bearer token) into a temp file, all downloads start at once, and the files are
  played in order with `AVAudioPlayer` as they land (part 1 starts as soon as it is there, the next is usually ready when it ends;
  files are deleted after playing); a part that fails (502 / 504) is skipped. On a 503
  `SPEECH_UNAVAILABLE`, any network error, or no parts, the watch speaks on the device instead: one `AVSpeechUtterance` per
  sentence with the best installed voice for the language (premium, then enhanced, else default). Tapping while it speaks
  stops it. The audio session is `.record` while listening and `.playback` while speaking. Decisions and fallbacks are logged
  with `Logger` (subsystem `io.github.nigelleong0703.juno.watch`, category `voice`).
- **Server** — fixed: `WatchServer.url` in `JunoWatch/Client.swift` is read from the `JUNO_SERVER_URL` build setting (`Config/Juno.xcconfig`, placeholder `https://juno.example.com`). Set yours in `Config/Server.local.xcconfig` (gitignored): `JUNO_SERVER_URL = https:/$()/your.server`. There is no in-app setting.

```sh
cd packages/watch && scripts/fetch-models.sh && xcodegen generate
xcodebuild -project JunoWatch.xcodeproj -scheme JunoWatch -destination 'generic/platform=watchOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

Not built yet: push for messages that arrive while the app is closed, a complication, a first-chat
screen for accounts that have no chat.
