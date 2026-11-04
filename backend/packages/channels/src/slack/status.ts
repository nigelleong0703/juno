/**
 * Slack's "is thinking…" status of an assistant thread while a run works (docs.slack.dev/reference/methods/assistant.threads.setStatus:
 * `channel_id`, `thread_ts`, `status`, bot scope `chat:write`; an empty status clears it, and Slack clears it itself after two minutes
 * without a message) and the suggested prompts of a new assistant thread (`assistant.threads.setSuggestedPrompts`). Best effort:
 * a refusal (a workspace without the AI surface, a channel type that is not an assistant thread) is returned, never thrown.
 */
import { slackApiBase } from './base.js';

export interface SuggestedPrompt {
  title: string;
  message: string;
}

async function call(fetchFn: typeof fetch, token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetchFn(slackApiBase() + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    return record['ok'] === true ? { ok: true } : { ok: false, error: typeof record['error'] === 'string' ? record['error'] : String(response.status) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Show (or, with an empty text, clear) the status of an assistant thread. */
export function setSlackThreadStatus(fetchFn: typeof fetch, token: string, channelId: string, threadTs: string, status: string): Promise<{ ok: boolean; error?: string }> {
  return call(fetchFn, token, 'assistant.threads.setStatus', { channel_id: channelId, thread_ts: threadTs, status });
}

/** Up to four prompts under the composer of a new assistant thread. */
export function setSlackSuggestedPrompts(fetchFn: typeof fetch, token: string, channelId: string, threadTs: string, prompts: readonly SuggestedPrompt[]): Promise<{ ok: boolean; error?: string }> {
  return call(fetchFn, token, 'assistant.threads.setSuggestedPrompts', { channel_id: channelId, thread_ts: threadTs, prompts: prompts.slice(0, 4) });
}

/** A Slack API call by name with a JSON body (the plugin's other best-effort calls: `views.publish`, `chat.postMessage`). */
export function slackJson(fetchFn: typeof fetch, token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return call(fetchFn, token, method, body);
}

/** The ts of a message posted with `chat.postMessage`, or the error. */
export async function postSlackMessage(fetchFn: typeof fetch, token: string, body: Record<string, unknown>): Promise<{ ts: string } | { error: string }> {
  try {
    const response = await fetchFn(slackApiBase() + 'chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    return record['ok'] === true && typeof record['ts'] === 'string' ? { ts: record['ts'] } : { error: typeof record['error'] === 'string' ? record['error'] : String(response.status) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
