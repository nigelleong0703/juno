import type { VoiceCallSession } from "@agent-desktop/client";
import {
  ParticipantKind,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type LocalAudioTrack,
  Room,
  type RemoteParticipant,
} from "livekit-client";
import { t } from "../../lib/i18n";
import { createLevelMeter, type CreateLevelMeter, type LevelMeter } from "./levelMeter";
import {
  AGENT_STATE_ATTRIBUTE,
  LevelSmoother,
  agentStateIsReady,
  phaseOfAgentState,
  updateTurns,
  type CallTurn,
  type VoiceCallPhase,
} from "./voiceCallState";

/** How long a joined room waits for the worker to become a listening agent participant. */
export const READINESS_TIMEOUT_MS = 30_000;
const SAMPLE_INTERVAL_MS = 50;
const TRANSCRIPTION_TOPIC = "lk.transcription";

/** Everything the screen reads. A new object on every change (for `useSyncExternalStore`). */
export interface VoiceCallSnapshot {
  phase: VoiceCallPhase;
  /** The reason, while `phase` is "failed". */
  error: string | null;
  /** 0...1, smoothed: your microphone while listening, the agent's voice while speaking. */
  level: number;
  muted: boolean;
  turns: readonly CallTurn[];
  /** When the call went live (epoch ms); null until the agent is listening. */
  liveSince: number | null;
}

export interface VoiceCallDeps {
  startSession: () => Promise<VoiceCallSession>;
  createRoom: () => Room;
  createMicTrack: () => Promise<LocalAudioTrack>;
  createMeter: CreateLevelMeter;
  now: () => number;
}

export const defaultVoiceCallDeps = (startSession: () => Promise<VoiceCallSession>): VoiceCallDeps => ({
  startSession,
  createRoom: () => new Room(),
  createMicTrack: () => createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
  createMeter: createLevelMeter,
  now: () => Date.now(),
});

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

/**
 * Owns one call (iOS `VoiceCallController`). A joined room is not yet a usable call: the dispatched worker has to join
 * as a LiveKit agent participant and report `listening` through its `lk.agent.state` attribute. Until then the call
 * waits; a worker that never arrives (timeout) or leaves makes the call unavailable. `end()` (and unmounting, which
 * calls it) invalidates every outstanding callback, disconnects and releases the microphone.
 */
export class VoiceCallController {
  private snapshot: VoiceCallSnapshot = { phase: "connecting", error: null, level: 0, muted: false, turns: [], liveSince: null };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private started = false;
  private ready = false;
  private room: Room | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private samplingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly smoother = new LevelSmoother();
  private readonly meters = new Map<MediaStreamTrack, LevelMeter>();
  private readonly audioElements = new Map<string, HTMLMediaElement>();
  private readonly startedAt: number;
  private readonly marked = new Set<string>();

  constructor(private readonly deps: VoiceCallDeps) {
    this.startedAt = deps.now();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceCallSnapshot => this.snapshot;

  /** Starts the call once: microphone, credential, room, then the wait for the agent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const current = ++this.generation;
    this.mark("appeared");
    try {
      this.micTrack = await this.deps.createMicTrack();
    } catch (error) {
      if (current === this.generation) this.fail(errorName(error) === "NotAllowedError" ? t("call.error.microphone") : t("call.error.noMicrophone"));
      return;
    }
    if (current !== this.generation) return this.releaseMic();
    this.mark("permission");
    let session: VoiceCallSession;
    try {
      session = await this.deps.startSession();
    } catch (error) {
      if (current === this.generation) this.fail(errorCode(error) === "VOICE_CALL_UNSUPPORTED" ? t("call.error.unsupported") : t("call.error.unavailable"));
      return;
    }
    if (current !== this.generation) return;
    this.mark("token");
    await this.join(session, current);
  }

  async toggleMute(): Promise<void> {
    const track = this.micTrack;
    if (track === null || this.room === null) return;
    const current = this.generation;
    const next = !this.snapshot.muted;
    try {
      await (next ? track.mute() : track.unmute());
    } catch {
      if (current === this.generation) this.fail(t("call.error.disconnected"));
      return;
    }
    if (current === this.generation) this.update({ muted: next });
  }

  /** Hangs up: disconnects and releases the microphone. Safe to call more than once. */
  async end(): Promise<void> {
    this.generation++;
    const room = this.release();
    if (this.snapshot.phase !== "failed") this.update({ phase: "ended", level: 0 });
    await room?.disconnect();
  }

  private async join(session: VoiceCallSession, current: number): Promise<void> {
    const room = this.deps.createRoom();
    this.room = room;
    room
      .on(RoomEvent.Disconnected, () => {
        if (current === this.generation) this.lost(t("call.error.disconnected"));
      })
      .on(RoomEvent.ParticipantConnected, () => this.agentChanged(current))
      .on(RoomEvent.ParticipantAttributesChanged, () => this.agentChanged(current))
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (current === this.generation && participant.kind === ParticipantKind.AGENT && this.agentParticipant() === undefined) {
          this.lost(t("call.error.agentUnavailable"));
        }
      })
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (current !== this.generation || track.kind !== Track.Kind.Audio) return;
        const element = track.attach();
        element.style.display = "none";
        document.body.append(element);
        this.audioElements.set(track.sid ?? participant.identity, element);
        void element.play().catch(() => room.startAudio().catch(() => undefined));
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach((element) => element.remove());
      });
    try {
      room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participant) => {
        const attributes = reader.info.attributes ?? {};
        const segmentId = attributes["lk.segment_id"] ?? reader.info.id;
        const final = attributes["lk.transcription_final"] === "true";
        const isOther = participant.identity !== session.participantIdentity;
        let text = "";
        try {
          for await (const chunk of reader) {
            text += chunk;
            this.receive(current, session, participant.identity, segmentId, text, false);
          }
          this.receive(current, session, participant.identity, segmentId, text, final || isOther);
        } catch {
          // A closed or interrupted stream must not create a synthetic final transcript.
        }
      });
      await room.connect(session.url, session.token);
      if (current !== this.generation) return void (await room.disconnect());
      this.mark("roomConnected");
      const mic = this.micTrack;
      if (mic === null) throw new Error("microphone released");
      await room.localParticipant.publishTrack(mic, { source: Track.Source.Microphone });
      if (current !== this.generation) return void (await room.disconnect());
      this.mark("micPublished");
      this.readinessTimer = setTimeout(() => {
        if (current === this.generation && !this.ready) this.lost(t("call.error.agentUnavailable"));
      }, READINESS_TIMEOUT_MS);
      // The worker may already be in the room when this client finishes joining.
      this.agentChanged(current);
    } catch {
      if (current === this.generation) this.lost(t("call.error.connect"));
    }
  }

  private agentParticipant(): RemoteParticipant | undefined {
    const agents = [...(this.room?.remoteParticipants.values() ?? [])].filter((participant) => participant.kind === ParticipantKind.AGENT);
    // An avatar worker is also an agent participant but carries no state.
    return agents.find((participant) => participant.attributes[AGENT_STATE_ATTRIBUTE] !== undefined) ?? agents[0];
  }

  private agentChanged(current: number): void {
    if (current !== this.generation || this.room === null) return;
    const agent = this.agentParticipant();
    if (agent === undefined) return;
    this.mark("agentJoined");
    const raw = agent.attributes[AGENT_STATE_ATTRIBUTE];
    const next = phaseOfAgentState(raw);
    if (next === undefined || this.micTrack === null || !this.micPublished()) return;
    if (!this.ready) {
      if (!agentStateIsReady(raw)) return;
      this.ready = true;
      this.clearReadinessTimer();
      this.startSampling(current);
      this.update({ liveSince: this.deps.now() });
    }
    if (this.snapshot.phase !== next) this.update({ phase: next });
    if (next === "listening") this.mark("listening");
  }

  private micPublished(): boolean {
    return this.marked.has("micPublished");
  }

  private receive(current: number, session: VoiceCallSession, identity: string, segmentId: string, text: string, isFinal: boolean): void {
    if (current !== this.generation) return;
    const turns = updateTurns(this.snapshot.turns, {
      segmentId,
      participantIdentity: identity,
      localIdentity: session.participantIdentity,
      text,
      isFinal,
    });
    if (turns !== this.snapshot.turns) this.update({ turns });
  }

  private startSampling(current: number): void {
    this.samplingTimer = setInterval(() => {
      if (current !== this.generation) return;
      const next = this.smoother.push(this.sampleLevel());
      if (Math.abs(next - this.snapshot.level) > 0.004) this.update({ level: next });
    }, SAMPLE_INTERVAL_MS);
  }

  /** Raw 0...1 level for the current phase; meters attach lazily because tracks appear after the room joins. */
  private sampleLevel(): number {
    const { phase, muted } = this.snapshot;
    if (phase === "listening") {
      if (muted) return 0;
      const track = this.micTrack?.mediaStreamTrack;
      return track === undefined ? 0 : this.meterFor(track).level();
    }
    if (phase === "speaking") {
      const agent = this.agentParticipant();
      const track = [...(agent?.audioTrackPublications.values() ?? [])].find((publication) => publication.track !== undefined)?.track?.mediaStreamTrack;
      return track === undefined ? (agent?.audioLevel ?? 0) : this.meterFor(track).level();
    }
    return 0;
  }

  private meterFor(track: MediaStreamTrack): LevelMeter {
    let meter = this.meters.get(track);
    if (meter === undefined) {
      meter = this.deps.createMeter(track);
      this.meters.set(track, meter);
    }
    return meter;
  }

  /** The room went away (timeout, agent left, dropped): show why and let go of everything. */
  private lost(message: string): void {
    this.generation++;
    const room = this.release();
    this.fail(message);
    void room?.disconnect().catch(() => undefined);
  }

  private fail(message: string): void {
    this.releaseMic();
    this.update({ phase: "failed", error: message, level: 0 });
  }

  private release(): Room | null {
    this.ready = false;
    this.clearReadinessTimer();
    if (this.samplingTimer !== null) clearInterval(this.samplingTimer);
    this.samplingTimer = null;
    this.meters.forEach((meter) => meter.dispose());
    this.meters.clear();
    this.smoother.reset();
    this.audioElements.forEach((element) => element.remove());
    this.audioElements.clear();
    this.releaseMic();
    const room = this.room;
    this.room = null;
    return room;
  }

  private releaseMic(): void {
    this.micTrack?.stop();
    this.micTrack = null;
  }

  private clearReadinessTimer(): void {
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  /** Records a connect phase once per call (ms since the call began), so a real call shows where the wait is. */
  private mark(phase: string): void {
    if (this.marked.has(phase)) return;
    this.marked.add(phase);
    console.info(`[voice-call] phase ${phase} +${this.deps.now() - this.startedAt}ms`);
  }

  private update(patch: Partial<VoiceCallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
