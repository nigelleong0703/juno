import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { VoiceCallSession } from '@agent-desktop/public-contracts';
import { sessionKey } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import type { WarmOutcome, WarmTarget } from 'juno-agent/execution/harness/services/warm';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { isAgentVisible, isConversationVisible } from './relationships.js';

const log = createLogger({ service: 'agentd' });

/** Warms a conversation's prompt cache (a tiny model call, nothing stored); runs in the request's owner scope. */
export type VoiceWarm = (target: WarmTarget, signal: AbortSignal) => Promise<WarmOutcome>;

/** One warm-up per conversation per this long: a call that reconnects, or a client that retries, never fans out into model calls. */
const WARM_INTERVAL_MS = 60_000;
/** The worker may ask at every start of speech; one preparation per conversation per this long. */
const PREPARE_INTERVAL_MS = 3_000;
/** A warm-up that has not answered by now is dropped; it is best effort. */
const WARM_TIMEOUT_MS = 20_000;

/** Warms what the conversation's next run starts with (connector tool discovery); resolves when done. Runs in the request's owner scope. */
export type VoicePrepare = (target: WarmTarget, signal: AbortSignal) => Promise<'prepared' | 'failed'>;

export interface VoiceCallIssuer {
  issue(ownerId: string, conversationId: string, agentId: string): Promise<VoiceCallSession>;
}

/** Uses a fresh room for every call; dispatch metadata is created only by this trusted server. */
function configuredIssuer(): VoiceCallIssuer | undefined {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, LIVEKIT_VOICE_AGENT_NAME: agentName } = process.env;
  if (!url || !key || !secret || !agentName) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error('LIVEKIT_URL must use ws or wss');
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const rooms = new RoomServiceClient(parsed.toString(), key, secret);
  const dispatch = new AgentDispatchClient(parsed.toString(), key, secret);
  return {
    async issue(ownerId, conversationId, agentId) {
      const room = `voice-${randomUUID()}`;
      const participantIdentity = `user-${randomUUID()}`;
      await rooms.createRoom({ name: room, emptyTimeout: 60, departureTimeout: 10, maxParticipants: 2 });
      try {
        await dispatch.createDispatch(room, agentName, { metadata: JSON.stringify({ ownerId, conversationId, agentId }) });
        const token = new AccessToken(key, secret, { identity: participantIdentity, ttl: '10m' });
        token.addGrant({ room, roomJoin: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false });
        return { url, token: await token.toJwt(), participantIdentity };
      } catch (error) {
        await rooms.deleteRoom(room).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function registerVoiceCall(app: Hono, deps: AgentdDeps): void {
  app.post('/v1/conversations/:id/voice-calls', async (c) => {
    const ownerId = getOwnerId(c);
    const conversation = await deps.store.get('conversations', c.req.param('id'));
    if (!conversation || !isConversationVisible(conversation, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    if (conversation.kind !== 'direct' || conversation.agentIds.length !== 1 || conversation.channel !== undefined) {
      return c.json({ error: { code: 'VOICE_CALL_UNSUPPORTED', message: 'Voice calls require an in-app direct conversation with one agent' } }, 400);
    }
    const agent = await deps.store.get('agents', conversation.agentIds[0]!);
    if (!agent || !isAgentVisible(agent, ownerId)) {
      return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404);
    }
    try {
      const issuer = deps.voiceCallIssuer ?? configuredIssuer();
      if (!issuer) return c.json({ error: { code: 'VOICE_CALL_UNAVAILABLE', message: 'Voice calls are not configured' } }, 503);
      const result = await issuer.issue(ownerId, conversation.id, conversation.agentIds[0]!);
      c.header('Cache-Control', 'no-store');
      return c.json(result, 201);
    } catch {
      return c.json({ error: { code: 'VOICE_CALL_UNAVAILABLE', message: 'Unable to start voice call' } }, 503);
    }
  });
  // Internal routes the voice worker calls (service bearer, absent from the gateway's list). Best effort and never an error to the
  // caller: the answer only says what happened.
  /** The conversation and its agent when the owner may see them; otherwise the 404 answer. Each route keeps its own throttle. */
  async function voiceTarget(c: Context, throttle: Map<string, number>, intervalMs: number) {
    const ownerId = getOwnerId(c);
    const conversation = await deps.store.get('conversations', c.req.param('id') ?? '');
    const agentId = conversation?.agentIds[0];
    if (!conversation || !isConversationVisible(conversation, ownerId) || agentId === undefined) {
      return { response: c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } }, 404) };
    }
    const target: WarmTarget = { ownerId, agentId, conversationId: conversation.id, sessionKey: sessionKey(agentId, conversation.id) };
    const key = ownerId + ':' + conversation.id;
    const now = Date.now();
    const throttled = now - (throttle.get(key) ?? -Infinity) < intervalMs;
    if (!throttled) throttle.set(key, now);
    return { target, throttled };
  }
  // The voice worker primes the provider's prompt cache as a call starts, in parallel with joining the room.
  const lastWarm = new Map<string, number>();
  app.post('/v1/conversations/:id/voice/warm', async (c) => {
    if (deps.warm === undefined) return c.json({ error: { code: 'VOICE_WARM_UNAVAILABLE', message: 'Warm-up is not available here' } }, 503);
    const found = await voiceTarget(c, lastWarm, WARM_INTERVAL_MS);
    if (found.response) return found.response;
    if (found.throttled) return c.json({ status: 'throttled' });
    try {
      return c.json({ status: await deps.warm(found.target, AbortSignal.timeout(WARM_TIMEOUT_MS)) });
    } catch (error) {
      log.warn({ err: error, conversationId: found.target.conversationId }, 'voice warm-up failed');
      return c.json({ status: 'failed' });
    }
  });
  // The worker calls this when the person starts to speak (and once as the call starts): what the run needs that does not
  // depend on the words (connector tool discovery) is warmed now. Throttled per conversation.
  const lastPrepare = new Map<string, number>();
  app.post('/v1/conversations/:id/voice/prepare', async (c) => {
    if (deps.prepare === undefined) return c.json({ error: { code: 'VOICE_PREPARE_UNAVAILABLE', message: 'Preparation is not available here' } }, 503);
    const found = await voiceTarget(c, lastPrepare, PREPARE_INTERVAL_MS);
    if (found.response) return found.response;
    if (found.throttled) return c.json({ status: 'throttled' });
    try {
      return c.json({ status: await deps.prepare(found.target, AbortSignal.timeout(WARM_TIMEOUT_MS)) });
    } catch (error) {
      log.warn({ err: error, conversationId: found.target.conversationId }, 'voice prepare failed');
      return c.json({ status: 'failed' });
    }
  });
}
