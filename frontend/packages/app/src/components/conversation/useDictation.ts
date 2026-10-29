import { useCallback, useEffect, useRef, useState } from "react";

export type DictationPhase = "idle" | "recording" | "transcribing";
export type DictationProblem = "denied" | "unavailable" | "failed";

/** A dictation longer than this stops by itself. */
const MAX_RECORDING_MS = 120_000;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"];

function problemOf(error: unknown): DictationProblem {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return status === 503 ? "unavailable" : "failed";
}

/**
 * Record from the microphone, send the clip to the backend and hand back the text. `toggle` starts and stops;
 * the tracks are always released, and a failure leaves the caller's draft alone.
 */
export function useDictation(args: {
  transcribe: ((audio: Blob) => Promise<string>) | undefined;
  onText: (text: string) => void;
  onProblem: (problem: DictationProblem | null) => void;
}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const asking = useRef(false);
  const latest = useRef(args);
  latest.current = args;

  const release = (stream: MediaStream | null): void => {
    stream?.getTracks().forEach((track) => track.stop());
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const start = useCallback(async (): Promise<void> => {
    if (asking.current) return;
    latest.current.onProblem(null);
    let stream: MediaStream;
    asking.current = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      latest.current.onProblem("denied");
      return;
    } finally {
      asking.current = false;
    }
    if (!alive.current) {
      release(stream);
      return;
    }
    const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      release(stream);
      latest.current.onProblem("failed");
      return;
    }
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    rec.onstop = () => {
      release(stream);
      recorder.current = null;
      const base = (rec.mimeType || mimeType || "audio/webm").split(";")[0] ?? "audio/webm";
      const audio = new Blob(chunks, { type: base });
      const transcribe = latest.current.transcribe;
      if (!alive.current || !transcribe || audio.size === 0) {
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      transcribe(audio).then(
        (text) => {
          if (!alive.current) return;
          setPhase("idle");
          if (text.trim() !== "") latest.current.onText(text.trim());
        },
        (error: unknown) => {
          if (!alive.current) return;
          setPhase("idle");
          latest.current.onProblem(problemOf(error));
        },
      );
    };
    recorder.current = rec;
    rec.start();
    setPhase("recording");
    timer.current = setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORDING_MS);
  }, []);

  const toggle = useCallback((): void => {
    if (phase === "recording") recorder.current?.stop();
    else if (phase === "idle") void start();
  }, [phase, start]);

  // Leaving the composer drops the recording without sending it.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const rec = recorder.current;
      if (rec && rec.state !== "inactive") rec.stop();
    };
  }, []);

  return { phase, toggle };
}
