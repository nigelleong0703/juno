import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import {
  aliasToolNamesInMessages,
  aliasToolNamesInResult,
  createToolNameAliases,
} from '../toolNames.js';

const SANDBOX_NAMES = [
  'shell.run', 'computer.screenshot', 'computer.click', 'computer.move', 'computer.type',
  'computer.key', 'computer.scroll', 'browser.navigate', 'files.read', 'files.write',
];

describe('model tool-name aliases', () => {
  it('maps dotted sandbox names to OpenAI-valid names and back', () => {
    const aliases = createToolNameAliases(SANDBOX_NAMES);
    for (const name of SANDBOX_NAMES) {
      const protocol = aliases.toProtocol(name);
      expect(protocol).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(aliases.fromProtocol(protocol)).toBe(name);
    }
    expect(aliases.toProtocol('shell.run')).toBe('shell_run');
  });

  it('keeps dotted and underscored names distinct instead of colliding', () => {
    const aliases = createToolNameAliases(['foo.bar', 'foo_bar']);
    const dotted = aliases.toProtocol('foo.bar');
    const underscored = aliases.toProtocol('foo_bar');
    expect(underscored).toBe('foo_bar');
    expect(dotted).not.toBe(underscored);
    expect(aliases.fromProtocol(dotted)).toBe('foo.bar');
    expect(aliases.fromProtocol(underscored)).toBe('foo_bar');
  });

  it('keeps a dotted/underscored collision consistent across replayed history and the returned call', () => {
    const aliases = createToolNameAliases(['foo_bar', 'foo.bar']);
    const dotted = aliases.toProtocol('foo.bar');
    expect(aliases.toProtocol('foo_bar')).toBe('foo_bar');
    expect(dotted).toBe('foo_bar_1');
    const assistant = {
      role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'm',
      content: [{ type: 'toolCall', id: 'c1', name: 'foo.bar', arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 1,
    } satisfies AssistantMessage;
    const toolResult: Message = { role: 'toolResult', toolCallId: 'c1', toolName: 'foo.bar',
      content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 };
    const [assistantOut, resultOut] = aliasToolNamesInMessages([assistant, toolResult], aliases);
    expect(assistantOut).toMatchObject({ content: [{ name: 'foo_bar_1' }] });
    expect(resultOut).toMatchObject({ toolName: 'foo_bar_1' });
    const returned = { ...assistant, content: [{ type: 'toolCall', id: 'c1', name: dotted, arguments: {} }] } satisfies AssistantMessage;
    expect(aliasToolNamesInResult(returned, aliases).content[0]).toMatchObject({ name: 'foo.bar' });
  });

  it('deterministically truncates over-long names to the 64-char limit', () => {
    const long = `sandbox.${'x'.repeat(120)}`;
    const first = createToolNameAliases([long]).toProtocol(long);
    const second = createToolNameAliases([long]).toProtocol(long);
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(createToolNameAliases([long]).fromProtocol(first)).toBe(long);
  });

  it('fails clearly when the model returns a tool the registry does not know', () => {
    const aliases = createToolNameAliases(['shell.run']);
    expect(() => aliases.fromProtocol('rm_rf')).toThrow(/unknown tool/);
  });

  it('still sanitizes a name that is no longer in the registry, without stealing a registered alias', () => {
    const aliases = createToolNameAliases(['foo_bar']);
    const stale = aliases.toProtocol('foo.bar');
    expect(stale).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(stale).not.toBe('foo_bar');
  });

  it('rewrites tool-call and tool-result names in replayed history', () => {
    const aliases = createToolNameAliases(SANDBOX_NAMES);
    const assistant = {
      role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'm',
      content: [{ type: 'toolCall', id: 'call-1', name: 'shell.run', arguments: { command: 'ls' } }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 1,
    } satisfies AssistantMessage;
    const toolResult: Message = { role: 'toolResult', toolCallId: 'call-1', toolName: 'shell.run',
      content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 };
    const [assistantOut, resultOut] = aliasToolNamesInMessages([assistant, toolResult], aliases);
    expect(assistantOut).toMatchObject({ content: [{ name: 'shell_run' }] });
    expect(resultOut).toMatchObject({ toolName: 'shell_run' });
  });

  it('maps a provider result back to internal names for journaling', () => {
    const aliases = createToolNameAliases(SANDBOX_NAMES);
    const message = {
      role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'm',
      content: [{ type: 'toolCall', id: 'call-1', name: 'shell_run', arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 1,
    } satisfies AssistantMessage;
    const mapped = aliasToolNamesInResult(message, aliases);
    expect(mapped.content[0]).toMatchObject({ name: 'shell.run' });
  });

  it('leaves a screenshot image tool result unchanged while aliasing its name', () => {
    const aliases = createToolNameAliases(['computer.screenshot']);
    const imageResult: Message = { role: 'toolResult', toolCallId: 'c9', toolName: 'computer.screenshot',
      content: [{ type: 'text', text: 'Captured screen' },
        { type: 'image', data: 'png-base64', mimeType: 'image/png' }], isError: false, timestamp: 5 };
    const [out] = aliasToolNamesInMessages([imageResult], aliases);
    expect(out).toMatchObject({ toolName: 'computer_screenshot',
      content: [{ type: 'text', text: 'Captured screen' },
        { type: 'image', mimeType: 'image/png', data: 'png-base64' }] });
  });
});
