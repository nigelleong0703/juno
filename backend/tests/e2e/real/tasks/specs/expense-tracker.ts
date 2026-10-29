import { callsOf, okResultsOf, skillsUsed } from '../observe';
import { verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';

/** The fetch() URLs a page (and its scripts) call, so the round trip uses the app's own API, not a guessed one. */
export function fetchedPaths(source: string): { post: string[]; get: string[] } {
  const post: string[] = [];
  const get: string[] = [];
  for (const m of source.matchAll(/fetch\(\s*(['"`])([^'"`$]+)\1\s*(?:,\s*\{([^}]*)\})?/g)) {
    const path = m[2] ?? '';
    if (!path.startsWith('/') && !path.startsWith('./') && !path.startsWith('api')) continue;
    (/method\s*:\s*['"`]POST/i.test(m[3] ?? '') ? post : get).push(path.replace(/^\.\//, '/').replace(/^(?!\/)/, '/'));
  }
  return { post: [...new Set(post)], get: [...new Set(get)] };
}

export const expenseTracker: TaskSpec = {
  id: 'expense-tracker',
  title: 'Spaces: a small expense tracker app, published and working',
  timeoutMs: 1_500_000,
  turns: [{ message: 'Build a small expense tracker app.' }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    (o) => [
      verdict('the spaces skill was used', skillsUsed(o).includes('spaces'), `skills seen: ${skillsUsed(o).join(', ') || 'none'}`),
      verdict('space_publish succeeded', callsOf(o, 'space_publish').length > 0 && okResultsOf(o, 'space_publish').length > 0, 'space_publish missing or failed'),
    ],
    async (_o, env): Promise<CheckResult[]> => {
      const out: CheckResult[] = [];
      const spaces = await env.api('GET', '/v1/spaces');
      const space = ((spaces.body?.items ?? []) as Array<{ id: string; status: string; title?: string }>).find((s) => s.status === 'published' || s.status === 'running');
      out.push(verdict('a published Space exists', space !== undefined, `spaces: ${JSON.stringify(spaces.body).slice(0, 300)}`));
      if (space === undefined) return out;
      const opened = await env.api('POST', `/v1/spaces/${space.id}/open-url`);
      const link = new URL(String(opened.body?.url ?? 'http://invalid.invalid/'));
      const granted = await env.hostRequest(link.host, link.pathname + link.search);
      const cookie = /^(juno_space=[^;]+)/.exec(String(granted.headers['set-cookie']?.[0] ?? ''))?.[1] ?? '';
      out.push(verdict('the owner can open it through the gateway', granted.status === 302 && cookie !== '', `open ${granted.status}`));
      const page = await env.hostRequest(link.host, '/', { headers: { cookie } });
      out.push(verdict('the gateway returns the page', page.status === 200 && /<html|<!doctype|<body/i.test(page.body), `status ${page.status}`));
      // One round trip through the app's own API: find a POST the page makes, send an expense, read it back.
      let source = page.body;
      for (const src of [...page.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1] ?? '')) {
        if (src.startsWith('/') || src.startsWith('./')) source += '\n' + (await env.hostRequest(link.host, src.replace(/^\./, ''), { headers: { cookie } })).body;
      }
      out.push(verdict('the page has a form to add an entry', /<(form|input|button|textarea)\b|["'`](form|input|button|textarea)["'`]/i.test(source), 'no form, input or button'));
      out.push(verdict('the page has a place to list entries', /<(ul|ol|table|tbody|li)\b|(list|table|items|entries|rows)["'\s]/i.test(source), 'no list or table'));
      const { post, get } = fetchedPaths(source);
      const target = post[0];
      if (target === undefined) return [...out, verdict('the page talks to its own API (a fetch POST)', false, `fetch calls: get ${get.join(',') || '-'}, post none`)];
      const marker = 'e2e-roundtrip-' + Date.now().toString(36);
      const body = JSON.stringify({ description: marker, title: marker, name: marker, note: marker, category: 'food', amount: 12.5, date: new Date().toISOString().slice(0, 10) });
      const posted = await env.hostRequest(link.host, target, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
      out.push(verdict('POST to the app is accepted', posted.status >= 200 && posted.status < 300, `POST ${target} -> ${posted.status} ${posted.body.slice(0, 120)}`));
      const readBack = await env.hostRequest(link.host, target, { headers: { cookie } });
      out.push(verdict('GET returns what was posted', readBack.status === 200 && readBack.body.includes(marker), `GET -> ${readBack.status} ${readBack.body.slice(0, 160)}`));
      return out;
    },
  ],
};
