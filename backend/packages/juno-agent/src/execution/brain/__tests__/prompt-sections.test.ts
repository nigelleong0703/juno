// Plugin prompt sections (agentd plugin host `ctx.prompt.section`): static text handed to the brain once, appended to the frozen
// rules of every session's system message, before the agent's own texts, in the order given.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../context.js';
import { AGENT, conversationDoc, seed, wakeFor } from './agent-resources.fixtures.js';
import { contextText } from './context-text.js';

let sessions = 0;
async function systemOf(promptSections?: readonly string[]): Promise<string> {
  const store = await seed();
  sessions += 1;
  const conversationId = 'conv-ps-' + String(sessions);
  await store.put('conversations', conversationDoc(conversationId, [AGENT]) as never);
  const sessionKey = AGENT + ':' + conversationId;
  const ctx = await buildContext(store, {
    agentId: AGENT, conversationId, sessionKey,
    wake: [{ ...wakeFor(AGENT), conversationId, sessionKey }],
    ...(promptSections === undefined ? {} : { promptSections }),
  });
  return contextText(ctx);
}

describe('plugin prompt sections', () => {
  it('sit in the frozen system message after the rules and before the agent texts, in the given order', async () => {
    const content = await systemOf(['## Alpha plugin\nalpha rules', '## Beta plugin\nbeta rules']);
    const at = (needle: string): number => content.indexOf(needle);
    expect(at('## Conflicts')).toBeGreaterThan(-1);
    expect(at('## Alpha plugin\nalpha rules')).toBeGreaterThan(at('## Conflicts'));
    expect(at('## Beta plugin\nbeta rules')).toBeGreaterThan(at('## Alpha plugin'));
    expect(at('## Agent:')).toBeGreaterThan(at('## Beta plugin'));
  });

  it('add nothing when no plugin offers one', async () => {
    expect(await systemOf()).not.toContain('plugin');
  });
});
