// juno-agent cannot import the platform adapters (@agent-desktop/channels depends on it), and in production agentd's plugin host
// registers each adapter's capabilities when the platform plugin loads. The chat tests here need the platforms' chats declared, so this
// declares the facts they rely on (the real declarations are in packages/channels/src/<platform>/abilities.ts and tested there).
import { declareCapabilities, NO_HISTORY, registerChatSurface } from '@agent-desktop/public-contracts';

registerChatSurface('discord', () => declareCapabilities({ ui: { fields: false } }));
registerChatSurface('slack', () => declareCapabilities({ ui: { fields: false }, reactions: { mode: 'limited', allowed: ['👍', '👎', '❤️', '😂', '😄', '🎉'] } }));
registerChatSurface('telegram', () => declareCapabilities({ history: NO_HISTORY, ui: { fields: false }, reactions: { mode: 'limited', allowed: ['👍', '👎', '❤', '🔥', '🥰', '👏'] } }));
registerChatSurface('feishu', (grants) => declareCapabilities({
  history: grants.includes('im:message.group_msg') ? { ...NO_HISTORY, onDemand: true } : NO_HISTORY,
  ui: { fields: false },
  reactions: grants.includes('im:message.reactions:write_only') ? { mode: 'limited', allowed: ['👍', '✅'] } : { mode: 'none' },
}));
