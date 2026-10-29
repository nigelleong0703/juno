import { browserUrls, callsOf, lastReply } from '../observe';
import { verdict, type CheckResult, type TaskSpec } from '../types';
import { commonChecks } from './common';

const POSTCODE = '319458';
/** Tool work that means the agent has started on the task (not just asking). */
const WORK = /^(browser\.|computer\.|web_search|web_fetch|child_spawn)/;
/** More coordinate clicks than this means the snapshot failed it and it fell back to clicking a screenshot. */
const MAX_COORDINATE_CLICKS = 3;

/**
 * The owner's "Shopee Finder" conversation (2026-10-18): the agent asked five questions over five turns, never opened Shopee,
 * spent 24 steps on screenshot clicks on Lazada, and did not save the postcode the owner gave. Plan first, ask once,
 * open the shops with the browser tools, save the postcode, and compare totals with shipping.
 */
export const detergentCheapestPlatform: TaskSpec = {
  id: 'detergent-cheapest-platform',
  title: 'Shopping plan-first: one question card, Shopee and Lazada opened in the browser, postcode saved, totals with shipping',
  timeoutMs: 1_200_000,
  turns: [
    { message: 'Want to buy detergent, help me find price and see which platform is cheaper' },
    { message: `I'm at ${POSTCODE}. With shipping and vouchers, which platform is cheapest for one?` },
  ],
  user: {
    replies: [
      { match: /post(al)? ?code|postcode|address|deliver(y)? to|location|where (do )?you live|area/i, answer: POSTCODE },
      { match: /brand/i, answer: 'Dynamo' },
      { match: /scent|fragrance/i, answer: 'Fresh' },
      { match: /type|form|liquid|powder|pods?|capsules?/i, answer: 'Pods / capsules' },
      { match: /size|pack|quantity|how many|count/i, answer: '52 pods, one tub' },
      { match: /platform|shop|store|where|site/i, answer: 'Shopee and Lazada' },
    ],
    fallbackReply: 'Dynamo 4in1 laundry capsules, 52 pods, Fresh, from Shopee or Lazada',
    defaultApproval: 'approve',
    takeover: "I can't sign in now, continue without it",
  },
  checks: [
    (o) => commonChecks(o),
    (o) => {
      const firstWork = o.steps.filter((s) => WORK.test(s.target)).map((s) => Date.parse(s.startedAt)).sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;
      // A fresh account's first message also gets the platform's "pick a name" onboarding card: that one is not the agent asking.
      const questions = o.interactions.filter((i) => i.kind === 'question' && !/pick a name/i.test(i.text));
      const before = questions.filter((i) => Date.parse(i.at) < firstWork);
      const shops = browserUrls(o).filter((url) => /(^|\.)(shopee|lazada)\.sg/i.test(new URL(url, 'https://x').hostname));
      const coordinateClicks = callsOf(o, 'computer.click', 'computer.double_click').length;
      return [
        verdict('at most one question card before work started', before.length <= 1, `${before.length} questions first: ${before.map((i) => i.text.slice(0, 120)).join(' || ')}`),
        verdict('no more than two question cards in the whole case', questions.length <= 2, questions.map((i) => i.text.slice(0, 120)).join(' || ')),
        verdict('Shopee or Lazada was opened with the browser tools', shops.length > 0, `browser URLs: ${browserUrls(o).slice(0, 8).join(', ') || '(none)'}`),
        verdict(`at most ${MAX_COORDINATE_CLICKS} coordinate clicks`, coordinateClicks <= MAX_COORDINATE_CLICKS, `${coordinateClicks} computer.click calls, ${callsOf(o, 'browser.snapshot').length} snapshots`),
      ];
    },
    async (_o, env): Promise<CheckResult[]> => {
      const profile = (await env.api('GET', '/v1/profile')).body;
      return [verdict(`the postcode ${POSTCODE} is saved to the profile`, JSON.stringify(profile ?? {}).includes(POSTCODE), `profile: ${JSON.stringify(profile).slice(0, 300)}`)];
    },
    (o) => {
      const reply = o.turns.at(-1)?.replies.join('\n') ?? lastReply(o);
      // Shopee shows prices only after a sign-in the scripted user declines, so the comparison may be Lazada against another shop.
      const shops = ['shopee', 'lazada', 'fairprice', 'redmart'].filter((shop) => new RegExp(shop, 'i').test(reply));
      return [verdict('the final answer compares platforms\' totals including shipping', shops.length >= 2 && /lazada|shopee/i.test(reply) && /shipping|delivery|运费/i.test(reply) && /\$\s?\d/.test(reply), reply.slice(0, 400))];
    },
  ],
};
