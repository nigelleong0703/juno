/**
 * The owner's iPhone as a device (BACKEND 7.13), in the same shape as My Mac's declaration but over the app's live event stream:
 * the app declares what the owner allowed (EventKit) while it is open and connected, the declaration disappears when the
 * stream closes (presence.ts) or the app withdraws it, and a call is an `device.call` event on the owner's stream that the app
 * answers with a POST. The server never wakes a phone.
 *
 * The coordinator holds the stream and receives the answer; the `phone_*` tools run on any worker (BACKEND 2.2c). So the
 * declaration lives in the owner's presence row, and a call is a `phoneCalls` row: the worker writes it `pending`, emits the
 * event, and polls the row; the coordinator's POST handler marks it `done` with the answer. A worker that sees the declaration
 * gone while it waits treats the call as lost (the app disconnected), so nothing needs to find the waiting process.
 */
import { PHONE_CALL_NEEDS, type PhoneAction, type PhoneCallAction, type PhoneCallResult, type PhoneDeclaration } from '@agent-desktop/public-contracts';
import type { Store } from '../contracts/index.js';
import { patchWhen } from '../contracts/index.js';
import { pollFor } from './poll.js';
import { readPresence, setPhoneDeclaration } from './presence.js';

/** How long a call waits for the app's answer. */
export const PHONE_CALL_TIMEOUT_MS = 20_000;

/** How often a waiting worker looks at its call row. */
const CALL_POLL_MS = 150;

export const PHONE_CLOSED = "The iPhone app isn't open. Ask the owner to open Juno on their phone and try again; nothing was done.";

/** What the agent is told when a call needs an action the app did not declare (the owner can fix it in the app's settings). */
const MISSING: Record<PhoneAction, string> = {
  'calendar.read': "Juno on the iPhone can't read the calendar right now (access isn't allowed). Ask the owner to allow Calendars in Juno > Settings > iPhone calendar and reminders (or iPhone Settings > Juno); nothing was done.",
  'calendar.write': "Juno on the iPhone can't add to the calendar right now (access isn't allowed). Ask the owner to allow Calendars in Juno > Settings > iPhone calendar and reminders (or iPhone Settings > Juno); nothing was done.",
  'reminders.read': "Juno on the iPhone can't read reminders right now (access isn't allowed). Ask the owner to allow Reminders in Juno > Settings > iPhone calendar and reminders (or iPhone Settings > Juno); nothing was done.",
  'reminders.write': "Juno on the iPhone can't change reminders right now (access isn't allowed). Ask the owner to allow Reminders in Juno > Settings > iPhone calendar and reminders (or iPhone Settings > Juno); nothing was done.",
};

export type PhoneOutcome =
  | { kind: 'done'; result: PhoneCallResult }
  /** The call was sent and no answer came in time: it may or may not have run. */
  | { kind: 'timeout' }
  /** The call was sent, then the app disconnected (or the run was cancelled) before answering: it may or may not have run. */
  | { kind: 'lost' };

/** The app declared (or re-declared) what it can do; it replaces the previous declaration of this owner. Coordinator only. */
export async function declarePhone(store: Store, ownerId: string, declaration: PhoneDeclaration): Promise<void> {
  await setPhoneDeclaration(store, ownerId, declaration);
}

/** The declaration is gone (the app went to the background, or its stream closed): waiting workers see it and give up, new calls are refused. */
export async function withdrawPhone(store: Store, ownerId: string, deviceId?: string): Promise<void> {
  await setPhoneDeclaration(store, ownerId, undefined, deviceId);
}

/** What the iPhone app declared right now; undefined while it is not open. Readable from any process. */
export async function phoneDeclaration(store: Store, ownerId: string | undefined): Promise<PhoneDeclaration | undefined> {
  const presence = await readPresence(store, ownerId);
  return presence?.clients.includes('ios') === true ? presence.phone : undefined;
}

/** Why a call cannot be sent: nothing declared, or an action the app did not declare. Undefined = it can be sent. */
export async function phoneRefusal(store: Store, ownerId: string, call: PhoneCallAction): Promise<string | undefined> {
  const declaration = await phoneDeclaration(store, ownerId);
  if (declaration === undefined) return PHONE_CLOSED;
  const missing = PHONE_CALL_NEEDS[call].find((action) => !declaration.actions.includes(action));
  return missing === undefined ? undefined : MISSING[missing];
}

/**
 * The app's answer, recorded for the worker that waits. False when nobody waits for it any more (late, duplicate, unknown, or
 * another owner's call). The row lock decides between two answers.
 */
export async function completePhoneCall(store: Store, ownerId: string, callId: string, result: PhoneCallResult): Promise<boolean> {
  const done = await patchWhen(store, 'phoneCalls', callId, (call) => call.ownerId === ownerId && call.status === 'pending', { status: 'done', result });
  return done !== undefined;
}

export interface PhoneCallInput {
  ownerId: string;
  agentId: string;
  /** Stable for one step of a run: the app answers a repeated id with the result it already has instead of running it again. */
  callId: string;
  action: PhoneCallAction;
  args: Record<string, unknown>;
  store: Store;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Sends one call to the declared app and waits for its answer. The caller has already checked `phoneRefusal`. */
export async function callPhone(input: PhoneCallInput): Promise<PhoneOutcome> {
  const { store, ownerId, callId } = input;
  const declaration = await phoneDeclaration(store, ownerId);
  if (declaration === undefined || input.signal?.aborted === true) return { kind: 'lost' };
  const timeoutMs = input.timeoutMs ?? PHONE_CALL_TIMEOUT_MS;
  await store.put('phoneCalls', { id: callId, ownerId, status: 'pending', createdAt: new Date().toISOString() });
  try {
    await store.emit({
      type: 'device.call',
      agentId: input.agentId,
      deviceId: declaration.deviceId,
      callId,
      action: input.action,
      args: input.args,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
    const waited = await pollFor<PhoneOutcome>(async () => {
      const row = await store.get('phoneCalls', callId);
      if (row?.status === 'done' && row.result !== undefined) return { kind: 'done', result: row.result };
      if (row === null || row.status === 'lost') return { kind: 'lost' };
      // The app disconnected (or withdrew its declaration) while the call was out.
      if ((await phoneDeclaration(store, ownerId)) === undefined) return { kind: 'lost' };
      return undefined;
    }, { timeoutMs, intervalMs: CALL_POLL_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    return waited.kind === 'value' ? waited.value : waited.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'lost' };
  } catch {
    return { kind: 'lost' };
  } finally {
    await store.delete('phoneCalls', callId).catch(() => undefined);
  }
}

const ACTION_WORDS: Record<PhoneAction, string> = {
  'calendar.read': 'calendar.read (list calendars and events)',
  'calendar.write': 'calendar.write (add events)',
  'reminders.read': 'reminders.read (list reminders)',
  'reminders.write': 'reminders.write (add, change, complete and delete reminders)',
};

/**
 * The agent's context note about the iPhone: what the open app declared. Part of the appended context (a change adds one note),
 * never the frozen system prompt. Empty while the app is not open and nothing was said about it before.
 */
export async function buildPhoneSection(store: Store, ownerId: string | undefined): Promise<string> {
  const declaration = await phoneDeclaration(store, ownerId);
  if (declaration === undefined) return '';
  const missing = (Object.keys(ACTION_WORDS) as PhoneAction[]).filter((action) => !declaration.actions.includes(action));
  const can = declaration.actions.map((action) => ACTION_WORDS[action]).join(', ');
  return '## Your iPhone\n- The user\'s iPhone app is open (' + JSON.stringify(declaration.name) + ', ' + declaration.osVersion + ') and declares these actions: ' + (can === '' ? 'none' : can) + '.'
    + (missing.length === 0 ? '' : ' Not allowed on the phone: ' + missing.join(', ') + '; a call for those is refused, so tell the user what to allow in the app instead of retrying.')
    + ' The phone_* tools (find them with tool_search) work only while the app is open: if it closes they are refused, and the user must open Juno on their phone. Changing an existing event needs read and write calendar access. A change that gets no answer in time may or may not have been applied: read before trying again.';
}

/** Said when a section that was delivered is now empty: the app closed or its declaration was withdrawn. */
export const PHONE_SECTION_GONE = '## Your iPhone\n- The user\'s iPhone app is not open right now, so the phone_* tools are refused. If you need the phone calendar or reminders, ask the user to open Juno on their phone.';
