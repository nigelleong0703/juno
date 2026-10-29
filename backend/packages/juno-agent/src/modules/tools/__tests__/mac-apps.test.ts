import { describe, expect, it } from 'vitest';
import { createMacAppsTools } from '../tools/macApps.js';
import type { ComputerClient } from '../../../ports/computer/index.js';

describe('Mac apps tools', () => {
  it('relay the call to the Mac with the short tool name and the validated arguments', async () => {
    const calls: unknown[] = [];
    const client = { macApps: async (_agent: string, input: unknown) => { calls.push(input); return 'Sent to a@b.test'; } } as unknown as ComputerClient;
    const send = createMacAppsTools({ computer: () => client }).find((tool) => tool.name === 'mac_mail_send');
    const ctx = { agentId: 'a1', signal: new AbortController().signal } as Parameters<NonNullable<typeof send>['execute']>[1];
    const result = await send?.execute({ to: ['a@b.test'], subject: 's', body: 'b' }, ctx);
    expect(result?.content[0]).toEqual({ type: 'text', text: 'Sent to a@b.test' });
    expect(calls).toEqual([{ tool: 'mail_send', args: { to: ['a@b.test'], subject: 's', body: 'b' } }]);
    await expect(send?.execute({ to: [], subject: 's', body: 'b' }, ctx)).rejects.toThrow();
  });
});
