/**
 * `POST /v1/requests/:id/secure-input` (BACKEND 8.7): the user's values for a pending `secure_input` request, typed
 * straight into the page fields the agent named.
 *
 * END-TO-END ENCRYPTED. The request offered the sandbox's own X25519 public key (`payload.encryption`); the client
 * sealed each value to it, so what reaches this handler is ciphertext `{epk, nonce, ciphertext}` per field, bound to
 * this request id, the field id and the page ref. This process cannot read a value: it passes the three strings to
 * computerd as one `fill_secret` browser action per field, and only the sandbox's helper (root, the key's only holder)
 * opens them and types the value. Plaintext bodies are refused, so no hop (this process, computerd, the provider)
 * ever carries a value. Nothing here is stored but each field's filled/failed status, and the run resumes from a note
 * like "Filled Card number (card_number) into e12." The fill happens here and not in the run on purpose: whatever
 * reaches a run is journaled durably by Restate.
 *
 * Format checks (`validateSecureInputValues`) therefore run on the client before sealing; this handler checks that
 * every required field has a sealed value and that no unknown field is sent.
 */
import { type Hono } from 'hono';
import { NotFoundError, parseStoredRequest, toPublicRequest, type StoredRequest } from '@agent-desktop/contracts';
import { submitSecureInputSchema, type SealedSecureValue, type SecureInputField, type SecureInputResult } from '@agent-desktop/public-contracts';
import { auditInitiatorFor } from 'juno-agent/execution/harness/logic/run-origin';
import { getOwnerId } from '../auth.js';
import { ComputerdClientError, type ComputerdClient } from '../computerd.js';
import { decisionErrorStatus, errorBody, recordDecision, REQUEST_NOT_PENDING, withRequestLock } from './requests.js';
import type { AgentdDeps } from './index.js';

/** Audit `action` of a secure-input fill; `/v1/audit?action=secure_input.fill` lists them. */
export const SECURE_INPUT_AUDIT_ACTION = 'secure_input.fill';

type FieldOutcome = SecureInputResult['fields'][number];

/** Thrown while filling: the screen is the user's right now, so nothing is decided and they can retry. */
class UserHoldsScreen extends Error {}

/** Field ids that are not the request's, as a fixed message naming only ids. */
function fieldProblem(known: SecureInputField[], sent: Record<string, SealedSecureValue>): string | undefined {
  const ids = new Set(known.map((field) => field.id));
  const unknown = Object.keys(sent).filter((id) => !ids.has(id));
  return unknown.length > 0 ? `Unknown field ${unknown.join(', ')}` : undefined;
}

/** Required fields (the page did not mark them optional) that came without a value, by field id. */
function missingRequired(fields: SecureInputField[], sent: Record<string, SealedSecureValue>): Record<string, string> | undefined {
  const missing = fields.filter((field) => field.required !== false && sent[field.id] === undefined);
  return missing.length === 0 ? undefined : Object.fromEntries(missing.map((field) => [field.id, 'This field is required']));
}

async function fillFields(computerd: ComputerdClient, request: StoredRequest, fields: SecureInputField[], sent: Record<string, SealedSecureValue>): Promise<FieldOutcome[]> {
  const outcomes: FieldOutcome[] = [];
  for (const field of fields) {
    const sealed = sent[field.id];
    // An optional field the user left empty stays as the page has it.
    if (sealed === undefined) continue;
    if (field.ref === undefined) {
      outcomes.push({ id: field.id, status: 'failed', error: 'the field names no page element' });
      continue;
    }
    try {
      await computerd.browser(request.agentId, { action: 'fill_secret', ref: field.ref, requestId: request.id, fieldId: field.id, sealed }, new AbortController().signal);
      outcomes.push({ id: field.id, status: 'filled' });
    } catch (error) {
      if (error instanceof ComputerdClientError && error.code === 'user_control') throw new UserHoldsScreen();
      const message = error instanceof Error ? error.message : 'the fill failed';
      // The helper never quotes a value (it only ever holds the plaintext inside the sandbox).
      outcomes.push({ id: field.id, status: 'failed', error: message.slice(0, 300) });
    }
  }
  return outcomes;
}

/** What the page says about a filled field after the fill: the error line under it when the page shows one. */
type Rejection = { error?: string };

/**
 * Which filled fields the page now marks invalid, keyed by field id. One `bounds` read gives each ref's name (refs
 * go stale at the next snapshot), then one snapshot shows the page's own verdict: a node with the same role and name
 * flagged `invalid`, and the first plain text line after it (before the next control) as the page's rule. Any
 * failure returns nothing: the note then stays as it was.
 */
async function pageRejections(computerd: ComputerdClient, request: StoredRequest, fields: SecureInputField[], outcomes: FieldOutcome[]): Promise<Map<string, Rejection>> {
  const rejected = new Map<string, Rejection>();
  const filled = fields.filter((field) => field.ref !== undefined && outcomes.some((o) => o.id === field.id && o.status === 'filled'));
  if (filled.length === 0) return rejected;
  try {
    const signal = new AbortController().signal;
    const bounds = await computerd.browser(request.agentId, { action: 'bounds', refs: filled.map((field) => field.ref!) }, signal);
    const page = await computerd.browser(request.agentId, { action: 'snapshot' }, signal);
    if (bounds.action !== 'bounds' || page.action !== 'snapshot') return rejected;
    for (const field of filled) {
      const named = bounds.elements.find((element) => element.ref === field.ref);
      const at = page.nodes.findIndex((node) => node.ref !== undefined && node.role === named?.role && node.name === named.name && node.state?.includes('invalid'));
      if (named === undefined || at < 0) continue;
      let text: string | undefined;
      for (const node of page.nodes.slice(at + 1)) {
        if (node.ref !== undefined) break;
        if (node.heading === undefined) {
          text = node.name;
          break;
        }
      }
      // The helper has already replaced any filled value in this text with dots.
      rejected.set(field.id, text === undefined ? {} : { error: text.slice(0, 300) });
    }
  } catch {
    // The check is a courtesy: a failed read leaves today's note.
  }
  return rejected;
}

const FILLED_HINT = 'Filled fields show (filled securely) in snapshots, without their value: do not ask for them again.';

/** What the run learns: which field got a value, never the value. */
function noteFor(fields: SecureInputField[], outcomes: FieldOutcome[], rejected: Map<string, Rejection>): string {
  const parts = fields
    .map((field) => {
      const outcome = outcomes.find((o) => o.id === field.id);
      const where = field.ref === undefined ? '' : ` into ${field.ref}`;
      if (outcome === undefined) return `Left ${field.label} (${field.kind}) empty: the user skipped this optional field.`;
      const bad = rejected.get(field.id);
      if (outcome.status === 'filled' && bad !== undefined) {
        const rule = bad.error === undefined ? '' : `: ${JSON.stringify(bad.error)}`;
        return `Filled ${field.label} (${field.kind}), but the page marks it invalid${rule}. Ask the user again for just this field and quote the page's rule in the reason.`;
      }
      if (outcome.status === 'filled') return `Filled ${field.label} (${field.kind})${where}.`;
      return `Could not fill ${field.label} (${field.kind})${where}: ${outcome.error ?? 'unknown error'}. Take a fresh snapshot and ask again if it is still needed.`;
    });
  const anyFilled = fields.some((field) => outcomes.some((o) => o.id === field.id && o.status === 'filled' && !rejected.has(field.id)));
  return (anyFilled ? [...parts, FILLED_HINT] : parts).join(' ');
}

export function registerSecureInput(app: Hono, deps: AgentdDeps & { computerd: ComputerdClient }): void {
  app.post('/v1/requests/:id/secure-input', async (c) => {
    const ownerId = getOwnerId(c);
    const reqId = c.req.param('id');
    const body: unknown = await c.req.json().catch(() => null);
    // A plaintext body (the old shape) is never accepted: the value would travel through every hop.
    if (typeof body === 'object' && body !== null && 'values' in body) {
      return c.json(errorBody('ENCRYPTION_REQUIRED', "Values must be encrypted to the request's key (payload.encryption); plaintext is not accepted"), 400);
    }
    const parsed = submitSecureInputSchema.safeParse(body);
    // Fixed text: a validation issue must never quote what was submitted.
    if (!parsed.success) return c.json(errorBody('INVALID_SECURE_INPUT', 'fields must map 1 to 8 field ids to sealed values {epk, nonce, ciphertext}'), 400);
    const sent = parsed.data.fields;

    return withRequestLock(reqId, async () => {
      const found = await deps.store.get('requests', reqId);
      if (!found) throw new NotFoundError('requests', reqId);
      const request = parseStoredRequest(found);
      if (request.payload.kind !== 'secure_input') return c.json(errorBody('INVALID_SECURE_INPUT', 'This request does not take secure input'), 400);
      // Submitted twice, or after the user or the run cancelled it: the request is over, nothing is typed.
      if (request.status !== 'pending') return c.json(errorBody(REQUEST_NOT_PENDING, `This request is already ${request.status}`), 409);
      const payload = request.payload;
      // Raised before encryption existed: the sandbox key it would need was never offered. The user can cancel it.
      if (payload.encryption === undefined) return c.json(errorBody('ENCRYPTION_UNAVAILABLE', 'This request predates end-to-end encryption; cancel it and ask the agent again'), 409);
      const problem = fieldProblem(payload.fields, sent);
      if (problem) return c.json(errorBody('INVALID_SECURE_INPUT', problem), 400);
      const missing = missingRequired(payload.fields, sent);
      if (missing) return c.json(errorBody('INVALID_SECURE_INPUT', 'Some values are missing', missing), 400);

      let outcomes: FieldOutcome[];
      try {
        outcomes = await fillFields(deps.computerd, request, payload.fields, sent);
      } catch (error) {
        if (error instanceof UserHoldsScreen) return c.json(errorBody('USER_CONTROL', 'Hand the screen back to the agent, then submit again'), 409);
        throw error;
      }
      const fields = payload.fields.map((field) => {
        const status = outcomes.find((o) => o.id === field.id)?.status;
        return status === undefined ? field : { ...field, status };
      });
      const rejected = await pageRejections(deps.computerd, request, payload.fields, outcomes);
      const note = noteFor(payload.fields, outcomes, rejected);
      await deps.store.put('audit', {
        ...auditInitiatorFor(request.runId === undefined ? null : await deps.store.get('runs', request.runId)),
        id: 'aud-secure-' + request.id,
        at: new Date().toISOString(),
        actor: 'user',
        agentId: request.agentId,
        action: SECURE_INPUT_AUDIT_ACTION,
        target: payload.site,
        decision: 'approved',
        reason: note,
        requestId: request.id,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
      }, { agentId: request.agentId, kind: SECURE_INPUT_AUDIT_ACTION, ...(request.runId === undefined ? {} : { runId: request.runId }) });
      const recorded = await recordDecision(deps, ownerId, request, { action: 'approve', note }, { ...payload, fields });
      if ('error' in recorded) return c.json(recorded.error, decisionErrorStatus(recorded.error));
      const result: SecureInputResult = { request: toPublicRequest(recorded.request), fields: outcomes };
      return c.json(result);
    });
  });
}
