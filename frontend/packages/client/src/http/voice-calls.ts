import type { VoiceCallsApi } from '../contracts.js';
import { voiceCallSessionSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Voice calls: one short-lived room credential per call. */
export function createVoiceCallsApi(http: HttpTransport): VoiceCallsApi {
  return {
    start: (conversationId) =>
      http.request(`/v1/conversations/${encodeURIComponent(conversationId)}/voice-calls`, 'POST', undefined, voiceCallSessionSchema),
  };
}
