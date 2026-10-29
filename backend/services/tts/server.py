"""Juno TTS sidecar: Kokoro-82M behind a loopback HTTP server.

POST /split {text} -> {parts: [text]}  sentence-sized chunks in playback order (the first sentence alone)
POST /speak {text, lang?: 'en'|'zh', voice?} -> {text, durationMs, format, audio(base64)}  one part as audio
GET  /health -> {ok: true, encoder}

The backend splits first, returns the part urls at once, then asks for the parts one by one so playback starts after the
first. Both pipelines are loaded once at start; synthesis is serialised (one model, one GPU/CPU).
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from splitting import language_runs, split_parts

SAMPLE_RATE = 24000
BITRATE = int(os.environ.get("TTS_BITRATE", "40000"))
DEFAULT_VOICES = {"en": "af_heart", "zh": "zf_001"}
ZH_REPO = "hexgrad/Kokoro-82M-v1.1-zh"
MAX_CHARS = 4000


def configure_espeak() -> None:
    """The pip espeakng-loader wheel has a broken compiled-in data path; use a system espeak-ng when one is configured."""
    library = os.environ.get("TTS_ESPEAK_LIBRARY")
    data = os.environ.get("TTS_ESPEAK_DATA")
    if not library or not data:
        return
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    EspeakWrapper.set_library(library)
    EspeakWrapper.set_data_path(data)
    espeakng_loader.get_library_path = lambda: library
    espeakng_loader.get_data_path = lambda: data


def pick_encoder() -> str:
    """afconvert (macOS) first, then ffmpeg, else plain WAV."""
    wanted = os.environ.get("TTS_ENCODER")
    for name in ([wanted] if wanted else ["afconvert", "ffmpeg"]):
        if name == "wav":
            break
        if shutil.which(name):
            return name
    return "wav"


def encode(samples: np.ndarray, encoder: str) -> tuple[bytes, str]:
    """Mono 24 kHz float samples -> (bytes, format). AAC in an MP4 container ('m4a') unless no encoder exists."""
    import soundfile as sf

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "in.wav")
        sf.write(wav, samples, SAMPLE_RATE, subtype="PCM_16")
        if encoder == "wav":
            with open(wav, "rb") as handle:
                return handle.read(), "wav"
        out = os.path.join(tmp, "out.m4a")
        if encoder == "afconvert":
            command = ["afconvert", wav, out, "-f", "m4af", "-d", f"aac@{SAMPLE_RATE}", "-c", "1", "-b", str(BITRATE)]
        else:
            command = ["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", str(BITRATE), "-ar", str(SAMPLE_RATE), "-ac", "1", out]
        subprocess.run(command, check=True, capture_output=True, timeout=30)
        with open(out, "rb") as handle:
            return handle.read(), "m4a"


class Speaker:
    def __init__(self) -> None:
        configure_espeak()
        from kokoro import KPipeline

        self.encoder = pick_encoder()
        self.pipelines = {"en": KPipeline(lang_code="a"), "zh": KPipeline(lang_code="z", repo_id=ZH_REPO)}
        self.lock = threading.Lock()
        self.synthesize("Ready.", "en")  # warm-up
        self.synthesize("准备好了。", "zh")

    def voice_for(self, lang: str, voice: str | None) -> str:
        # A requested voice applies only to runs in its own language (a*/b* English, z* Chinese).
        if voice and (voice[0] == "z") == (lang == "zh"):
            return voice
        return DEFAULT_VOICES[lang]

    def synthesize(self, text: str, lang: str, voice: str | None = None) -> np.ndarray:
        chunks = []
        with self.lock:
            for _, _, audio in self.pipelines[lang](text, voice=self.voice_for(lang, voice)):
                chunks.append(np.asarray(audio, dtype=np.float32))
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

    def speak(self, text: str, lang: str | None, voice: str | None) -> dict:
        """One part (a chunk from /split) as audio."""
        runs = [(lang, text)] if lang in ("en", "zh") else language_runs(text)
        samples = [self.synthesize(chunk, run_lang, voice) for run_lang, chunk in runs if chunk.strip()]
        if not samples:
            raise ValueError("nothing to speak")
        audio = np.concatenate(samples)
        data, fmt = encode(audio, self.encoder)
        return {"text": text, "durationMs": round(len(audio) / SAMPLE_RATE * 1000), "format": fmt, "audio": base64.b64encode(data).decode()}


def make_handler(speaker: Speaker):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, body: dict) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:
            if self.path == "/health":
                self.reply(200, {"ok": True, "encoder": speaker.encoder})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path not in ("/speak", "/split"):
                self.reply(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
                text = body.get("text")
                lang = body.get("lang")
                voice = body.get("voice")
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_CHARS:
                    self.reply(400, {"error": f"text must be 1-{MAX_CHARS} characters"})
                    return
                if lang not in (None, "en", "zh"):
                    self.reply(400, {"error": "lang must be en or zh"})
                    return
                if voice is not None and not isinstance(voice, str):
                    self.reply(400, {"error": "voice must be a string"})
                    return
                if self.path == "/split":
                    # Parts with nothing to say (only punctuation) are dropped.
                    self.reply(200, {"parts": [part for part in split_parts(text) if language_runs(part)]})
                else:
                    self.reply(200, speaker.speak(text, lang, voice))
            except ValueError as error:  # includes invalid JSON
                self.reply(400, {"error": str(error)})
            except Exception as error:  # keep the server alive; the backend maps this to a 502
                self.reply(500, {"error": str(error)})

        def log_message(self, format: str, *args) -> None:
            pass

    return Handler


def main() -> None:
    port = int(os.environ.get("TTS_PORT", "8792"))
    speaker = Speaker()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(speaker))
    print(f"[tts] ready on 127.0.0.1:{port} (encoder {speaker.encoder})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
