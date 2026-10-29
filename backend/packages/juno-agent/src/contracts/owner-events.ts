/**
 * Owner derivation for the durable event log (AU2).
 *
 * Event payloads are never trusted for the owner itself: ids in the payload are pointers into
 * persisted rows, and the recorded row owner wins. Anything that resolves to no persisted row
 * lands on UNKNOWN_OWNER, which account-mode subscribers never see.
 *
 * Production logic: the Postgres store (db) and the in-memory store both apply these rules, so they
 * live here once rather than inside either store.
 */
import { EventType, type AgentEvent } from '@agent-desktop/public-contracts';
import type { Collection } from './storage.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Owner recorded when no relationship resolves; never visible to scoped subscribers. */
export const UNKNOWN_OWNER = 'unknown';

/** Persisted-owner lookup used to resolve an event to its owning account. */
export type OwnerLookup = (collection: Collection, id: string) => Promise<string | undefined>;

/** Message for a scoped put that meets an id owned by someone else. */
export function ownerCollisionMessage(collection: string, id: string): string {
  return collection + ' ' + id + ' is already owned by another owner';
}

interface EventPointer {
  collection: Collection;
  id: string;
}

/**
 * Every event variant carries at least one persisted relationship id. Reads stay defensive:
 * legacy payloads may miss the embedded doc entirely, which simply yields no pointer.
 */
function eventPointers(event: AgentEvent): EventPointer[] {
  const out: EventPointer[] = [];
  const push = (collection: Collection, id: unknown): void => {
    if (typeof id === 'string') out.push({ collection, id });
  };
  const pushDoc = (collection: Collection, doc: unknown): void => {
    if (isRecord(doc)) push(collection, doc['id']);
  };
  // Standard AG-UI events carry their durable relationships in `metadata.juno` (and, for run
  // segments, the wire `runId`/`threadId`); the payload ids stay the authority.
  const junoOf = (): Record<string, unknown> => {
    const metadata = (event as { metadata?: unknown }).metadata;
    if (!isRecord(metadata) || !isRecord(metadata['juno'])) return {};
    return metadata['juno'] as Record<string, unknown>;
  };
  const pushJuno = (field: string, collection: Collection): void => {
    push(collection, junoOf()[field]);
  };
  switch (event.type) {
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
      push('runs', event.runId);
      push('conversations', event.threadId);
      pushJuno('runId', 'runs');
      pushJuno('conversationId', 'conversations');
      break;
    case EventType.RUN_ERROR:
      pushJuno('runId', 'runs');
      pushJuno('conversationId', 'conversations');
      break;
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      pushJuno('runId', 'runs');
      pushJuno('stepId', 'steps');
      break;
    case EventType.CUSTOM:
      if (event.name === 'juno.run.updated') pushDoc('runs', event.value);
      else if (event.name === 'juno.preview.closed' || event.name === 'juno.preview.snapshot') {
        if (isRecord(event.value)) push('runs', event.value['runId']);
      }
      pushJuno('runId', 'runs');
      pushJuno('conversationId', 'conversations');
      break;
    case 'agent.status':
      push('agents', event.agentId);
      break;
    case 'agent.created':
    case 'agent.updated':
      pushDoc('agents', event.agent);
      break;
    case 'agent.deleted':
      push('agents', event.agentId);
      break;
    case 'agent.home.changed':
      push('agents', event.agentId);
      break;
    case 'device.call':
      push('agents', event.agentId);
      break;
    case 'computer.state':
      push('computers', event.computerId);
      break;
    case 'item.added':
      push('conversations', event.conversationId);
      break;
    case 'conversation.created':
    case 'conversation.updated':
      pushDoc('conversations', event.conversation);
      break;
    case 'conversation.deleted':
      push('conversations', event.conversationId);
      break;
    case 'request.created':
    case 'request.resolved':
      pushDoc('requests', event.request);
      break;
    case 'routine.updated':
      pushDoc('routines', event.routine);
      break;
    case 'artifact.updated':
      pushDoc('library', event.artifact);
      break;
    case 'document.draft.updated':
      pushDoc('documentDrafts', event.draft);
      break;
    case 'goal.updated':
      pushDoc('goals', event.goal);
      break;
    case 'goal.deleted':
      push('goals', event.goalId);
      break;
    case 'idea.updated':
      pushDoc('ideas', event.idea);
      break;
    case 'task.updated':
      push('agents', event.task.agentId);
      break;
    case 'feed.created':
    case 'feed.updated':
      pushDoc('feedPosts', event.post);
      break;
    case 'feed.brief':
      push('routines', event.routineId);
      break;
    default:
      // The remaining standard events (streamed text, tool calls, reasoning, activities,
      // subagents, snapshots) attribute through `metadata.juno` alone.
      pushJuno('runId', 'runs');
      pushJuno('conversationId', 'conversations');
      pushJuno('agentId', 'agents');
      break;
  }
  return out;
}

/** First resolved persisted owner wins; empty ids and missing rows fall through to unknown. */
export async function resolveEventOwner(event: AgentEvent, lookup: OwnerLookup): Promise<string> {
  if (event.type === 'agent.home.changed' && event.agentId === undefined && event.ownerId !== undefined) return event.ownerId;
  const pointers = eventPointers(event);
  for (const pointer of pointers) {
    if (pointer.id.length === 0) continue;
    const owner = await lookup(pointer.collection, pointer.id);
    if (typeof owner === 'string' && owner.length > 0) return owner;
  }
  return UNKNOWN_OWNER;
}
