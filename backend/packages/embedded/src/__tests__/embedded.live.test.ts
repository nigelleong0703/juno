/**
 * Live: an embedded Juno boots (an embedded Postgres, the API and agentd on free ports), a scripted model answers a
 * message whose send names its run, and stop() leaves no port listening and no temporary directory behind.
 * It starts Postgres, so it is gated: JUNO_EMBEDDED_LIVE=1 pnpm --filter @agent-desktop/embedded test
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedJuno } from '../index.js';

const live = process.env['JUNO_EMBEDDED_LIVE'] === '1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function call(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const parsed: unknown = text === '' ? undefined : JSON.parse(text);
  return { status: response.status, body: parsed };
}

/** Poll until `check` gives a value, or fail after the deadline. */
async function poll<T>(label: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await new Promise((done) => setTimeout(done, 200));
  }
}

describe.runIf(live)('embedded Juno (live)', () => {
  it('answers a message through the scripted model, names the run, and stops clean', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'juno-embedded-script-'));
    const scriptFile = join(scriptDir, 'script.json');
    // No scripted turns: the scripted model answers with its built-in reply.
    writeFileSync(scriptFile, '{}');
    const juno = await startEmbeddedJuno({ env: { MODEL_PROVIDER: 'scripted', SCRIPTED_MODEL_FILE: scriptFile } });
    try {
      const agent = await call(juno.baseUrl, juno.token, 'POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const agentId = isRecord(agent.body) ? agent.body['id'] : undefined;
      const created = await call(juno.baseUrl, juno.token, 'POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      expect(created.status).toBe(201);
      const conversationId = isRecord(created.body) ? created.body['id'] : undefined;

      const sent = await call(juno.baseUrl, juno.token, 'POST', `/v1/conversations/${String(conversationId)}/messages`, { text: 'hello' });
      expect(sent.status).toBe(202);
      // An idle direct chat starts its run after the reply window; the send already names that run.
      const runId = isRecord(sent.body) ? sent.body['runId'] : undefined;
      expect(typeof runId).toBe('string');

      const reply = await poll('the agent reply', async () => {
        const items = await call(juno.baseUrl, juno.token, 'GET', `/v1/conversations/${String(conversationId)}/items`);
        const list = isRecord(items.body) && Array.isArray(items.body['items']) ? items.body['items'] : [];
        return list.find((item) => isRecord(item) && item['type'] === 'agent_message' && item['runId'] === runId);
      });
      expect(isRecord(reply) && typeof reply['markdown'] === 'string' && reply['markdown'].includes('scripted model')).toBe(true);

      await poll('the run to finish', async () => {
        const run = await call(juno.baseUrl, juno.token, 'GET', `/v1/runs/${String(runId)}`);
        return isRecord(run.body) && run.body['status'] === 'completed' ? true : undefined;
      });
    } finally {
      await juno.stop();
    }
    expect(existsSync(juno.dataDir)).toBe(false);
    expect(await listening(juno.ports.api)).toBe(false);
    expect(await listening(juno.ports.agentd)).toBe(false);
    rmSync(scriptDir, { recursive: true, force: true });
  }, 180_000);
});
