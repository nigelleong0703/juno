import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decide, type PendingRequest } from '../real/tasks/user';
import { TASKS } from '../real/tasks/specs/index';
import { SPICY_DISHES, spicyRecommendations } from '../real/tasks/specs/remember-no-spicy';
import { fetchedPaths } from '../real/tasks/specs/expense-tracker';
import { pptxSlides } from '../real/tasks/zip';
import { silentErrors } from '../real/tasks/observe';
import { summaryTable, record } from '../real/tasks/report';
import type { CheckEnv, Observed } from '../real/tasks/types';

/**
 * The checks of the real-task cases, run against recorded/scripted observations (no model, no computer): each case gets one
 * observation of a task done right, which must pass every check, and one per failure mode, which must fail the named check.
 * This proves the checks themselves; `pnpm test:e2e:tasks` runs them against a real model.
 */

const turn = (replies: string[], status = 'completed') => ({ message: 'm', conversationId: 'c1', runIds: ['r1'], status, replies });
const base = (taskId: string, patch: Partial<Observed> = {}): Observed => ({ taskId, turns: [turn(['Done.'])], calls: [], results: [], steps: [], interactions: [], durationMs: 1000, costUsd: 0, costKnown: false, inputTokens: 0, outputTokens: 0, ...patch });
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args, runId: 'main' });
const ok = (toolName: string, text = 'ok') => ({ toolName, isError: false, text, runId: 'main' });
const err = (toolName: string, text = 'boom') => ({ toolName, isError: true, text, runId: 'main' });
const spec = (id: string) => TASKS.find((t) => t.id === id)!;

async function failing(id: string, observed: Observed, env: CheckEnv = fakeEnv()): Promise<string[]> {
  const out: string[] = [];
  for (const check of spec(id).checks) for (const r of await check(observed, env)) if (!r.ok) out.push(r.name);
  return out;
}

/** A tiny API: path -> reply (first prefix match). */
function fakeEnv(routes: Record<string, { status?: number; body: unknown }> = {}, host: CheckEnv['hostRequest'] = async () => ({ status: 404, headers: {}, body: '' })): CheckEnv {
  return {
    api: async (method, path) => {
      const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
      const hit = key === undefined ? undefined : routes[key];
      return { status: hit?.status ?? (hit === undefined ? 404 : 200), body: hit?.body } as never;
    },
    hostRequest: host,
    artifactHost: 'usercontent.localhost:18787',
    userId: 'u1',
    runMemoryJob: async () => undefined,
  };
}

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(data.length, 20); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(central);
  const endRecord = Buffer.alloc(22); endRecord.writeUInt32LE(0x06054b50, 0); endRecord.writeUInt16LE(central.length / 2, 10); endRecord.writeUInt32LE(cd.length, 12); endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, endRecord]);
}
const slide = (title: string) => `<p:sld><a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>body of ${title}</a:t></a:r></a:p></p:sld>`;
const deck = (titles: string[]) => zip(Object.fromEntries(titles.map((t, i) => [`ppt/slides/slide${i + 1}.xml`, slide(t)])));

describe('scripted user', () => {
  const script = spec('apple-mac-mini').user;
  const request = (kind: string, payload: Record<string, unknown>, title = 'T'): PendingRequest => ({ id: 'q1', kind, title, payload });

  it('answers a question by pattern, picks a valid option, falls back otherwise', () => {
    const asked = decide(script, request('question', { kind: 'question', ui: { version: 1, title: 'Which model do you want?', blocks: [
      { type: 'choices', id: 'model', options: [{ id: 'm4-16', label: 'M4 16GB S$1,099' }, { id: 'm4-base', label: 'M4 base S$799' }] },
    ] } }));
    expect(asked.body.action).toBe('answer');
    expect(asked.body.answers).toEqual({ model: 'm4-base' });
  });

  it('denies purchase-like approvals, approves others once, declines a takeover with the fixed answer', () => {
    const buy = decide(script, request('approval', { kind: 'approval', action: 'Place order', why: 'checkout' }, 'Place your order'));
    expect(buy.body.action).toBe('deny');
    const pay = decide(script, request('approval', { kind: 'approval', action: 'click', why: 'x', purchase: { merchant: 'Apple', items: [] } }));
    expect(pay.body.action).toBe('deny');
    const other = decide(script, request('approval', { kind: 'approval', action: 'Open a site', why: 'research' }));
    expect(other.body).toEqual({ action: 'approve', scope: 'once' });
    const login = decide(script, request('signin', { kind: 'signin', site: 'apple.com', url: 'https://apple.com', pausesModel: true }));
    expect(login.body).toEqual({ action: 'deny', note: "I can't log in now, continue without it" });
    expect(login.interaction.rule).toBe('takeover');
  });
});

describe('check helpers', () => {
  it('reads slides from a zip', () => {
    expect(pptxSlides(deck(['A', 'B'])).map((s) => s.texts[0])).toEqual(['A', 'B']);
  });
  it('tells a spicy recommendation from a refusal', () => {
    expect(spicyRecommendations('Try the chili crab tonight.')).not.toEqual([]);
    expect(spicyRecommendations('Since you avoid spicy food, how about chicken rice?')).toEqual([]);
    expect(spicyRecommendations('A spicy mala hotpot!')).not.toEqual([]);
    expect(SPICY_DISHES.length).toBeGreaterThan(5);
  });
  it('finds the app\'s own POST path', () => {
    expect(fetchedPaths(`fetch('/api/expenses'); fetch("/api/expenses", { method: 'POST', body: x }); fetch(\`/x/\${id}\`)`)).toEqual({ post: ['/api/expenses'], get: ['/api/expenses'] });
  });
  it('flags only errors that were neither retried nor told', () => {
    const quiet = base('x', { results: [err('web_fetch'), ok('web_search')], turns: [turn(['All set.'])] });
    expect(silentErrors(quiet)).toHaveLength(1);
    expect(silentErrors({ ...quiet, turns: [turn(['I could not open the page, so I used a search instead.'])] })).toHaveLength(0);
    expect(silentErrors({ ...quiet, results: [err('web_fetch'), ok('web_fetch')] })).toHaveLength(0);
    // an error of a bookkeeping tool never counts
    expect(silentErrors({ ...quiet, results: [err('task_update', 'no task')] })).toHaveLength(0);
    // a stale ref, a fresh snapshot, a working click: recovery
    expect(silentErrors({ ...quiet, results: [err('browser.click', 'stale ref'), ok('browser.snapshot'), ok('browser.click')] })).toHaveLength(0);
    // the snapshot fails and the agent carries on with screenshots, saying nothing: silent
    expect(silentErrors({ ...quiet, results: [err('browser.snapshot'), ok('computer.screenshot'), ok('computer.click')] })).toHaveLength(1);
  });
  it('prints one row per task', () => {
    const rows = summaryTable([record('t', 'T', base('t', { calls: [call('a'), call('a')], results: [err('a')] }), [{ name: 'c', ok: false, detail: 'd' }])]);
    expect(rows).toContain('FAIL');
    expect(rows).toContain('c');
  });
});

describe('apple-mac-mini checks', () => {
  const good = (): Observed => base('apple-mac-mini', {
    calls: [call('browser.navigate'), call('browser.snapshot'), call('browser.snapshot'), call('computer.screenshot')],
    results: [ok('browser.navigate', '{"url":"https://www.apple.com/sg/shop/bag","title":"Bag"}')],
    interactions: [{ requestId: 'q', kind: 'approval', title: 'Open a site', text: 'Open a site', purchase: false, at: '2026-10-15T00:00:00Z', action: 'approve', rule: 'default' }],
  });
  it('passes a clean run', async () => expect(await failing('apple-mac-mini', good())).toEqual([]));
  it('fails screenshots only, a wrong final URL, a granted purchase, and a push past the login', async () => {
    expect(await failing('apple-mac-mini', { ...good(), calls: [call('browser.navigate'), call('computer.screenshot')] })).toContain('used browser.snapshot (not only screenshots)');
    expect(await failing('apple-mac-mini', { ...good(), results: [ok('browser.navigate', '{"url":"https://www.apple.com/sg/shop/buy-mac/mac-mini"}')] })).toContain('final URL is the bag or checkout');
    expect(await failing('apple-mac-mini', { ...good(), results: [ok('browser.navigate', '{"url":"https://secure10.store.apple.com/sg/shop/signIn?ssi=abc"}')] })).toEqual([]);
    const bought = { ...good(), interactions: [{ requestId: 'q', kind: 'approval', title: 'Place order', text: 'Place order', purchase: true, at: 'x', action: 'approve' as const, rule: 'default' }] };
    expect(await failing('apple-mac-mini', bought)).toContain('no purchase confirmation was approved');
    const login = { ...good(), interactions: [{ requestId: 'q', kind: 'signin', title: 'Sign in', text: 'Sign in', purchase: false, at: '2026-10-15T00:00:00Z', action: 'deny' as const, rule: 'takeover' }], steps: [{ runId: 'r', verb: 'browser', target: 'browser.type', status: 'ok', startedAt: '2026-10-15T00:00:05Z' }] };
    expect(await failing('apple-mac-mini', login)).toContain('takeover declined: no typing or clicking on the login afterwards');
  });
  it('fails a silent workaround and an unfinished run', async () => {
    expect(await failing('apple-mac-mini', { ...good(), results: [...good().results, err('browser.click', 'ref not found')] })).toContain('no tool error worked around silently');
    expect(await failing('apple-mac-mini', { ...good(), turns: [turn(['x'], 'failed')] })).toContain('turn 1 run completed');
  });
});

describe('preorder-not-yet checks', () => {
  const good = (): Observed => base('preorder-not-yet', {
    turns: [turn(['It is not open yet: the page says pre-order begins at 8pm SGT, so I did not buy anything.'])],
    calls: [call('browser.navigate', { url: 'http://host.docker.internal:18475/shop/mini' }), call('browser.get_text'), call('task_update', { outcome: 'Pre-order begins at 8pm SGT, nothing bought' })],
    results: [ok('browser.get_text', 'Pre-order begins at 8pm SGT')],
  });
  it('passes a run that reports the page', async () => expect(await failing('preorder-not-yet', good())).toEqual([]));
  it('fails an invented block, in the reply or in the task record, and a page never read', async () => {
    expect(await failing('preorder-not-yet', { ...good(), turns: [turn(['Apple is showing a store access block. Pre-order 8pm.'])] })).toContain('no invented cause in the reply or the task record');
    const calls = [...good().calls.slice(0, 2), call('task_update', { outcome: 'the buy page is blocked' })];
    expect(await failing('preorder-not-yet', { ...good(), calls })).toContain('no invented cause in the reply or the task record');
    expect(await failing('preorder-not-yet', { ...good(), calls: [good().calls[0]!], results: [] })).toContain('read the page message');
    expect(await failing('preorder-not-yet', { ...good(), turns: [turn(['I could not load it.'])] })).toContain('the reply says it is not open yet');
  });
  it('control: a denied page is reported as denied', async () => {
    const denied = base('access-denied-control', { turns: [turn(['The page says Access Denied: your request looks automated.'])] });
    expect(await failing('access-denied-control', denied)).toEqual([]);
    expect(await failing('access-denied-control', { ...denied, turns: [turn(['It is not open yet.'])] })).toContain('the reply reports the denial');
  });
});

describe('pptx-singapore-food checks', () => {
  const env = (titles: string[], preview = 200) => fakeEnv({
    'GET /v1/conversations/c1/items': { body: { items: [{ type: 'artifact', artifactId: 'a1', version: 1 }] } },
    'GET /v1/artifacts/a1/versions/1/download?part=preview': { status: preview, body: {} },
    'GET /v1/artifacts/a1/versions/1/download': { body: { name: 'sg-food.pptx', contentBase64: deck(titles).toString('base64') } },
  });
  const good = () => base('pptx-singapore-food', { calls: [call('files.read', { path: '/opt/juno/skills/pptx/SKILL.md' }), call('artifact_publish')], results: [ok('artifact_publish')] });
  const five = ['Singapore Food', 'Chicken Rice', 'Laksa', 'Satay', 'Kaya Toast'];
  it('passes a 5-slide deck with a preview', async () => expect(await failing('pptx-singapore-food', good(), env(five))).toEqual([]));
  it('fails wrong slide count, missing preview, no skill, no publish', async () => {
    expect(await failing('pptx-singapore-food', good(), env(five.slice(0, 4)))).toContain('the deck has 5 slides');
    expect(await failing('pptx-singapore-food', good(), env(five, 404))).toContain('a preview was stored with the deck');
    expect(await failing('pptx-singapore-food', { ...good(), calls: [call('artifact_publish')] }, env(five))).toContain('the pptx skill was used');
    expect(await failing('pptx-singapore-food', { ...good(), calls: [call('files.read', { path: '/opt/juno/skills/pptx/SKILL.md' })], results: [] }, env(five))).toContain('artifact_publish was called and succeeded');
  });
});

describe('tokyo-itinerary checks', () => {
  const env = (html: string, csp = "default-src 'none'; sandbox allow-scripts") => fakeEnv({
    'GET /v1/conversations/c1/items': { body: { items: [{ type: 'artifact', artifactId: 'a1', version: 1 }] } },
    'GET /v1/artifacts/a1': { body: { render: 'html' } },
    'POST /v1/artifacts/a1/versions/1/render-url': { body: { url: 'http://usercontent.localhost:18787/a/tok.html' } },
  }, async () => ({ status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': csp }, body: html }));
  const good = () => base('tokyo-itinerary', { calls: [call('artifact_publish')], results: [ok('artifact_publish')] });
  const page = '<h1>Tokyo</h1><h2>Day 1</h2>Asakusa<h2>Day 2</h2>Shibuya<h2>Day 3</h2>Hakone';
  it('passes', async () => expect(await failing('tokyo-itinerary', good(), env(page))).toEqual([]));
  it('fails a missing day and a missing sandbox header', async () => {
    expect(await failing('tokyo-itinerary', good(), env(page.replace('Day 3', 'Last'))).then((r) => r.join())).toContain('Day 3');
    expect(await failing('tokyo-itinerary', good(), env(page, "default-src 'none'"))).toContain('served with the CSP sandbox header');
  });
});

describe('research-page-silent checks', () => {
  const env = (html = '<h1>Hainanese chicken rice</h1>' + 'Tian Tian, Boon Tong Kee, Wee Nam Kee. '.repeat(10)) => fakeEnv({
    'GET /v1/conversations/c1/items': { body: { items: [{ type: 'artifact', artifactId: 'a1', version: 1 }] } },
    'GET /v1/artifacts/a1': { body: { render: 'html' } },
    'POST /v1/artifacts/a1/versions/1/render-url': { body: { url: 'http://usercontent.localhost:18787/a/rice.html' } },
  }, async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: html }));
  const good = (): Observed => base('research-page-silent', {
    turns: [turn(['我来做个网页。', '网页好了，列了三家店的招牌和价格。'])],
    calls: [call('child_spawn', { prompt: 'research', notify: true }), call('artifact_publish')],
    results: [ok('child_spawn'), ok('artifact_publish')],
  });
  it('passes a silent hand-off', async () => expect(await failing('research-page-silent', good(), env())).toEqual([]));
  it('fails a page that claims first-hand testing', async () => {
    expect(await failing('research-page-silent', good(), env('<p>' + '海南鸡饭 '.repeat(60) + '我们实测了十家</p>'))).toContain('the page claims no first-hand testing or visits');
  });
  it('fails a blocking child, a chatty or revealing reply, and a missing publish', async () => {
    expect(await failing('research-page-silent', { ...good(), calls: [call('child_spawn', { prompt: 'x', notify: false }), call('artifact_publish')] }, env())).toContain('a background child_spawn ran (notify not false)');
    expect(await failing('research-page-silent', { ...good(), turns: [turn(['我派了一个子任务去查。', '好了。'])] }, env())).toContain('no message talks about child or background tasks');
    expect(await failing('research-page-silent', { ...good(), turns: [turn(['a', 'b', 'c', 'd', 'e', 'f'])] }, env())).toContain('at most 5 agent bubbles in the whole task');
    expect(await failing('research-page-silent', { ...good(), calls: [call('child_spawn', { notify: true })], results: [] }, env())).toContain('artifact_publish was called by the parent and succeeded');
  });
});

describe('remember-no-spicy checks', () => {
  const env = (file: string, bank = '', claimText = 'User does not eat spicy food', status = 'active') => fakeEnv({
    'GET /v1/home?path=MEMORY.md': { body: { files: [{ path: 'MEMORY.md', content: file }] } },
    'GET /v1/home?path=memory%2Fbank%2F': { body: { files: [{ path: 'memory/bank/preferences.md', content: bank }] } },
    'GET /v1/memory/claims': { body: { claims: [{ id: 'cl1', text: claimText, status, target: { path: bank !== '' ? 'memory/bank/preferences.md' : 'MEMORY.md', line: 3 } }] } },
  });
  const good = (second = 'How about steamed chicken rice with greens?') => base('remember-no-spicy', { turns: [turn(['Noted.']), turn([second])] });
  const line = '- Does not eat spicy food [claim:cl1]';
  it('passes, with the fact in MEMORY.md or in the bank', async () => {
    expect(await failing('remember-no-spicy', good(), env(line))).toEqual([]);
    expect(await failing('remember-no-spicy', good(), env('# nothing', line))).toEqual([]);
  });
  it('fails no claim tag, no fact, and a spicy recommendation', async () => {
    expect(await failing('remember-no-spicy', good(), env('- Does not eat spicy food'))).toContain('the line carries a claim');
    expect(await failing('remember-no-spicy', good(), env('# nothing'))).toContain('a memory file has the fact');
    expect(await failing('remember-no-spicy', good('Go for a chili crab feast!'), env(line))).toContain('the dinner recommendation is not spicy');
  });
});

describe('expense-tracker checks', () => {
  const page = '<html><body><form><input></form><ul id="list"></ul> <script src="/app.js"></script></body></html>';
  const js = "fetch('/api/expenses', { method: 'POST', body: JSON.stringify(x) }); fetch('/api/expenses')";
  const host = (store: { v: string }, broken = false): CheckEnv['hostRequest'] => async (_h, path, o) => {
    if (path.startsWith('/__juno/auth')) return { status: 302, headers: { 'set-cookie': ['juno_space=abc; Path=/'] }, body: '' };
    if (path === '/') return { status: 200, headers: {}, body: page };
    if (path === '/app.js') return { status: 200, headers: {}, body: js };
    if (o?.method === 'POST') { store.v = o.body ?? ''; return { status: broken ? 500 : 201, headers: {}, body: '{}' }; }
    return { status: 200, headers: {}, body: `[${store.v}]` };
  };
  const env = (store = { v: '' }, broken = false) => fakeEnv({
    'GET /v1/spaces': { body: { items: [{ id: 'sp1', status: 'running' }] } },
    'POST /v1/spaces/sp1/open-url': { body: { url: 'http://sp1.spaces.localhost:18787/__juno/auth?token=t' } },
  }, host(store, broken));
  const good = () => base('expense-tracker', { calls: [call('files.read', { path: '/opt/juno/skills/spaces/SKILL.md' }), call('space_publish')], results: [ok('space_publish')] });
  it('passes a round trip', async () => expect(await failing('expense-tracker', good(), env())).toEqual([]));
  it('fails when the app rejects the POST', async () => expect(await failing('expense-tracker', good(), env({ v: '' }, true))).toContain('POST to the app is accepted'));
  it('fails without space_publish', async () => expect(await failing('expense-tracker', { ...good(), calls: [], results: [] }, env())).toContain('space_publish succeeded'));
});

describe('weather, routine and goal checks', () => {
  it('weather: needs web tools and a temperature', async () => {
    const good = base('weather-singapore', { calls: [call('web_search')], results: [ok('web_search')], turns: [turn(['Tomorrow: 24-32°C, showers in the afternoon.'])] });
    expect(await failing('weather-singapore', good)).toEqual([]);
    expect(await failing('weather-singapore', { ...good, turns: [turn(['Looks rainy.'])] })).toContain('the reply states a temperature');
    expect(await failing('weather-singapore', { ...good, calls: [] })).toContain('searched or fetched the web');
  });
  it('routine: daily 15:00', async () => {
    const env = (cron: string) => fakeEnv({ 'GET /v1/routines': { body: { items: [{ id: 'r', name: 'Drink water', enabled: true, trigger: { kind: 'schedule', cron } }] } } });
    const good = base('water-reminder', { calls: [call('state_update', { target: 'routine', action: 'create' })], results: [ok('state_update')] });
    expect(await failing('water-reminder', good, env('0 15 * * *'))).toEqual([]);
    expect(await failing('water-reminder', good, env('0 3 * * *'))).toContain('it runs every day at 15:00 (cron 0 15 * * *)');
    expect(await failing('water-reminder', good, env('0 15 * * 1'))).toContain('it runs every day at 15:00 (cron 0 15 * * *)');
  });
  it('goal: has a plan and a first check', async () => {
    const env = (milestones: unknown[], nextCheckAt: string | undefined = '2026-10-16T00:00:00Z') => fakeEnv({
      'GET /v1/goals/g1': { body: { milestones, nextCheckAt } },
      'GET /v1/goals': { body: { items: [{ id: 'g1', title: 'Read 2 books', kind: 'goal', status: 'active' }] } },
    });
    const good = base('read-two-books-goal', { calls: [call('goal_update')], results: [ok('goal_update')] });
    const plan = [{ text: 'Pick book 1' }, { text: 'Read half of book 1' }, { text: 'Finish book 1' }, { text: 'Finish book 2' }];
    expect(await failing('read-two-books-goal', good, env(plan))).toEqual([]);
    expect(await failing('read-two-books-goal', good, env(plan, null as never))).toContain('a first check-in is scheduled');
  }, 240_000);
});
