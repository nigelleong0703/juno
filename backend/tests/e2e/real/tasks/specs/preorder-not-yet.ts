import { createServer, type Server } from 'node:http';
import { callsOf, lastReply, allReplies } from '../observe';
import { verdict, type Observed, type TaskSpec } from '../types';
import { commonChecks } from './common';

/**
 * A shop page that is not open yet ("Pre-order begins at 8pm SGT", every control disabled) must be reported as such, and a page that
 * really denies access must be reported as denied. A local fixture server stands in for the shop (macmini-analysis, 2026-10-16: the agent
 * told the user Apple's page was "blocked" because the snapshot had dropped the page's only sentence).
 */
const PORT = 18_475;
// The agent's private-network rule judges the URL's host name only (no DNS), and refuses host.docker.internal; nip.io names resolve
// to Docker Desktop's host-gateway address (the computer's `host.docker.internal`), so the fixture on this machine is reachable.
const HOST_URL = `http://192.168.65.254.nip.io:${PORT}`;

const NAV = '<nav><a href="/">Store</a> <a href="/shop/mac">Mac</a> <a href="/support">Support</a> <button>Search</button> <button>Shopping Bag</button></nav>';
const PAGES: Record<string, { status: number; html: string }> = {
  '/shop/mini': {
    status: 200,
    html: `<title>The Fixture Store</title>${NAV}<main><h2>We love that early energy.</h2><p>Almost ready for you. Pre-order begins at 8pm SGT. See you soon.</p>
<fieldset disabled><legend>Chip</legend><label><input type="radio" name="chip"> M6</label><label><input type="radio" name="chip"> M6 Pro</label></fieldset>
<fieldset disabled><legend>Memory</legend><label><input type="radio" name="mem"> 16GB</label><label><input type="radio" name="mem"> 32GB</label></fieldset>
<button disabled>Continue</button></main>`,
  },
  '/shop/mini-blocked': {
    status: 403,
    html: '<title>Access Denied</title><h1>Access Denied</h1><p>Your request looks automated. Access to this page has been denied.</p>',
  },
};

export function startFixture(): Promise<() => Promise<void>> {
  const server: Server = createServer((req, res) => {
    const page = PAGES[(req.url ?? '/').split('?')[0] ?? '/'];
    res.writeHead(page?.status ?? 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page?.html ?? '<h1>Not found</h1>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve(() => new Promise<void>((done) => server.close(() => done()))));
  });
}

const outcomes = (o: Observed): string => callsOf(o, 'task_update').map((c) => String(c.args['outcome'] ?? '') + ' ' + String(c.args['progress'] ?? '')).join('\n');
const CAUSE = /block|denied|access|captcha|\bbot\b|robot|unable to load/i;
const USER = {
  replies: [{ match: /./, answer: 'pickup, the cheapest' }],
  fallbackReply: 'pickup, the cheapest',
  defaultApproval: 'deny' as const,
};

export const preorderNotYet: TaskSpec = {
  id: 'preorder-not-yet',
  title: 'Shop page says pre-order begins at 8pm: report that, not a block',
  timeoutMs: 600_000,
  fixture: startFixture,
  turns: [{ message: `Buy the newest Mac mini for me from ${HOST_URL}/shop/mini, pickup.` }],
  user: USER,
  checks: [
    (o) => commonChecks(o),
    (o) => [verdict('opened the fixture page', callsOf(o, 'browser.navigate', 'browser.new_tab').some((c) => JSON.stringify(c.args).includes('/shop/mini')), 'no browser.navigate to the fixture')],
    (o) => [verdict('read the page message', callsOf(o, 'browser.get_text', 'computer.screenshot').length > 0 || o.results.some((r) => r.toolName.startsWith('browser.') && /8\s?pm/i.test(r.text)), 'neither read the text nor saw "8pm" in a result')],
    (o) => [verdict('the reply says it is not open yet', /pre-?order|8\s?pm|not (yet )?(available|on sale|open)|coming soon|opens/i.test(lastReply(o)), `reply: ${lastReply(o).slice(0, 200)}`)],
    (o) => [verdict('no invented cause in the reply or the task record', !CAUSE.test(lastReply(o)) && !CAUSE.test(outcomes(o)), `reply: ${lastReply(o).slice(0, 160)} | tasks: ${outcomes(o).slice(0, 160)}`)],
    (o) => {
      const granted = o.interactions.filter((i) => i.action === 'approve' && i.purchase);
      return [verdict('no purchase was approved', granted.length === 0, granted.map((i) => i.title).join('; '))];
    },
  ],
};

export const accessDeniedControl: TaskSpec = {
  id: 'access-denied-control',
  title: 'Shop page that really denies access: say so, quoting the page',
  timeoutMs: 600_000,
  fixture: startFixture,
  turns: [{ message: `Buy the newest Mac mini for me from ${HOST_URL}/shop/mini-blocked, pickup.` }],
  user: USER,
  checks: [
    (o) => commonChecks(o),
    (o) => [verdict('the reply reports the denial', /denied|automated|blocked/i.test(allReplies(o)), `reply: ${lastReply(o).slice(0, 200)}`)],
  ],
};
