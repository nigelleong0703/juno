/**
 * The agent package is an allowlist. The source below carries every kind of field the package must never share (memory, people, accounts,
 * credentials, conversations, ids, targets, usage counters); the test fails if any of them, or any key outside the allowlist, reaches the output.
 */
import { describe, expect, it } from 'vitest';
import { buildAgentPackage, type PackageSource } from '../package.js';

const FORBIDDEN_VALUES = ['MEM-SECRET', 'jane@example.com', 'Jane Doe', 'sk-live-123', 'oauth-token', 'agt-private', 'owner-private', 'conv-private', 'chat-target-99', 'ver-private'];

/** Every key the package may contain. Anything else in the output is a leak. */
const ALLOWED_KEYS = new Set([
  'agent', 'name', 'description', 'persona', 'instructions',
  'skills', 'deps', 'type',
  'routines', 'schedule', 'cron', 'human', 'tz',
  'connectors', 'catalogId',
]);

function keysOf(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

/** A source with everything that must not leave the owner's account next to what may. */
const polluted = {
  agent: {
    name: 'Nova',
    description: 'Helps with the weekly report.',
    persona: 'Calm and direct.',
    instructions: 'Write three bullets.',
    id: 'agt-private',
    ownerId: 'owner-private',
    memory: [{ text: 'MEM-SECRET the owner is in Berlin' }],
    people: [{ name: 'Jane Doe', email: 'jane@example.com' }],
    accounts: [{ handle: 'jane@example.com' }],
    apiKey: 'sk-live-123',
    credentials: { token: 'oauth-token' },
    conversations: [{ id: 'conv-private' }],
    knowledgeFiles: ['notes/private.md'],
  },
  skills: [
    {
      name: 'Weekly report',
      description: 'Draft the weekly report.',
      instructions: 'Read the sheet, then write three bullets.',
      deps: [{ type: 'tool' as const, name: 'sheet_read', schemaHash: 'abc' }, { type: 'connector' as const, catalogId: 'google-sheets' }, { type: 'connector' as const, catalogId: 'google-sheets' }],
      id: 'skl-private',
      versionId: 'ver-private',
      used: 12,
      helpful: 4,
      harmful: 1,
      ownerId: 'owner-private',
    },
  ],
  routines: [
    {
      id: 'rtn-private',
      agentId: 'agt-private',
      name: 'Monday report',
      instructions: 'Send the report.',
      schedule: { cron: '0 9 * * 1', human: 'Mondays 9:00', tz: 'Europe/Berlin', endDate: '2027-01-01' },
      delivery: { channel: 'email', target: 'chat-target-99' },
      recipient: 'jane@example.com',
      webhookSecretHash: 'hash-private',
    },
  ],
};

describe('buildAgentPackage (allowlist)', () => {
  const built = buildAgentPackage(polluted as PackageSource);
  const json = JSON.stringify(built);

  it('contains only allowlisted keys, at every depth', () => {
    const outside = [...keysOf(built, new Set())].filter((key) => !ALLOWED_KEYS.has(key));
    expect(outside).toEqual([]);
  });

  it('never carries a forbidden value', () => {
    for (const value of FORBIDDEN_VALUES) expect(json).not.toContain(value);
  });

  it('keeps what a package is for: the persona, the instructions, the skill text and the schedule', () => {
    expect(built.agent).toEqual({ name: 'Nova', description: 'Helps with the weekly report.', persona: 'Calm and direct.', instructions: 'Write three bullets.' });
    expect(built.skills).toEqual([{
      name: 'Weekly report',
      description: 'Draft the weekly report.',
      instructions: 'Read the sheet, then write three bullets.',
      deps: [{ type: 'tool', name: 'sheet_read' }, { type: 'connector', catalogId: 'google-sheets' }, { type: 'connector', catalogId: 'google-sheets' }],
    }]);
    expect(built.routines).toEqual([{ name: 'Monday report', instructions: 'Send the report.', schedule: { cron: '0 9 * * 1', human: 'Mondays 9:00', tz: 'Europe/Berlin' } }]);
  });

  it('lists each connector once, in order, and drops the usage counters and pinned hashes', () => {
    expect(built.connectors).toEqual(['google-sheets']);
    expect(json).not.toContain('"used"');
    expect(json).not.toContain('schemaHash');
  });
});
