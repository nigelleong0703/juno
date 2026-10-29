// CORE-02/05 + CORE-16~21: the system message is assembled in one fixed order, and the owner's
// USER.md plus the agent's IDENTITY / SOUL / AGENTS.md (from the home mirror) are injected into it.
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@agent-desktop/public-contracts';
import { buildContext, buildDateSection, buildRunStartLine } from '../context.js';
import { connectClient, resetPresence } from '../../presence.js';
import { settingsIdFor } from '../model-selection.js';
import { AGENT, conversationDoc, seed, wakeFor } from './agent-resources.fixtures.js';
import { newRow, putRow } from '../../../modules/home/mirror.js';
import { agentFilePath } from '../../../modules/home/paths.js';
import type { MemoryPort } from '../../../modules/memory/port.js';
import { portOf, startMemoryGraph } from '../../../modules/memory/__tests__/memory-graph-fixture.js';
import { contextText } from './context-text.js';
import { harnessText } from '../../../modules/harness/loader.js';

function settingsRow(): AppSettings & { id: string } {
  return {
    id: settingsIdFor('owner-1'),
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: '#0066cc' },
    notifications: [],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: 'http://localhost:8787', modelProviders: [] },
    privacy: { dataRetentionDays: 90, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  };
}

const NOW = '2026-10-12T00:00:00.000Z';

const OWNER = 'owner-1';
const STRANGER = 'ext-discord-0123456789abcdef';

// Each call is a fresh session: the system message is frozen per session, so an edit only reaches an existing one as a note.
// `owner` is the owner's own chat with the agent; `stranger` is a room the owner shares with someone else, woken by that person.
let sessions = 0;
// `chat` overrides fields of the conversation record (a platform-bound chat carries its kind, memberIds and channel).
// `memory` is the memory graph the Memory section reads (the items); absent, the section is not built.
async function systemOf(store: Awaited<ReturnType<typeof seed>>, who: 'owner' | 'stranger' = 'owner', chat: Record<string, unknown> = {}, memory?: MemoryPort): Promise<string> {
  sessions += 1;
  const conversationId = 'conv-' + String(sessions);
  await store.patch('agents', AGENT, { createdBy: OWNER });
  const base = who === 'owner'
    ? conversationDoc(conversationId, [AGENT])
    : { ...conversationDoc(conversationId, [AGENT]), kind: 'room', memberIds: [OWNER, STRANGER] };
  await store.put('conversations', { ...base, ...chat } as never);
  const ctx = await buildContext(store, {
    agentId: AGENT, conversationId, sessionKey: AGENT + ':' + conversationId,
    wake: [{ ...wakeFor(AGENT), conversationId, sessionKey: AGENT + ':' + conversationId, origin: { type: 'user', id: who === 'owner' ? OWNER : STRANGER }, trusted: who === 'owner' }],
    ...(memory === undefined ? {} : { home: { memory } }),
  });
  return contextText(ctx);
}

describe('system context assembly order', () => {
  it('omits each identity text that is empty, and all when the home has no files', async () => {
    const store = await seed();
    await store.put('settings', settingsRow());
    const content = await systemOf(store);
    expect(content).not.toContain('## About the user');
    // No persona and no principles from the owner: the default persona speaks instead.
    expect(content).toContain('## Agent persona (default)\n' + harnessText('persona.default'));
    expect(content).not.toContain('## Agent persona (written by the user)');
    expect(content).not.toContain('## Agent principles and tone');
    expect(content).not.toContain('## Agent working instructions');

    await putRow(store, newRow('owner-1', agentFilePath(AGENT, 'SOUL.md'), 'ONLY-PRINCIPLES', 'user', NOW));
    await putRow(store, newRow('owner-1', agentFilePath(AGENT, 'AGENTS.md'), '   ', 'user', NOW));
    const partial = await systemOf(store);
    expect(partial).toContain('## Agent principles and tone (written by the user)\nONLY-PRINCIPLES');
    // The owner's own principles replace the default persona entirely (never mixed).
    expect(partial).not.toContain('## Agent persona');
    expect(partial).not.toContain('## Agent working instructions');
  });

  it('injects USER.md, the AGENTS.md working instructions and its reach-out section, and the learned alignment', async () => {
    const store = await seed();
    await putRow(store, newRow('owner-1', 'USER.md', 'I live in Lisbon.', 'user', NOW));
    await putRow(store, newRow('owner-1', 'ALIGNMENT_SYNTHESIS.md', 'Keep it short.', 'platform', NOW));
    await putRow(store, newRow('owner-1', agentFilePath(AGENT, 'AGENTS.md'), 'Do the work.\n\n## When to reach out\nOnly for emergencies.', 'user', NOW));
    const content = await systemOf(store);
    expect(content).toContain('## About the user (written by the user)\nI live in Lisbon.');
    expect(content).toContain('## Agent working instructions (written by the user)\nDo the work.');
    expect(content).toContain('## When to reach out to the user (written by the user)\nOnly for emergencies.');
    expect(content).toContain('## How this user likes to be answered (learned)\nKeep it short.');
    expect(content.indexOf('About the user')).toBeLessThan(content.indexOf('How this user likes'));
  });

  it('keeps the owner\'s private texts out of a run that includes anyone else, and says so in "Where you are"', async () => {
    const store = await seed();
    await putRow(store, newRow(OWNER, 'USER.md', 'I live in Lisbon.', 'user', NOW));
    await putRow(store, newRow(OWNER, 'PROACTIVE_PREFERENCES.md', 'Never tell me about football.', 'user', NOW));
    await putRow(store, newRow(OWNER, 'ALIGNMENT_SYNTHESIS.md', 'Keep it short.', 'platform', NOW));
    await putRow(store, newRow(OWNER, agentFilePath(AGENT, 'AGENTS.md'), 'Do the work.', 'user', NOW));
    const notice = "The private memory of the person you're helping is not loaded here";
    const graph = await startMemoryGraph();
    try {
      await graph.graph.items.addItem(OWNER, { text: 'Allergic to peanuts.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });

      const dm = await systemOf(store, 'owner', {}, portOf(graph, store));
      for (const kept of ['I live in Lisbon.', 'Keep it short.', 'Allergic to peanuts.', '## Memory']) expect(dm).toContain(kept);
      // The proactive rules are never part of the frozen prompt: they ride in the text of the automatic wakes that decide to message.
      expect(dm).not.toContain('Never tell me about football.');
      expect(dm).not.toContain('Proactive preferences (');
      expect(dm).not.toContain(notice);

      // The room where a stranger woke the agent: persona and instructions stay, the owner's own texts do not.
      const room = await systemOf(store, 'stranger', {}, portOf(graph, store));
      for (const gone of ['I live in Lisbon.', 'Never tell me about football.', 'Keep it short.', 'Allergic to peanuts.', '## Memory', '## About the user', 'How this user likes to be answered']) expect(room).not.toContain(gone);
      expect(room).toContain('## Agent working instructions (written by the user)\nDo the work.');
      expect(room.split(notice)).toHaveLength(2);
      // The section says how to answer the owner privately and what a stranger asking for the owner's things gets (the notice moved out of the persona text).
      expect(room).toContain('## Where you are');
      expect(room).toContain("pass it on with send_message toOwner:true and a one-line note (not the answer). You'll answer in your private chat with");
      expect(room).toContain('need their approval');
      expect(room.split('## Where you are')).toHaveLength(2);
    } finally {
      await graph.close();
    }
  }, 60_000);

  it('keeps the owner\'s private texts and goals out of a platform room the owner woke, and keeps them in the owner\'s own platform chat', async () => {
    const store = await seed();
    await putRow(store, newRow(OWNER, 'USER.md', 'I live in Lisbon.', 'user', NOW));
    await putRow(store, newRow(OWNER, 'ALIGNMENT_SYNTHESIS.md', 'Keep it short.', 'platform', NOW));
    await store.put('goals', { id: 'goal-1', agentId: AGENT, ownerId: OWNER, title: 'Learn Japanese', summary: 'Daily practice', status: 'active', createdAt: NOW, updatedAt: NOW } as never);
    const graph = await startMemoryGraph();
    try {
      await graph.graph.items.addItem(OWNER, { text: 'Allergic to peanuts.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
      // A Discord room: the record lists only the owner, but everyone in the room reads the replies.
      const platform = { kind: 'discord', channelId: 'G1.agent-alpha', threadId: 'C1', chatId: 'C1' };
      const room = await systemOf(store, 'owner', { kind: 'room', memberIds: [OWNER], channel: platform }, portOf(graph, store));
      for (const gone of ['I live in Lisbon.', 'Keep it short.', 'Allergic to peanuts.', '## Memory', '## About the user', 'How this user likes to be answered', 'Learn Japanese']) expect(room).not.toContain(gone);
      expect(room).toContain("The private memory of the person you're helping is not loaded here");

      const dm = await systemOf(store, 'owner', { kind: 'direct', memberIds: [OWNER], channel: platform }, portOf(graph, store));
      for (const kept of ['I live in Lisbon.', 'Keep it short.', 'Allergic to peanuts.', 'Learn Japanese']) expect(dm).toContain(kept);
      expect(dm).not.toContain('is not loaded here');
    } finally {
      await graph.close();
    }
  }, 60_000);
  it('states the weekday and date (no minute) in the user timezone, or UTC and that the timezone is unknown', async () => {
    const store = await seed();
    const at = new Date('2026-10-12T05:30:00Z');
    expect(await buildDateSection(store, 'owner-1', at)).toBe('## Current date\nToday for the user: Monday 2026-10-12, UTC (the user\'s timezone is unknown).');
    await store.put('settings', { ...settingsRow(), general: { ...settingsRow().general, timezone: 'Asia/Singapore' } });
    expect(await buildDateSection(store, 'owner-1', at)).toBe('## Current date\nToday for the user: Monday 2026-10-12, Asia/Singapore (GMT+08:00).');
    expect(await systemOf(store)).toContain('## Current date\nToday for the user: ');
    await store.put('settings', { ...settingsRow(), general: { ...settingsRow().general, timezone: 'Asia/Singapore', locale: 'en-SG' } });
    expect(await buildDateSection(store, 'owner-1', at)).toContain("\nTheir device locale: en-SG (Singapore); use its currency, units and date format unless asked otherwise.");
  });

  it('puts the exact time, presence and the wake (never its id) in the run-start line', async () => {
    const store = await seed();
    const at = new Date('2026-10-12T05:30:00Z');
    await store.put('settings', { ...settingsRow(), general: { ...settingsRow().general, timezone: 'Asia/Singapore' } });
    const wake = wakeFor(AGENT);
    const line = await buildRunStartLine(store, 'owner-1', AGENT, [wake], at);
    expect(line).toContain('Run started Monday 2026-10-12 13:30, Asia/Singapore (GMT+08:00).');
    expect(line).toContain('Woken by: kind ');
    expect(line).not.toContain(wake.id);
    const leave = await connectClient(store, 'owner-1', 'ios');
    expect(await buildRunStartLine(store, 'owner-1', AGENT, [wake], at)).toContain('The user has the iPhone app open right now.');
    await leave();
    resetPresence();
  });
});
