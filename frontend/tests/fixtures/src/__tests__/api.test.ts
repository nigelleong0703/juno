import { describe, expect, it } from 'vitest';
import { EventType, type AgentEvent } from '@agent-desktop/client';
import { createMockClient } from '../index.js';

const NOW = Date.UTC(2026, 9, 5, 4, 30, 0);
const make = () => createMockClient({ clock: () => NOW, seed: 7 });

describe('list filters, sorting and cursor pagination', () => {
  it('paginates with a cursor and no overlap', async () => {
    const client = make();
    const first = await client.plugins.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await client.plugins.list({ limit: 2, cursor: first.nextCursor });
    const firstIds = first.items.map((p) => p.id);
    const secondIds = second.items.map((p) => p.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('filters by typed params', async () => {
    const client = make();
    const installed = await client.plugins.list({ installed: true });
    expect(installed.items).toHaveLength(8);
    expect(installed.items.every((p) => p.installed)).toBe(true);

    const engineering = await client.plugins.list({ filter: { category: 'Engineering' } });
    expect(engineering.items.length).toBeGreaterThan(0);
    expect(engineering.items.every((p) => p.category === 'Engineering')).toBe(true);

    const running = await client.runs.list({ status: 'running' });
    expect(running.items.length).toBeGreaterThan(0);
    expect(running.items.every((r) => r.status === 'running')).toBe(true);

    const junoRuns = await client.runs.list({ agentId: 'agent-juno' });
    expect(junoRuns.items.every((r) => r.agentId === 'agent-juno')).toBe(true);
  });

  it('scopes the library list to one conversation before pagination', async () => {
    const client = make();
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (;;) {
      const page = await client.library.list({ conversationId: 'conv-juno', limit: 2, cursor });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.conversationId === 'conv-juno')).toBe(true);
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const global = await client.library.list({ limit: 100 });
    expect(global.items.length).toBeGreaterThan(seen.length);
    expect(global.items.some((item) => item.conversationId === undefined)).toBe(true);
  });

  it('sorts descending by default and ascending on request', async () => {
    const client = make();
    const desc = await client.requests.list({ limit: 20 });
    const times = desc.items.map((r) => Date.parse(r.createdAt));
    const sortedDesc = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sortedDesc);

    const asc = await client.agents.list({ order: 'asc' });
    const names = asc.items.map((a) => a.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('puts the newly created agent at the top of the chat list', async () => {
    const client = make();
    const list = await client.conversations.list({ limit: 10 });
    expect(list.items).toHaveLength(9);
    expect(list.items[0]?.id).toBe('conv-new');
  });

});

describe('requests.resolve', () => {
  it('updates the request, removes it from pending, and emits request.resolved', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const pendingBefore = await client.requests.list({ status: 'pending' });
    expect(pendingBefore.items).toHaveLength(8);
    const target = pendingBefore.items.find((r) => r.id === 'req-juno-email');
    expect(target).toBeDefined();

    await client.requests.resolve('req-juno-email', { action: 'approve', scope: 'once' });

    const resolved = await client.requests.get('req-juno-email');
    expect(resolved.status).toBe('approved');
    expect(resolved.decision?.mode).toBe('manual');
    expect(resolved.decision?.scope).toBe('once');
    expect(resolved.decision?.by).toBe('member-robin');

    const pendingAfter = await client.requests.list({ status: 'pending' });
    expect(pendingAfter.items.map((r) => r.id)).not.toContain('req-juno-email');
    expect(pendingAfter.items).toHaveLength(7);

    const resolvedEvents = events.filter((e) => e.type === 'request.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({ type: 'request.resolved' });
    const event = resolvedEvents[0];
    if (event && event.type === 'request.resolved') {
      expect(event.request.id).toBe('req-juno-email');
      expect(event.request.status).toBe('approved');
    }

    // an audit row was appended
    const audit = await client.audit.list({ limit: 5 });
    expect(audit.items[0]?.requestId).toBe('req-juno-email');
  });

  it('answers a question and denies an approval', async () => {
    const client = make();
    const answered = await client.requests.resolve('req-juno-question', {
      action: 'answer',
      answers: { 'q-baseline': 'balanced' },
    });
    expect(answered.status).toBe('answered');
    if (answered.payload.kind === 'question') {
      expect(answered.payload.answers?.['q-baseline']).toBe('balanced');
    }

    const denied = await client.requests.resolve('req-patch-install', { action: 'deny', note: 'Use the CI runner instead.' });
    expect(denied.status).toBe('denied');
    expect(denied.decision?.note).toBe('Use the CI runner instead.');

    const pending = await client.requests.list({ status: 'pending' });
    expect(pending.items.map((r) => r.id).sort()).toEqual(
      ['req-juno-email', 'req-juno-signin', 'req-ledger-stripe', 'req-atlas-travel', 'req-juno-secure', 'req-patch-computer'].sort(),
    );
  });

  it('resolving a request twice is a no-op', async () => {
    const client = make();
    await client.requests.resolve('req-ledger-stripe', { action: 'approve', scope: 'once' });
    const again = await client.requests.resolve('req-ledger-stripe', { action: 'deny' });
    expect(again.status).toBe('approved');
  });
});

describe('computer control', () => {
  it('takeOver / returnControl update the controller and emit computer.state', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    // Use agent-juno's computer
    const computers = await client.computers.list({ agentId: 'agent-juno' });
    const computerId = computers.items[0]?.id;
    expect(computerId).toBeDefined();

    const taken = await client.computers.takeOver(computerId!);
    expect(taken.controller).toBe('user');
    const returned = await client.computers.returnControl(computerId!);
    expect(returned.controller).toBe('agent');

    const states = events.filter((e) => e.type === 'computer.state');
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ type: 'computer.state', computerId: computerId, controller: 'user' });
    expect(states[1]).toMatchObject({ type: 'computer.state', computerId: computerId, controller: 'agent' });

    // handoff markers were posted to Juno's direct conversation
    const junoItems = await client.conversations.items('conv-juno');
    const handoffs = junoItems.items.filter((i) => i.type === 'handoff');
    expect(handoffs.map((h) => (h.type === 'handoff' ? h.direction : ''))).toContain('to_user');
    expect(handoffs.map((h) => (h.type === 'handoff' ? h.direction : ''))).toContain('to_agent');
  });

  it('pause / resume / reboot emit the matching states', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    // Use agent-juno's computer
    const computers = await client.computers.list({ agentId: 'agent-juno' });
    const computerId = computers.items[0]?.id;
    expect(computerId).toBeDefined();

    expect((await client.computers.pause(computerId!)).state).toBe('paused');
    expect((await client.computers.resume(computerId!)).state).toBe('running');
    const rebooting = await client.computers.reboot(computerId!);
    expect(rebooting.state).toBe('rebooting');

    const states = events
      .filter((e) => e.type === 'computer.state')
      .map((e) => (e.type === 'computer.state' ? e.state : ''));
    expect(states).toEqual(['paused', 'running', 'rebooting']);
  });
});

describe('sending messages and mutations', () => {
  it('send posts a user item, starts a run and emits events', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const result = await client.conversations.send('conv-juno', {
      text: 'Can you also check the memory overhead numbers?',
      mentions: [{ kind: 'agent', id: 'agent-juno', label: '@Juno' }],
      options: { model: 'claude-opus-4-6', background: true },
    });
    expect(result.item.type).toBe('user_message');
    expect(result.runId).toEqual(expect.any(String));
    const run = await client.runs.get(result.runId as string);
    expect(run.status).toBe('running');
    expect(run.kind).toBe('background');

    const types = events.map((e) => e.type);
    expect(types).toContain('item.added');
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain('agent.status');
  });

  it('stop ends a run', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));
    const stopped = await client.runs.stop('run-pr-review');
    expect(stopped.status).toBe('stopped');
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
    expect(finished).toBeDefined();
    if (finished?.type === EventType.RUN_FINISHED) expect(finished.outcome).toEqual({ type: 'cancelled' });
  });

  it('routine toggle flips status and emits routine.updated', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));
    const off = await client.routines.toggle('routine-inbox-triage', false);
    expect(off.enabled).toBe(false);
    expect(off.status).toBe('paused');
    const on = await client.routines.toggle('routine-inbox-triage');
    expect(on.enabled).toBe(true);
    expect(events.filter((e) => e.type === 'routine.updated')).toHaveLength(2);
  });

  it('rule drafts can be accepted or rejected', async () => {
    const client = make();
    const accepted = await client.rules.acceptDraft('rule-draft-priya');
    expect(accepted.source).toBe('user');
    expect(accepted.enabled).toBe(true);
    await client.rules.rejectDraft('rule-draft-sentry');
    const drafts = await client.rules.list({ source: 'agent_draft' });
    expect(drafts.items).toHaveLength(0);
  });

  it('forgetting a claim retracts it and removes its lines', async () => {
    const client = make();
    const result = await client.memory.forget({ claimIds: ['claim-01'] });
    expect(result).toEqual({ retracted: 1, removedLines: 1 });
    const active = await client.memory.claims({ status: 'active' });
    expect(active.claims.map((c) => c.id)).not.toContain('claim-01');
    const { files } = await client.home.list('MEMORY.md');
    expect(files[0]?.content).not.toContain('claim-01');
  });

  it('plugins install and tool permissions change', async () => {
    const client = make();
    const installed = await client.plugins.install('plugin-figma');
    expect(installed.installed).toBe(true);
    const updated = await client.plugins.setToolPermission({
      pluginId: 'plugin-gmail',
      toolId: 'send_email',
      permission: 'always',
    });
    const tool = updated.tools.find((t) => t.name === 'send_email');
    expect(tool?.permission).toBe('always');
  });

  it('creates a blank agent with its own thread and greeting', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const created = await client.agents.create({ name: 'New agent' });
    expect(created.name).toBe('New agent');
    expect(created.title).toBe('New agent');
    expect((await client.home.list(`agents/${created.id}/`)).files).toEqual([]);
    expect(created.status).toBe('idle');
    expect(created.createdBy).toBe('member-robin');
    expect(events.some((e) => e.type === 'agent.created')).toBe(true);

    // The new agent joins the one shared computer.
    const computers = await client.computers.list({ agentId: created.id });
    expect(computers.items).toHaveLength(1);
    expect(computers.items[0]?.agentIds).toContain(created.id);

    // Its conversation contains only the greeting.
    const convs = await client.conversations.list({ agentId: created.id });
    expect(convs.items).toHaveLength(1);
    const conv = convs.items[0];
    expect(conv).toBeDefined();
    const rows = await client.conversations.items(conv!.id);
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.type).toBe('agent_message');
    expect(events.some((e) => e.type === 'item.added')).toBe(true);

    const updated = await client.agents.update(created.id, { section: 'Work' });
    expect(updated.section).toBe('Work');
  });

  it('sending the first message to a blank agent proposes a setup', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const created = await client.agents.create({ name: 'New agent' });
    const convs = await client.conversations.list({ agentId: created.id });
    const conv = convs.items[0]!;

    await client.conversations.send(conv.id, { text: 'You’ll help me with research.' });

    // No run started; instead a question request offering name/avatar/focus/routine.
    const pending = await client.requests.list({ status: 'pending' });
    const setup = pending.items.find((r) => r.agentId === created.id);
    expect(setup?.kind).toBe('question');
    expect(setup?.id.startsWith('req-setup-')).toBe(true);
    if (setup?.payload.kind === 'question') {
      const block = setup.payload.ui.blocks[0];
      const ids = block?.type === 'fields' ? block.fields.map((f) => f.id) : [];
      expect(ids).toContain('setup-name');
      expect(ids).toContain('setup-avatar');
      expect(ids).toContain('setup-focus');
    }

    await client.requests.resolve(setup!.id, {
      action: 'answer',
      answers: {
        'setup-name': 'Nova',
        'setup-avatar': 'Diamond',
        'setup-focus': 'Research & inbox',
        'setup-routine': 'None yet',
      },
    });

    const agent = await client.agents.get(created.id);
    expect(agent.name).toBe('Nova');
    expect(agent.avatar.shape).toBe('diamond');
    expect(agent.title).toBe('Research & inbox');
    expect(agent.pluginIds.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'agent.updated')).toBe(true);

    const renamed = await client.conversations.get(conv.id);
    expect(renamed.title).toBe('Nova');
  });

  it('posts a request item into the transcript when a request is created', async () => {
    const client = make();
    const created = await client.agents.create({ name: 'New agent' });
    const conv = (await client.conversations.list({ agentId: created.id })).items[0]!;

    await client.conversations.send(conv.id, { text: 'You’ll help me with research.' });

    const pending = await client.requests.list({ status: 'pending' });
    const setup = pending.items.find((r) => r.agentId === created.id)!;
    const rows = await client.conversations.items(conv.id);
    const requestItem = rows.items.find((i) => i.type === 'request');
    expect(requestItem).toBeDefined();
    if (requestItem?.type === 'request') expect(requestItem.requestId).toBe(setup.id);
  });
});

describe('conversations.create', () => {
  it('starts a room with a default title from its members and emits conversation.created', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const room = await client.conversations.create({
      kind: 'room',
      memberAgentIds: ['agent-juno', 'agent-patch', 'agent-echo'],
    });
    expect(room.kind).toBe('room');
    expect(room.title).toBe('Juno, Patch & Echo');
    expect(room.agentIds).toEqual(['agent-juno', 'agent-patch', 'agent-echo']);
    expect(room.memberIds).toContain('member-robin');
    expect(events.some((e) => e.type === 'conversation.created')).toBe(true);

    const list = await client.conversations.list({ limit: 20 });
    expect(list.items.map((c) => c.id)).toContain(room.id);
  });

  it('honours an explicit room title and posts the first message into the transcript', async () => {
    const client = make();
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));

    const room = await client.conversations.create({
      kind: 'room',
      memberAgentIds: ['agent-atlas', 'agent-ledger'],
      title: 'Trip planning',
      firstMessage: { text: 'Can you two sync on the Lisbon budget?' },
    });
    expect(room.title).toBe('Trip planning');

    const rows = await client.conversations.items(room.id);
    expect(rows.items[0]?.type).toBe('user_message');
    expect(events.some((e) => e.type === 'item.added')).toBe(true);
  });

  it('returns the agent’s existing direct thread instead of a duplicate', async () => {
    const client = make();
    const existing = await client.conversations.create({ kind: 'direct', memberAgentIds: ['agent-juno'] });
    expect(existing.id).toBe('conv-juno');

    const directs = await client.conversations.list({ kind: 'direct', limit: 20 });
    expect(directs.items.filter((c) => c.agentIds.includes('agent-juno'))).toHaveLength(1);
  });
});

describe('agents.plans', () => {
  it('derives the agent plan from the real seeded plan items only', async () => {
    const client = make();
    const juno = await client.agents.plans('agent-juno');
    expect(juno.nextCursor).toBeNull();
    const plan = juno.items.find((item) => item.id === 'item-juno-04');
    expect(plan).toBeDefined();
    expect(plan?.conversationId).toBe('conv-juno');
    expect(plan?.todos.some((todo) => todo.status === 'in_progress')).toBe(true);
  });

  it('never fabricates tasks for an agent with no plan', async () => {
    const client = make();
    const patch = await client.agents.plans('agent-patch');
    expect(patch.items).toEqual([]);
  });
});
