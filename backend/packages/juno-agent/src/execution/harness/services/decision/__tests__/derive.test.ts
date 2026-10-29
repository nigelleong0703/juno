/**
 * The decision brief per tool family (BACKEND 8.1): what the server derives from the real call, and that the agent's own
 * words and declarations never change a verified fact. Pure functions, no store.
 */
import { describe, expect, it } from 'vitest';
import type { ToolOrigin } from '../../../../../contracts/index.js';
import { deriveDecision, type DeriveInput } from '../derive.js';

function origin(catalogId: string | undefined, toolName: string, extra: Partial<ToolOrigin> = {}): ToolOrigin {
  return { connectionId: 'conn-1', connectionName: catalogId ?? 'My server', toolName, access: 'action', ...(catalogId === undefined ? {} : { catalogId }), ...extra };
}

function mcp(catalogId: string | undefined, toolName: string, args: Record<string, unknown>, extra: Partial<ToolOrigin> = {}): ReturnType<typeof deriveDecision> {
  return deriveDecision({ toolName: `mcp.abc123.${toolName}_1a2b`, args, origin: origin(catalogId, toolName, extra) });
}

const approval = (sentence = 'Reply to Mei'): { approval: { sentence: string } } => ({ approval: { sentence } });

describe('connector calls (catalog table + the real arguments)', () => {
  it('Gmail: a send names its addressees from to/cc/bcc, never from the body, and cannot be unsent', () => {
    const { brief } = mcp('gmail', 'send_email', { to: 'Mei <mei@x.com>', cc: ['sam@x.com'], body: 'Also tell zed@evil.com', ...approval() }, { connectionName: 'Gmail', account: 'me@gmail.com' });
    expect(brief.categories).toEqual(['speaking']);
    expect(brief.platform).toMatchObject({ kind: 'connector', name: 'Gmail', catalogId: 'gmail', account: 'me@gmail.com' });
    expect(brief.facts.audience).toMatchObject({ kind: 'people', count: 2, source: 'verified' });
    expect(brief.facts.audience?.recipients.map((r) => r.address)).toEqual(['mei@x.com', 'sam@x.com']);
    expect(brief.facts.reversible).toMatchObject({ value: 'no', source: 'verified' });
    expect(brief.facts.asAccount).toMatchObject({ label: 'me@gmail.com', source: 'verified' });
  });

  it('Gmail: a draft is reversible and says nothing was sent; a reply is a reply', () => {
    const draft = mcp('gmail', 'create_draft', { to: 'mei@x.com', subject: 'Hi', body: 'x', ...approval('Draft a note') });
    expect(draft.brief.facts.reversible).toMatchObject({ value: 'yes', source: 'verified' });
    expect(draft.verb).toBe('draft');
    expect(mcp('gmail', 'reply_to_thread', { to: 'mei@x.com', body: 'ok', ...approval() }).verb).toBe('reply');
  });

  it('Google Calendar: an invite with attendees speaks and commits, with the start as a verified instant', () => {
    const { brief } = mcp('google-calendar', 'create_event', { title: 'Review', attendees: [{ email: 'a@x.com' }, 'b@x.com'], start: { dateTime: '2026-10-16T15:00:00', timeZone: 'Asia/Singapore' }, ...approval('Invite the team') });
    expect(brief.categories).toEqual(['speaking', 'committing']);
    expect(brief.facts.commitments?.[0]).toMatchObject({ kind: 'meeting', at: '2026-10-16T07:00:00.000Z', source: 'verified' });
    expect(brief.facts.audience?.count).toBe(2);
  });

  it('Google Calendar: accepting commits; a start without a zone is no verified time; deleting is irreversible', () => {
    const accepted = mcp('google-calendar', 'respond_to_event', { event_id: 'e1', response: 'accepted', start: '2026-10-16T15:00:00+08:00', ...approval('Accept') });
    expect(accepted.brief.categories).toEqual(['committing']);
    expect(accepted.brief.facts.commitments?.[0]?.at).toBe('2026-10-16T07:00:00.000Z');
    const ambiguous = mcp('google-calendar', 'respond_to_event', { event_id: 'e1', start: '2026-10-16T15:00:00', ...approval('Accept') });
    expect(ambiguous.brief.facts.commitments?.[0]?.at).toBeUndefined();
    const deleted = mcp('google-calendar', 'delete_event', { event_id: 'e1', summary: 'Standup', ...approval('Delete it') });
    expect(deleted.brief.categories).toEqual(['irreversible']);
    expect(deleted.brief.facts.targets).toEqual([{ kind: 'event', label: 'Standup' }]);
  });

  it('Stripe: a refund spends and cannot be undone; the amount is read in minor units of the currency, only with a currency', () => {
    const { brief } = mcp('stripe', 'create_refund', { payment_intent: 'pi_1', amount: 4800, currency: 'usd', ...approval('Refund Acme') });
    expect(brief.categories).toEqual(['irreversible', 'spending']);
    expect(brief.primary).toBe('irreversible');
    expect(brief.facts.money).toEqual({ amount: '48.00', currency: 'USD', source: 'verified' });
    expect(mcp('stripe', 'create_refund', { payment_intent: 'pi_1', amount: 4800, ...approval() }).brief.facts.money).toBeUndefined();
    expect(mcp('stripe', 'charge_card', { amount: 5000, currency: 'JPY', ...approval() }).brief.facts.money?.amount).toBe('5000.00');
  });

  it('Drive: a public share is public, a share to named people speaks, delete is irreversible', () => {
    expect(mcp('google-drive', 'share_file', { file_id: 'f', type: 'anyone', role: 'reader', ...approval() }).brief.categories).toEqual(['public']);
    const named = mcp('google-drive', 'share_file', { file_id: 'f', email: 'a@x.com', ...approval() });
    expect(named.brief.categories).toEqual(['speaking']);
    expect(mcp('google-drive', 'trash_file', { file_id: 'f', ...approval() }).brief.categories).toEqual(['irreversible']);
  });

  it('Linear: a comment or a new issue speaks to the team', () => {
    expect(mcp('linear', 'create_comment', { issue_id: 'i', body: 'x', ...approval() }).brief.facts.audience).toMatchObject({ kind: 'team', source: 'verified' });
    expect(mcp('linear', 'create_issue', { title: 'x', ...approval() }).brief.categories).toEqual(['speaking']);
  });

  it('Zapier is opaque: the name\'s words give a category, the arguments give no verified fact', () => {
    const { brief } = mcp('zapier', 'send_email', { to: 'a@x.com', amount: 5, currency: 'USD', ...approval() });
    expect(brief.categories).toEqual(['speaking']);
    expect(brief.facts.audience).toBeUndefined();
    expect(brief.facts.money).toBeUndefined();
  });

  it('a custom server has no catalog id, so nothing about it can be allowed in advance, but its arguments are still read', () => {
    const derived = mcp(undefined, 'send_message', { channel: '#ops', text: 'deploy', ...approval() });
    expect(derived.brief.facts.audience).toMatchObject({ kind: 'room', source: 'verified' });
    expect(derived.delegable).toEqual({ ok: false, reason: expect.stringContaining('custom') });
    expect(derived.platformKey).toBeUndefined();
  });

  it('a credential in the arguments is sensitive', () => {
    expect(mcp('notion', 'update_page', { page_id: 'p', api_key: 'sk-1', ...approval() }).brief.categories).toContain('sensitive');
  });
});

describe('the agent tells the story, the server the facts', () => {
  const tool = (extra: Record<string, unknown>): ReturnType<typeof deriveDecision> => mcp('gmail', 'send_email', { to: 'mei@x.com', body: 'hi', ...extra }, { connectionName: 'Gmail' });

  it('uses the agent\'s sentence, reason and "if denied"; falls back to a plain sentence without one', () => {
    const told = tool({ approval: { sentence: 'Reply to Mei', why: 'She asked', ifDenied: 'I will ask you' } }).brief;
    expect(told).toMatchObject({ sentence: 'Reply to Mei', sentenceSource: 'agent', why: 'She asked', ifDenied: 'I will ask you' });
    const silent = tool({});
    expect(silent.app).toBe('Gmail');
    expect(silent.brief).toMatchObject({ sentence: 'Send email in Gmail', sentenceSource: 'server' });
    expect(silent.delegable).toMatchObject({ ok: false });
    expect(tool({ approval: { why: 'no sentence' } }).delegable).toMatchObject({ ok: false });
  });

  it('ignores declared recipients and money the server derived itself, fills only what it could not', () => {
    const { brief } = tool({ approval: { sentence: 'Tell Mei', facts: { recipients: ['boss@x.com'], money: { amount: '1', currency: 'USD' }, reversible: 'yes' } } });
    expect(brief.facts.audience?.recipients.map((r) => r.address)).toEqual(['mei@x.com']);
    expect(brief.facts.audience?.source).toBe('verified');
    expect(brief.facts.reversible?.source).toBe('verified');
    // Declared money has no verified counterpart here, so it is kept as the agent's claim, and makes the request stricter.
    expect(brief.facts.money).toMatchObject({ amount: '1', currency: 'USD', source: 'declared' });
    expect(brief.categories).toEqual(['spending', 'speaking']);
  });

  it('can add categories but never remove one; the primary is the most severe', () => {
    const { brief } = tool({ approval: { sentence: 'x', categories: ['irreversible', 'bogus', 'public'] } });
    expect(brief.categories).toEqual(['irreversible', 'public', 'speaking']);
    expect(brief.primary).toBe('irreversible');
    expect(tool({ approval: { sentence: 'x', categories: [] } }).brief.categories).toEqual(['speaking']);
  });

  it('a declared category the server cannot back makes the request undelegable, not delegable', () => {
    expect(tool({ approval: { sentence: 'x', categories: ['sensitive'] } }).delegable).toMatchObject({ ok: false, reason: expect.stringContaining('sensitive') });
  });
});

describe('binding: what was reviewed is what runs', () => {
  const base = { to: 'mei@x.com', subject: 'Hi', body: 'Meet at 3' };
  const bind = (args: Record<string, unknown>) => mcp('gmail', 'send_email', { ...args, ...approval() }).brief.binding;

  it('is stable for the same call and ignores the agent\'s own words', () => {
    expect(bind(base)).toEqual(bind(base));
    const reworded = mcp('gmail', 'send_email', { ...base, approval: { sentence: 'a different sentence', why: 'other' }, background: true }).brief.binding;
    expect(reworded).toEqual(bind(base));
  });

  it('changes when the content, a recipient or the amount changes', () => {
    const original = bind(base);
    expect(bind({ ...base, body: 'Meet at 4' }).contentDigest).not.toBe(original.contentDigest);
    expect(bind({ ...base, body: 'Meet at 4' }).factsHash).not.toBe(original.factsHash);
    expect(bind({ ...base, to: ['mei@x.com', 'zed@x.com'] }).factsHash).not.toBe(original.factsHash);
    expect(bind({ ...base, to: ['mei@x.com', 'zed@x.com'] }).argsHash).not.toBe(original.argsHash);
    const refund = (amount: number) => mcp('stripe', 'create_refund', { payment_intent: 'pi_1', amount, currency: 'usd', ...approval() }).brief.binding;
    expect(refund(4800).factsHash).not.toBe(refund(5000).factsHash);
    expect(refund(4800).factsHash).toBe(refund(4800).factsHash);
  });

  it('does not depend on what the agent merely declares', () => {
    const declared = (amount: string) => mcp('gmail', 'send_email', { ...base, approval: { sentence: 's', facts: { money: { amount, currency: 'USD' } } } }).brief.binding.factsHash;
    expect(declared('1')).toBe(declared('2'));
  });
});

describe('browser and screen actions', () => {
  const click = (args: Record<string, unknown>, pageUrl?: string): ReturnType<typeof deriveDecision> =>
    deriveDecision({ toolName: 'browser.click', args, ...(pageUrl === undefined ? {} : { pageUrl }) } as DeriveInput);

  it('takes the site from the active page, not from what the agent says; the amount stays the agent\'s claim', () => {
    const { brief } = click({ ref: 'e2', approval: { sentence: 'Place the order at apple.com' }, purchase: { merchant: 'apple.com', items: [], total: 'S$2,399.00', currency: 'sgd' } }, 'https://www.shop.example.com/checkout');
    expect(brief.platform).toEqual({ kind: 'site', name: 'shop.example.com', host: 'shop.example.com' });
    expect(brief.categories).toEqual(['spending']);
    expect(brief.facts.money).toEqual({ amount: '2399.00', currency: 'SGD', merchant: 'shop.example.com', source: 'declared' });
  });

  it('is a plain browser without a known page, and a deletion sentence is irreversible', () => {
    const { brief } = click({ ref: 'e1', confirm: 'Delete the account for good' });
    expect(brief.platform).toMatchObject({ kind: 'none', name: 'Browser' });
    expect(brief.categories).toEqual(['irreversible']);
    expect(brief.sentenceSource).toBe('agent');
  });

  it('a different host after the approval changes the facts hash (a new approval is needed)', () => {
    const args = { ref: 'e2', confirm: 'Place the order' };
    expect(click(args, 'https://a.com/x').brief.binding.factsHash).not.toBe(click(args, 'https://b.com/x').brief.binding.factsHash);
  });
});

describe('native tools', () => {
  const native = (toolName: string, args: Record<string, unknown>) => deriveDecision({ toolName, args });

  it('shell: rm -rf is irreversible with its targets, a global install is setup', () => {
    const rm = native('shell.run', { command: 'rm -rf build dist' }).brief;
    expect(rm.categories).toEqual(['irreversible']);
    expect(rm.facts.targets).toEqual([{ kind: 'file', label: 'build' }, { kind: 'file', label: 'dist' }]);
    expect(rm.platform).toEqual({ kind: 'none', name: 'Computer' });
    expect(native('shell.run', { command: 'brew install ffmpeg' }).brief.categories).toEqual(['setup']);
    expect(native('shell.run', { command: 'ls' }).brief.categories).toEqual([]);
  });

  it('system packages and agent admin are setup, with their targets', () => {
    expect(native('computer.install_packages', { packages: ['ffmpeg', 'git'] }).brief.facts.targets).toHaveLength(2);
    const admin = native('agent_create', { name: 'Scout' }).brief;
    expect(admin.categories).toEqual(['setup']);
    expect(admin.platform.kind).toBe('juno');
    expect(admin.facts.targets).toEqual([{ kind: 'agent', label: 'Scout' }]);
  });

  it('publishing an app or a document is public and can be undone', () => {
    const published = native('space_publish', {}).brief;
    expect(published.categories).toEqual(['public']);
    expect(published.facts.reversible).toMatchObject({ value: 'yes' });
  });

  it('never calls a native tool delegable', () => {
    expect(native('space_publish', { approval: { sentence: 'Publish my app' } }).delegable).toMatchObject({ ok: false });
  });
});
