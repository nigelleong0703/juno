import type { Agent } from "@agent-desktop/client";
import { IconButton } from "@agent-desktop/ui";
import { Captions, Mic, MicOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { agentAccentStyle } from "../../lib/avatars";
import { t } from "../../lib/i18n";
import { AgentAvatar } from "../agent/AgentAvatar";
import { useVoiceCall } from "./useVoiceCall";
import type { VoiceCallDeps, VoiceCallSnapshot } from "./VoiceCallController";
import { formatCallTime } from "./voiceCallState";

const PHASE_LABEL = {
  connecting: "call.connecting",
  listening: "call.listening",
  thinking: "call.thinking",
  speaking: "call.speaking",
  ended: "call.ended",
  failed: "call.error.connect",
} as const;

/** What the call is doing, in a sentence (iOS `VoiceCallView.status`). */
export function callStatus(snapshot: VoiceCallSnapshot, agentName: string): string {
  switch (snapshot.phase) {
    case "listening":
      return snapshot.muted ? t("call.statusMuted") : t("call.statusListening");
    case "speaking":
      return t("call.statusSpeaking", { name: agentName });
    case "failed":
      return snapshot.error ?? t(PHASE_LABEL.failed);
    default:
      return t(PHASE_LABEL[snapshot.phase]);
  }
}

const SUBTITLES_KEY = "voiceCall.subtitles";

function readSubtitles(): boolean {
  try {
    return localStorage.getItem(SUBTITLES_KEY) === "1";
  } catch {
    return false;
  }
}

function CallTimer({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return null;
  return <span data-slot="call-timer" className="tabular-nums">{formatCallTime(now - since)}</span>;
}

function CallButton({ label, onClick, children, active, tone }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; tone?: "danger" }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`flex size-16 items-center justify-center rounded-full transition-transform active:scale-[0.98] focus-ring ${
        active ? "bg-white text-black" : "bg-white/15 hover:bg-white/20"
      } ${tone === "danger" ? "text-danger" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * The in-app call over the chat column (iOS `VoiceCallView`): always dark, the agent's character in a soft orb that
 * follows your level while listening and the agent's while speaking, the status in words, a timer, mute and end.
 * Mounting starts the call; unmounting (End, leaving the chat) hangs up.
 */
export function VoiceCallOverlay({ conversationId, agent, onClose, deps }: {
  conversationId: string;
  agent: Agent;
  onClose: () => void;
  deps?: Partial<VoiceCallDeps>;
}) {
  const client = useClient();
  const { snapshot, toggleMute, end } = useVoiceCall(() => client.voiceCalls.start(conversationId), deps);
  const [subtitles, setSubtitles] = useState(readSubtitles);
  const failed = snapshot.phase === "failed";
  const status = callStatus(snapshot, agent.name);
  const hangUp = (): void => {
    end();
    onClose();
  };
  const toggleSubtitles = (): void => {
    const next = !subtitles;
    setSubtitles(next);
    try {
      localStorage.setItem(SUBTITLES_KEY, next ? "1" : "0");
    } catch {
      // Remembering the choice is a convenience only.
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("call.window", { name: agent.name })}
      data-slot="voice-call"
      data-phase={snapshot.phase}
      className="voice-call"
      style={agentAccentStyle(agent.id, agent.avatar)}
    >
      <header className="flex items-start justify-between px-6 pt-4">
        <div className="flex flex-col text-sm">
          <span className="font-medium text-white/60">{agent.name}</span>
          <span className="text-xs text-white/40"><CallTimer since={snapshot.liveSince} /></span>
        </div>
        <IconButton
          label={subtitles ? t("call.subtitlesHide") : t("call.subtitlesShow")}
          aria-pressed={subtitles}
          size="lg"
          className={subtitles ? "text-white hover:bg-white/10" : "text-white/60 hover:bg-white/10"}
          onClick={toggleSubtitles}
        >
          <Captions />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8">
        <div
          data-slot="call-orb"
          aria-hidden
          className="voice-orb"
          data-muted={snapshot.muted && snapshot.phase === "listening"}
          style={{ ["--level" as string]: snapshot.level }}
        >
          <span className="voice-orb-glow" />
          <span className="voice-orb-body">
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} status={agent.status} size={136} />
          </span>
        </div>
        <div className="mt-2 flex flex-col items-center gap-3.5">
          <span aria-hidden className="voice-dots"><i /><i /><i /></span>
          <p role="status" className={`text-center text-base ${failed ? "text-danger" : "text-white/60"}`}>{status}</p>
        </div>
      </div>

      <div className="flex h-28 flex-col items-center gap-2.5 px-8 text-center text-base">
        {subtitles && snapshot.turns.slice(-2).map((turn) => (
          <p key={turn.id} className={`line-clamp-3 transition-opacity ${turn.isUser ? "text-white/60" : "text-white"} ${turn.isFinal ? "" : "opacity-55"}`}>
            {turn.text}
          </p>
        ))}
      </div>

      <div className="flex justify-center gap-7 pb-2">
        <CallButton label={snapshot.muted ? t("call.unmute") : t("call.mute")} active={snapshot.muted} onClick={toggleMute}>
          {snapshot.muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
        </CallButton>
        <CallButton label={t("call.end")} tone="danger" onClick={hangUp}>
          <X className="size-7" />
        </CallButton>
      </div>
      <p className="pb-4 pt-4 text-center text-xs text-white/35">{t("call.aiNotice")}</p>
    </div>
  );
}
