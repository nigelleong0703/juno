/**
 * Things on the owner's iPhone, for the agent (BACKEND 7.13): calendar and reminders, contacts, location, health, photos, music and
 * home. The iPhone app runs them while it is open and connected, one `device.call` each; here a tool only names the call. Which
 * tools exist for which capability is in `phone/*.ts`; this file turns those lists into tools.
 *
 * Reads are free. A change (or a private photo leaving the phone) asks the owner each time, with the kind of decision the list
 * says. A change is never retried: when the phone does not answer in time the agent is told it may or may not have been applied,
 * and reads to check. The declaration the app made decides at the moment of the call, not when the tool was found.
 */
import { randomUUID } from 'node:crypto';
import { invalidArguments } from '../toolArguments.js';
import type { PhoneCallAction } from '@agent-desktop/public-contracts';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { callPhone, phoneRefusal } from '../../../execution/phone.js';
import { CALENDAR_DEFS } from './phone/calendar.js';
import { CONTACTS_DEFS } from './phone/contacts.js';
import type { PhoneDecision, PhoneToolDef } from './phone/def.js';
import { HEALTH_DEFS } from './phone/health.js';
import { HOME_DEFS } from './phone/home.js';
import { LOCATION_DEFS } from './phone/location.js';
import { MUSIC_DEFS } from './phone/music.js';
import { PHOTOS_DEFS } from './phone/photos.js';
import { REMINDERS_DEFS } from './phone/reminders.js';

const DEFS: readonly PhoneToolDef[] = [...CALENDAR_DEFS, ...REMINDERS_DEFS, ...CONTACTS_DEFS, ...LOCATION_DEFS, ...HEALTH_DEFS, ...PHOTOS_DEFS, ...MUSIC_DEFS, ...HOME_DEFS];

const BY_NAME: ReadonlyMap<string, PhoneToolDef> = new Map(DEFS.map((def) => [def.name, def]));

/** The tools that change something (or send something private off the phone): policy asks first for each. */
export const PHONE_WRITE_TOOLS: ReadonlySet<string> = new Set(DEFS.filter((def) => def.decision !== undefined).map((def) => def.name));
/** Every tool of this unit. */
export const PHONE_TOOLS: ReadonlySet<string> = new Set(DEFS.map((def) => def.name));

/** The decision a call puts to the owner, or undefined for a read (and for a tool that is not a phone tool). */
export function phoneDecision(toolName: string, args: unknown): PhoneDecision | undefined {
  const def = BY_NAME.get(toolName);
  if (def?.decision === undefined) return undefined;
  const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return def.stricter?.(input) ?? def.decision;
}

/** The call a phone tool sends to the app (and so the declared actions it needs, `PHONE_CALL_NEEDS`). */
export function phoneToolCall(toolName: string): PhoneCallAction | undefined {
  return BY_NAME.get(toolName)?.call;
}

/** Largest answer text handed to the model. */
const MAX_TEXT = 20_000;

/**
 * What the app said when it could not do a call, with the class of cause in front so the agent says the true thing: this build of the
 * app lacks the capability (a developer-side gap; the person cannot fix it and did not block anything), or the person has not allowed
 * it (they can switch it on), or unknown (the app's words as they are).
 */
export function explainPhoneFailure(error: string): string {
  if (/entitlement|not available|isn't available|unavailable|not supported|unsupported|no such (?:capability|feature)/i.test(error)) {
    return `This version of the Juno app can't do that: the capability is not built into it (${error}). It is not something the person turned off or can fix in Settings, and their iPhone did not block anything. Say plainly that this version of the app can't do it yet; do not blame their phone or send them to Settings.`;
  }
  if (/denied|not authori[sz]ed|permission|not allowed|restricted/i.test(error)) {
    return `The person hasn't allowed this on their iPhone (${error}). They can switch it on in iPhone Settings > Juno, or in Juno > Settings > iPhone access; offer that as the one next step and retry yourself when they say it is done.`;
  }
  return error;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '\n(cut off)' : value }], ...(isError ? { isError } : {}) });

export function createPhoneTools(): Tool[] {
  return DEFS.map((def): Tool => {
    const writes = def.decision !== undefined || def.changes === true;
    return {
      name: def.name,
      description: def.description,
      parameters: { type: 'object', properties: def.properties, ...(def.required === undefined ? {} : { required: def.required }), additionalProperties: false },
      replay: writes ? 'never' : 'safe',
      sideEffect: writes,
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const parsed = def.schema.safeParse(args ?? {});
        if (!parsed.success) return invalidArguments(def.name, args, parsed.error);
        // The phone's own declaration decides, at the moment of the call: the app may have closed since the tool was found.
        const refusal = await phoneRefusal(ctx.store, ctx.ownerId, def.call);
        if (refusal !== undefined) return text(refusal, true);
        return ctx.step(def.name, async (): Promise<ToolResult> => {
          // The id is the same when this step is run again after a crash, so the phone answers it from what it already did.
          const callId = `phone_${ctx.runId}_${ctx.stepId ?? randomUUID()}`;
          const outcome = await callPhone({ ownerId: ctx.ownerId, agentId: ctx.agentId, callId, action: def.call, args: parsed.data, store: ctx.store, signal: ctx.signal });
          if (outcome.kind === 'done') {
            if (!outcome.result.ok) return text(explainPhoneFailure(outcome.result.error), true);
            if (def.present !== undefined) return def.present(outcome.result.data, parsed.data, ctx);
            return text(typeof outcome.result.data === 'string' ? outcome.result.data : JSON.stringify(outcome.result.data ?? null));
          }
          const why = outcome.kind === 'timeout' ? "The iPhone didn't answer within 20 seconds" : 'The iPhone app disconnected before it answered';
          return writes
            ? text(`${why}, so this change may or may not have been applied. Do not repeat it: read first to check (for a calendar or reminder, list it), then decide.`, true)
            : text(`${why}. Nothing changed. It may be a brief connection drop: if the person is writing to you from the Juno app they are in it, so do not tell them to open it; try once more, and if it fails say you can't reach their phone right now.`, true);
        });
      },
    };
  });
}
