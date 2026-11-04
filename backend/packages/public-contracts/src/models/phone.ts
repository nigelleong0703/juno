import { z } from 'zod';

/**
 * The iPhone app as a device (BACKEND 7.13, 7.13b). While the app is open and its event stream is connected it declares what the
 * owner has switched on and the system has allowed (EventKit, Contacts, ...): one or two actions per part of the phone. The server
 * never wakes a phone; a call is sent over the live stream and the app answers with a POST.
 */
export const PHONE_ACTIONS = [
  'calendar.read', 'calendar.write',
  'reminders.read', 'reminders.write',
  'contacts.read', 'contacts.write',
  'location.read',
  'health.read',
  'photos.read',
  'music.read', 'music.control',
  'home.read', 'home.write',
] as const;
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
  'contacts.search',
  'contacts.create',
  'contacts.add_detail',
  'location.current',
  'health.query',
  'photos.search',
  'photos.send',
  'music.now_playing',
  'music.play',
  'music.transport',
  'home.list',
  'home.set',
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
  'contacts.search': ['contacts.read'],
  'contacts.create': ['contacts.write'],
  // Adding to a contact that exists means finding it first.
  'contacts.add_detail': ['contacts.read', 'contacts.write'],
  'location.current': ['location.read'],
  'health.query': ['health.read'],
  // Sending a photo reads the library and uploads one picture; the owner is asked each time, so it is not a separate switch.
  'photos.search': ['photos.read'],
  'photos.send': ['photos.read'],
  'music.now_playing': ['music.read'],
  'music.play': ['music.control'],
  'music.transport': ['music.control'],
  'home.list': ['home.read'],
  // Setting a value means finding the accessory first.
  'home.set': ['home.read', 'home.write'],
};

/** `POST /v1/phone/calls/:callId/result`: the app's answer to one call. */
export const phoneCallResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(500) }),
]);
export type PhoneCallResult = z.infer<typeof phoneCallResultSchema>;
