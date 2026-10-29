import { callsOf, okResultsOf } from '../observe';
import { verdict, type TaskSpec } from '../types';
import { commonChecks } from './common';

export const readTwoBooksGoal: TaskSpec = {
  id: 'read-two-books-goal',
  title: 'Goal: read 2 books this month, with milestones',
  timeoutMs: 600_000,
  turns: [{ message: 'Create a goal: read 2 books this month' }],
  user: { fallbackReply: 'use your best judgement', defaultApproval: 'approve', replies: [{ match: /./, answer: 'use your best judgement' }] },
  checks: [
    (o) => commonChecks(o),
    async (o, env) => {
      // The goal's agent writes its plan (3 to 7 milestones) in a run of its own right after the goal exists: wait for it.
      let items: Array<{ id: string; title: string; kind: string; status: string }> = [];
      let book: (typeof items)[number] | undefined;
      let milestones: Array<{ text?: string; title?: string; done?: boolean; status?: string }> = [];
      let nextCheckAt: string | undefined;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        items = ((await env.api('GET', '/v1/goals')).body?.items ?? []) as typeof items;
        book = items.find((g) => /book|read/i.test(g.title));
        const detail = book === undefined ? undefined : await env.api('GET', `/v1/goals/${book.id}`);
        milestones = (detail?.body?.milestones ?? []) as typeof milestones;
        nextCheckAt = (detail?.body?.nextCheckAt ?? undefined) as string | undefined;
        if (milestones.length >= 3) break;
        await new Promise((done) => setTimeout(done, 3_000));
      }
      return [
        verdict('goal_update was called and succeeded', callsOf(o, 'goal_update').length > 0 && okResultsOf(o, 'goal_update').length > 0, 'no successful goal_update'),
        verdict('a goal about reading books exists', book !== undefined, `goals: ${items.map((g) => g.title).join('; ') || 'none'}`),
        verdict('it is an active goal', book?.status === 'active', `status ${book?.status}`),
        verdict('it has a plan of 3 to 7 milestones', milestones.length >= 3 && milestones.length <= 7, `${milestones.length} milestones after waiting 3 minutes`),
        verdict('the milestones are not already done', milestones.every((m) => m.done !== true && m.status !== 'done'), JSON.stringify(milestones).slice(0, 200)),
        verdict('a first check-in is scheduled', nextCheckAt !== undefined, 'no nextCheckAt'),
        verdict('exactly one such goal (no duplicates)', items.filter((g) => /book/i.test(g.title)).length === 1, `${items.length} goals`),
      ];
    },
  ],
};
