/**
 * The run computer section: present only with an injected source, rendered into the system
 * prompt (never the user transcript), and truthful on failure instead of invented directories.
 */
import { describe, expect, it } from 'vitest';
import { wakeEventSchema, type Collection, type Doc, type ListPage, type Store, type WakeEvent } from '../../../contracts/index.js';
import { harnessText } from '../../../modules/harness/loader.js';
import { buildContext } from '../context.js';
import { contextText, withoutNotes } from './context-text.js';

const NOW = '2026-10-06T00:00:00.000Z';

const wake: WakeEvent = wakeEventSchema.parse({
  id: 'wk-1',
  ownerId: 'owner-1',
  agentId: 'agent-1',
  sessionKey: 'agent-1:conv-1',
  conversationId: 'conv-1',
  kind: 'user_message',
  origin: { type: 'user' },
  trusted: true,
  priority: 'user',
  payload: {},
  at: NOW,
});

function fakeStore(): Store {
  return {
    async tx<T>(fn: (inner: Store) => Promise<T>): Promise<T> {
      return fn(fakeStore());
    },
    async get(): Promise<null> {
      return null;
    },
    async list<C extends Collection>(): Promise<ListPage<Doc<C>>> {
      return { items: [] };
    },
    async put<C extends Collection>(collection: C, doc: Doc<C>): Promise<Doc<C>> {
      void collection;
      return doc;
    },
    async patch(): Promise<never> {
      throw new Error('unimplemented');
    },
    async delete(): Promise<void> {
    },
    async emit(): Promise<void> {
    },
  };
}


const base = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wake: [wake] };

describe('run computer section', () => {
  it('names the bound working directory in the system prompt, outside the transcript', async () => {
    const ctx = await buildContext(fakeStore(), {
      ...base,
      environment: async () => ({
        os: 'Linux 6.8.0 x86_64',
        platform: 'linux',
        user: 'sandbox-user',
        home: '/home/sandbox-user',
        workingDirectory: '/custom/base',
      }),
    });
    expect(systemText(ctx)).toContain('## Computer');
    expect(systemText(ctx)).toContain('/custom/base');
    const userTexts = withoutNotes(ctx.messages);
    expect(JSON.stringify(userTexts)).not.toContain('/custom/base');
  });

  it('reports no bound computer instead of inventing one', async () => {
    const ctx = await buildContext(fakeStore(), { ...base, environment: async () => null });
    expect(systemText(ctx)).toContain('no sandbox for this run');
  });

  it('reports an unavailable computer with its reason and keeps building context', async () => {
    const ctx = await buildContext(fakeStore(), {
      ...base,
      environment: async () => {
        throw new Error('no computer is bound for this owner yet');
      },
    });
    expect(systemText(ctx)).toContain('Sandbox unavailable');
    expect(systemText(ctx)).toContain('no computer is bound for this owner yet');
  });

  it('says the screen starts on the first call (not unavailable) when the agent has no screen yet', async () => {
    const ctx = await buildContext(fakeStore(), {
      ...base,
      environment: async () => {
        throw Object.assign(new Error('agent agent-1 has no screen yet'), { code: 'no_screen' });
      },
    });
    expect(systemText(ctx)).toContain(harnessText('computer.sandbox.not_started'));
    expect(systemText(ctx)).not.toContain('Sandbox unavailable');
  });
});

describe('two computers', () => {
  const agentStore = (macAccess: boolean): Store => ({ ...fakeStore(), async get(collection: string, id: string) { return collection === 'agents' && id === 'agent-1' ? { id: 'agent-1', macAccess } : null; } }) as unknown as Store;
  const linux = { os: 'Linux 6.8.0 x86_64', platform: 'linux', user: 'agent', home: '/juno', workingDirectory: '/workspace', kind: 'sandbox' };
  const mac = { os: 'macOS (Darwin 25)', platform: 'darwin', user: 'robin', home: '/Users/robin', workingDirectory: '/Users/robin/Juno', kind: 'mac' };

  it('describes both computers and the per-call choice when the agent may use the Mac', async () => {
    const ctx = await buildContext(agentStore(true), { ...base, environment: async (_agent, on) => (on === 'mac' ? mac : linux) });
    const text = systemText(ctx);
    expect(text).toContain('/workspace');
    expect(text).toContain('/Users/robin/Juno');
    expect(text).toContain('The sandbox is the default for every call');
    expect(text).toContain('only when the task explicitly needs');
    expect(text).toContain('never silently use the sandbox instead');
    expect(text).toContain('only the actions listed under Computer as declared by the Mac work');
    expect(text).toContain('do not reset it, clean it, or copy private local data');
    expect(text).toContain('computer_copy');
  });

  it('lists what the Mac declared in an appended note, never in the frozen system message', async () => {
    const declared = { ...mac, device: { name: "Robin's MacBook", osVersion: 'macOS 15.2', actions: ['files', 'shell', 'browser'] } };
    const ctx = await buildContext(agentStore(true), { ...base, environment: async (_agent, on) => (on === 'mac' ? declared : linux) });
    const system = ctx.messages.filter((message) => message.role === 'system').map((message) => JSON.stringify(message.content)).join('\n');
    expect(system).not.toContain('declares these actions');
    expect(system).not.toContain("Robin's MacBook");
    const notes = ctx.messages.filter((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<context_update>')).map((message) => String(message.content)).join('\n');
    expect(notes).toContain('"Robin\'s MacBook" (macOS 15.2) declares these actions: files (files.* on the Mac), shell (shell.* on the Mac), browser (browser.* in their Chrome).');
    expect(notes).toContain('Not available (not granted on the Mac): desktop, audio, apps.');
    expect(notes).toContain('tell the user what to enable on the Mac instead of retrying');
  });

  it('says nothing about missing actions when the Mac declares them all', async () => {
    const all = { ...mac, device: { name: 'Mac', osVersion: 'macOS 15.2', actions: ['files', 'shell', 'desktop', 'browser', 'audio', 'apps'] } };
    const text = systemText(await buildContext(agentStore(true), { ...base, environment: async (_agent, on) => (on === 'mac' ? all : linux) }));
    expect(text).toContain('declares these actions');
    expect(text).not.toContain('Not available (not granted on the Mac)');
  });

  it('says nothing of the Mac without access, and names an unreachable Mac without failing', async () => {
    const without = systemText(await buildContext(agentStore(false), { ...base, environment: async (_agent, on) => (on === 'mac' ? mac : linux) }));
    expect(without).toContain('/workspace');
    expect(without).not.toContain('/Users/robin/Juno');
    expect(without).not.toContain('computer_copy');
    const offline = systemText(await buildContext(agentStore(true), { ...base, environment: async (_agent, on) => { if (on === 'mac') throw new Error('Your Mac is offline'); return linux; } }));
    expect(offline).toContain('not reachable right now (Your Mac is offline)');
    expect(offline).toContain('/workspace');
  });
});

function systemText(ctx: { messages: Array<{ role: string; content: unknown }> }): string {
  return contextText(ctx);
}
