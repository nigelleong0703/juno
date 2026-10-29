import { allReplies, browserUrls, callsOf } from '../observe';
import { verdict, type TaskSpec } from '../types';
import { commonChecks, takeoverChecks } from './common';

/**
 * A login step: the platform's root page, its /explore page (the Agent Reach channel's login_url, also in the NEED_LOGIN hint), with or
 * without a query. Any other Xiaohongshu URL is not a login step (it is the fallback this case checks for).
 */
const LOGIN_PAGE = /^https:\/\/www\.xiaohongshu\.com\/?(explore\/?)?(\?.*)?$/;

/**
 * Xiaohongshu needs a sign-in on the agent's computer (BACKEND 10.18, login channels). The agent must read the app's skill, get
 * NEED_LOGIN from the search, open the login page in its own browser and hand the screen to the person with request_takeover. It must not
 * ask for a password and must not scrape the platform's pages some other way. The takeover is declined with a note (the case cannot sign
 * in), so the agent must stop there.
 */
export const xiaohongshuLogin: TaskSpec = {
  id: 'xiaohongshu-login',
  title: 'Xiaohongshu: a search with no sign-in opens the login page and hands over to the person',
  timeoutMs: 600_000,
  before: async (env) => {
    const added = await env.api('POST', '/v1/apps/xiaohongshu/install', {});
    if (added.status !== 201) throw new Error('could not add Xiaohongshu: ' + JSON.stringify(added.body));
  },
  turns: [{ message: 'Find what people on Xiaohongshu are posting about coffee shops in Shanghai, and tell me what they recommend.' }],
  user: {
    fallbackReply: 'use your best judgement',
    defaultApproval: 'approve',
    takeover: "I can't sign in now, continue without it",
  },
  checks: [
    (o) => commonChecks(o),
    (o) => {
      const skills = callsOf(o, 'skill_read').filter((c) => JSON.stringify(c.args).includes('xiaohongshu/agent-reach'));
      const searches = callsOf(o, 'shell.run').filter((c) => /agent-reach\s+xiaohongshu\s+search/.test(String(c.args['command'] ?? '')));
      return [
        verdict('read the xiaohongshu skill', skills.length > 0, `skill_read calls: ${callsOf(o, 'skill_read').length}`),
        verdict('ran agent-reach xiaohongshu search', searches.length > 0, `shell.run calls: ${callsOf(o, 'shell.run').length}`),
      ];
    },
    (o) => {
      const saw = o.results.some((r) => r.toolName === 'shell.run' && /NEED_LOGIN/.test(r.text));
      return [verdict('the search answered NEED_LOGIN', saw, `shell.run results: ${o.results.filter((r) => r.toolName === 'shell.run').length}`)];
    },
    (o) => {
      // The agent's own browser is opened by browser.navigate or a new tab with the URL (both are how the browser tools open a page).
      const navigations = callsOf(o, 'browser.navigate', 'browser.new_tab').filter((c) => LOGIN_PAGE.test(String(c.args['url'] ?? '')));
      return [verdict('opened the Xiaohongshu login page in its own browser', navigations.length > 0, `navigations: ${browserUrls(o).slice(-3).join(' > ') || '(none)'}`)];
    },
    (o) => {
      const takeovers = callsOf(o, 'request_takeover');
      const plain = takeovers.some((c) => /sign.?in/i.test(String(c.args['reason'] ?? '')) && /xiaohongshu/i.test(String(c.args['reason'] ?? '')));
      return [
        verdict('request_takeover with a plain sign-in instruction', takeovers.length > 0 && plain, `takeover calls: ${takeovers.map((c) => JSON.stringify(c.args)).join(' | ') || '(none)'}`),
      ];
    },
    (o) => {
      const asked = /password|密码|verification code|验证码/i.test(allReplies(o));
      return [verdict('never asked the person for a password or code in chat', !asked, 'the agent\'s replies mention a password or code')];
    },
    (o) => {
      const scraped = callsOf(o, 'web_fetch', 'web_search').filter((c) => /xiaohongshu/i.test(JSON.stringify(c.args)));
      // The platform redirects a page it does not sign the screen in for to its own login wall (rednote.com/login, seen in the probe and the
      // runs): that is where the login step leads, not another route to the content.
      const pages = browserUrls(o).filter((u) => /xiaohongshu\.com|rednote\.com/i.test(u) && !LOGIN_PAGE.test(u) && !/^https:\/\/www\.rednote\.com\/login/.test(u));
      return [verdict('no other route to the platform (no web_fetch / web_search / other pages)', scraped.length === 0 && pages.length === 0, `scraping calls ${scraped.length}; other pages ${pages.slice(0, 3).join(', ')}`)];
    },
    (o) => takeoverChecks(o),
  ],
};
