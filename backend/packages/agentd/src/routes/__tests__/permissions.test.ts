/**
 * What an agent's permissions page reads (BACKEND 8.8): the decision history (`status=resolved`, newest
 * first, pending excluded, paged), all owner-scoped. (Standing delegations: decision-delegation.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store, StoredRequest } from '@agent-desktop/contracts';
import type { Request } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const A = 'owner-a';
const B = 'owner-b';

function approval(id: string, createdAt: string, status: StoredRequest['status']): StoredRequest {
  return {
    id, kind: 'approval', status, title: 'Send email', summary: 'Send the summary', agentId: 'agent-a', triggeringRuleId: 'builtin.mcp',
    createdAt, payload: { kind: 'approval', action: 'mcp.gmail.send_email', target: 'to: sam@example.com', why: 'Send the weekly summary' },
  };
}

async function build() {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  const own = mem.forOwner?.(A) as Store;
  await own.put('agents', { id: 'agent-a', name: 'Atlas' } as never);
  await own.put('requests', approval('req-old', '2026-10-01T00:00:00.000Z', 'denied'));
  await own.put('requests', approval('req-new', '2026-10-03T00:00:00.000Z', 'approved'));
  await own.put('requests', approval('req-mid', '2026-10-02T00:00:00.000Z', 'pending'));
  await (mem.forOwner?.(B) as Store).put('requests', { ...approval('req-b', '2026-10-04T00:00:00.000Z', 'approved'), agentId: 'agent-b' });
  return { app };
}

async function items<T>(res: Response): Promise<{ items: T[]; nextCursor: string | null }> {
  return (await res.json()) as { items: T[]; nextCursor: string | null };
}

describe('permissions page data', () => {
  it('lists the decision history newest first, without pending requests, paged and owner-scoped', async () => {
    const { app } = await build();
    const all = await items<Request>(await requestAs(app, A, '/v1/requests?agentId=agent-a&status=resolved'));
    expect(all.items.map((request) => request.id)).toEqual(['req-new', 'req-old']);
    expect(all.items[0]?.payload).toMatchObject({ why: 'Send the weekly summary' });

    const first = await items<Request>(await requestAs(app, A, '/v1/requests?status=resolved&limit=1'));
    expect(first.items.map((request) => request.id)).toEqual(['req-new']);
    const rest = await items<Request>(await requestAs(app, A, '/v1/requests?status=resolved&limit=5&cursor=' + encodeURIComponent(first.nextCursor ?? '')));
    expect(rest.items.map((request) => request.id)).toEqual(['req-old']);
  });
});
