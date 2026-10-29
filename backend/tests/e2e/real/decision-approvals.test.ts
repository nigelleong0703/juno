import { aguiInput } from '../../agui-input.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, listItems, runReport, toolActivity, type Account, type EventListener } from '../harness/client';

/**
 * Decision approvals with a real model (BACKEND 8.0/8.1): the agent says what it wants to do in its own words, the server
 * states the facts from the real call, a changed amount or content is a new decision, a delegation lets a matching call through
 * (and records it), and what is asked every time cannot be delegated. The connectors are fake MCP servers on 127.0.0.1 with
 * Gmail's and Stripe's catalog ids. Assertions check behaviour (requests, calls the servers received), never wording.
 */

const NOW = new Date().toISOString();
const note = (label: string, value: unknown): void => { if (process.env['E2E_VERBOSE'] === '1') console.info(`[decision-e2e] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); };

interface Received { tool: string; args: Record<string, unknown> }

const TOOLS: Record<string, Array<{ name: string; description: string; inputSchema: object }>> = {
  gmail: [
    { name: 'send_email', description: 'Send an email.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
    { name: 'delete_message', description: 'Permanently delete a message from the mailbox.', inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, subject: { type: 'string' } }, required: ['message_id'] } },
  ],
  stripe: [
    { name: 'charge_card', description: 'Charge a customer\'s card. `amount` is in the smallest currency unit (cents), `currency` is the ISO code in lower case.', inputSchema: { type: 'object', properties: { customer: { type: 'string' }, amount: { type: 'integer' }, currency: { type: 'string' } }, required: ['customer', 'amount', 'currency'] } },
  ],
};

/** A minimal streamable-HTTP MCP server (JSON replies) that records every tool call it receives. */
async function fakeMcp(kind: 'gmail' | 'stripe', received: Received[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: kind, version: '1' } });
      if (message.method === 'tools/list') return reply({ tools: TOOLS[kind] });
      if (message.method === 'tools/call') {
        received.push({ tool: message.params?.name ?? '', args: message.params?.arguments ?? {} });
        return reply({ content: [{ type: 'text', text: 'Done: ' + (message.params?.name ?? '') }] });
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp` };
}

async function setup(prefix: string) {
  const account = await createAccount(prefix);
  const events = await listenEvents(account.cookie);
  const gmail: Received[] = [];
  const stripe: Received[] = [];
  const servers = [await fakeMcp('gmail', gmail), await fakeMcp('stripe', stripe)];
  const names = { gmail: 'Gmail', stripe: 'Stripe' } as const;
  for (const [index, kind] of (['gmail', 'stripe'] as const).entries()) {
    await insertDocRow('connections', account.userId, { id: `con-e2e-${kind}-${account.userId.slice(0, 12)}`, kind: 'mcp', name: names[kind], status: 'connected', enabled: true, catalogId: kind, permission: 'full', endpoint: servers[index]!.url, transport: 'http', createdAt: NOW });
  }
  const agent = await defaultAgent(account);
  const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
  expect(chat.status).toBe(201);
  return {
    account, events, gmail, stripe, agentId: agent.id, conversationId: chat.body.id as string, sessionKey: `${agent.id}:${chat.body.id}`,
    close: async (): Promise<void> => { events.close(); await Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))); },
  };
}

interface ApprovalRow {
  id: string; status: string; outcome?: string; title: string; triggeringRuleId?: string;
  decision?: { mode: string; scope: string; reason?: string; note?: string };
  payload: { kind: string; action: string; why: string; app?: string; recipient?: string; brief?: { sentence: string; sentenceSource?: string; why?: string; categories: string[]; primary?: string; platform: { kind: string; catalogId?: string; name: string }; facts: { money?: { amount: string; currency: string; source: string }; audience?: { source: string; recipients: Array<{ address?: string }> } }; binding: { factsHash: string; contentDigest: string } }; delegationOffer?: { delegable: boolean; reason?: string; suggested: unknown[] } };
}

const requests = async (account: Account, query: string): Promise<ApprovalRow[]> => (await account.api('GET', `/v1/requests?${query}`)).body.items as ApprovalRow[];

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('timed out waiting for ' + what);
}

const pending = (account: Account, agentId: string, after = 0) => until('a pending approval', async () => (await requests(account, `agentId=${agentId}&status=pending&kind=approval`))[after]);

async function say(account: Account, conversationId: string, text: string): Promise<void> {
  expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
}

/** Finished top-level runs: an approval pause also ends a wire segment (outcome `interrupt`) but the run is not done. */
const runsDone = (events: EventListener, conversationId: string): number => events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type !== 'interrupt' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId).length;

describe('real model: decision approvals', () => {
  it('the agent gives the sentence for an email, the card shows facts the server read from the call', async () => {
    const env = await setup('real-decision-mail');
    const { account, events, gmail, agentId, conversationId, sessionKey } = env;
    try {
      await say(account, conversationId, 'Use the Gmail send email tool to email mei@example.com, with a copy to zed@example.com, subject "Friday" and body "See you at 3pm". Do not ask me anything first.');
      const card = await pending(account, agentId);
      note('card', card);
      const brief = card.payload.brief;
      expect(brief, 'the request carries a brief').toBeDefined();
      // The agent said it in its own words (it filled `approval`), and the server worked out the rest.
      expect(brief?.sentenceSource, JSON.stringify(await toolActivity(sessionKey))).toBe('agent');
      expect(brief?.platform).toMatchObject({ kind: 'connector', catalogId: 'gmail', name: 'Gmail' });
      expect(brief?.categories).toContain('speaking');
      expect(brief?.facts.audience?.source).toBe('verified');
      const shown = (brief?.facts.audience?.recipients ?? []).map((r) => r.address).sort();
      expect(shown).toEqual(['mei@example.com', 'zed@example.com']);
      expect(card.payload.app).toBe('Gmail');
      expect(card.payload.recipient).toContain('mei@example.com');
      // Plain words: neither the tool's raw name nor its hash is on the card.
      expect(JSON.stringify(card)).not.toMatch(/mcp\.|send_email_/);
      expect(gmail).toHaveLength(0);

      expect((await account.api('POST', `/v1/requests/${card.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor(() => runsDone(events, conversationId) >= 1, 240_000);
      // What the server received is exactly what the card showed; the agent's `approval` words never reach the connector.
      expect(gmail).toHaveLength(1);
      const sent = gmail[0]!.args;
      expect([String(sent['to']), String(sent['cc'])].map((a) => a.toLowerCase()).sort()).toEqual(['mei@example.com', 'zed@example.com']);
      expect(sent).not.toHaveProperty('approval');
      const done = (await requests(account, `agentId=${agentId}&status=resolved`))[0]!;
      expect(done).toMatchObject({ status: 'approved', outcome: 'allowed_once' });
      expect(done.payload.brief?.binding.factsHash).toBe(brief?.binding.factsHash);
    } catch (error) {
      console.error('[decision-e2e] run report', await runReport(account, events.events.find((e) => e.data.type === 'RUN_FINISHED')?.data.metadata.juno.run.id ?? '').catch(() => ''));
      throw error;
    } finally {
      await env.close();
    }
  }, 600_000);

  it('a delegation lets a matching charge through and records it; a bigger or changed amount is a new decision; the owner\'s note reaches the agent', async () => {
    const env = await setup('real-decision-spend');
    const { account, events, stripe, agentId, conversationId, sessionKey } = env;
    try {
      const made = await account.api('POST', '/v1/delegations', { agentId, category: 'spending', platform: { kind: 'connector', catalogId: 'stripe' }, limits: { perPurchase: { amount: '50', currency: 'USD' }, perMonth: { amount: '100', currency: 'USD' } } });
      expect(made.status).toBe(201);

      // 30 USD is inside both limits: no card, the charge happens, and the decision is recorded as made by the rule.
      await say(account, conversationId, 'Use the Stripe charge card tool to charge customer cus_acme 30 US dollars (currency usd; the amount is in cents). Do not ask me anything first.');
      await events.waitFor(() => runsDone(events, conversationId) >= 1, 240_000);
      note('activity', await toolActivity(sessionKey));
      expect(stripe.map((call) => call.args['amount'])).toEqual([3000]);
      const [auto] = await requests(account, `agentId=${agentId}&status=resolved&kind=approval`);
      expect(auto).toMatchObject({ status: 'approved', outcome: 'allowed_rule', triggeringRuleId: made.body.id, decision: { mode: 'auto' } });
      expect(auto?.payload.brief?.facts.money).toEqual({ amount: '30.00', currency: 'USD', source: 'verified' });
      expect((await account.api('GET', `/v1/delegations?agentId=${agentId}`)).body.items[0]).toMatchObject({ useCount: 1 });
      // (Creating the agent woke it in its own chat to onboard: its naming card is a question, not a decision.)
      expect(await requests(account, `agentId=${agentId}&status=pending&kind=approval`)).toHaveLength(0);

      // 80 USD is over the per-purchase limit: a card, with the amount the server read. Send it back with a note.
      await say(account, conversationId, 'Now charge customer cus_acme 80 US dollars with the same tool. Do not ask me anything first.');
      const card = await pending(account, agentId);
      expect(card.payload.brief?.facts.money).toEqual({ amount: '80.00', currency: 'USD', source: 'verified' });
      expect(card.payload.brief?.categories).toEqual(['spending']);
      expect(card.payload.delegationOffer?.delegable).toBe(true);
      expect(stripe).toHaveLength(1);
      expect((await account.api('POST', `/v1/requests/${card.id}/resolve`, { action: 'deny', reason: 'revise', note: 'Too much. Charge 40 US dollars (4000 cents) instead.' })).status).toBe(200);
      await events.waitFor(() => runsDone(events, conversationId) >= 2, 240_000);
      const resolved = await requests(account, `agentId=${agentId}&status=resolved&kind=approval`);
      expect(resolved.find((r) => r.id === card.id)).toMatchObject({ status: 'denied', outcome: 'revised' });
      expect(stripe.map((call) => call.args['amount']), 'the 80 USD charge never ran').not.toContain(8000);

      // The note reached the model, which asked again with the new amount: a new decision (new facts hash), and 40 is inside the limits.
      const activity = await toolActivity(sessionKey);
      note('after revise', activity);
      expect(activity.results.some((r) => /sent this back to be changed/.test(r.text) && /Charge 40/.test(r.text)), 'the note came back as the tool result').toBe(true);
      const retried = resolved.find((r) => r.id !== card.id && r.payload.brief?.facts.money?.amount === '40.00');
      expect(retried, 'the agent asked again with the changed amount').toBeDefined();
      expect(retried?.payload.brief?.binding.factsHash).not.toBe(card.payload.brief?.binding.factsHash);
      expect(retried?.outcome).toBe('allowed_rule');
      expect(stripe.map((call) => call.args['amount'])).toEqual([3000, 4000]);

      // The month is 70 of 100: another 40 would pass it, so it asks again.
      await say(account, conversationId, 'Charge customer cus_acme 40 US dollars once more with the same tool. Do not ask me anything first.');
      const over = await pending(account, agentId);
      expect(over.payload.brief?.facts.money?.amount).toBe('40.00');
      expect(stripe).toHaveLength(2);
      // History filters.
      expect((await requests(account, `agentId=${agentId}&status=resolved&category=spending&outcome=allowed_rule`)).length).toBeGreaterThanOrEqual(2);
    } catch (error) {
      console.error('[decision-e2e] run report', await runReport(account, events.events.find((e) => e.data.type === 'RUN_FINISHED')?.data.metadata.juno.run.id ?? '').catch(() => ''));
      console.error('[decision-e2e] chat', JSON.stringify((await listItems(account, conversationId).catch(() => [])).map((item) => [item.type, item.markdown ?? ''])));
      console.error('[decision-e2e] tool calls',JSON.stringify(await toolActivity(sessionKey).catch(() => ''), null, 1));
      console.error('[decision-e2e] requests', JSON.stringify(await requests(account, `agentId=${agentId}`).catch(() => ''), null, 1));
      throw error;
    } finally {
      await env.close();
    }
  }, 900_000);

  it('deleting for good is asked even with a delegation on the same app, and cannot be delegated', async () => {
    const env = await setup('real-decision-never');
    const { account, events, gmail, agentId, conversationId } = env;
    try {
      // Sending mail is delegated (any recipient, 20 a day) - deleting is not covered by that.
      expect((await account.api('POST', '/v1/delegations', { agentId, category: 'speaking', platform: { kind: 'connector', catalogId: 'gmail' }, limits: { maxPerDay: 20 } })).status).toBe(201);
      for (const category of ['irreversible', 'sensitive', 'setup', 'choice']) {
        const refused = await account.api('POST', '/v1/delegations', { agentId, category, platform: { kind: 'connector', catalogId: 'gmail' }, limits: {} });
        expect(refused.status, category).toBe(400);
      }
      await say(account, conversationId, 'Use the Gmail delete message tool to permanently delete message m-42 (subject "Old invoice"). Do not ask me anything first.');
      const card = await pending(account, agentId);
      expect(card.payload.brief?.categories).toEqual(['irreversible']);
      expect(card.payload.delegationOffer).toMatchObject({ delegable: false });
      expect(gmail).toHaveLength(0);
      // Allowing this kind is refused by the server, the card stays pending; the owner can still allow it once.
      const refused = await account.api('POST', `/v1/requests/${card.id}/resolve`, { action: 'approve', scope: 'delegate' });
      expect(refused.status).toBe(400);
      expect((await account.api('GET', `/v1/requests/${card.id}`)).body.status).toBe('pending');
      expect((await account.api('POST', `/v1/requests/${card.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor(() => runsDone(events, conversationId) >= 1, 240_000);
      expect(gmail.map((call) => call.tool)).toEqual(['delete_message']);
    } catch (error) {
      console.error('[decision-e2e] run report', await runReport(account, events.events.find((e) => e.data.type === 'RUN_FINISHED')?.data.metadata.juno.run.id ?? '').catch(() => ''));
      throw error;
    } finally {
      await env.close();
    }
  }, 600_000);
});
