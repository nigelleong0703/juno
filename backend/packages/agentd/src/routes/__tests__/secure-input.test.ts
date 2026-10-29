/**
 * Needs-you security (BACKEND 8.7): a secure-input submission is end-to-end encrypted. agentd never sees a value: it
 * passes each sealed value (bound to request, field and ref) on untouched to be typed into its page field, refuses
 * plaintext, and nothing but the ciphertext-free outcome is kept (not in the stored request, the event log, the audit
 * row or the run's resume value); it is owner-scoped and only fills a pending request's own fields.
 * Tap targets are served only while the user drives the screen or a take-over request is pending, and
 * handing the screen back answers that take-over request.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, ScreenResponse, StoredRequest, WakeEvent } from '@agent-desktop/contracts';
import type { BrowserInput } from 'juno-agent/computer';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';
import { ComputerdClientError, type ComputerdClient } from '../../computerd.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const PASSWORD = 'hunter2-Sekret!';
const CARD = '4242424242424242';
const ENCRYPTION = { alg: 'X25519-HKDF-SHA256-AES256GCM' as const, keyId: 'aaa8fff703b50b22', publicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };

/** A sealed value as a client sends it; the bytes are opaque here (only the sandbox helper opens them). */
const sealed = (seed: string) => ({
  epk: Buffer.alloc(32, seed.charCodeAt(0)).toString('base64'),
  nonce: Buffer.alloc(12, seed.charCodeAt(1)).toString('base64'),
  ciphertext: Buffer.from(`cipher-${seed}-xxxxxxxxxxxxxxxxxxxx`).toString('base64'),
});
const PASSWORD_BOX = sealed('p1');
const CARD_BOX = sealed('c2');
const at = '2026-10-13T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  readonly resumed: Array<{ id: string; value: unknown }> = [];
  async enqueue(_event: WakeEvent): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async resolveAwakeable(id: string, value: unknown): Promise<void> {
    this.resumed.push({ id, value });
  }
}

function screen(controller: 'agent' | 'user'): ScreenResponse {
  return {
    id: 'scr-1', ownerId: OWNER, computerId: 'sbx-1', agentId: 'agent-1', displayNo: 2, state: 'live', controller, controlEpoch: 0,
    title: 'screen', resolution: '1280x800', lastUsedAt: at, lastVncPort: 5902, lastWebPort: 6082,
  };
}

interface Fixture {
  fills: BrowserInput[];
  controller: 'agent' | 'user';
  /** What the next fill does: succeed, fail with this message, or refuse because the user holds the screen. */
  failWith?: string;
  userHolds?: boolean;
  /** The page after the fills: what a snapshot lists (refs are re-minted), with the names bounds gives the old refs. */
  after?: { names: Record<string, { role: string; name: string }>; nodes: Array<{ ref?: string; role: string; name: string; state?: string[] }> };
}

function fakeComputerd(fx: Fixture): ComputerdClient {
  return {
    computer: async () => ({ sandboxId: 'sbx-1', template: 't', screens: [], metrics: null }),
    screens: async () => [screen(fx.controller)],
    screenById: async (id) => (id === 'scr-1' ? screen(fx.controller) : null),
    ensureScreen: async () => screen('agent'),
    takeOver: async () => ({ ...screen('user'), changed: true }),
    returnControl: async () => ({ ...screen('agent'), changed: true }),
    controlState: async () => null,
    macStop: async () => ({ paired: false, online: false }),
    screenshot: async () => ({ data: '', mimeType: 'image/png' }),
    browser: async (_agentId, input) => {
      if (fx.userHolds) throw new ComputerdClientError(409, 'user_control', 'the user controls this screen');
      if (input.action === 'bounds') {
        const elements = input.refs?.map((ref) => ({ ref, rect: { x: 1, y: 1, width: 5, height: 5 }, ...(fx.after?.names[ref] ?? { role: 'textbox', name: ref }) })) ?? [];
        return { action: 'bounds', url: 'https://shop.example/pay', title: 'Pay', tab: 't1', elements };
      }
      if (input.action === 'snapshot') return { action: 'snapshot', url: 'https://shop.example/pay', title: 'Pay', tab: 't1', nodes: fx.after?.nodes ?? [], crossOriginFrames: 0 };
      fx.fills.push(input);
      if (fx.failWith) throw new ComputerdClientError(500, 'failed', fx.failWith);
      return { action: 'fill_secret', url: 'https://shop.example/pay', title: 'Pay', tab: 't1', filled: true };
    },
    elements: async () => ({ screenId: 'scr-1', width: 1280, height: 800, elements: [{ rect: { x: 1, y: 2, width: 30, height: 20 }, role: 'button', name: 'Pay' }] }),
    pasteClipboard: async () => ({ kind: 'image', path: 'Pictures/Pasted/x.png' }),
    copyClipboard: async () => ({ kind: 'empty' }),
    stopProcess: async (_agentId, handle) => ({ handle, state: 'stopped', exitCode: null }),
    pause: async () => undefined,
    resume: async () => undefined,
    computerState: async () => 'none' as const,
    macStatus: async () => ({ paired: false, online: false }),
    macPair: async () => { throw new Error('no Mac in this test'); },
    macRevoke: async () => ({ paired: false, online: false }),
    runtime: async () => ({ kind: 'cloud' as const, image: { state: 'ready' as const } }),
  };
}

function secureRequest(id: string, extra: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id, kind: 'secure_input', status: 'pending', title: 'Enter details for shop.example', summary: 'Pay',
    agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', awakeableId: 'awk-' + id, createdAt: at,
    payload: {
      kind: 'secure_input', site: 'shop.example', reason: 'Pay for the order',
      fields: [
        { id: 'f1', label: 'Password', kind: 'password', ref: 'e12' },
        { id: 'f2', label: 'Card number', kind: 'card_number', ref: 'e14' },
      ],
      encryption: ENCRYPTION,
    },
    ...extra,
  };
}

function takeoverRequest(id: string): StoredRequest {
  return {
    id, kind: 'computer', status: 'pending', title: 'Your help is needed on the screen', summary: 'captcha',
    agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', awakeableId: 'awk-' + id, createdAt: at,
    payload: { kind: 'computer', reason: 'Solve the captcha' },
  };
}

async function build(controller: 'agent' | 'user' = 'agent') {
  const mem = createMemoryStore();
  const store = withDefaultOwner(mem, OWNER);
  const enqueuer = new RecordingEnqueuer();
  const fx: Fixture = { fills: [], controller };
  const app = createTestApp({ store, bus: mem.eventBus, enqueuer, computerd: fakeComputerd(fx) });
  await store.put('agents', { id: 'agent-1', ownerId: OWNER, name: 'Atlas' } as never);
  return { app, mem, store, enqueuer, fx };
}

const submit = (fields: Record<string, ReturnType<typeof sealed>>) => ({ method: 'POST', body: { fields } });
const both = () => submit({ f1: PASSWORD_BOX, f2: CARD_BOX });

/** Everything that outlives the request handler, as one string to search for a leaked value. */
async function everythingKept(env: Awaited<ReturnType<typeof build>>, requestId: string): Promise<string> {
  const request = await env.store.get('requests', requestId);
  const audit = await env.store.list('audit', { limit: 50 });
  const events = await env.mem.eventBus.since(0, 500);
  return JSON.stringify({ request, audit: audit.items, events, resumed: env.enqueuer.resumed });
}

describe('secure input submission', () => {
  it('passes each sealed value on untouched, bound to request and field, and keeps nothing of them', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1'));
    const res = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', both());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(PASSWORD);
    expect(JSON.parse(body)).toMatchObject({ request: { status: 'approved' }, fields: [{ id: 'f1', status: 'filled' }, { id: 'f2', status: 'filled' }] });
    expect(env.fx.fills).toEqual([
      { action: 'fill_secret', ref: 'e12', requestId: 'req-1', fieldId: 'f1', sealed: PASSWORD_BOX },
      { action: 'fill_secret', ref: 'e14', requestId: 'req-1', fieldId: 'f2', sealed: CARD_BOX },
    ]);
    // The run resumes from a note naming fields only.
    expect(env.enqueuer.resumed).toEqual([{ id: 'awk-req-1', value: { action: 'approve', note: 'Filled Password (password) into e12. Filled Card number (card_number) into e14. Filled fields show (filled securely) in snapshots, without their value: do not ask for them again.' } }]);
    const kept = await everythingKept(env, 'req-1');
    expect(kept).not.toContain(PASSWORD_BOX.ciphertext);
    expect(kept).not.toContain(CARD_BOX.ciphertext);
    expect(kept).toContain('"status":"filled"');
  });

  it('refuses a plaintext body when the request offered encryption, and a request raised before encryption existed', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1'));
    const plain = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', { method: 'POST', body: { values: { f1: PASSWORD, f2: CARD } } });
    expect(plain.status).toBe(400);
    const text = await plain.text();
    expect(text).toContain('ENCRYPTION_REQUIRED');
    expect(text).not.toContain(PASSWORD);

    const legacy = secureRequest('req-old');
    await env.store.put('requests', { ...legacy, payload: { ...legacy.payload, encryption: undefined } as never });
    const old = await requestAs(env.app, OWNER, '/v1/requests/req-old/secure-input', both());
    expect(old.status).toBe(409);
    expect(await old.text()).toContain('ENCRYPTION_UNAVAILABLE');
    expect(env.fx.fills).toEqual([]);
    expect((await env.store.get('requests', 'req-1'))?.status).toBe('pending');
  });

  it('tells the run which filled fields the page marks invalid, with its rule as the sandbox redacted it', async () => {
    const env = await build();
    env.fx.after = {
      names: { e12: { role: 'textbox', name: 'Password' }, e14: { role: 'textbox', name: 'Card number' } },
      nodes: [
        { ref: 'e30', role: 'textbox', name: 'Password' },
        { ref: 'e31', role: 'textbox', name: 'Card number', state: ['invalid'] },
        // The sandbox helper has already replaced the filled value in the page text with dots.
        { role: 'text', name: 'Enter 16 digits, not \u2022\u2022\u2022\u2022' },
      ],
    };
    await env.store.put('requests', secureRequest('req-1'));
    const res = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', both());
    expect(res.status).toBe(200);
    expect(env.enqueuer.resumed[0]?.value).toEqual({ action: 'approve', note: expect.stringContaining('Filled Card number (card_number), but the page marks it invalid') });
    const note = (env.enqueuer.resumed[0]?.value as { note: string }).note;
    expect(note).toContain('Filled Password (password) into e12.');
    expect(note).toContain('the page marks it invalid: "Enter 16 digits, not \u2022\u2022\u2022\u2022". Ask the user again');
    expect(note).not.toContain(CARD);
  });

  it('answers another owner exactly like an unknown request and types nothing', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1'));
    const foreign = await requestAs(env.app, OTHER, '/v1/requests/req-1/secure-input', both());
    const missing = await requestAs(env.app, OWNER, '/v1/requests/req-ghost/secure-input', both());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(env.fx.fills).toEqual([]);
  });

  it('refuses unknown, missing or malformed sealed values without quoting them', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1'));
    const cases = [
      submit({ f1: PASSWORD_BOX, f9: CARD_BOX }),
      submit({ f1: PASSWORD_BOX }),
      submit({ f1: PASSWORD_BOX, f2: { ...CARD_BOX, ciphertext: 'x'.repeat(3000) } }),
      submit({ f1: PASSWORD_BOX, f2: { epk: CARD_BOX.epk } as never }),
      { method: 'POST', body: { fields: { f1: PASSWORD_BOX, f2: CARD_BOX }, values: { f1: PASSWORD } } },
    ];
    for (const body of cases) {
      const res = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', body);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(PASSWORD_BOX.ciphertext);
    }
    expect(env.fx.fills).toEqual([]);
    expect((await env.store.get('requests', 'req-1'))?.status).toBe('pending');
  });

  it('types nothing into a request that is no longer pending, nor for another kind', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1', { status: 'denied' }));
    await env.store.put('requests', takeoverRequest('req-2'));
    expect((await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', both())).status).toBe(409);
    expect((await requestAs(env.app, OWNER, '/v1/requests/req-2/secure-input', submit({ f1: PASSWORD_BOX }))).status).toBe(400);
    expect(env.fx.fills).toEqual([]);
  });

  it('only cancels through resolve: approving without values is refused', async () => {
    const env = await build();
    await env.store.put('requests', secureRequest('req-1'));
    expect((await requestAs(env.app, OWNER, '/v1/requests/req-1/resolve', { method: 'POST', body: { action: 'approve' } })).status).toBe(400);
    const denied = await requestAs(env.app, OWNER, '/v1/requests/req-1/resolve', { method: 'POST', body: { action: 'deny' } });
    expect(await denied.json()).toMatchObject({ status: 'denied' });
  });

  it('leaves the request pending while the user holds the screen', async () => {
    const env = await build();
    env.fx.userHolds = true;
    await env.store.put('requests', secureRequest('req-1'));
    const res = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', both());
    expect(res.status).toBe(409);
    expect((await env.store.get('requests', 'req-1'))?.status).toBe('pending');
    expect(env.enqueuer.resumed).toEqual([]);
  });

  it('reports a field the sandbox could not fill as failed and tells the run', async () => {
    const env = await build();
    env.fx.failWith = 'the value could not be unsealed (wrong key, request, field or ref; ask the user again)';
    await env.store.put('requests', secureRequest('req-1'));
    const res = await requestAs(env.app, OWNER, '/v1/requests/req-1/secure-input', both());
    expect(await res.json()).toMatchObject({ fields: [{ id: 'f1', status: 'failed' }, { id: 'f2', status: 'failed' }] });
    const kept = await everythingKept(env, 'req-1');
    expect(kept).toContain('Could not fill Password (password) into e12');
  });
});

describe('tap targets and take-over hand-back', () => {
  it('serves elements only while the user drives the screen or a take-over is pending', async () => {
    const agentDriven = await build('agent');
    expect((await requestAs(agentDriven.app, OWNER, '/v1/screens/scr-1/elements')).status).toBe(409);
    await agentDriven.store.put('requests', takeoverRequest('req-t'));
    const asked = await requestAs(agentDriven.app, OWNER, '/v1/screens/scr-1/elements');
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({ screenId: 'scr-1', width: 1280, height: 800, elements: [{ role: 'button', name: 'Pay' }] });

    const userDriven = await build('user');
    expect((await requestAs(userDriven.app, OWNER, '/v1/screens/scr-1/elements')).status).toBe(200);
    expect((await requestAs(userDriven.app, OTHER, '/v1/screens/scr-1/elements')).status).toBe(404);
  });

  it('handing the screen back approves the pending take-over request and resumes its run', async () => {
    const env = await build('user');
    await env.store.put('requests', takeoverRequest('req-t'));
    expect((await requestAs(env.app, OWNER, '/v1/screens/scr-1/return-control', { method: 'POST' })).status).toBe(200);
    expect((await env.store.get('requests', 'req-t'))?.status).toBe('approved');
    expect(env.enqueuer.resumed).toEqual([{ id: 'awk-req-t', value: { action: 'approve', note: 'The user handed control of the screen back.' } }]);
  });
});
