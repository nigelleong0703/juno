/**
 * Voice as a conversation channel. A spoken call is not a different conversation: it shares the text chat's transcript, system prompt
 * and tools. What differs is only how a turn is answered, and that is said per turn, in the turn's own wake context, so the cached prompt
 * prefix (system + tools + history) is byte-identical between voice and text turns.
 *
 * The channel is an explicit internal field of the user wake (`payload.channel`), set by the voice call's own service-authenticated
 * route in agentd, never guessed from an id and never taken from a public request body.
 */
import type { WakeEvent } from '../contracts/index.js';

export const VOICE_CHANNEL = 'voice';

/** The one line a voice turn adds to its run-start note. Plain text: no markdown, since it is read by the model, not shown. */
export const VOICE_TURN_HINT =
  'This turn is a live spoken phone call: the user hears your reply read aloud. Reply in short, plain spoken sentences, with no markdown, lists, links or emoji, and keep it brief. '
  + 'Before using tools, say a short acknowledgement as plain text (it is spoken as you write it) instead of calling send_message.';

/** True for a wake that a voice call started. Only the explicit channel field decides it. */
export function isVoiceWake(wake: Pick<WakeEvent, 'kind' | 'payload'>): boolean {
  return wake.kind === 'user_message' && wake.payload['channel'] === VOICE_CHANNEL;
}
