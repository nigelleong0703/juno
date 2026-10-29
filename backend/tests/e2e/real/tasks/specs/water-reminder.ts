import { callsOf, okResultsOf } from '../observe';
import { verdict, type TaskSpec } from '../types';
import { commonChecks } from './common';

export const waterReminder: TaskSpec = {
  id: 'water-reminder',
  title: 'Routine: drink water every day at 3pm',
  timeoutMs: 600_000,
  turns: [{ message: 'Set a reminder to drink water every day at 3pm' }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /time ?zone|where|city|location/i, answer: 'Asia/Singapore' }, { match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    async (o, env) => {
      const routines = await env.api('GET', '/v1/routines');
      const items = (routines.body?.items ?? []) as Array<{ id: string; name: string; enabled: boolean; instructions?: string; trigger: { kind: string; cron?: string; human?: string } }>;
      const water = items.filter((r) => /water|drink/i.test(`${r.name} ${r.instructions ?? ''}`));
      const daily3pm = water.find((r) => r.trigger.kind === 'schedule' && /^0\s+15\s+\*\s+\*\s+(\*|0-6|1-7|\*\/1)$/.test((r.trigger.cron ?? '').trim()));
      return [
        verdict('state_update created a routine', callsOf(o, 'state_update').some((c) => c.args['target'] === 'routine') && okResultsOf(o, 'state_update').length > 0, 'no successful state_update'),
        verdict('exactly one water routine exists', water.length === 1, `routines: ${items.map((r) => `${r.name} [${r.trigger.cron ?? r.trigger.kind}]`).join('; ') || 'none'}`),
        verdict('it runs every day at 15:00 (cron 0 15 * * *)', daily3pm !== undefined, `cron: ${water.map((r) => r.trigger.cron).join(', ') || 'none'}`),
        verdict('it is enabled', water.every((r) => r.enabled), 'disabled'),
      ];
    },
  ],
};
