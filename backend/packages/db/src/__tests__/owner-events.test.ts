/**
 * Owner derivation for the event log (AU2): ids are pointers into persisted rows, the body
 * is never trusted for the owner, and anything unresolvable lands on unknown.
 */
import { describe, expect, it } from 'vitest';
import type { Collection } from '@agent-desktop/contracts';
import {
  UNKNOWN_OWNER,
  resolveEventOwner,
  type OwnerLookup,
} from '../owner-events.js';

function lookupFrom(rows: Record<string, string>): OwnerLookup {
  return async (collection: Collection, id: string) => rows[collection + ':' + id];
}

describe('resolveEventOwner', () => {
  it('resolves each variant through its persisted relationship', async () => {
    const lookup = lookupFrom({
      'agents:a1': 'owner-a',
      'runs:r1': 'owner-a',
      'conversations:c1': 'owner-a',
      'computers:comp1': 'owner-a',
      'requests:req1': 'owner-a',
      'routines:rt1': 'owner-a',
      'feedPosts:feed1': 'owner-a',
    });
    const cases = [
      { type: 'agent.status', agentId: 'a1', status: 'idle' },
      { type: 'agent.created', agent: { id: 'a1' } },
      { type: 'computer.state', computerId: 'comp1', state: {}, controller: {} },
      { type: 'RUN_STARTED', threadId: 'c1', runId: 'r1' },
      { type: 'RUN_FINISHED', threadId: 'c1', runId: 'r1', outcome: { type: 'success' } },
      { type: 'RUN_ERROR', message: 'failed', metadata: { juno: { runId: 'r1' } } },
      { type: 'CUSTOM', name: 'juno.run.updated', value: { id: 'r1' } },
      { type: 'STEP_STARTED', stepName: 'Read x', metadata: { juno: { runId: 'r1', stepId: 's1' } } },
      { type: 'STEP_FINISHED', stepName: 'Read x', metadata: { juno: { runId: 'r1', stepId: 's1' } } },
      { type: 'item.added', conversationId: 'c1', item: { id: 'i1' } },
      { type: 'conversation.created', conversation: { id: 'c1' } },
      { type: 'request.created', request: { id: 'req1' } },
      { type: 'request.resolved', request: { id: 'req1' } },
      { type: 'routine.updated', routine: { id: 'rt1' } },
      { type: 'feed.created', post: { id: 'feed1' } },
      { type: 'feed.updated', post: { id: 'feed1' } },
    ];
    for (const event of cases) {
      await expect(resolveEventOwner(event, lookup)).resolves.toBe('owner-a');
    }
  });

  it('returns unknown when no relationship resolves', async () => {
    const lookup = lookupFrom({});
    await expect(resolveEventOwner({ type: 'STEP_STARTED', stepName: 'x', metadata: { juno: { runId: 'nope', stepId: 's' } } }, lookup)).resolves.toBe(
      UNKNOWN_OWNER
    );
    await expect(resolveEventOwner({ type: 'agent.status', agentId: '', status: 'idle' }, lookup)).resolves.toBe(
      UNKNOWN_OWNER
    );
  });

  it('never trusts the owner carried in the payload body', async () => {
    const lookup = lookupFrom({ 'agents:a1': 'owner-persisted' });
    const event = {
      type: 'agent.updated',
      agent: { id: 'a1', ownerId: 'owner-forged' },
    };
    await expect(resolveEventOwner(event, lookup)).resolves.toBe('owner-persisted');
  });

  it('ignores legacy payloads without an embedded doc', async () => {
    const lookup = lookupFrom({ 'agents:agent-1': 'owner-a' });
    const legacy = { type: 'agent.updated', agentId: 'agent-1' };
    await expect(resolveEventOwner(legacy, lookup)).resolves.toBe(UNKNOWN_OWNER);
  });
});
