import { normalizedLevel } from "./voiceCallState";

/** Reads the loudness (0...1) of one audio track until disposed. */
export interface LevelMeter {
  level(): number;
  dispose(): void;
}

export type CreateLevelMeter = (track: MediaStreamTrack) => LevelMeter;

const silent: LevelMeter = { level: () => 0, dispose: () => undefined };

/** Web Audio meter: an analyser on the track's stream (never connected to the speakers, so no echo). */
export const createLevelMeter: CreateLevelMeter = (track) => {
  const Context = globalThis.AudioContext;
  if (typeof Context !== "function") return silent;
  try {
    const context = new Context();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      level() {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        return normalizedLevel(Math.sqrt(sum / samples.length));
      },
      dispose() {
        source.disconnect();
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    return silent;
  }
};
