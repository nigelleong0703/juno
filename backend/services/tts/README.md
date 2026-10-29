# Juno TTS sidecar

Kokoro-82M behind a loopback HTTP server. The backend (`packages/agentd/src/routes/speech.ts`) talks to it; clients never do.

- `POST /split {text}` returns `{parts: [text]}`: sentence-sized chunks in playback order (the first sentence alone). This is the only place text is split.
- `POST /speak {text, lang?: "en"|"zh", voice?}` speaks one part and returns `{text, durationMs, format, audio(base64)}`. Language is detected by script when `lang` is absent; mixed text is split into runs and each run uses its own pipeline.
- `GET /health` returns `{ok, encoder}`.
- Voices: English `af_heart` (repo `hexgrad/Kokoro-82M`), Chinese `zf_001` (repo `hexgrad/Kokoro-82M-v1.1-zh`). Both models load at start and are warmed up.
- Audio is AAC in an MP4 container (`m4a`), mono 24 kHz, 40 kbps (`TTS_BITRATE`), because watchOS AVPlayer plays it and WWDC20 recommends low-bitrate AAC. Encoder: `afconvert` on macOS, else `ffmpeg`, else WAV (`TTS_ENCODER=afconvert|ffmpeg|wav` forces one).

## Run

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
TTS_ESPEAK_LIBRARY=/opt/homebrew/lib/libespeak-ng.dylib TTS_ESPEAK_DATA=/opt/homebrew/share/espeak-ng-data .venv/bin/python server.py
```

Normally `pnpm dev:backend` starts it when `TTS_ENABLED=1` and `TTS_PYTHON` is set (see `.env.example`), and stops it with the other services. It is optional: if it exits on its own, the launcher restarts it with backoff and the api, agentd and computerd keep running (clients get 503 and speak on-device meanwhile). `TTS_PORT` defaults to 8792. The first start downloads the model weights from Hugging Face (about 313 MB each).

On macOS install `brew install espeak-ng` and set `TTS_ESPEAK_LIBRARY` / `TTS_ESPEAK_DATA`; the pip `espeakng-loader` wheel has a compiled-in data path that does not exist on your machine.

## Test

`python3 -m unittest` in this folder (sentence and language splitting only; needs no model).
