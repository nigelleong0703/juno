/**
 * Audio helpers for Discord voice: Discord delivers Opus at 48 kHz stereo, the transcriber wants 16 kHz mono.
 */

/** Below this many 16 kHz samples (0.4 s) an utterance is a cough or a click, not speech. */
export const MIN_UTTERANCE_SAMPLES = 6_400;
/** Speech louder than this RMS (of 16-bit samples) counts; anything quieter is line noise. */
export const MIN_RMS = 120;

/** 48 kHz stereo s16le to 16 kHz mono s16le: average the channels, then every three samples. */
export function to16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(Math.floor(frames / 3) * 2);
  for (let i = 0; i < out.length / 2; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const at = (i * 3 + k) * 4;
      sum += (pcm.readInt16LE(at) + pcm.readInt16LE(at + 2)) / 2;
    }
    out.writeInt16LE(Math.round(sum / 3), i * 2);
  }
  return out;
}

export function rms(pcm16: Buffer): number {
  const samples = Math.floor(pcm16.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm16.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

/** Whether a 16 kHz mono clip is long and loud enough to be worth sending to the transcriber. */
export function worthTranscribing(pcm16: Buffer): boolean {
  return pcm16.length / 2 >= MIN_UTTERANCE_SAMPLES && rms(pcm16) >= MIN_RMS;
}
