/**
 * Start-of-speech preparation for a conversation's next run (a voice call asks for it when the person begins to talk): what the run
 * needs that does not depend on the words yet to come starts now, so the run finds it warm. Nothing durable, nothing stored.
 */
import type { RunServices } from './run-types.js';
import type { WarmTarget } from './warm.js';

/**
 * Two reads, started together: tool discovery (lists the agent's connector tools, which opens their servers and fills their caches; the
 * list itself is not kept, the run reads a fresh one) and the connection to the model provider the run will call (the TLS handshake is
 * ~0.4 s and turns are seconds apart). Each is best effort: `prepared` when at least one did its work, `failed` when none did.
 */
export async function prepareConversation(services: RunServices, target: WarmTarget, signal: AbortSignal): Promise<'prepared' | 'failed'> {
  const results = await Promise.allSettled([
    services.toolRegistry.forAgent(target.agentId, { signal }),
    services.brain.warmConnection?.({ agentId: target.agentId, signal }),
  ]);
  return results.some((result) => result.status === 'fulfilled') ? 'prepared' : 'failed';
}
