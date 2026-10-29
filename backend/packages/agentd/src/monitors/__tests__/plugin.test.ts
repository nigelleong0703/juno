import { describe, expect, it } from 'vitest';
import type { Enqueuer, Store } from '@agent-desktop/contracts';
import { createMemoryStore } from '@agent-desktop/db';
import type { Tool, ToolContext, WakeEvent } from 'juno-agent/contracts';
import { createMemoryBlobStore } from 'juno-agent/testing/blobs';
import { runWithOwner } from 'juno-agent/owner-context';
import type { PluginToolBuild } from 'juno-agent/modules/tools/plugin-tool';
import { createPluginHost, type PluginLog } from '../../plugins/host.js';
import type { Services } from '../../plugins/services.js';
import { monitorsPlugin } from '../plugin.js';

const silent: PluginLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const OWNER = 'owner-mon';
const NOW = '2026-10-26T10:00:00.000Z';

/** The monitors plugin on a real plugin host, with the core services it injects (the tools are only built, never run, here). */
function monitorsHost(rows?: Parameters<typeof createPluginHost<Services>>[0]['rows']) {
  const host = createPluginHost<Services>({ log: silent, ...(rows ? { rows } : {}) });
  host.provide('store', createMemoryStore() as Store);
  host.provide('enqueuer', {} as Enqueuer);
  host.use(monitorsPlugin);
  return host;
}

describe('monitors plugin', () => {
  it('registers the two monitor tools as first-party tools, offered wherever the built-in tools are', async () => {
    const host = monitorsHost();
    await host.load();
    expect(host.status()).toEqual([{ name: 'monitors', state: 'active' }]);
    expect(host.tools().map((entry) => entry.tool.name)).toEqual(['monitor_create', 'monitor_manage']);
    expect(host.tools().map((entry) => entry.connectedApp)).toEqual([false, false]);
  });

  it('takes the tools away when disabled (JUNO_PLUGINS), so the agent cannot create or manage a monitor', async () => {
    const host = monitorsHost({ monitors: { enabled: false } });
    await host.load();
    expect(host.status()).toEqual([{ name: 'monitors', state: 'disabled' }]);
    expect(host.tools()).toEqual([]);
    // What boot hands the execution service: the checks run only while the plugin is active.
    expect(host.status().some((status) => status.name === 'monitors' && status.state === 'active')).toBe(false);
  });

  // Regression: the tool wrote monitorState through the core's raw store, so its row had no owner ('unknown') and the owner's
  // next check could not update it (the scenario failed with "already owned by another owner"). The tool runs in the owner's
  // scope, so its writes must land under that owner.
  it('writes the monitor state under the owner the monitor belongs to, so that owner can check it again', async () => {
    const base = createMemoryStore() as Store & { forOwner(owner: string): Store };
    const scoped = base.forOwner(OWNER);
    await scoped.put('agents', { id: 'juno', name: 'Juno', handle: 'juno', createdBy: OWNER, status: 'idle' } as never);
    await scoped.put('conversations', { id: 'chat', kind: 'direct', agentIds: ['juno'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW } as never);
    const enqueuer = { scheduleRoutine: async () => undefined } as unknown as Enqueuer;
    const host = createPluginHost<Services>({ log: silent });
    host.provide('store', base as unknown as Store);
    host.provide('enqueuer', enqueuer);
    host.use(monitorsPlugin);
    await host.load();
    const [entry] = host.tools();
    const create = (entry?.tool as PluginToolBuild).build({ forAgent: async () => [watched] });
    const wake: WakeEvent = {
      id: 'w', ownerId: OWNER, agentId: 'juno', sessionKey: 'juno:chat', conversationId: 'chat', kind: 'user_message', origin: { type: 'user', id: OWNER },
      trusted: true, priority: 'user', payload: {}, at: NOW, status: 'accepted',
    };
    const ctx: ToolContext = {
      ownerId: OWNER, agentId: 'juno', conversationId: 'chat', runId: 'run', store: scoped, blobs: createMemoryBlobStore(), enqueuer, wake,
      step: async (_name, fn) => fn(), signal: new AbortController().signal,
    };
    const result = await runWithOwner(OWNER, () => create.execute({ name: 'New issues', tool: 'list_issues', args: { repo: 'acme/app' }, items: 'issues', id: 'id' }, ctx));
    expect(result.isError).toBeUndefined();
    const routine = (await scoped.list('routines', { limit: 10 })).items.find((candidate) => candidate.trigger.kind === 'check');
    expect(routine).toBeDefined();
    expect(await scoped.get('monitorState', routine?.id ?? '')).not.toBeNull();
    expect(await base.forOwner('someone-else').get('monitorState', routine?.id ?? '')).toBeNull();
  });
});

/** A read-only connector tool with two items; the creation check finds both and records them as seen. */
const watched: Tool = {
  name: 'list_issues', description: 'List issues', parameters: { type: 'object', properties: {} }, replay: 'never', sideEffect: true, mcp: true,
  origin: { connectionId: 'con', connectionName: 'Tracker', toolName: 'list_issues', access: 'read' },
  execute: async () => ({ content: [{ type: 'text', text: JSON.stringify({ issues: [{ id: 1, title: 'one' }, { id: 2, title: 'two' }] }) }] }),
};
