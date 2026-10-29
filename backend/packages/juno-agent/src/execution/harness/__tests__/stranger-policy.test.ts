/**
 * BACKEND 8.0b: a run a stranger woke (not the owner) may only use a short list of tools without asking, works in its own chat's
 * folder, and needs the owner's "sharing" delegation to read another chat's files. A run the owner woke is not held to any of it.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Rule } from '@agent-desktop/public-contracts';
import { chatFolder } from '../../../modules/chat-folder.js';
import { CANCELLED, NEVER_CANCELLED } from '../services/cancel.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import { unwrapProxyCalls } from '../../brain/tool-proxy.js';
import { buildDelegationOffer, delegationRuleId } from '../services/decision/delegation.js';
import { STRANGER_ALLOWED } from '../services/decision/stranger.js';
import { deriveFor, evaluateToolPolicy, policyCallOf, readToolPolicyConfig, type ToolCallContext, type ToolPolicyConfig } from '../services/tool-policy.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const OWNER = 'owner-1';
const AGENT = 'agent-1';
const FRIENDS = 'cvn-friends';
const WORK = 'cvn-work';
const AT = '2026-10-22T00:00:00.000Z';
const FRIENDS_TITLE = '#general · Slack';
const WORK_TITLE = 'Work group';
const OWN_FOLDER = chatFolder({ id: FRIENDS, title: FRIENDS_TITLE });
const WORK_FOLDER = chatFolder({ id: WORK, title: WORK_TITLE });

function wake(overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + FRIENDS, conversationId: FRIENDS,
    kind: 'room_mention', origin: { type: 'user' }, trusted: false, priority: 'user',
    payload: { text: 'hi', speakerRole: 'stranger', speakerName: 'Bob', channelKind: 'slack' }, at: AT, status: 'accepted', ...overrides,
  };
}
const stranger = wake();
const owner = wake({ trusted: true, payload: { text: 'hi', speakerRole: 'owner' } });

const TOOLS = [
  'shell.run', 'shell.start', 'files.read', 'files.write', 'files.edit', 'artifact_publish', 'browser.navigate', 'computer.click', 'web_search', 'web_fetch',
  'send_message', 'react', 'todo_write', 'tool_search', 'tool_load', 'skill_search', 'skill_read', 'transcript_read', 'transcript_search', 'request_withdraw', 'channel_history', 'group_rule',
  'send_file', 'post_to_room', 'memory_note', 'mail_send_email',
];
const mailOrigin = { connectionId: 'c1', connectionName: 'Gmail', catalogId: 'gmail', toolName: 'send_email', access: 'action' } as const;

function configOf(extra: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    exposed: new Set(TOOLS), rules: [], plugins: [], disconnectedPluginIds: new Set<string>(), unreadable: false, agentId: AGENT,
    origins: new Map([['mail_send_email', mailOrigin]]),
    chat: { conversationId: FRIENDS, title: FRIENDS_TITLE, stranger: { name: 'Bob' }, other: { id: WORK, title: WORK_TITLE } },
    ...extra,
  };
}

function sharing(overrides: Partial<Rule> = {}): Rule {
  return {
    id: delegationRuleId(AGENT, 'sharing', 'chat:' + WORK, undefined), description: 'Share files from "Work group"', scope: 'delegation', behavior: 'auto', source: 'user', enabled: true,
    agentId: AGENT, createdAt: AT, createdBy: OWNER, expiresAt: '2999-01-01T00:00:00.000Z',
    delegation: { category: 'sharing', platformKey: 'chat:' + WORK, limits: { recipients: [FRIENDS] } }, ...overrides,
  };
}

const decide = (config: ToolPolicyConfig, tool: string, args: unknown, w: WakeEvent = stranger) => evaluateToolPolicy(config, tool, w, args);

describe('a run a stranger woke', () => {
  it('asks for every tool outside the allowlist and says who asked, where and what for', () => {
    expect(decide(configOf(), 'shell.run', { command: 'ls' })).toEqual({
      kind: 'ask', reason: 'Bob asked in #general · Slack: run a command on its computer', ruleId: 'builtin.stranger',
    });
    expect(decide(configOf(), 'shell.start', { command: 'sleep 5' })).toMatchObject({ kind: 'ask', reason: 'Bob asked in #general · Slack: start a command on its computer' });
    expect(decide(configOf(), 'artifact_publish', { path: '/juno/MEMORY.md' })).toMatchObject({ kind: 'ask', reason: expect.stringContaining('Bob asked in #general · Slack: publish a document') });
    for (const [tool, args] of [['files.edit', {}], ['browser.navigate', { url: 'https://docs.example/guide' }], ['computer.click', { x: 1, y: 2 }], ['send_file', {}], ['post_to_room', {}], ['memory_note', {}], ['mail_send_email', {}]] as const) {
      expect(decide(configOf(), tool, args), tool).toMatchObject({ kind: 'ask', ruleId: 'builtin.stranger' });
    }
    // Without a speaker name or a title the line still reads, and an auto rule for the tool does not lift it.
    const bare = configOf({ chat: { conversationId: FRIENDS, stranger: {} }, rules: [{ id: 'r', description: 'r', scope: 'action', behavior: 'auto', source: 'user', enabled: true, subject: 'shell.run', createdAt: AT, createdBy: OWNER }] });
    expect(decide(bare, 'shell.run', { command: 'ls' }, wake({ payload: { text: 'hi' } }))).toMatchObject({ kind: 'ask', reason: 'Someone asked in a group chat: run a command on its computer' });
  });

  it('runs the allowlist without asking, and tool_call is judged by the inner tool', () => {
    const free = ['web_search', 'web_fetch', 'send_message', 'react', 'todo_write', 'tool_search', 'tool_load', 'skill_search', 'skill_read', 'transcript_read', 'transcript_search', 'request_withdraw', 'channel_history', 'group_rule'];
    for (const tool of free) expect(decide(configOf(), tool, tool === 'web_fetch' ? { url: 'https://docs.example/guide' } : {}), tool).toEqual({ kind: 'allow' });
    expect([...STRANGER_ALLOWED].sort()).toEqual([...free, 'tool_call'].sort());
    // A built-in refusal stays stricter than the allowlist.
    expect(decide(configOf(), 'web_fetch', { url: 'http://169.254.169.254/latest' })).toMatchObject({ kind: 'deny', ruleId: 'builtin.private-network' });
    expect(decide(configOf({ plugins: [] , exposed: new Set(['web_search']) }), 'web_fetch', {})).toMatchObject({ kind: 'deny' });
  });

  it('works in its own chat\'s folder: read, write and publish are allowed there, with a relative path too', () => {
    for (const tool of ['files.read', 'files.write', 'artifact_publish']) {
      expect(decide(configOf(), tool, { path: OWN_FOLDER + '/notes/q4.md', content: 'x' }), tool).toEqual({ kind: 'allow' });
    }
    expect(decide(configOf(), 'files.write', { path: OWN_FOLDER.replace('/workspace/', '') + '/a.md', content: 'x' })).toEqual({ kind: 'allow' });
    // The folder is found by its hash, so the name the agent was told before a rename still works; `..` does not get out of it.
    expect(decide(configOf(), 'files.read', { path: '/workspace/chats/old-title-' + OWN_FOLDER.slice(-8) + '/a.md' })).toEqual({ kind: 'allow' });
    expect(decide(configOf(), 'files.read', { path: OWN_FOLDER + '/../../../juno/MEMORY.md' })).toMatchObject({ kind: 'ask' });
    // The Mac is never a chat folder (and without Mac access the call is refused outright, which stays stricter).
    expect(decide(configOf({ macAccess: true }), 'files.read', { path: OWN_FOLDER + '/a.md', on: 'mac' })).toMatchObject({ kind: 'ask' });
    expect(decide(configOf(), 'files.read', { path: OWN_FOLDER + '/a.md', on: 'mac' })).toMatchObject({ kind: 'deny', ruleId: 'builtin.mac-off' });
  });

  it('asks for a file of another chat and offers exactly the delegation that would allow it', () => {
    const args = { path: WORK_FOLDER + '/q4.md' };
    const verdict = decide(configOf(), 'files.read', args);
    expect(verdict).toMatchObject({ kind: 'ask', ruleId: 'builtin.stranger', reason: 'Bob asked in #general · Slack: read a file from "Work group"' });
    const derived = deriveFor(configOf(), 'files.read', args, stranger);
    expect(derived.brief).toMatchObject({ categories: ['sharing'], primary: 'sharing', platform: { kind: 'juno', name: WORK_TITLE }, facts: { targets: [{ kind: 'file', label: args.path }] } });
    expect(derived.brief.sentence).toBe('Read a file from "Work group"');
    expect(buildDelegationOffer(derived, stranger, undefined, [])).toEqual({
      delegable: true,
      suggested: [{ category: 'sharing', platform: { kind: 'chat', conversationId: WORK, title: WORK_TITLE }, limits: { recipients: [FRIENDS] } }],
    });
  });

  it('keeps the chats already allowed when the same source chat is offered for another one', () => {
    const earlier = sharing({ delegation: { category: 'sharing', platformKey: 'chat:' + WORK, limits: { recipients: ['cvn-family'] } } });
    const derived = deriveFor(configOf(), 'files.read', { path: WORK_FOLDER + '/q4.md' }, stranger);
    expect(buildDelegationOffer(derived, stranger, undefined, [earlier]).suggested[0]?.limits).toEqual({ recipients: ['cvn-family', FRIENDS] });
  });

  it('lets the owner\'s sharing delegation through (source chat -> this chat) and nothing narrower or older', () => {
    const args = { path: WORK_FOLDER + '/q4.md' };
    const allowed = decide(configOf({ rules: [sharing()] }), 'files.read', args);
    expect(allowed).toEqual({ kind: 'allow', delegationId: sharing().id });
    expect(decide(configOf({ rules: [sharing()] }), 'artifact_publish', args)).toMatchObject({ kind: 'allow' });
    for (const [why, rule] of [
      ['expired', sharing({ expiresAt: '2026-01-01T00:00:00.000Z' })],
      ['switched off', sharing({ enabled: false })],
      ['for another agent', sharing({ agentId: 'agent-2' })],
      ['for another target chat', sharing({ delegation: { category: 'sharing', platformKey: 'chat:' + WORK, limits: { recipients: ['cvn-family'] } } })],
      ['for another source chat', sharing({ delegation: { category: 'sharing', platformKey: 'chat:cvn-other', limits: { recipients: [FRIENDS] } } })],
    ] as const) {
      expect(decide(configOf({ rules: [rule] }), 'files.read', args), why).toMatchObject({ kind: 'ask', ruleId: 'builtin.stranger' });
    }
    // The delegation covers files only: another tool of the stranger still asks, and so does a path outside the chat folders.
    expect(decide(configOf({ rules: [sharing()] }), 'shell.run', { command: 'cat ' + args.path })).toMatchObject({ kind: 'ask' });
    expect(decide(configOf({ rules: [sharing()] }), 'files.read', { path: '/juno/MEMORY.md' })).toMatchObject({ kind: 'ask' });
  });

  it('asks about private files every time and offers nothing to allow in advance', () => {
    for (const path of ['/juno/MEMORY.md', '/workspace/notes.md', 'notes.md', '~/.ssh/id_rsa', '/home/agent/a.txt', '/workspace/chats/made-up-00000000/a.md', '/workspace/chats']) {
      const args = { path };
      const verdict = decide(configOf({ rules: [sharing()] }), 'files.read', args);
      expect(verdict, path).toMatchObject({ kind: 'ask', ruleId: 'builtin.stranger' });
      const derived = deriveFor(configOf(), 'files.read', args, stranger);
      expect(derived.brief.categories, path).toEqual(['sensitive']);
      expect(derived.brief.facts.sensitive, path).toEqual([{ kind: 'private_files', label: path, source: 'verified' }]);
      expect(buildDelegationOffer(derived, stranger, undefined, [sharing()]), path).toEqual({ delegable: false, reason: 'private files', suggested: [] });
    }
    // Any other tool of a stranger is asked every time too: the card does not offer to allow its kind.
    const shell = deriveFor(configOf(), 'shell.run', { command: 'ls' }, stranger);
    expect(buildDelegationOffer(shell, stranger, undefined, [])).toMatchObject({ delegable: false, suggested: [] });
    const mail = deriveFor(configOf(), 'mail_send_email', { to: 'a@x.com', approval: { sentence: 'Send it' } }, stranger);
    expect(buildDelegationOffer(mail, stranger, undefined, [])).toMatchObject({ delegable: false, suggested: [] });
  });

  it('an MCP tool asks for the stranger even when a delegation of the owner covers it', () => {
    const speaking = { id: 'rul-dlg-speaking', description: 'd', scope: 'delegation', behavior: 'auto', source: 'user', enabled: true, agentId: AGENT, createdAt: AT, createdBy: OWNER, expiresAt: '2999-01-01T00:00:00.000Z', delegation: { category: 'speaking', platformKey: 'app:gmail', limits: {} } } as Rule;
    const args = { to: 'a@x.com', subject: 's', body: 'b', approval: { sentence: 'Send it' } };
    expect(decide(configOf({ rules: [speaking], chat: undefined }), 'mail_send_email', args, owner)).toMatchObject({ kind: 'allow', delegationId: 'rul-dlg-speaking' });
    expect(decide(configOf({ rules: [speaking] }), 'mail_send_email', args)).toMatchObject({ kind: 'ask', ruleId: 'builtin.stranger', reason: expect.stringContaining('Bob asked in #general · Slack') });
  });
});

describe('a run the owner woke', () => {
  it('is not held to the stranger rule, in a group too', () => {
    const config = configOf({ chat: undefined });
    expect(decide(config, 'shell.run', { command: 'ls' }, owner)).toEqual({ kind: 'allow' });
    expect(decide(config, 'files.read', { path: WORK_FOLDER + '/q4.md' }, owner)).toEqual({ kind: 'allow' });
    expect(decide(config, 'files.read', { path: '/juno/MEMORY.md' }, owner)).toEqual({ kind: 'allow' });
    // Not a user at all (a routine, a child task, a peer): those are not strangers either.
    for (const origin of [{ type: 'automation' }, { type: 'system' }, { type: 'agent' }] as const) {
      expect(decide(config, 'shell.run', { command: 'ls' }, wake({ origin, trusted: false })), origin.type).toEqual({ kind: 'allow' });
    }
  });

  it('is held to it when any wake of the run is a stranger\'s (the policy config says so)', () => {
    expect(decide(configOf(), 'shell.run', { command: 'ls' }, owner)).toMatchObject({ kind: 'ask', reason: 'Bob asked in #general · Slack: run a command on its computer' });
  });
});

describe('reading the policy for a stranger-woken run', () => {
  async function seeded(): Promise<Store> {
    const store = createMemoryStore();
    const base = { kind: 'room', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: OWNER } as const;
    await store.put('conversations', { ...base, id: FRIENDS, title: FRIENDS_TITLE } as never);
    await store.put('conversations', { ...base, id: WORK, title: WORK_TITLE } as never);
    return store;
  }
  const registry: ToolRegistry = { forAgent: async () => [], get: () => undefined };
  const callOf = (tool: string, args: unknown, wakes = [stranger]) => policyCallOf({ conversationId: FRIENDS, wakeEvents: wakes }, tool, args);

  it('carries the chat, the speaker and the other chat a path points into; an owner run carries nothing', async () => {
    const store = await seeded();
    const read = (tool: string, args: unknown, wakes?: WakeEvent[]) => readToolPolicyConfig(store, registry, AGENT, OWNER, undefined, callOf(tool, args, wakes));
    expect((await read('files.read', { path: WORK_FOLDER + '/q4.md' })).chat).toEqual({ conversationId: FRIENDS, title: FRIENDS_TITLE, stranger: { name: 'Bob' }, other: { id: WORK, title: WORK_TITLE } });
    expect((await read('files.read', { path: OWN_FOLDER + '/a.md' })).chat).toEqual({ conversationId: FRIENDS, title: FRIENDS_TITLE, stranger: { name: 'Bob' } });
    expect((await read('shell.run', { command: 'ls' })).chat?.other).toBeUndefined();
    expect((await read('files.read', { path: '/workspace/chats/gone-00000000/a.md' })).chat?.other).toBeUndefined();
    expect((await read('files.read', { path: WORK_FOLDER + '/q4.md' }, [owner])).chat).toBeUndefined();
    expect((await read('files.read', { path: WORK_FOLDER + '/q4.md' }, [owner, stranger])).chat?.stranger).toEqual({ name: 'Bob' });
    expect((await readToolPolicyConfig(store, registry, AGENT, OWNER)).chat).toBeUndefined();
  });
});

describe('a stranger-woken run through the harness', () => {
  function testContext(id: string): ToolCallContext & { decide(value: unknown): void } {
    let settle: ((value: unknown) => void) | undefined;
    const journal = new Map<string, unknown>();
    return {
      rand: { uuidv4: () => id },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => {
          journal.set(name, structuredClone(value));
          return value;
        }));
      },
      awakeable<T>(): { id: string; promise: RestatePromise<T> } {
        return { id: 'awk-1', promise: RestatePromise.resolve(new Promise<T>((resolver) => { settle = (value) => resolver(value as T); })) };
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      decide: (value) => settle?.(value),
    };
  }

  function toolFor(name: string, executions: string[]): Tool {
    return {
      name, description: name, parameters: {}, replay: 'never', sideEffect: true,
      execute: async (args: unknown): Promise<ToolResult> => {
        executions.push(JSON.stringify(args));
        return { content: [{ type: 'text', text: name + ' done' }] };
      },
    };
  }

  async function build() {
    const store = createMemoryStore();
    const base = { kind: 'room', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: OWNER } as const;
    await store.put('conversations', { ...base, id: FRIENDS, title: FRIENDS_TITLE } as never);
    await store.put('conversations', { ...base, id: WORK, title: WORK_TITLE } as never);
    await store.put('runs', {
      id: 'run-1', agentId: AGENT, conversationId: FRIENDS, title: 'test', status: 'running', kind: 'chat',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
    }, { conversationId: FRIENDS });
    const executions: string[] = [];
    const tools = ['files.read', 'files.write', 'shell.run', 'memory_note'].map((name) => toolFor(name, executions));
    const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
    const input: RunInput = { agentId: AGENT, conversationId: FRIENDS, sessionKey: AGENT + ':' + FRIENDS, wakeEvents: [stranger] };
    const call = (id: string, name: string, args: Record<string, unknown>, ctx = testContext(id), wireName?: string) => ({
      ctx, running: executeSingleToolCall(ctx, services, input, 'run-1', 0, 0, { id, name, arguments: args, ...(wireName === undefined ? {} : { wireName }) }, NEVER_CANCELLED, []),
    });
    return { store, executions, call };
  }

  const pending = async (store: Store) => (await store.list('requests', { where: { status: 'pending' }, limit: 10 })).items;
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 200 && !(await check()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  };

  it('runs a call in its own folder, and refuses a stranger\'s shell command outright: the shell is not offered in a group', async () => {
    const { store, executions, call } = await build();
    const own = await call('s1', 'files.write', { path: OWN_FOLDER + '/a.md', content: 'x' }).running;
    expect(own === CANCELLED ? '' : JSON.stringify(own.result)).toContain('files.write done');
    expect(await pending(store)).toHaveLength(0);

    // Batch 5b: a hidden tool is refused at the call (the stricter of the scope and the stranger rule), so nothing is asked of the owner.
    const shell = await call('s2', 'shell.run', { command: 'ls /juno' }).running;
    expect(shell === CANCELLED ? '' : JSON.stringify(shell.result)).toContain('shell.run is not available in this chat');
    expect(await pending(store)).toHaveLength(0);
    expect(executions).toEqual([JSON.stringify({ path: OWN_FOLDER + '/a.md', content: 'x' })]);
  });

  it('a hidden tool reached through the tool_call proxy is refused as the tool it reaches, and nothing runs', async () => {
    const { store, executions, call } = await build();
    // What the provider hands the harness for a model's `tool_call {name:"shell.run", ...}` (brain/tool-proxy.ts).
    const [unwrapped] = unwrapProxyCalls([{ id: 'p1', name: 'tool_call', arguments: { name: 'shell.run', arguments: { command: 'ls /juno' } } }]);
    expect(unwrapped).toEqual({ id: 'p1', name: 'shell.run', arguments: { command: 'ls /juno' }, wireName: 'tool_call' });
    const proxied = await call('p1', unwrapped?.name ?? '', unwrapped?.arguments ?? {}, undefined, unwrapped?.wireName).running;
    expect(proxied === CANCELLED ? '' : JSON.stringify(proxied.result)).toContain('shell.run is not available in this chat');
    expect(await pending(store)).toHaveLength(0);
    expect(executions).toEqual([]);
  });

  it('a file of another chat is refused for a stranger, even under the owner\'s sharing delegation: a group reaches only its own folder', async () => {
    const { store, executions, call } = await build();
    await store.put('rules', sharing());
    const refused = await call('s1', 'files.read', { path: WORK_FOLDER + '/q4.md' }).running;
    expect(refused === CANCELLED ? '' : JSON.stringify(refused.result)).toContain('Files outside this chat\'s own folder');
    expect(await pending(store)).toHaveLength(0);
    expect(executions).toHaveLength(0);
  });

  it('the card says who asked even when the agent tells another story', async () => {
    const { store, call } = await build();
    void call('s1', 'memory_note', { text: 'a note', approval: { sentence: 'Note it', why: 'The owner asked me to' } }).running.catch(() => undefined);
    await waitFor(async () => (await pending(store)).length > 0);
    const [request] = await pending(store);
    expect(request).toMatchObject({ title: 'Note it', triggeringRuleId: 'builtin.stranger' });
    expect(request?.payload).toMatchObject({ brief: { sentence: 'Note it', why: 'The owner asked me to' } });
    expect(String(request?.summary)).toContain('Bob asked in #general');
  });

  it('a private file is refused in a group: it is outside the chat folder, so nothing is asked', async () => {
    const { store, executions, call } = await build();
    const refused = await call('s1', 'files.read', { path: '/juno/MEMORY.md' }).running;
    expect(refused === CANCELLED ? '' : JSON.stringify(refused.result)).toContain('Files outside this chat\'s own folder');
    expect(await pending(store)).toHaveLength(0);
    expect(executions).toHaveLength(0);
  });
});
