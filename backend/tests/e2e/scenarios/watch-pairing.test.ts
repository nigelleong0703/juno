import { aguiInput } from '../../agui-input.js';
import { describe, expect, it, vi } from 'vitest';
import { createAccount, scriptedChat, stackUrls } from '../harness/client';

/**
 * The watch pairs without a phone cable: it shows a code, the signed-in phone claims and approves it, and the watch
 * redeems a session of the same account. The watch is a native client, so its calls carry a bearer token and no Origin.
 */
describe('watch pairing', () => {
  const watchCall = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(stackUrls().apiUrl + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as any };
  };

  it('lets the paired watch read and write the phone account\'s chat, and nobody else', async () => {
    const phone = await createAccount('watch-phone');
    const agents = await phone.api('GET', '/v1/agents');
    const agentId: string = agents.body.items[0].id;
    const { conversationId } = await scriptedChat(phone, agentId, [{ text: 'hello from the agent' }, { text: 'second reply' }], 'hi');

    const issued = await watchCall('POST', '/auth/device/code', { client_id: 'juno-watch' });
    expect(issued.status).toBe(200);
    const userCode: string = issued.body.user_code;
    const redeem = () => watchCall('POST', '/auth/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: issued.body.device_code, client_id: 'juno-watch',
    });

    // Another account cannot hijack the code by approving it before it is claimed, and the watch gets nothing until approval.
    const stranger = await createAccount('watch-stranger');
    expect((await stranger.api('POST', '/auth/device/approve', { userCode })).status).toBe(400);
    expect((await redeem()).body.error).toBe('authorization_pending');

    expect((await phone.api('GET', `/auth/device?user_code=${userCode}`)).status).toBe(200);
    expect((await phone.api('POST', '/auth/device/approve', { userCode })).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const token = await redeem();
    expect(token.status).toBe(200);
    const watchToken: string = token.body.access_token;

    // The watch sees the phone's direct chat, including the agent's reply, and can write to it.
    const conversations = await watchCall('GET', '/v1/conversations', undefined, watchToken);
    expect(conversations.status).toBe(200);
    expect(conversations.body.items.map((c: any) => c.id)).toContain(conversationId);
    await vi.waitFor(async () => {
      const items = await watchCall('GET', `/v1/conversations/${conversationId}/items?order=desc&limit=20`, undefined, watchToken);
      expect(items.body.items.map((i: any) => i.text ?? i.markdown)).toContain('hello from the agent');
    }, { timeout: 20_000 });
    const sent = await watchCall('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'from the wrist' }), watchToken);
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      const items = await watchCall('GET', `/v1/conversations/${conversationId}/items?order=desc&limit=20`, undefined, watchToken);
      expect(items.body.items.map((i: any) => i.text ?? i.markdown)).toContain('second reply');
    }, { timeout: 20_000 });

    // Without the token the API refuses.
    expect((await watchCall('GET', '/v1/conversations')).status).toBe(401);
  });
});
