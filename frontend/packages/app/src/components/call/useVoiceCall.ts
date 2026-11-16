import type { VoiceCallSession } from "@agent-desktop/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VoiceCallController, defaultVoiceCallDeps, type VoiceCallDeps, type VoiceCallSnapshot } from "./VoiceCallController";

const idle: VoiceCallSnapshot = { phase: "connecting", error: null, level: 0, muted: false, turns: [], liveSince: null };
const noSubscribe = (): (() => void) => () => undefined;

/**
 * One call for the life of the calling component: it starts on mount and hangs up (disconnect, microphone released) on
 * unmount, so leaving the chat always ends the call. `deps` is the test seam for the room and microphone.
 */
export function useVoiceCall(startSession: () => Promise<VoiceCallSession>, deps?: Partial<VoiceCallDeps>) {
  const [controller, setController] = useState<VoiceCallController | null>(null);
  const latest = useRef({ startSession, deps });
  latest.current = { startSession, deps };

  useEffect(() => {
    const call = new VoiceCallController({
      ...defaultVoiceCallDeps(() => latest.current.startSession()),
      ...latest.current.deps,
    });
    setController(call);
    void call.start();
    return () => {
      void call.end();
    };
  }, []);

  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? (() => idle));
  return { snapshot, toggleMute: () => void controller?.toggleMute(), end: () => void controller?.end() };
}
