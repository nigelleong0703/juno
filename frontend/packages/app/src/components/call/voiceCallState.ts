/**
 * What the call screen shows (iOS `VoiceCallState`). `connecting` covers everything until the call is live (room joined,
 * microphone publishing and the agent listening).
 */
export type VoiceCallPhase = "connecting" | "listening" | "thinking" | "speaking" | "ended" | "failed";

/** The worker's `lk.agent.state` attribute. */
export const AGENT_STATE_ATTRIBUTE = "lk.agent.state";

/** Maps the worker's state. Unknown values return undefined so the screen keeps its current state. */
export function phaseOfAgentState(raw: string | undefined): VoiceCallPhase | undefined {
  switch (raw) {
    case "initializing":
    case "idle":
      return "connecting";
    case "listening":
    case "thinking":
    case "speaking":
      return raw;
    default:
      return undefined;
  }
}

/** Only an active state means the worker can hear the person; a joined room alone does not. */
export function agentStateIsReady(raw: string | undefined): boolean {
  return raw === "listening" || raw === "thinking" || raw === "speaking";
}

/** One caption line of the call (a speaker's segment of the transcript). */
export interface CallTurn {
  id: string;
  isUser: boolean;
  text: string;
  isFinal: boolean;
}

/** Updates for the same speaker and segment replace each other; final text is never overwritten by a late interim one. */
export function updateTurns(
  turns: readonly CallTurn[],
  update: { segmentId: string; participantIdentity: string; localIdentity: string; text: string; isFinal: boolean },
): readonly CallTurn[] {
  if (update.segmentId === "" || update.participantIdentity === "" || update.text === "") return turns;
  const id = `${update.participantIdentity.length}:${update.participantIdentity}${update.segmentId}`;
  const turn: CallTurn = { id, isUser: update.participantIdentity === update.localIdentity, text: update.text, isFinal: update.isFinal };
  const index = turns.findIndex((existing) => existing.id === id);
  if (index < 0) return [...turns, turn];
  const existing = turns[index];
  if (existing?.isFinal === true && !update.isFinal) return turns;
  return turns.map((candidate, position) => (position === index ? turn : candidate));
}

/** Speech RMS spans roughly -50 dBFS (quiet room) to -10 dBFS (loud); map that to 0...1. */
export function normalizedLevel(rms: number): number {
  const decibels = 20 * Math.log10(Math.max(rms, 1e-5));
  return Math.min(Math.max((decibels + 50) / 40, 0), 1);
}

/** Turns raw samples into a 0...1 value that rises fast and falls slowly, so the orb does not flicker. */
export class LevelSmoother {
  value = 0;
  constructor(private readonly attack = 0.55, private readonly release = 0.15) {}

  push(target: number): number {
    const clamped = Math.min(Math.max(target, 0), 1);
    this.value += (clamped - this.value) * (clamped > this.value ? this.attack : this.release);
    if (this.value < 0.005) this.value = 0;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

/** `m:ss` for the call timer. */
export function formatCallTime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
