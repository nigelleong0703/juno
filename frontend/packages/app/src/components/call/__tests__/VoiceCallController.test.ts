import type { VoiceCallSession } from "@agent-desktop/client";
import { ParticipantKind, RoomEvent, type LocalAudioTrack, type Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallController, READINESS_TIMEOUT_MS, type VoiceCallDeps } from "../VoiceCallController";
import { updateTurns } from "../voiceCallState";

const session: VoiceCallSession = { url: "wss://example.test", token: "jwt", participantIdentity: "user-1" };

type Handler = (...args: unknown[]) => void;

/** The part of a LiveKit room the controller uses, with the server side played by the test. */
class FakeRoom {
  handlers = new Map<string, Handler>();
  remoteParticipants = new Map<string, FakeAgent>();
  streamHandler: ((reader: AsyncIterable<string> & { info: { id: string; attributes: Record<string, string> } }, participant: { identity: string }) => Promise<void>) | undefined;
  connect = vi.fn(() => Promise.resolve());
  disconnect = vi.fn(() => Promise.resolve());
  startAudio = vi.fn(() => Promise.resolve());
  localParticipant = { publishTrack: vi.fn(() => Promise.resolve()) };
  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }
  registerTextStreamHandler(_topic: string, handler: NonNullable<FakeRoom["streamHandler"]>): void {
    this.streamHandler = handler;
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
  /** The worker joins, or reports a new `lk.agent.state`. */
  agentState(state: string): void {
    const agent = this.remoteParticipants.get("agent") ?? new FakeAgent();
    agent.attributes["lk.agent.state"] = state;
    this.remoteParticipants.set("agent", agent);
    this.emit(RoomEvent.ParticipantAttributesChanged);
  }
}

class FakeAgent {
  kind = ParticipantKind.AGENT;
  identity = "agent";
  attributes: Record<string, string> = {};
  audioLevel = 0;
  audioTrackPublications = new Map();
}

function setup(overrides: Partial<VoiceCallDeps> = {}) {
  const room = new FakeRoom();
  const mic = { stop: vi.fn(), mute: vi.fn(() => Promise.resolve()), unmute: vi.fn(() => Promise.resolve()), mediaStreamTrack: {} };
  const deps: VoiceCallDeps = {
    startSession: vi.fn(() => Promise.resolve(session)),
    createRoom: () => room as unknown as Room,
    createMicTrack: () => Promise.resolve(mic as unknown as LocalAudioTrack),
    createMeter: () => ({ level: () => 0, dispose: () => undefined }),
    now: () => Date.now(),
    ...overrides,
  };
  const call = new VoiceCallController(deps);
  return { call, room, mic, deps };
}

async function started(overrides: Partial<VoiceCallDeps> = {}) {
  const harness = setup(overrides);
  await harness.call.start();
  return harness;
}

const phase = (call: VoiceCallController) => call.getSnapshot().phase;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VoiceCallController", () => {
  it("stays connecting after the room is joined until the agent is listening, then follows the agent", async () => {
    const { call, room, mic } = await started();
    expect(room.connect).toHaveBeenCalledWith(session.url, session.token);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(mic, expect.anything());
    expect(phase(call)).toBe("connecting");
    expect(call.getSnapshot().liveSince).toBeNull();

    room.agentState("initializing");
    expect(phase(call)).toBe("connecting");

    room.agentState("listening");
    expect(phase(call)).toBe("listening");
    expect(call.getSnapshot().liveSince).not.toBeNull();

    room.agentState("thinking");
    expect(phase(call)).toBe("thinking");
    room.agentState("speaking");
    expect(phase(call)).toBe("speaking");
    room.agentState("something-new");
    expect(phase(call)).toBe("speaking");
  });

  it("is live at once when the agent was in the room before this client finished joining", async () => {
    const harness = setup();
    harness.room.connect.mockImplementation(() => {
      harness.room.agentState("listening");
      return Promise.resolve();
    });
    await harness.call.start();
    expect(phase(harness.call)).toBe("listening");
  });

  it("mutes and unmutes the microphone", async () => {
    const { call, room, mic } = await started();
    room.agentState("listening");
    await call.toggleMute();
    expect(mic.mute).toHaveBeenCalled();
    expect(call.getSnapshot().muted).toBe(true);
    await call.toggleMute();
    expect(mic.unmute).toHaveBeenCalled();
    expect(call.getSnapshot().muted).toBe(false);
  });

  it("hanging up disconnects, releases the microphone and ignores what the room says afterwards", async () => {
    const { call, room, mic } = await started();
    room.agentState("listening");
    await call.end();
    expect(phase(call)).toBe("ended");
    expect(room.disconnect).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
    room.agentState("speaking");
    room.emit(RoomEvent.Disconnected);
    expect(phase(call)).toBe("ended");
  });

  it("hanging up before the room is joined never connects", async () => {
    let release: (value: VoiceCallSession) => void = () => undefined;
    const { call, room, mic } = setup({ startSession: () => new Promise((resolve) => (release = resolve)) });
    const running = call.start();
    await vi.waitFor(() => expect(phase(call)).toBe("connecting"));
    await call.end();
    release(session);
    await running;
    expect(room.connect).not.toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
    expect(phase(call)).toBe("ended");
  });

  it.each([
    ["the chat does not support calls", { status: 400, code: "VOICE_CALL_UNSUPPORTED" }, /aren't available in this chat/],
    ["the server is unavailable", { status: 503, code: "VOICE_CALL_UNAVAILABLE" }, /unavailable/],
  ])("shows a message when %s, and lets go of the microphone", async (_name, failure, message) => {
    const { call, mic } = await started({ startSession: () => Promise.reject(Object.assign(new Error("x"), failure)) });
    expect(phase(call)).toBe("failed");
    expect(call.getSnapshot().error).toMatch(message);
    expect(mic.stop).toHaveBeenCalled();
  });

  it("asks for the microphone before it asks the server for a room, and explains a refusal", async () => {
    const startSession = vi.fn(() => Promise.resolve(session));
    const { call } = await started({
      startSession,
      createMicTrack: () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(phase(call)).toBe("failed");
    expect(call.getSnapshot().error).toMatch(/microphone/i);
  });

  it("fails with a message when the room cannot be joined", async () => {
    const harness = setup();
    harness.room.connect.mockRejectedValue(new Error("network"));
    await harness.call.start();
    expect(phase(harness.call)).toBe("failed");
    expect(harness.call.getSnapshot().error).toMatch(/couldn't connect/i);
    expect(harness.mic.stop).toHaveBeenCalled();
  });

  it("gives up when the agent never becomes ready", async () => {
    vi.useFakeTimers();
    const { call, room, mic } = await started();
    room.agentState("initializing");
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 1);
    expect(phase(call)).toBe("failed");
    expect(call.getSnapshot().error).toMatch(/agent is unavailable/i);
    expect(room.disconnect).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
  });

  it("fails when the agent leaves or the connection drops mid-call", async () => {
    const left = await started();
    left.room.agentState("speaking");
    left.room.remoteParticipants.clear();
    left.room.emit(RoomEvent.ParticipantDisconnected, { kind: ParticipantKind.AGENT });
    expect(phase(left.call)).toBe("failed");
    expect(left.call.getSnapshot().error).toMatch(/agent is unavailable/i);

    const dropped = await started();
    dropped.room.agentState("listening");
    dropped.room.emit(RoomEvent.Disconnected);
    expect(phase(dropped.call)).toBe("failed");
    expect(dropped.call.getSnapshot().error).toMatch(/disconnected/i);
    expect(dropped.mic.stop).toHaveBeenCalled();
  });

  it("collects the transcript, interim text replaced by the final text of the same segment", async () => {
    const { call, room } = await started();
    const stream = (id: string, final: boolean, ...chunks: string[]) => ({
      info: { id, attributes: { "lk.segment_id": id, "lk.transcription_final": String(final) } },
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    });
    await room.streamHandler?.(stream("s1", true, "Hello ", "there"), { identity: "user-1" });
    await room.streamHandler?.(stream("s2", false, "Hi, "), { identity: "agent" });
    expect(call.getSnapshot().turns).toEqual([
      expect.objectContaining({ isUser: true, text: "Hello there", isFinal: true }),
      expect.objectContaining({ isUser: false, text: "Hi, ", isFinal: true }),
    ]);
  });
});

describe("updateTurns", () => {
  const update = { segmentId: "s", participantIdentity: "a", localIdentity: "me", text: "x", isFinal: false };

  it("never lets a late interim update overwrite final text, and ignores empty text", () => {
    const final = updateTurns([], { ...update, text: "done", isFinal: true });
    expect(updateTurns(final, { ...update, text: "do" })).toBe(final);
    expect(updateTurns(final, { ...update, text: "" })).toBe(final);
  });
});
