import { callsOf, lastReply } from '../observe';
import { verdict, type TaskSpec } from '../types';
import { commonChecks } from './common';

export const weatherSingapore: TaskSpec = {
  id: 'weather-singapore',
  title: "Web research: tomorrow's weather in Singapore",
  timeoutMs: 600_000,
  turns: [{ message: "Find tomorrow's weather in Singapore and tell me." }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    (o) => {
      const reply = lastReply(o);
      return [
        verdict('searched or fetched the web', callsOf(o, 'web_search', 'web_fetch').length > 0, `tools: ${[...new Set(o.calls.map((c) => c.name))].join(', ')}`),
        verdict('the reply states a temperature', /\d{2}(\.\d)?\s*(°|º|degrees?|deg\b|℃|C\b|celsius)|\d{2}\s*(to|-|–)\s*\d{2}\s*(°|º)/i.test(reply), `reply: ${reply.slice(0, 200)}`),
      ];
    },
  ],
};
