import { callsOf, okResultsOf, stripTags } from '../observe';
import { fail, verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';
import { artifactCards } from './pptx-singapore-food';

export const tokyoItinerary: TaskSpec = {
  id: 'tokyo-itinerary',
  title: 'Web page: 3-day Tokyo itinerary (HTML artifact)',
  timeoutMs: 900_000,
  turns: [{ message: 'Make a web page for a 3-day Tokyo itinerary.' }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    (o) => [verdict('artifact_publish was called and succeeded', callsOf(o, 'artifact_publish').length > 0 && okResultsOf(o, 'artifact_publish').length > 0, 'artifact_publish missing or failed')],
    async (o, env) => {
      const out: CheckResult[] = [];
      const cards = await artifactCards(o, env);
      let html: { artifactId: string; version: number } | undefined;
      for (const card of cards) {
        const detail = await env.api('GET', `/v1/artifacts/${card.artifactId}`);
        if (detail.body?.render === 'html') html = card;
      }
      out.push(verdict('an HTML artifact was published', html !== undefined, `cards ${cards.length}`));
      if (html === undefined) return out;
      const minted = await env.api('POST', `/v1/artifacts/${html.artifactId}/versions/${html.version}/render-url`);
      out.push(verdict('render-url works', minted.status === 200 && typeof minted.body?.url === 'string', `status ${minted.status}`));
      if (minted.status !== 200) return out;
      const url = new URL(String(minted.body.url));
      const served = await env.hostRequest(url.host, url.pathname);
      const csp = String(served.headers['content-security-policy'] ?? '');
      out.push(verdict('the page is served', served.status === 200 && /text\/html/.test(String(served.headers['content-type'])), `status ${served.status}`));
      out.push(verdict('served with the CSP sandbox header', /sandbox/.test(csp) && /default-src 'none'/.test(csp), `csp ${csp || '(none)'}`));
      const text = stripTags(served.body);
      for (const day of [1, 2, 3]) out.push(verdict(`the page has Day ${day}`, new RegExp(`day\\s*${day}\\b`, 'i').test(text), `text starts: ${text.slice(0, 160)}`));
      out.push(verdict('the page is about Tokyo', /tokyo/i.test(text), 'no Tokyo'));
      if (/day\s*4\b/i.test(text)) out.push(fail('the itinerary has 3 days, not more', 'found Day 4'));
      return out;
    },
  ],
};
