import { TerminalError } from '@agent-desktop/durable';
import { z } from 'zod';
import type { Store } from '../../../contracts/index.js';
import { runUsageSchema } from '@agent-desktop/public-contracts';
import type { Run } from '@agent-desktop/public-contracts';
import { snapshotOfRun } from './run-budget.js';

/**
 * Rebuilding a run row (run start, failed start) must keep what the child reservation stored:
 * parent link, session/plan ids, frozen budget, result and background reporting target.
 */
/** Strict owner limits: malformed known limits fail; unknown future limits ride through. */
const budgetLimitsSchema = z.object({ steps: z.number().min(0).optional(), tokens: z.number().min(0).optional(), activeSeconds: z.number().min(0).optional(), costUsd: z.number().min(0).optional(), onUnknown: z.enum(['block', 'ignore']).optional() }).passthrough();
/** Private frozen budget at spawn; unknown-spend flags are strict fields, never stripped. */
const budgetSnapshotSchema = z.object({ limits: budgetLimitsSchema, parentSteps: z.number(), parentTokens: z.number(), parentCostUsd: z.number(), parentActiveSeconds: z.number(), parentMeasured: z.boolean().optional(), parentCostKnown: z.boolean().optional(), explicitCost: z.boolean().optional(), inheritedAt: z.string() });

/** Canonical reservation fields, parsed from the STORED row, never the raw wake payload. */
const reservedChildSchema = z.object({
  parentRunId: z.string().min(1).optional(),
  rootRunId: z.string().min(1).optional(),
  depth: z.number().int().min(0).optional(),
  childSessionKey: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  dispatch: z.enum(['pending', 'accepted']).optional(),
  dispatchError: z.string().min(1).optional(),
  budgetSnapshot: budgetSnapshotSchema.optional(),
  childPrompt: z.string().min(1).optional(),
  childRunIds: z.array(z.string().min(1)).optional(),
  /** child_spawn `tools`: the narrowing fixed at reservation; a rebuilt row must keep it or the child is unrestricted. */
  allowedTools: z.array(z.string().min(1)).optional(),
  /** child_spawn `fast`: buildContext reads it from the row, so a rebuilt row must keep it or the child runs on the normal model. */
  fastModel: z.literal(true).optional(),
  /** child_spawn `deep`: the child runs at the deep reasoning tier; read by buildContext from the row, so a rebuilt row must keep it. */
  deepEffort: z.literal(true).optional(),
  /** Private feed-card origin stamp: the rebuild must keep it or an async user-requested card is lost. */
  feedCardUserOrigin: z.literal(true).optional(),
  /** CT: the canonical child result rides every reservation overlay, so rebuilds never drop it. */
  childResult: z.string().optional(),
  /** H-69: a background child's reporting target must survive the rebuild, or it never reports back. */
  notifyParent: z.object({ ownerId: z.string(), agentId: z.string(), conversationId: z.string(), chainId: z.string(), generation: z.number() }).optional(),
  title: z.string().min(1).optional(),
  kind: z.enum(['chat', 'routine', 'scheduled', 'manual', 'background']).optional(),
  usage: runUsageSchema.optional(),
});

/** Markers meaning the row was reserved; any present requires a valid parent link. */
const CHILD_MARKERS = ['parentRunId', 'childSessionKey', 'planId', 'dispatch', 'dispatchError', 'budgetSnapshot', 'childPrompt'];

/** True when the stored row claims a reservation, even when its link is invalid. */
function claimsReservation(stored: unknown): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  return CHILD_MARKERS.some((marker) => Reflect.get(stored, marker) !== undefined);
}

/** Overlay reservation fields plus canonical frozen state; an invalid claimed link refuses loudly. */
function withReservedChild(created: Run, stored: unknown, strict: boolean): Run {
  const parsed = reservedChildSchema.safeParse(stored);
  const child = parsed.success ? parsed.data : undefined;
  const snapshot = snapshotOfRun(stored);
  const frozen = {
    ...(snapshot === undefined ? {} : { executionBudget: snapshot }),
    ...(child?.usage === undefined ? {} : { usage: child.usage }),
    ...(child?.childRunIds === undefined ? {} : { childRunIds: child.childRunIds }),
    ...(child?.childResult === undefined ? {} : { childResult: child.childResult }),
    ...(child?.notifyParent === undefined ? {} : { notifyParent: child.notifyParent }),
  };
  if (child !== undefined && child.parentRunId !== undefined) {
    return {
      ...created,
      ...frozen,
      ...(child.title === undefined ? {} : { title: child.title }),
      ...(child.kind === undefined ? {} : { kind: child.kind }),
      ...(child.parentRunId === undefined ? {} : { parentRunId: child.parentRunId }),
      ...(child.rootRunId === undefined ? {} : { rootRunId: child.rootRunId }),
      ...(child.depth === undefined ? {} : { depth: child.depth }),
      ...(child.childSessionKey === undefined ? {} : { childSessionKey: child.childSessionKey }),
      ...(child.planId === undefined ? {} : { planId: child.planId }),
      ...(child.dispatch === undefined ? {} : { dispatch: child.dispatch }),
      ...(child.dispatchError === undefined ? {} : { dispatchError: child.dispatchError }),
      ...(child.budgetSnapshot === undefined ? {} : { budgetSnapshot: child.budgetSnapshot }),
      ...(child.childPrompt === undefined ? {} : { childPrompt: child.childPrompt }),
      ...(child.allowedTools === undefined ? {} : { allowedTools: child.allowedTools }),
      ...(child.fastModel === undefined ? {} : { fastModel: child.fastModel }),
      ...(child.deepEffort === undefined ? {} : { deepEffort: child.deepEffort }),
      ...(child.feedCardUserOrigin === undefined ? {} : { feedCardUserOrigin: child.feedCardUserOrigin }),
    };
  }
  if (strict && claimsReservation(stored)) {
    throw new TerminalError('reserved child run metadata is invalid; refusing to overwrite it with a root run');
  }
  return { ...created, ...frozen };
}

export async function putRunPreservingChild(store: Store, row: Run, strict: boolean): Promise<Run> {
  const stored = await store.get('runs', row.id);
  // A run writer holding a stale copy must not undo the model-written title (BACKEND §10.11).
  const kept = stored?.titleGenerated === true ? { ...row, title: stored.title, titleGenerated: true } : row;
  return store.put('runs', withReservedChild(kept, stored, strict));
}
