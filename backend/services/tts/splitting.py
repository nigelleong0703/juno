"""Text handling for the TTS sidecar: language runs and sentence-sized parts. No heavy imports, so it tests fast."""
import re

_CJK = re.compile(r"[㐀-䶿一-鿿　-〿＀-￯]")
_LATIN = re.compile(r"[A-Za-z]")
# A sentence ends after . ! ? (needs a following space or the end) or after the CJK full stops, with closing quotes kept.
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*(?=\s|$)|(?<=[。！？；])[\"')\]」』”’）]*|\n+")

FIRST_PART_MIN = 12  # a tiny opening sentence ("Sure.") is merged forward so the first audio is worth starting
PART_TARGET = 160  # later sentences are packed up to about this many characters per part


def detect_lang(text: str) -> str:
    """'zh' when the text has any CJK character, otherwise 'en'."""
    return "zh" if _CJK.search(text) else "en"


def language_runs(text: str) -> list[tuple[str, str]]:
    """Split into consecutive (lang, text) runs. Digits, spaces and punctuation stay with the run they follow."""
    runs: list[tuple[str, str]] = []
    for char in text:
        lang = "zh" if _CJK.match(char) else "en" if _LATIN.match(char) else None
        if lang is None:
            if runs:
                runs[-1] = (runs[-1][0], runs[-1][1] + char)
            else:
                runs.append(("", char))
            continue
        if runs and runs[-1][0] == "":
            runs[-1] = (lang, runs[-1][1] + char)
        elif runs and runs[-1][0] == lang:
            runs[-1] = (lang, runs[-1][1] + char)
        else:
            runs.append((lang, char))
    return [(lang or "en", chunk) for lang, chunk in runs if chunk.strip()]


def sentences(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(text):
        piece = text[start : match.end()].strip()
        if piece:
            out.append(piece)
        start = match.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def split_parts(text: str) -> list[str]:
    """Parts to speak in order: the first sentence alone (so playback starts early), the rest packed into longer parts."""
    pieces = sentences(text)
    parts: list[str] = []
    current = ""
    for piece in pieces:
        current = f"{current} {piece}" if current and _needs_space(current) else current + piece
        if len(current) >= (PART_TARGET if parts else FIRST_PART_MIN):
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    return parts


def _needs_space(left: str) -> bool:
    return not _CJK.search(left[-1])
