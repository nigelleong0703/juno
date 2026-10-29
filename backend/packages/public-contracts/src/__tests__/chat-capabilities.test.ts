// The capability registry: a platform's chats are what its adapter declared while it is registered; anything else gets text only.
// (What each platform declares is tested with the adapters, in packages/channels.)
import { describe, expect, it } from 'vitest';
import { chatCapabilities, declareCapabilities, NO_HISTORY, registerChatSurface, reactionAllowed } from '../models/chat-capabilities.js';

describe('chat capabilities', () => {
  it('a registered platform answers with its declaration and the grants of the app; taking it back leaves text only', () => {
    const off = registerChatSurface('irc', (grants) => declareCapabilities({ history: grants.includes('log') ? {} : NO_HISTORY }));
    expect(chatCapabilities('irc').history.onDemand).toBe(false);
    expect(chatCapabilities('irc', ['log']).history.onDemand).toBe(true);
    off();
    expect(chatCapabilities('irc')).toMatchObject({ history: { onDemand: false }, reactions: { mode: 'none' }, ui: { choices: false }, files: { send: false } });
  });

  it('the app hears everything and has no chat history to fetch', () => {
    expect(chatCapabilities('app')).toMatchObject({ hears: 'all', history: { onDemand: false } });
  });

  it('a limited reaction set matches an emoji with or without its variation selector', () => {
    const limited = { mode: 'limited', allowed: ['👍', '❤'] } as const;
    expect(reactionAllowed(limited, '❤️')).toBe(true);
    expect(reactionAllowed(limited, '🦄')).toBe(false);
    expect(reactionAllowed({ mode: 'none' }, '👍')).toBe(false);
  });
});
