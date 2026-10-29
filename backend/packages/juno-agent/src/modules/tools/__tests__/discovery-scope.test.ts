import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { selectDiscoveryScope } from '../tools/discoveryScope.js';
import { groupNamespaces } from '../tools/namespaceDirectory.js';

function tool(connectionId: string, connectionName: string, catalogId: string, account: string): Tool {
  return {
    name: 'mcp__' + connectionId + '__search', description: 'Search', parameters: { type: 'object' },
    replay: 'safe', sideEffect: false, mcp: true,
    origin: { connectionId, connectionName, catalogId, account, toolName: 'search', access: 'read' },
    execute: async () => ({ content: [] }),
  };
}

function groups(tools: Tool[]) {
  return groupNamespaces(tools);
}

describe('explicit MCP discovery scope', () => {
  const tools = [
    tool('mail-work', 'Mail', 'mail', 'Work'),
    tool('mail-me', 'Mail', 'mail', 'Personal'),
    tool('gmail-work', 'Gmail', 'gmail', 'Work'),
    tool('notion', 'Notion', 'notion', 'Team'),
    tool('google-cal', 'Google Calendar', 'google-calendar', 'Work'),
    tool('outlook-cal', 'Outlook Calendar', 'outlook-calendar', 'Work'),
  ];
  const keys = (query: string) => selectDiscoveryScope(groups(tools), query)?.groups.map((group) => group.key) ?? [];

  it('keeps all accounts for an app and narrows an app plus short account label to that account', () => {
    expect(keys('Read Mail')).toEqual(expect.arrayContaining(['mcp:mail-work', 'mcp:mail-me']));
    expect(keys('Read Mail Personal')).toEqual(['mcp:mail-me']);
    expect(keys('Read Gmail Work')).toEqual(['mcp:gmail-work']);
  });

  it('accepts several explicitly named apps without widening to every connection', () => {
    expect(keys('Move notes from Notion into Gmail Work')).toEqual(expect.arrayContaining(['mcp:notion', 'mcp:gmail-work']));
    expect(keys('Move notes from Notion into Gmail Work')).not.toContain('mcp:mail-work');
  });

  it('does not treat a generic account label or an ambiguous calendar word as an app request', () => {
    expect(keys('make this work')).toEqual([]);
    expect(keys('check my calendar')).toEqual([]);
    expect(keys('Google Calendar')).toEqual(['mcp:google-cal']);
  });

  it('matches a Latin app label beside CJK text without splitting or executing candidate text', () => {
    expect(keys('用Notion查资料')).toEqual(['mcp:notion']);
  });

  it('uses an available catalog alias when it differs from the connection label', () => {
    const scoped = tool('mailbox-1', 'Mailbox', 'gmail', 'Work');
    expect(selectDiscoveryScope(groups([scoped]), 'Search Gmail')?.groups.map((group) => group.key)).toEqual(['mcp:mailbox-1']);
  });
});
