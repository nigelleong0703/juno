/**
 * The silence rule (BACKEND §5.10): after 5 proactive items of the same type in a row that the owner never read (messages) or
 * never answered (ideas that expired unseen), the agent asks ONE question, "Want fewer of these?". Only a yes writes a rule (a soft
 * one, about the type); no answer and no changes nothing. Routines keep their own pause after 5 unread results (policies.ts).
 */
import { randomUUID } from 'node:crypto';
import type { Request } from '@agent-desktop/public-contracts';
import { withFallbackText } from '@agent-desktop/public-contracts';
import type { SilenceQuestion, StoredRequest } from '../../contracts/index.js';
import { emitAgentStatus } from '../../execution/agent-status.js';
import { docOwner } from '../../execution/execution-owner.js';
import type { HomeDeps } from '../home/service.js';
import { normalizeKey } from '../ideas/cooldown.js';
import { listAll } from '../memory/util.js';
import { readRules, logProactive, ownerLog, recordRule, roomOn, todayFor } from './service.js';

export const SILENCE_AFTER = 5;
export const SILENCE_CHOICES_ID = 'fewer';
export const SILENCE_YES = 'yes';
export const SILENCE_NO = 'no';

type SilentType = 'daily-check' | 'goal-checkin' | 'idea';
const TYPES: Record<SilentType, { what: string; rule: string }> = {
  'daily-check': { what: 'daily checks', rule: 'Daily checks (weather, deadlines, things worth knowing today)' },
  'goal-checkin': { what: 'goal check-ins', rule: 'Goal check-in messages' },
  idea: { what: 'ideas', rule: 'Daily ideas' },
};

/** How many of the newest items of a type, after `since`, nobody reacted to. */
async function ignoredStreak(deps: HomeDeps, ownerId: string, type: SilentType, since: string): Promise<number> {
  const { store } = deps;
  let streak = 0;
  if (type === 'idea') {
    const ideas = (await listAll(store, 'ideas')).filter((idea) => docOwner(idea) === ownerId && idea.source === 'daily' && idea.createdAt > since).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const idea of ideas) {
      // An idea still waiting has not had its chance yet; anything the owner answered ends the run.
      if (idea.status === 'open') continue;
      if (idea.outcome !== 'ignored') break;
      streak += 1;
    }
    return streak;
  }
  const lastRead = new Map<string, string | undefined>();
  for (const row of (await ownerLog(store, ownerId, [type])).filter((entry) => entry.at > since)) {
    if (row.conversationId !== undefined && !lastRead.has(row.conversationId)) lastRead.set(row.conversationId, (await store.get('conversations', row.conversationId))?.lastReadAt);
    const read = row.conversationId === undefined ? undefined : lastRead.get(row.conversationId);
    if (read !== undefined && read >= row.at) break;
    streak += 1;
  }
  return streak;
}

/**
 * Raises the question for the first type that has gone unread 5 times in a row, if the daily cap has room, none was asked about
 * it since, and no type rule already covers it. Returns the type asked about.
 */
export async function askIfSilent(deps: HomeDeps, input: { ownerId: string; agentId: string; now: Date }): Promise<SilentType | undefined> {
  const { store } = deps;
  const { ownerId, agentId, now } = input;
  const date = await todayFor(store, ownerId, now);
  if ((await roomOn(store, ownerId, date)) < 1) return undefined;
  const asked = await ownerLog(store, ownerId, ['silence-question']);
  const rules = await readRules(store, ownerId);
  for (const type of Object.keys(TYPES) as SilentType[]) {
    const { what, rule } = TYPES[type];
    if (rules.some((existing) => existing.scope === 'type' && existing.kind !== 'tell' && normalizeKey(existing.text) === normalizeKey(rule))) continue;
    if ((await ignoredStreak(deps, ownerId, type, asked.find((row) => row.topic === type)?.at ?? '')) < SILENCE_AFTER) continue;
    const at = now.toISOString();
    const question: SilenceQuestion = { text: rule, source: 'You said yes to "Want fewer of these?" after ' + String(SILENCE_AFTER) + ' unread ' + what + ' in a row' };
    const request: Request & { ownerId: string; silenceQuestion: SilenceQuestion } = {
      id: 'req-' + randomUUID(), kind: 'question', status: 'pending', title: 'Want fewer of these?',
      summary: 'The last ' + String(SILENCE_AFTER) + ' ' + what + ' went unread.', agentId, ownerId, createdAt: at, silenceQuestion: question,
      payload: {
        kind: 'question',
        ui: withFallbackText({
          version: 1,
          blocks: [
            { type: 'text', text: 'The last ' + String(SILENCE_AFTER) + ' ' + what + ' I sent were not opened. Want fewer of these?' },
            { type: 'choices', id: SILENCE_CHOICES_ID, options: [{ id: SILENCE_YES, label: 'Yes, fewer', style: 'primary' }, { id: SILENCE_NO, label: 'Keep them' }] },
          ],
        }),
      },
    };
    await store.put('requests', request);
    const { silenceQuestion: _held, ownerId: _owner, ...visible } = request;
    await store.emit({ type: 'request.created', request: visible });
    await emitAgentStatus(store, agentId);
    await logProactive(store, { ownerId, kind: 'silence-question', agentId, topic: type, date, at });
    return type;
  }
  return undefined;
}

/** The owner answered: yes writes the soft rule, no (or a decline) writes nothing. A retried delivery adds the rule once (same text again is a no-op). */
export async function settleSilenceQuestion(deps: HomeDeps, ownerId: string, request: StoredRequest, now = new Date()): Promise<void> {
  const question = request.silenceQuestion;
  if (question === undefined || request.status !== 'answered' || request.payload.kind !== 'question') return;
  if (request.payload.answers?.[SILENCE_CHOICES_ID] !== SILENCE_YES) return;
  await recordRule(deps, ownerId, { kind: 'less', scope: 'type', text: question.text, source: question.source }, now);
}
