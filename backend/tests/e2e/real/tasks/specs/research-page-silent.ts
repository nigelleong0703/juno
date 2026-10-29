import { callsOf, okResultsOf, stripTags } from '../observe';
import { verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';
import { artifactCards } from './pptx-singapore-food';

/** The words that would mean the agent narrated its own work split to the user. */
const SPLIT_TALK = /子任务|后台任务|subtask|sub-task|child task|background task/i;

/** Claims of first-hand testing or visits: a page compiled from research must not make them. */
const FIRST_HAND = /(?<![非未没不])(实测|亲测|实地探店)|first-hand|we tested/i;

/** The match with 40 characters on each side, so a failure shows whether it is a claim or a disclaimer. */
const around = (text: string, pattern: RegExp): string => {
  const at = text.search(pattern);
  return at < 0 ? '' : text.slice(Math.max(0, at - 40), at + 40);
};

export const researchPageSilent: TaskSpec = {
  id: 'research-page-silent',
  title: 'Long research into a web page: background research child, then a page child, few short messages',
  timeoutMs: 900_000,
  turns: [{ message: '帮我调研一下新加坡评价最好的十家海南鸡饭店，对比价格、口味评价和排队情况，做成一个网页' }],
  user: { fallbackReply: '你看着办', defaultApproval: 'approve', replies: [{ match: /./, answer: '你看着办' }] },
  checks: [
    // A research child hits dead links (404, unknown host) and moves on to other sources; the published page is the proof it recovered.
    (o) => commonChecks(o).filter((check) => check.name !== 'no tool error worked around silently'),
    (o) => {
      const spawns = callsOf(o, 'child_spawn');
      const replies = o.turns.flatMap((t) => t.replies);
      return [
        verdict('a background child_spawn ran (notify not false)', spawns.some((c) => c.args['notify'] !== false), `spawns: ${JSON.stringify(spawns.map((c) => c.args['notify']))}`),
        verdict('artifact_publish was called by the parent and succeeded', callsOf(o, 'artifact_publish').length > 0 && okResultsOf(o, 'artifact_publish').length > 0, 'artifact_publish missing or failed'),
        verdict('at most 5 agent bubbles in the whole task', replies.length <= 5, `${replies.length} bubbles`),
        verdict('no message talks about child or background tasks', !replies.some((text) => SPLIT_TALK.test(text)), replies.filter((text) => SPLIT_TALK.test(text)).join(' | ')),
      ];
    },
    async (o, env): Promise<CheckResult[]> => {
      const cards = await artifactCards(o, env);
      let html: { artifactId: string; version: number } | undefined;
      for (const card of cards) if ((await env.api('GET', `/v1/artifacts/${card.artifactId}`)).body?.render === 'html') html = card;
      if (html === undefined) return [verdict('an HTML artifact was published', false, `cards ${cards.length}`)];
      const minted = await env.api('POST', `/v1/artifacts/${html.artifactId}/versions/${html.version}/render-url`);
      if (minted.status !== 200) return [verdict('an HTML artifact was published', true, ''), verdict('render-url works', false, `status ${minted.status}`)];
      const url = new URL(String(minted.body.url));
      const served = await env.hostRequest(url.host, url.pathname);
      return [
        verdict('an HTML artifact was published', true, ''),
        verdict('the page is served and has some content', served.status === 200 && stripTags(served.body).length > 200, `status ${served.status}, ${stripTags(served.body).length} characters of text`),
        verdict('the page claims no first-hand testing or visits', !FIRST_HAND.test(stripTags(served.body)), around(stripTags(served.body), FIRST_HAND)),
      ];
    },
  ],
};
