/**
 * Prompt-cache warm-up for a conversation's next run (a voice call asks for it when it starts). It builds the request prefix a run
 * would send now with the run's own rules for the tool list (same discovery inputs, same order, same cache key) and has the brain make
 * one tiny provider call. Nothing durable: no run, no items, no journal, no transcript row.
 */
import { chatHasRoomAgents, chatTakesReactions, recentlyUsedTools } from '../../brain/index.js';
import { profileAudience } from '../../../modules/profile/index.js';
import { discoverTools } from '../engines/pi-core/tools.js';
import { findSystemEntry, metaOf } from '../../brain/context-notes.js';
import { readTranscript } from '../../brain/transcript.js';
import { presentToolScope, readToolScope } from '../../../modules/tools/scope.js';
import { scopeToolsFor } from './tool-policy.js';
import type { RunServices } from './run-types.js';

export interface WarmTarget {
  ownerId: string;
  agentId: string;
  conversationId: string;
  sessionKey: string;
}

export type WarmOutcome = 'warmed' | 'cold' | 'unsupported';

/** The owner is the one speaking in their own conversation, so the audience is worked out as a user wake of the owner would. */
export async function warmConversation(services: RunServices, target: WarmTarget, signal: AbortSignal): Promise<WarmOutcome> {
  const warm = services.brain.warmPrefix?.bind(services.brain);
  if (warm === undefined) return 'unsupported';
  const { ownerId, agentId, conversationId, sessionKey } = target;
  const wake = [{ ownerId, kind: 'user_message' as const, origin: { type: 'user' as const }, trusted: true, payload: {} }];
  const audience = await profileAudience(services.store, { agentId, conversationId, wake });
  // The run offers only what the conversation's frozen tool scope allows (run.ts `scopeToolsFor`): the session's frozen row names it,
  // else it follows who is present. Without this the warm-up sent tools a real run never does, and the whole prefix missed.
  const entries = await readTranscript(services.store, sessionKey);
  const frozenScope = readToolScope(metaOf(findSystemEntry(entries)?.message ?? {})?.toolScope);
  const scope = frozenScope ?? await presentToolScope(services.store, { ownerId, agentId, conversationId, wake });
  const discover = async (): Promise<Awaited<ReturnType<typeof discoverTools>>> => discoverTools(scopeToolsFor(services, scope).toolRegistry, agentId, signal, {
    goalMode: await services.toolRegistry.nativeBrowserAvailable?.(agentId) === true,
    reactions: await chatTakesReactions(services.store, conversationId),
    roomTalk: await chatHasRoomAgents(services.store, conversationId),
    recent: await recentlyUsedTools(services.store, conversationId),
    ownerOnly: audience.ownerOnly,
  });
  // A turn reads the tool texts of the harness version its session is pinned to; the warm-up must read the same ones.
  const tools = await (services.brain.withSessionHarness?.(entries, discover) ?? discover());
  if (tools === null) return 'unsupported';
  return warm({ agentId, sessionKey, tools, signal, ...(services.log === undefined ? {} : { log: services.log }) });
}
