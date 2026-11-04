// send_message with `messages`: the model's way to send its reply as two or three separate texts. Each is its own bubble, in order, a reading pause
// apart; it is a reply (the final-reply path sees it as delivered), and the receipts let a recovered call find what was already written.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, ToolContext } from '../../../contracts/index.js';
import { createSendMessageTool, MAX_MESSAGES } from '../tools/sendMessage.js';
import { textOf, toolCtx } from './codingFixtures.js';

const KILLINEY = ['KillineyGO @ Toa Payoh，190 Lor 6 #01-570，每天 7am–8pm，现在开着。\n走过去大概 10 分钟。', '要我帮你导航过去吗？'];

function setup(overrides: Partial<ToolContext> = {}) {
  const store = createMemoryStore();
  const ctx: ToolContext = { ...toolCtx(store), stepId: 'step-1', ...overrides };
  return { store, ctx, tool: createSendMessageTool({ store, enqueuer: ctx.enqueuer }) };
}
const bubbles = async (store: Store) =>
  (await store.list('items', { where: { conversationId: 'conv-1' }, orderBy: 'at', limit: 20 })).items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : []));

describe('send_message messages', () => {
  it('posts each message as its own bubble, in order, and reports them delivered', async () => {
    const { store, ctx, tool } = setup();
    const result = await tool.execute({ kind: 'text', purpose: 'answer', messages: KILLINEY }, ctx);
    expect(result.isError).not.toBe(true);
    expect(await bubbles(store)).toEqual(KILLINEY);
    expect(textOf(result)).toMatch(/end your turn now with no text/);
    expect(result.details).toMatchObject({ deliveredText: KILLINEY.join('\n\n'), deliveredConversationId: 'conv-1' });
  });

  it('refuses a call that mixes messages with text, ui or another destination, and blank or too many messages, posting nothing', async () => {
    const { store, ctx, tool } = setup();
    const ui = { version: 1, blocks: [{ type: 'text', text: 'x' }] };
    for (const extra of [{ text: 'hi' }, { ui }, { toOwner: true }, { conversationId: 'c2' }, { targetAgentIds: ['a'] }]) {
      expect((await tool.execute({ kind: 'text', purpose: 'answer', messages: ['a', 'b'], ...extra }, ctx)).isError).toBe(true);
    }
    expect((await tool.execute({ kind: 'text', purpose: 'answer', messages: ['a', '  '] }, ctx)).isError).toBe(true);
    await expect(tool.execute({ kind: 'text', purpose: 'answer', messages: Array.from({ length: MAX_MESSAGES + 1 }, () => 'x') }, ctx)).rejects.toThrow();
    await expect(tool.execute({ kind: 'text', purpose: 'answer', messages: [] }, ctx)).rejects.toThrow();
    expect(await bubbles(store)).toEqual([]);
  });

  it('keeps the purpose rule of a run nobody is waiting on', async () => {
    const { store, ctx, tool } = setup({ sendOnly: true });
    expect((await tool.execute({ kind: 'text', purpose: 'answer', messages: ['a', 'b'] }, ctx)).isError).toBe(true);
    expect(await bubbles(store)).toEqual([]);
  });

  it('stops posting when the run is stopped during a pause, and says so', async () => {
    const controller = new AbortController();
    const { store, ctx, tool } = setup({ signal: controller.signal });
    const running = tool.execute({ kind: 'text', purpose: 'answer', messages: ['One.', 'Two.', 'Three.'] }, ctx);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    controller.abort();
    const result = await running;
    expect(await bubbles(store)).toEqual(['One.']);
    expect(textOf(result)).toMatch(/Stopped after 1 of 3/);
  });

  it('a recovered call finds its receipts: all written is succeeded, none is not executed, some is unknown', async () => {
    const { store, ctx, tool } = setup();
    const args = { kind: 'text', purpose: 'answer', messages: KILLINEY };
    expect(await tool.reconcile?.(args, ctx)).toMatchObject({ status: 'not_executed' });
    await tool.execute(args, ctx);
    expect(await tool.reconcile?.(args, ctx)).toMatchObject({ status: 'succeeded' });
    const [firstReceipt] = (await store.list('items', { where: { conversationId: 'conv-1' }, orderBy: 'at', limit: 1 })).items;
    await store.delete('items', firstReceipt!.id);
    expect(await tool.reconcile?.(args, ctx)).toMatchObject({ status: 'unknown' });
  });
});
