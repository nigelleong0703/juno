import { callsOf, okResultsOf, stripTags } from '../observe';
import { verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';
import { artifactCards } from './pptx-singapore-food';

/** The owner's own conversation (2026-10-18): a plan built up over chat, then "a very detailed plan". */
const NO_COMPUTER = /computer (isn'?t|is not) (attached|available|connected)|can'?t build a (file|page|artifact)/i;

export const klWeekendPlan: TaskSpec = {
  id: 'kl-weekend-plan',
  title: 'A detailed trip plan asked for in chat: react, one line, real research, an HTML artifact (not a card from memory)',
  timeoutMs: 900_000,
  turns: [
    { message: 'Going to kl in the next long weekend, we are flying to kl in Friday night and go back to sg in the Monday evening 2.30pm, how can I plan it' },
    { message: 'Yea I have booked flight, 745 pm, and hotel is in klcc, and I don’t know where to go and eat' },
    { message: 'I need a very detailed plan, only 2 adults' },
    // The owner's follow-up (2026-10-18): the change must be a new version of the page, not a second artifact.
    { message: 'change Sunday to a Batu Caves morning and update the page' },
  ],
  user: { fallbackReply: 'hawker food, we like walking', defaultApproval: 'approve', replies: [{ match: /./, answer: 'hawker food, we like walking' }] },
  checks: [
    // Research hits dead links and moves on; the published page is the proof it recovered.
    (o) => commonChecks(o).filter((check) => check.name !== 'no tool error worked around silently'),
    (o) => {
      const replies = o.turns.flatMap((t) => t.replies);
      const researched = callsOf(o, 'web_fetch', 'web_search', 'browser.navigate', 'browser.get_text').length > 0
        || callsOf(o, 'child_spawn').some((c) => c.args['mission'] === 'research');
      return [
        verdict('the agent reacted to a message that started work', callsOf(o, 'react').length > 0, 'react never called'),
        verdict('the plan was researched on real pages, not written from memory', researched, 'no web or research-helper call'),
        verdict('artifact_publish was called and succeeded', okResultsOf(o, 'artifact_publish').length > 0, 'artifact_publish missing or failed'),
        verdict('no message claims the computer is unavailable', !replies.some((text) => NO_COMPUTER.test(text)), replies.filter((text) => NO_COMPUTER.test(text)).join(' | ')),
      ];
    },
    async (o, env): Promise<CheckResult[]> => {
      const published = okResultsOf(o, 'artifact_publish');
      const cards = await artifactCards(o, env);
      const htmlIds = new Set<string>();
      for (const card of cards) if ((await env.api('GET', `/v1/artifacts/${card.artifactId}`)).body?.render === 'html') htmlIds.add(card.artifactId);
      const first = [...htmlIds][0];
      const latest = first === undefined ? undefined : (await env.api('GET', `/v1/artifacts/${first}`)).body;
      const withId = callsOf(o, 'artifact_publish').filter((c) => c.args['artifactId'] === first);
      return [
        verdict('the update was published as a new version of the first page', published.length >= 2 && withId.length > 0, `publishes ${published.length}, with the first artifactId ${withId.length}: ` + callsOf(o, 'artifact_publish').map((c) => JSON.stringify(c.args)).join(' | ')),
        verdict('there is a single html artifact, at version 2 or later', htmlIds.size === 1 && Number(latest?.version) >= 2, `html artifacts ${htmlIds.size}, version ${String(latest?.version)}`),
      ];
    },
    async (o, env): Promise<CheckResult[]> => {
      const cards = await artifactCards(o, env);
      let html: { artifactId: string; version: number } | undefined;
      for (const card of cards) if ((await env.api('GET', `/v1/artifacts/${card.artifactId}`)).body?.render === 'html') html = card;
      if (html === undefined) return [verdict('an HTML artifact was published', false, `cards ${cards.length}`)];
      const minted = await env.api('POST', `/v1/artifacts/${html.artifactId}/versions/${html.version}/render-url`);
      if (minted.status !== 200) return [verdict('render-url works', false, `status ${minted.status}`)];
      const url = new URL(String(minted.body.url));
      const text = stripTags((await env.hostRequest(url.host, url.pathname)).body);
      return [
        verdict('an HTML artifact was published', true, ''),
        // The fixed facts the chat gave must shape the plan: the flight times and the KLCC base.
        verdict('the page uses the chat\'s fixed facts (KLCC, Friday 7:45pm arrival, Monday 2:30pm flight)', /klcc/i.test(text) && /7[:.]?45/.test(text) && /2[:.]?30/.test(text), text.slice(0, 200)),
        verdict('the page covers Friday to Monday', ['fri', 'sat', 'sun', 'mon'].every((day) => new RegExp(day, 'i').test(text)), text.slice(0, 200)),
      ];
    },
  ],
};
