import { z } from 'zod';

/**
 * The iPhone app as a device (BACKEND 7.13). While the app is open and its event stream is connected it declares what the
 * owner has allowed (EventKit): reading and writing calendar events, reading and writing reminders. The server never wakes a
 * phone; a call is sent over the live stream and the app answers with a POST.
 */
export const PHONE_ACTIONS = ['calendar.read', 'calendar.write', 'reminders.read', 'reminders.write'] as const;
export const phoneActionSchema = z.enum(PHONE_ACTIONS);
export type PhoneAction = z.infer<typeof phoneActionSchema>;

/** `PUT /v1/phone/declaration`: replaces the declaration (EventKit authorization changed, or the app just connected). */
export const phoneDeclarationSchema = z.object({
  /** Stable across launches of the app on this phone. */
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  /** What the owner sees ("Robin's iPhone"). */
  name: z.string().trim().min(1).max(80),
  /** e.g. `iOS 26.0`. */
  osVersion: z.string().trim().min(1).max(80),
  /** Only what is authorized: write-only calendar access declares `calendar.write` alone. */
  actions: z.array(phoneActionSchema).max(PHONE_ACTIONS.length),
});
export type PhoneDeclaration = z.infer<typeof phoneDeclarationSchema>;

/** What a call asks the phone to do; each needs the declared actions named in `PHONE_CALL_NEEDS`. */
export const PHONE_CALL_ACTIONS = [
  'calendar.list_calendars',
  'calendar.list_events',
  'calendar.create_event',
  'calendar.update_event',
  'calendar.delete_event',
  'reminders.list',
  'reminders.create',
  'reminders.update',
  'reminders.delete',
] as const;
export const phoneCallActionSchema = z.enum(PHONE_CALL_ACTIONS);
export type PhoneCallAction = z.infer<typeof phoneCallActionSchema>;

/**
 * The declared actions a call needs. Changing or removing an existing event needs to read it first, so it needs both
 * calendar actions (write-only access can only add events).
 */
export const PHONE_CALL_NEEDS: Record<PhoneCallAction, readonly PhoneAction[]> = {
  'calendar.list_calendars': ['calendar.read'],
  'calendar.list_events': ['calendar.read'],
  'calendar.create_event': ['calendar.write'],
  'calendar.update_event': ['calendar.read', 'calendar.write'],
  'calendar.delete_event': ['calendar.read', 'calendar.write'],
  'reminders.list': ['reminders.read'],
  'reminders.create': ['reminders.write'],
  'reminders.update': ['reminders.write'],
  'reminders.delete': ['reminders.write'],
};

/** `POST /v1/phone/calls/:callId/result`: the app's answer to one call. */
export const phoneCallResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(500) }),
]);
export type PhoneCallResult = z.infer<typeof phoneCallResultSchema>;
