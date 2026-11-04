"""LiveKit voice worker; all provider and Juno service credentials stay on the server."""
import json
import logging
import os

import asyncio
import time

import aiohttp
from livekit.agents import (Agent, metrics, AgentSession, AudioConfig, BackgroundAudioPlayer, BuiltinAudioClip, JobContext, JobProcess,
                            WorkerOptions, cli, llm)
from livekit.plugins import elevenlabs, fishaudio, silero

from juno_bridge import JunoBridge, VoiceBridgeError

log = logging.getLogger("juno.voice")


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def build_stt() -> elevenlabs.STT:
    """Scribe v2 realtime with manual commits: LiveKit's VAD ends the segment, so no server-side silence wait.

    Language detection is off by default: with it on, the plugin waits for ElevenLabs' second, delayed commit
    (the one carrying timestamps + language) before emitting the final transcript.
    """
    secondary = [lang for lang in os.getenv("VOICE_STT_SECONDARY_LANGUAGES", "en").split(",") if lang.strip()]
    return elevenlabs.STT(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        model=os.getenv("VOICE_STT_MODEL", "scribe_v2_realtime"),
        language_code=os.getenv("VOICE_STT_LANGUAGE", "zh"),
        secondary_languages=secondary,
        include_language_detection=os.getenv("VOICE_STT_LANGUAGE_DETECTION") == "1",
    )


class JunoModelMarker(llm.LLM):
    """Marks a text-generation pipeline; JunoAgent.llm_node owns generation."""
    def chat(self, **kwargs):
        raise RuntimeError("Juno generation must use the Juno bridge")


class JunoAgent(Agent):
    def __init__(self, bridge: JunoBridge):
        super().__init__(instructions="", llm=JunoModelMarker())
        self.bridge = bridge

    async def llm_node(self, chat_ctx, tools, model_settings):
        message = next((item for item in reversed(chat_ctx.items)
                        if isinstance(item, llm.ChatMessage) and item.role == "user" and item.text_content), None)
        if message is None:
            return
        try:
            async for text in self.bridge.answer(message.text_content):
                yield text + "\n"
        except (VoiceBridgeError, aiohttp.ClientError, TimeoutError):
            log.warning("Juno voice turn failed")
            yield "抱歉，我暂时无法连接，请稍后再试。"


def prepare_on_speech(session: AgentSession, bridge: JunoBridge) -> None:
    """Fire Juno's prepare call whenever the user starts speaking, so the run that follows finds its inputs warm.

    Fire and forget, and never overlapping: Juno throttles too, but a burst of start-of-speech events is not worth a request each.
    """
    pending: set[asyncio.Task] = set()

    @session.on("user_state_changed")
    def _on_user_state(event):
        if event.new_state == "speaking" and not pending:
            task = asyncio.create_task(bridge.prepare())
            pending.add(task)
            task.add_done_callback(pending.discard)


def prewarm(proc: JobProcess):
    """Load the VAD model once per worker process instead of on every call's critical path."""
    proc.userdata["vad"] = silero.VAD.load(min_silence_duration=_env_float("VOICE_VAD_MIN_SILENCE", 0.4))


async def entrypoint(ctx: JobContext):
    started = time.monotonic()
    metadata = json.loads(ctx.job.metadata)
    if not isinstance(metadata, dict) or any(not isinstance(metadata.get(key), str) or not metadata[key]
                                              for key in ("ownerId", "conversationId", "agentId")):
        raise ValueError("Invalid voice dispatch metadata")
    client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
    ctx.add_shutdown_callback(client.close)
    bridge = JunoBridge(client, os.environ["JUNO_AGENTD_URL"], os.environ["INTERNAL_AGENTD_TOKEN"],
                        metadata["ownerId"], metadata["conversationId"], metadata["agentId"])
    # The model's prompt cache is primed while the room is joined (fire and forget: the call never waits on it, and it never fails the call).
    warm = asyncio.create_task(bridge.warm())
    ctx.add_shutdown_callback(lambda: warm.cancel())
    # Joining the room does not depend on the conversation check; run both so the agent is in the room sooner.
    await asyncio.gather(bridge.verify(), ctx.connect())
    joined = time.monotonic()
    session = AgentSession(
        stt=build_stt(),
        vad=ctx.proc.userdata["vad"],
        tts=fishaudio.TTS(model=os.getenv("FISH_TTS_MODEL", "s2.1-pro"), voice_id=os.environ["FISH_VOICE_ID"]),
        turn_handling={
            "endpointing": {"min_delay": _env_float("VOICE_ENDPOINT_MIN_DELAY", 0.3),
                            "max_delay": _env_float("VOICE_ENDPOINT_MAX_DELAY", 2.0)},
            "interruption": {"enabled": True},
            "preemptive_generation": {"enabled": False},
        },
    )
    @session.on("metrics_collected")
    def _turn_metrics(event):
        # Where a turn's time goes, from LiveKit's own clocks: the user's last voiced audio -> transcript -> turn decision; TTS first byte.
        m = event.metrics
        if isinstance(m, metrics.EOUMetrics):
            log.info("voice turn ended", extra={"transcriptMs": round(m.transcription_delay * 1000),
                                                 "endOfTurnMs": round(m.end_of_utterance_delay * 1000)})
        elif isinstance(m, metrics.TTSMetrics) and m.ttfb > 0:
            log.info("voice tts first audio", extra={"ttfbMs": round(m.ttfb * 1000)})

    prepare_on_speech(session, bridge)
    # Once at call start too (fire and forget), so the first utterance is covered even if it begins before the first speech event.
    prepare = asyncio.create_task(bridge.prepare())
    ctx.add_shutdown_callback(lambda: prepare.cancel())
    await session.start(agent=JunoAgent(bridge), room=ctx.room)
    log.info("voice session ready", extra={"joinMs": round((joined - started) * 1000),
                                            "readyMs": round((time.monotonic() - started) * 1000)})
    # Soft typing while the agent is thinking (user turn ended, no speech yet), so a long run is not dead air.
    volume = _env_float("VOICE_THINKING_VOLUME", 0.5)
    if volume > 0:
        thinking = BackgroundAudioPlayer(thinking_sound=[AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=volume),
                                                         AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=volume)])
        await thinking.start(room=ctx.room, agent_session=session)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name=os.environ["LIVEKIT_VOICE_AGENT_NAME"]))
