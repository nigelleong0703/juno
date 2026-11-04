"""Private bridge from one LiveKit dispatch to the existing owner-scoped Juno conversation.

A reply is read from one push stream per utterance (GET /v1/conversations/{id}/runs/{runId}/stream), never polled: live text
deltas of the model attempts, a reset when an attempt restarts, the durable reply item, and the run's end event all arrive on it.
The stream is opened before the run is admitted, so no frame of the run can be missed. A dropped stream reconnects once from the
last durable frame it saw; the replay then carries the reply item itself.
"""
import asyncio
import ipaddress
import json
import logging
import re
import time
import uuid
from urllib.parse import quote, urlsplit

import aiohttp


log = logging.getLogger("juno.voice")


class VoiceBridgeError(Exception):
    """The conversation could not safely produce a reply for this utterance."""


# Speech boundaries: a sentence ends at these; a long clause is also cut at a comma once it is this long.
SENTENCE_END = frozenset("。！？.!?\n")
CLAUSE_BREAK = frozenset("，,")
CLAUSE_MIN_CHARS = 40
# Whitespace and markdown punctuation are not spoken, so they do not take part in comparing spoken text with the reply item.
_NOT_SPOKEN = re.compile(r"[\s*_`#>\[\]()!~|\\-]")
# The wire run segment ends with one of these; a waiting run ends with RUN_FINISHED carrying an interrupt outcome.
RUN_END_EVENTS = frozenset(("RUN_FINISHED", "RUN_ERROR"))
# A durable cursor is read this far back, so a replay on reconnect also covers events that committed late.
RECONNECT_MARGIN = 200


def _squash(text):
    return _NOT_SPOKEN.sub("", text)


def _after(markdown, count):
    """The part of `markdown` after its first `count` spoken characters."""
    seen = 0
    for index, character in enumerate(markdown):
        if _NOT_SPOKEN.match(character):
            continue
        seen += 1
        if seen == count:
            return markdown[index + 1:]
    return ""


class SpeechChunker:
    """Cuts streamed text into speakable pieces at sentence ends, and at a comma once the clause is long enough."""

    def __init__(self):
        self._buffer = ""

    def feed(self, text):
        pieces = []
        for character in text:
            self._buffer += character
            if character in SENTENCE_END or (character in CLAUSE_BREAK and len(self._buffer.strip()) >= CLAUSE_MIN_CHARS):
                piece = self._buffer.strip()
                self._buffer = ""
                if piece:
                    pieces.append(piece)
        return pieces

    def flush(self):
        piece = self._buffer.strip()
        self._buffer = ""
        return [piece] if piece else []

    def clear(self):
        """Drop unspoken text: it belonged to an attempt that was reset, or to a turn that called tools."""
        self._buffer = ""


def _turn_of(attempt):
    """`model:3`, `model:3:retry:1` and `model:3:fallback:1` are attempts of the same turn (model:3)."""
    return ":".join(str(attempt).split(":")[:2])


class _Reply:
    """Turns the run's frames into speakable text, once.

    `spoken` is the squashed text already yielded for the current model turn (what a reply item of that turn is compared with);
    `replay` is what an earlier attempt of the same turn already said, which a retry streaming the same words must not say again.
    `delivered` is the squashed text of every reply item already spoken in this run.
    """

    def __init__(self, run_id, agent_id):
        self.run_id = run_id
        self.agent_id = agent_id
        self.spoken = ""
        self.replay = ""
        self.yielded = False
        self.ended = False
        self.chunker = SpeechChunker()
        self._turn = None
        self._seen_items = set()
        self._delivered = set()

    def apply(self, name, data):
        if name == "run.text.reset":
            self._new_attempt(data.get("attempt"))
            return []
        if name == "run.text.delta":
            return self._take(self.chunker.feed(data.get("text", "")))
        if name == "run.text.end":
            # A turn that calls tools is not the reply. Its unspoken tail is spoken from its own item (a voice run posts every
            # pre-tool line), so nothing is flushed here.
            if data.get("toolCalls", 0) > 0:
                self.chunker.clear()
            return []
        if name == "item.added":
            return self._reply_item(data.get("item"))
        if name in RUN_END_EVENTS:
            self.ended = True
        return []

    def _new_attempt(self, attempt):
        self.chunker.clear()
        turn = _turn_of(attempt)
        # A retry of the same turn repeats words a failed attempt may already have said; a new turn starts clean.
        self.replay = self.spoken if turn == self._turn else ""
        self.spoken = ""
        self._turn = turn

    def _reply_item(self, item):
        # Every agent_message of this run is a reply to this utterance: the run id is ours (send_message items carry it too).
        if not isinstance(item, dict) or item.get("type") != "agent_message" or item.get("agentId") != self.agent_id or item.get("runId") != self.run_id:
            return []
        markdown = item.get("markdown")
        item_key = item.get("id")
        if not isinstance(markdown, str) or not markdown.strip():
            return []
        if not isinstance(item_key, str) or item_key in self._seen_items:
            return []
        self._seen_items.add(item_key)
        squashed = _squash(markdown)
        # The durable item is the source of truth for its own turn: speak only what the stream has not already spoken. An item
        # whose text was already delivered in this run is the same words again (a send_message the final reply repeats).
        if squashed in self._delivered or squashed in self.spoken:
            remainder = ""
        elif self.spoken and squashed.startswith(self.spoken):
            remainder = _after(markdown, len(self.spoken))
        else:
            remainder = markdown
        self._delivered.add(squashed)
        self.chunker.clear()
        self.spoken = ""
        self.replay = ""
        if not remainder.strip():
            return []
        return self._take(self.chunker.feed(remainder) + self.chunker.flush())

    def _take(self, pieces):
        out = []
        for piece in pieces:
            squashed = _squash(piece)
            if self.replay and self.replay.startswith(squashed):
                self.replay = self.replay[len(squashed):]
            else:
                self.replay = ""
                out.append(piece)
                self.yielded = True
            self.spoken += squashed
        return out


class _Frame:
    __slots__ = ("id", "name", "data")

    def __init__(self, identifier, name, data):
        self.id = identifier
        self.name = name
        self.data = data


async def _sse_frames(content):
    identifier = None
    name = None
    data_lines = []
    async for raw in content:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if name is not None or data_lines:
                yield _Frame(identifier, name or "message", json.loads("\n".join(data_lines)) if data_lines else {})
            identifier = None
            name = None
            data_lines = []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            name = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
        elif line.startswith("id:"):
            value = line[len("id:"):].strip()
            identifier = int(value) if value.isdigit() else None


class _RunStream:
    """One open run stream. `last_id` is the last durable frame seen, the cursor a reconnect resumes from."""

    def __init__(self, response, deadline, last_id):
        self.response = response
        self.deadline = deadline
        self.last_id = last_id
        self._frames = _sse_frames(response.content)

    async def next_frame(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise VoiceBridgeError("Juno did not return an attributable reply in time")
        try:
            frame = await asyncio.wait_for(self._frames.__anext__(), remaining)
        except StopAsyncIteration:
            return None
        except asyncio.TimeoutError as error:
            raise VoiceBridgeError("Juno did not return an attributable reply in time") from error
        if frame.id is not None:
            self.last_id = max(self.last_id, frame.id)
        return frame

    def close(self):
        self.response.close()


def local_agentd_url(url: str) -> str:
    parsed = urlsplit(url)
    try:
        local = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        local = False
    if not local or parsed.scheme != "http" or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("JUNO_AGENTD_URL must be a loopback HTTP origin")
    return url.rstrip("/")


class JunoBridge:
    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str, owner_id: str, conversation_id: str, agent_id: str):
        self.session = session
        self.base_url = local_agentd_url(base_url)
        if not all((token, owner_id, conversation_id, agent_id)):
            raise ValueError("Missing trusted voice dispatch identity or service credential")
        self.headers = {"Authorization": f"Bearer {token}", "x-owner-id": owner_id}
        self.conversation_id = conversation_id
        self.agent_id = agent_id
        self.path = f"/v1/conversations/{quote(conversation_id, safe='')}"

    async def _request(self, method: str, path: str, **kwargs):
        async with self.session.request(method, self.base_url + path, headers=self.headers, allow_redirects=False, **kwargs) as response:
            if response.status < 200 or response.status >= 300:
                raise VoiceBridgeError("Juno service rejected the request")
            return await response.json()

    async def _best_effort(self, route: str, what: str):
        try:
            await self._request("POST", self.path + route)
        except Exception:
            log.warning("voice %s failed", what, exc_info=True)

    async def warm(self):
        """Ask Juno to prime the model's prompt cache for this conversation. Best effort: a failure only means the first turn is not warmed."""
        await self._best_effort("/voice/warm", "warm-up")

    async def prepare(self):
        """Ask Juno to start what the next run needs that does not depend on the words (called at the start of speech). Best effort."""
        await self._best_effort("/voice/prepare", "prepare")

    async def verify(self):
        conversation = await self._request("GET", self.path)
        if conversation.get("kind") != "direct" or conversation.get("agentIds") != [self.agent_id]:
            raise VoiceBridgeError("Voice dispatch no longer matches the conversation")

    async def _open_run_stream(self, run_id: str, after: int, deadline: float) -> _RunStream:
        response = await self.session.get(
            self.base_url + self.path + "/runs/" + quote(run_id, safe="") + "/stream",
            params={"after": str(after)}, headers=self.headers, allow_redirects=False,
            # The session's total timeout is for short calls; a reply stream lives as long as the run, bounded by the turn deadline.
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=max(1.0, deadline - time.monotonic())),
        )
        if response.status != 200:
            response.close()
            raise VoiceBridgeError("Juno service rejected the reply stream")
        stream = _RunStream(response, deadline, after)
        frame = await stream.next_frame()
        if frame is None or frame.name != "ready":
            stream.close()
            raise VoiceBridgeError("Juno reply stream did not open")
        return stream

    async def answer(self, text: str, *, timeout: float = 90.0):
        text = text.strip()
        if not text:
            raise VoiceBridgeError("Empty utterance")
        item_id = "voice-" + uuid.uuid4().hex
        # The run id is Juno's to name: the one sent is only a suggestion, and the id the service returns is the run to follow.
        body = {"threadId": self.conversation_id, "runId": str(uuid.uuid4()), "state": {},
                "messages": [{"id": item_id, "role": "user", "content": text}], "tools": [], "context": []}
        deadline = time.monotonic() + timeout
        cursor = (await self._request("GET", "/v1/events/cursor")).get("after")
        if not isinstance(cursor, int) or cursor < 0:
            raise VoiceBridgeError("Juno service returned an invalid event cursor")
        # Never retry an ambiguous admission: it may already be running. Cancelling playback only closes the stream.
        admitted = await self._request("POST", self.path + "/voice/runs", json=body)
        run_id = admitted.get("runId") if isinstance(admitted, dict) else None
        if not isinstance(run_id, str) or not run_id:
            raise VoiceBridgeError("Juno did not name the run for this utterance")
        reply = _Reply(run_id, self.agent_id)
        # Durable frames replay from the cursor taken before admission and live text replays from the hub's buffer of the run, so a
        # stream opened after the run started loses nothing. A steered utterance is admitted into the busy run: its id is followed.
        stream = await self._open_run_stream(run_id, cursor, deadline)
        try:
            reconnected = False
            while not reply.ended:
                try:
                    frame = await stream.next_frame()
                    if frame is not None:
                        for piece in reply.apply(frame.name, frame.data):
                            yield piece
                        continue
                except aiohttp.ClientError:
                    frame = None
                if frame is None and reply.ended:
                    break
                # The stream dropped before the run ended: one reconnect, replaying from a margin before the last durable frame.
                if reconnected:
                    raise VoiceBridgeError("Juno reply stream was lost")
                reconnected = True
                resume = max(0, stream.last_id - RECONNECT_MARGIN)
                stream.close()
                stream = await self._open_run_stream(run_id, resume, deadline)
        finally:
            stream.close()
        if not reply.yielded:
            raise VoiceBridgeError("Juno did not return an attributable reply in time")
