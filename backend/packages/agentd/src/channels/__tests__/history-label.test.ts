/**
 * Labelling of fetched group history: the shared bot posts every agent's replies, so lines posted by our own app are labelled by the
 * agent they were posted as, and the bare bot name is never shown.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '@agent-desktop/channels/types';
import { labelHistory, type HistoryIdentity } from '../history.js';

const who: HistoryIdentity = { botUserId: 'BOT', webhookIds: new Set(['W1', 'W2']), selfName: 'Nova', otherAgentNames: new Set(['Rex']) };
const msg = (author: ChannelMessage['author'], text: string): ChannelMessage => ({ id: '1', at: '', text, author });

describe('labelHistory', () => {
  it('labels this agent\'s own webhook post "you (Name)"', () => {
    expect(labelHistory([msg({ id: 'W1', name: 'Nova', isBot: true, webhookId: 'W1' }, 'hello')], who)).toEqual(['you (Nova): hello']);
  });

  it('labels another agent of the same install by its name', () => {
    expect(labelHistory([msg({ id: 'W2', name: 'Rex', isBot: true, webhookId: 'W2' }, 'hi')], who)).toEqual(['Rex: hi']);
  });

  it('keeps a stranger\'s own name, even when it is "Juno"', () => {
    expect(labelHistory([msg({ id: 'U9', name: 'Juno', isBot: false }, 'hey')], who)).toEqual(['Juno: hey']);
  });

  it('never shows the bare bot name for the bot user\'s own messages', () => {
    const lines = labelHistory([msg({ id: 'BOT', name: 'Juno', isBot: true }, 'x')], who);
    expect(lines).toEqual(['another agent: x']);
    expect(lines.join('\n')).not.toMatch(/^Juno:/);
  });

  it('counts an unattributable bot-user message as this agent\'s when it is the install\'s only agent', () => {
    expect(labelHistory([msg({ id: 'BOT', name: 'Juno', isBot: true }, 'x')], { ...who, otherAgentNames: new Set() })).toEqual(['you (Nova): x']);
  });

  it('does not treat a webhook of another install as ours', () => {
    expect(labelHistory([msg({ id: 'W9', name: 'Nova', isBot: true, webhookId: 'W9' }, 'x')], who)).toEqual(['Nova: x']);
  });
});
