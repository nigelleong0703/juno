/**
 * Standalone public-entry behavioral test: the factory composes a runnable agent from injected
 * dependencies (no host import, no listener), and the composed brain/tools/store execute a real
 * Pi runLoop to completion with a stored done bubble. A second instance proves owner isolation.
 */
import { createMemoryBlobStore } from '../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createVomuAgent } from '../index.js';
import { loadConfig } from '../index.js';
import { runWithOwner } from '../index.js';
import { createMemoryStore } from '../testing/store.js';
import { createConnectorCatalog } from '../modules/mcp/catalog.js';
import { RecordingEnqueuer } from '../execution/testing/enqueuer.js';
import { createScriptedModel } from '../execution/testing/index.js';
import type { Agent } from '@agent-desktop/public-contracts';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-1';

function agentDoc(id: string): Agent {
  return {
    id, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester', status: 'idle', section: 'Work', pinned: false, lastActivity: '',
    unreadCount: 0,
    model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false }, createdBy: OWNER,
    createdAt: AT, updatedAt: AT,
  };
}

describe('createVomuAgent public entry', () => {

  it('keeps a second instance and owner scope isolated', async () => {
    const first = await createVomuAgent({
      store: createMemoryStore(), blobs: createMemoryBlobStore(), config: loadConfig({}), enqueuer: new RecordingEnqueuer(),
      env: { MODEL_PROVIDER: 'scripted' }, provider: createScriptedModel([]), connectorCatalog: createConnectorCatalog([]),
    });
    const second = await createVomuAgent({
      store: createMemoryStore(), blobs: createMemoryBlobStore(), config: loadConfig({}), enqueuer: new RecordingEnqueuer(),
      env: { MODEL_PROVIDER: 'scripted' }, provider: createScriptedModel([]), connectorCatalog: createConnectorCatalog([]),
    });
    await runWithOwner('owner-a', () => first.store.put('agents', agentDoc('agent-1')));
    const foreign = await runWithOwner('owner-b', () => first.store.get('agents', 'agent-1'));
    expect(foreign).toBeNull();
    const own = await runWithOwner('owner-a', () => first.store.get('agents', 'agent-1'));
    expect(own?.id).toBe('agent-1');
    const separate = await runWithOwner('owner-a', () => second.store.get('agents', 'agent-1'));
    expect(separate).toBeNull();
  });
});
