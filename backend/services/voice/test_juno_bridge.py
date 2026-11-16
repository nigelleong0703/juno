import asyncio
import json
import uuid
import unittest

import aiohttp
from aiohttp import web
from livekit.agents import AgentSession, FlushSentinel, llm
from livekit.agents.voice.events import UserStateChangedEvent
from worker import JunoAgent, prepare_on_speech
from juno_bridge import JunoBridge, SpeechChunker, VoiceBridgeError, local_agentd_url

OWNER = "owner"
CONVERSATION = "conversation"
AGENT = "agent"


class FakeJuno:
    """agentd's internal /v1 surface for one conversation, served over real HTTP. Frames are scripted per stream connection."""

    def __init__(self):
        self.posted = asyncio.Event()
        self.heard = asyncio.Event()
        self.run_id = None
        self.user_item_id = None
        self.post_count = 0
        self.streams = []        # one queue per stream connection
        self.stream_after = []   # the `after` cursor each connection asked for
        self.closed_by_client = 0
        self._durable_id = 0

    def app(self):
        app = web.Application()
        app.router.add_get(f"/v1/conversations/{CONVERSATION}", self._conversation)
        app.router.add_get("/v1/events/cursor", self._cursor)
        app.router.add_post(f"/v1/conversations/{CONVERSATION}/voice/runs", self._admit)
        app.router.add_post(f"/v1/conversations/{CONVERSATION}/voice/warm", self._warm)
        app.router.add_post(f"/v1/conversations/{CONVERSATION}/voice/prepare", self._prepare)
        app.router.add_get(f"/v1/conversations/{CONVERSATION}/runs/{{runId}}/stream", self._stream)
        return app

    async def _conversation(self, request):
        self.check_identity(request)
        return web.json_response({"kind": "direct", "agentIds": [AGENT]})

    async def _cursor(self, request):
        self.check_identity(request)
        return web.json_response({"after": 0})

    async def _warm(self, request):
        self.check_identity(request)
        self.warm_count = getattr(self, "warm_count", 0) + 1
        return web.json_response({"status": "warmed"})

    async def _prepare(self, request):
        self.check_identity(request)
        self.prepare_count = getattr(self, "prepare_count", 0) + 1
        return web.json_response({"status": "prepared"})

    async def _admit(self, request):
        self.check_identity(request)
        body = await request.json()
        # The service names the run itself and ignores the id a client suggests, as the real Session does.
        self.client_run_id = body["runId"]
        self.run_id = "run_" + uuid.uuid4().hex
        self.user_item_id = body["messages"][0]["id"]
        self.post_count += 1
        self.posted.set()
        return web.json_response({"item": {"id": self.user_item_id}, "runId": self.run_id}, status=202)

    async def _stream(self, request):
        self.check_identity(request)
        if request.match_info["runId"] != self.run_id:
            return web.json_response({"error": "unknown run"}, status=200)  # an unknown run's stream never carries a frame
        self.stream_after.append(int(request.query["after"]))
        queue = asyncio.Queue()
        self.streams.append(queue)
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b"event: ready\ndata: {}\n\n")
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), 0.02)
                except asyncio.TimeoutError:
                    if request.transport is None or request.transport.is_closing():
                        self.closed_by_client += 1
                        return response
                    continue
                if frame is None:
                    break
                await response.write(frame)
        except (ConnectionResetError, asyncio.CancelledError):
            self.closed_by_client += 1
            raise
        await response.write_eof()
        return response

    def check_identity(self, request):
        assert request.headers.get("Authorization") == "Bearer test-token", "service bearer missing"
        assert request.headers.get("x-owner-id") == OWNER, "owner header missing"

    # Frames: a durable frame carries an `id:` line, a live frame does not.
    def _sse(self, name, data, durable=False):
        head = ""
        if durable:
            self._durable_id += 1
            head = f"id: {self._durable_id}\n"
        return f"{head}event: {name}\ndata: {json.dumps(data)}\n\n".encode()

    def delta(self, text, attempt="model:0"):
        return self._sse("run.text.delta", {"type": "run.text.delta", "ownerId": OWNER, "conversationId": CONVERSATION,
                                            "agentId": AGENT, "runId": self.run_id, "attempt": attempt, "text": text})

    def reset(self, attempt):
        return self._sse("run.text.reset", {"type": "run.text.reset", "ownerId": OWNER, "conversationId": CONVERSATION,
                                            "agentId": AGENT, "runId": self.run_id, "attempt": attempt})

    def end(self, tool_calls, attempt="model:0"):
        return self._sse("run.text.end", {"type": "run.text.end", "ownerId": OWNER, "conversationId": CONVERSATION,
                                          "agentId": AGENT, "runId": self.run_id, "attempt": attempt, "toolCalls": tool_calls})

    def item(self, identifier, markdown, *, run_id=None, agent=AGENT):
        data = {"type": "item.added", "conversationId": CONVERSATION,
                "item": {"id": identifier, "type": "agent_message", "agentId": agent, "runId": run_id or self.run_id,
                         "markdown": markdown, "citations": []}}
        return self._sse("item.added", data, durable=True)

    def finished(self):
        return self._sse("RUN_FINISHED", {"type": "RUN_FINISHED", "runId": self.run_id, "threadId": CONVERSATION,
                                          "metadata": {"juno": {"runId": self.run_id}}}, durable=True)

    def push(self, frame):
        self.streams[-1].put_nowait(frame)

    def drop(self):
        self.streams[-1].put_nowait(None)


async def run_turn(juno, bridge, text, script, timeout=5.0):
    """Consume answer() while `script` scripts the frames, and return the spoken pieces in order."""
    pieces = []

    async def consume():
        async for piece in bridge.answer(text, timeout=timeout):
            pieces.append(piece)
            juno.heard.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(juno.posted.wait(), 5)
    # The bridge opens the stream after admission, with the run id the service returned.
    while not juno.streams:
        await asyncio.sleep(0.005)
    await script()
    await asyncio.wait_for(task, 5)
    return pieces


class BridgeTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.juno = FakeJuno()
        self.runner = web.AppRunner(self.juno.app())
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = self.runner.addresses[0][1]
        self.session = aiohttp.ClientSession()
        self.bridge = JunoBridge(self.session, f"http://127.0.0.1:{self.port}", "test-token", OWNER, CONVERSATION, AGENT)

    async def asyncTearDown(self):
        for queue in self.juno.streams:
            queue.put_nowait(None)  # a handler parked on its queue would otherwise outlive the test
        await self.session.close()
        await self.runner.cleanup()


class VoiceBridgeTests(BridgeTestCase):
    async def test_streamed_sentences_are_spoken_before_the_run_ends(self):
        juno = self.juno

        async def script():
            juno.push(juno.delta("今天很好。"))
            await asyncio.wait_for(juno.heard.wait(), 5)
            # The first sentence was spoken while the run was still going: the run has not finished yet.
            self.assertEqual(juno.post_count, 1)
            juno.push(juno.delta("很高兴见到你。"))
            juno.push(juno.item("answer", "今天很好。很高兴见到你。"))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "你好", script), ["今天很好。", "很高兴见到你。"])
        # The bridge followed the run the service named, not the id it suggested.
        self.assertNotEqual(juno.client_run_id, juno.run_id)

    async def test_reply_item_covered_by_the_stream_is_not_spoken_again(self):
        juno = self.juno

        async def script():
            juno.push(juno.delta("Hello there. "))
            juno.push(juno.item("answer", "Hello there."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "hi", script), ["Hello there."])

    async def test_mid_run_send_message_is_spoken_once_then_the_final_text(self):
        juno = self.juno

        async def script():
            # The ack is a send_message bubble: it arrives as a durable item of this run, with no streamed text.
            juno.push(juno.item("ack", "I'll save your name now."))
            await asyncio.wait_for(juno.heard.wait(), 5)
            juno.push(juno.delta("Done, saved."))
            juno.push(juno.item("final", "Done, saved."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "my name is Robin", script),
                         ["I'll save your name now.", "Done, saved."])

    async def test_final_reply_repeating_the_send_message_ack_is_not_spoken_twice(self):
        juno = self.juno

        async def script():
            juno.push(juno.item("ack", "I'll save your name now."))
            juno.push(juno.delta("Saved. "))
            juno.push(juno.item("final", "I'll save your name now."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "my name is Robin", script),
                         ["I'll save your name now.", "Saved."])

    async def test_reset_discards_the_partial_text_of_a_failed_attempt(self):
        juno = self.juno

        async def script():
            juno.push(juno.delta("Partial text without an end", attempt="model:0"))
            juno.push(juno.reset("model:0:retry:1"))
            juno.push(juno.delta("Full answer.", attempt="model:0:retry:1"))
            juno.push(juno.end(0, attempt="model:0:retry:1"))
            juno.push(juno.item("answer", "Full answer."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "hi", script), ["Full answer."])

    async def test_pre_tool_text_is_spoken_once_from_its_stream_and_its_chat_item(self):
        juno = self.juno

        async def script():
            juno.push(juno.reset("model:0"))
            # The sentence is spoken as it streams; the unfinished tail of the turn is spoken from the item the run posts for it.
            juno.push(juno.delta("Checking the calendar. One moment", attempt="model:0"))
            juno.push(juno.end(1, attempt="model:0"))
            juno.push(juno.item("ack", "Checking the calendar. One moment"))
            juno.push(juno.reset("model:1"))
            juno.push(juno.delta("Checking the calendar. Done.", attempt="model:1"))
            juno.push(juno.end(0, attempt="model:1"))
            juno.push(juno.item("answer", "Checking the calendar. Done."))
            juno.push(juno.finished())

        # The final turn repeating an earlier sentence of its own is spoken in full: each turn is compared with its own item.
        self.assertEqual(await run_turn(juno, self.bridge, "what is on today", script),
                         ["Checking the calendar.", "One moment", "Checking the calendar.", "Done."])

    async def test_retry_does_not_repeat_what_the_failed_attempt_already_said(self):
        juno = self.juno

        async def script():
            juno.push(juno.reset("model:0"))
            juno.push(juno.delta("First sentence. Second part", attempt="model:0"))
            juno.push(juno.reset("model:0:retry:1"))
            juno.push(juno.delta("First sentence. Second sentence.", attempt="model:0:retry:1"))
            juno.push(juno.end(0, attempt="model:0:retry:1"))
            juno.push(juno.item("answer", "First sentence. Second sentence."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "hi", script), ["First sentence.", "Second sentence."])

    async def test_dropped_stream_reconnects_and_the_reply_is_spoken_exactly_once(self):
        juno = self.juno

        async def script():
            juno.push(juno.delta("Hello."))
            await asyncio.wait_for(juno.heard.wait(), 5)
            juno.drop()
            # The reconnect replays from the durable log: the reply item is there, and the run's end after it.
            for _ in range(100):
                if len(juno.streams) == 2:
                    break
                await asyncio.sleep(0.01)
            juno.push(juno.item("answer", "Hello. How are you?"))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "hi", script), ["Hello.", "How are you?"])
        self.assertEqual(len(juno.streams), 2)
        self.assertEqual(juno.post_count, 1)

    async def test_a_second_stream_drop_is_not_retried_again(self):
        juno = self.juno

        async def script():
            juno.drop()
            for _ in range(100):
                if len(juno.streams) == 2:
                    break
                await asyncio.sleep(0.01)
            juno.drop()

        with self.assertRaises(VoiceBridgeError):
            await run_turn(juno, self.bridge, "hi", script)
        self.assertEqual(len(juno.streams), 2)

    async def test_run_that_waits_for_a_person_ends_after_its_reply(self):
        juno = self.juno

        async def script():
            juno.push(juno.item("reply", "Waiting for your confirmation."))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "delete it", script), ["Waiting for your confirmation."])

    async def test_items_of_another_run_or_agent_are_never_spoken(self):
        juno = self.juno

        async def script():
            juno.push(juno.item("other-agent", "other", agent="someone-else"))
            juno.push(juno.item("other-run", "old", run_id="run-older"))
            juno.push(juno.item("answer", "right"))
            juno.push(juno.finished())

        self.assertEqual(await run_turn(juno, self.bridge, "hi", script), ["right"])

    async def test_run_without_any_reply_raises_instead_of_waiting_forever(self):
        juno = self.juno

        async def script():
            juno.push(juno.finished())

        with self.assertRaises(VoiceBridgeError):
            await run_turn(juno, self.bridge, "hi", script)

    async def test_timeout_does_not_stop_or_repeat_juno_work(self):
        juno = self.juno

        async def script():
            return None

        with self.assertRaises(VoiceBridgeError):
            await run_turn(juno, self.bridge, "hello", script, timeout=0.3)
        self.assertEqual(juno.post_count, 1)

    async def test_cancelled_playback_closes_the_stream_without_cancelling_the_run(self):
        juno = self.juno

        async def consume():
            async for _ in self.bridge.answer("hello"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(juno.posted.wait(), 5)
        while not juno.streams:
            await asyncio.sleep(0.005)
        juno.push(juno.delta("First sentence. "))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        # The stream was closed, not left open: the server sees its client go.
        for _ in range(200):
            if juno.closed_by_client:
                break
            await asyncio.sleep(0.01)
        self.assertGreaterEqual(juno.closed_by_client, 1)
        self.assertEqual(juno.post_count, 1)

    async def test_warm_up_posts_to_the_voice_warm_route_and_never_raises(self):
        await self.bridge.warm()
        self.assertEqual(self.juno.warm_count, 1)
        # A refused or unreachable warm-up is swallowed: the call goes on.
        down = JunoBridge(self.session, "http://127.0.0.1:1", "test-token", OWNER, CONVERSATION, AGENT)
        await down.warm()

    async def test_prepare_posts_to_the_voice_prepare_route_and_never_raises(self):
        await self.bridge.prepare()
        self.assertEqual(self.juno.prepare_count, 1)
        down = JunoBridge(self.session, "http://127.0.0.1:1", "test-token", OWNER, CONVERSATION, AGENT)
        await down.prepare()

    async def test_service_refuses_a_bridge_acting_for_another_owner(self):
        wrong = JunoBridge(self.session, f"http://127.0.0.1:{self.port}", "test-token", "someone-else", CONVERSATION, AGENT)
        with self.assertRaises(VoiceBridgeError):
            await wrong.verify()


class SpeechChunkerTests(unittest.TestCase):
    def test_cuts_at_sentence_ends_and_keeps_the_rest_for_later(self):
        chunker = SpeechChunker()
        self.assertEqual(chunker.feed("你好。今天"), ["你好。"])
        self.assertEqual(chunker.feed("很好！\n"), ["今天很好！"])
        self.assertEqual(chunker.flush(), [])

    def test_flushes_a_long_clause_at_a_comma_but_not_a_short_one(self):
        chunker = SpeechChunker()
        self.assertEqual(chunker.feed("好，"), [])
        long_clause = "a" * 45 + ","
        self.assertEqual(chunker.feed(long_clause), ["好，" + "a" * 45 + ","])

    def test_clear_drops_unspoken_text(self):
        chunker = SpeechChunker()
        chunker.feed("unfinished")
        chunker.clear()
        self.assertEqual(chunker.flush(), [])


class LiveKitWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_livekit_session_executes_the_custom_juno_node(self):
        bridge = FakeBridge()
        async with AgentSession() as session:
            await session.start(JunoAgent(bridge))
            result = await asyncio.wait_for(session.run(user_input="在吗"), timeout=5)
            self.assertIn("你好", [event.item.text_content.strip() for event in result.events if event.type == "message"])

    async def test_livekit_node_forwards_the_latest_user_turn(self):
        bridge = FakeBridge()
        context = llm.ChatContext()
        context.add_message(role="user", content="earlier")
        context.add_message(role="assistant", content="old answer")
        context.add_message(role="user", content="现在")
        agent = JunoAgent(bridge)
        parts = [part async for part in agent.llm_node(context, [], None)]
        # Every sentence ends its TTS segment, so it is spoken without waiting for the next one.
        self.assertEqual(parts[0], "你好")
        self.assertIsInstance(parts[1], FlushSentinel)
        self.assertEqual(len(parts), 2)
        self.assertEqual(bridge.sent, ["现在"])


class PrepareOnSpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_of_speech_fires_prepare_once_while_one_is_pending(self):
        bridge = FakeBridge()
        release = asyncio.Event()
        bridge.prepare_gate = release
        async with AgentSession() as session:
            prepare_on_speech(session, bridge)
            speak = UserStateChangedEvent(old_state="listening", new_state="speaking")
            session.emit("user_state_changed", UserStateChangedEvent(old_state="speaking", new_state="listening"))
            session.emit("user_state_changed", speak)
            session.emit("user_state_changed", speak)
            await asyncio.sleep(0.05)
            self.assertEqual(bridge.prepared, 1)
            release.set()
            await asyncio.sleep(0.05)
            session.emit("user_state_changed", speak)
            await asyncio.sleep(0.05)
            self.assertEqual(bridge.prepared, 2)


class FakeBridge(JunoBridge):
    """Only the reply side is replaced: the LiveKit node under test consumes answer() exactly as it does in production."""

    def __init__(self):
        super().__init__(None, "http://127.0.0.1:12345", "test-token", OWNER, CONVERSATION, AGENT)
        self.sent = []
        self.prepared = 0
        self.prepare_gate = None

    async def prepare(self):
        self.prepared += 1
        if self.prepare_gate is not None:
            await self.prepare_gate.wait()

    async def answer(self, text, *, timeout=90.0):
        self.sent.append(text)
        yield "你好"


class ConfigTests(unittest.TestCase):
    def test_credentials_cannot_be_sent_to_remote_host(self):
        for url in ("https://example.com", "http://localhost.example.com", "http://127.0.0.1@evil.example", "http://127.0.0.1/path"):
            with self.assertRaises(ValueError):
                local_agentd_url(url)
        self.assertEqual(local_agentd_url("http://127.0.0.1:1234/"), "http://127.0.0.1:1234")


if __name__ == "__main__":
    unittest.main()
