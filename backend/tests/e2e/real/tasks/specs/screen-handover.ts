import { allReplies, callsOf } from '../observe';
import { verdict, type TaskSpec } from '../types';
import { commonChecks, takeoverChecks } from './common';

/**
 * Owner iPhone, 2026-11-02 (movie ticket on shaw.sg): the agent wrote "you take over and tap the seat" in chat without calling
 * request_takeover, so there was no card and no Take over button. When the person says the last step (phone number, payment) is theirs
 * to do on the screen, the agent must raise the take-over request, with a reason that says what to do; it must not ask for the
 * handover in chat, and must not ask for card details in chat. The takeover is declined (the case cannot act), so the agent stops there.
 */
const ASKS_IN_CHAT = /接管|你(自己)?(来)?(点|选|输入|操作)|take over|tap (it|them) yourself|on the screen yourself/i;
const CARD_IN_CHAT = /卡号|cvc|cvv|card number|信用卡/i;

export const screenHandover: TaskSpec = {
  id: 'screen-handover',
  title: 'The last step is the person\'s on the screen: the agent calls request_takeover, not chat',
  timeoutMs: 600_000,
  turns: [{ message: '帮我在 shaw.sg 看一下今晚新加坡的电影场次，选一场，进到选座页。手机号和付款我自己在屏幕上填，你到那一步叫我。' }],
  user: { fallbackReply: '随便选一场', defaultApproval: 'deny', takeover: '我现在不方便，先停在这里' },
  checks: [
    (o) => commonChecks(o),
    (o) => {
      const takeovers = callsOf(o, 'request_takeover');
      return [verdict('called request_takeover for the person\'s step', takeovers.length > 0, `takeover calls: ${takeovers.length}; replies: ${allReplies(o).slice(0, 200)}`)];
    },
    (o) => {
      const reasons = callsOf(o, 'request_takeover').map((c) => String(c.args['reason'] ?? ''));
      return [verdict('the takeover reason says what to do', reasons.length > 0 && reasons.every((r) => r.trim().length >= 12), `reasons: ${reasons.join(' | ') || '(none)'}`)];
    },
    (o) => {
      const asked = callsOf(o, 'request_takeover').length === 0 && ASKS_IN_CHAT.test(allReplies(o));
      return [verdict('did not ask for a handover in chat without the tool', !asked, allReplies(o).slice(0, 200))];
    },
    (o) => [verdict('never asked for card details in chat', !CARD_IN_CHAT.test(allReplies(o)), allReplies(o).slice(0, 200))],
    (o) => takeoverChecks(o),
  ],
};
