/**
 * Mock `/v1/outbox*` and `/v1/files/*` (BACKEND.md 5.7.11, 5.2d): the owner's switch to pause outgoing messages, dropped deliveries that can be
 * retried, and kept earlier versions of a file. Tests seed rows through the returned handles.
 */
import type { ApiClient, FileSnapshot, OutboxEntry } from '@agent-desktop/client';
import { apiError } from './util.js';

export interface DeliveryMock {
  outbox: ApiClient['outbox'];
  files: ApiClient['files'];
  /** Test handles: rows and state the mock serves. */
  rows: OutboxEntry[];
  snapshots: FileSnapshot[];
  frozen: { owner: boolean; operator: boolean };
  failing: Array<{ platform: string; channelId: string; consecutiveFailures: number; lastError: string; since: string }>;
}

export function createDeliveryMock(deps: { delay: () => Promise<void>; newId: () => string; now: () => Date }): DeliveryMock {
  const mock: DeliveryMock = {
    rows: [],
    snapshots: [],
    frozen: { owner: false, operator: false },
    failing: [],
    outbox: {
      async list(query) {
        await deps.delay();
        const items = mock.rows
          .filter((row) => (query?.status ? row.status === query.status : true))
          .filter((row) => (query?.conversationId ? row.conversationId === query.conversationId : true))
          .map((row) => ({ ...row }));
        return { items, frozen: { ...mock.frozen }, health: { status: mock.failing.length > 0 ? 'red' : 'ok', failing: mock.failing.map((f) => ({ ...f })) } };
      },
      async retry(id) {
        await deps.delay();
        const row = mock.rows.find((entry) => entry.id === id && entry.status === 'dropped');
        if (!row) throw apiError(404, 'NOT_FOUND', 'delivery not found');
        row.status = 'pending';
        delete row.reason;
        delete row.droppedAt;
        return { id };
      },
      async freeze(input) {
        await deps.delay();
        mock.frozen.owner = input.frozen;
        return { frozen: input.frozen };
      },
    },
    files: {
      async history(query) {
        await deps.delay();
        const items = mock.snapshots
          .filter((snap) => snap.path === query.path && snap.agentId === query.agentId && snap.on === (query.on ?? 'sandbox'))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { items: items.map((snap) => ({ ...snap })) };
      },
      async restore(input) {
        await deps.delay();
        const snap = mock.snapshots.find((entry) => entry.id === input.snapshotId);
        if (!snap) throw apiError(404, 'NOT_FOUND', 'version not found');
        const undo: FileSnapshot = { ...snap, id: deps.newId(), tool: 'files.restore', restoredFrom: snap.id, createdAt: deps.now().toISOString() };
        mock.snapshots.push(undo);
        return { path: snap.path, on: snap.on, bytes: snap.sizeBytes, restored: { ...snap }, undo };
      },
    },
  };
  return mock;
}
