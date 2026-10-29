/**
 * Google Calendar on the Calendar API v3: calendars, events in a time range, free/busy (`calendar.readonly`) and
 * writing events (`calendar.events`). The tools create_event, update_event, delete_event, get_event, respond_to_event,
 * search_events and suggest_time carry the names and argument shapes of Google's own Calendar MCP server
 * (https://developers.google.com/workspace/calendar/api/v3/reference/mcp, Developer Preview), so a later switch to
 * that endpoint keeps prompts and policies. Not carried over: eventType, workingLocationProperties, googleMeetUrl.
 * The older read tools (list_events, query_free_busy) keep their own shapes.
 */
import { itemsOf, nextPage, page, PAGE, str, type Args, type HostedTool } from './shared.js';

export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

const NOTIFY = { type: 'string', enum: ['NOTIFICATION_LEVEL_UNSPECIFIED', 'NONE', 'EXTERNAL_ONLY', 'ALL'], description: 'Who is emailed about the change (default ALL).' };
const sendUpdates = (args: Args): string => ({ NONE: 'none', EXTERNAL_ONLY: 'externalOnly' })[str(args.notificationLevel) ?? ''] ?? 'all';
const calendarOf = (args: Args): string => encodeURIComponent(str(args.calendarId) ?? 'primary');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
const objects = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : []);

/** An event time as the API takes it: a date for all-day, else the wall time in `timeZone` when one is given (it overrides any offset), else as typed. */
function timeOf(value: string, args: Args): Record<string, string> {
  const zone = str(args.timeZone);
  if (args.allDay === true) return { date: value.slice(0, 10) };
  if (zone === undefined) return { dateTime: value };
  return { dateTime: value.replace(/(Z|[+-]\d\d:?\d\d)$/, ''), timeZone: zone };
}

const attendeeOf = (entry: Record<string, unknown>) => ({
  email: entry.email, displayName: entry.displayName, optional: entry.optionalAttendee, resource: entry.resource, additionalGuests: entry.additionalGuests, responseStatus: entry.responseStatus,
});

/** The fields create_event and update_event share, in the API's event shape. */
function eventFields(args: Args): Record<string, unknown> {
  const start = str(args.startTime);
  const end = str(args.endTime);
  const permissions = typeof args.guestPermissions === 'object' && args.guestPermissions !== null ? (args.guestPermissions as Record<string, unknown>) : {};
  const availability = str(args.availability);
  return {
    summary: str(args.summary),
    description: str(args.description),
    location: str(args.location),
    ...(start === undefined ? {} : { start: timeOf(start, args) }),
    ...(end === undefined ? {} : { end: timeOf(end, args) }),
    visibility: str(args.visibility),
    colorId: str(args.colorId),
    ...(availability === undefined ? {} : { transparency: availability === 'AVAILABILITY_FREE' ? 'transparent' : 'opaque' }),
    ...(permissions.guestsCanInviteOthers === undefined ? {} : { guestsCanInviteOthers: permissions.guestsCanInviteOthers }),
    ...(permissions.guestsCanModify === undefined ? {} : { guestsCanModify: permissions.guestsCanModify }),
    ...(permissions.guestsCanSeeOtherGuests === undefined && permissions.guestsCanSeeGuests === undefined ? {} : { guestsCanSeeOtherGuests: permissions.guestsCanSeeGuests ?? permissions.guestsCanSeeOtherGuests }),
    ...(Array.isArray(args.overrideReminders) ? { reminders: { useDefault: false, overrides: objects(args.overrideReminders).map((reminder) => ({ method: reminder.method, minutes: reminder.minutes })) } } : {}),
  };
}

const withoutUndefined = (body: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

const reminderShape = { type: 'array', items: { type: 'object', properties: { method: { type: 'string', enum: ['email', 'popup'] }, minutes: { type: 'integer' } }, required: ['method', 'minutes'] }, description: 'Reminders that replace the calendar defaults.' };
const attendeeShape = { type: 'object', properties: { email: { type: 'string' }, displayName: { type: 'string' }, optionalAttendee: { type: 'boolean' }, additionalGuests: { type: 'integer' } }, required: ['email'] };
const attachmentShape = { type: 'array', items: { type: 'object', properties: { fileUrl: { type: 'string' }, title: { type: 'string' } }, required: ['fileUrl'] }, description: 'Drive file attachments.' };
const guestShape = { type: 'object', properties: { guestsCanInviteOthers: { type: 'boolean' }, guestsCanModify: { type: 'boolean' }, guestsCanSeeGuests: { type: 'boolean' } } };
const SHARED = {
  calendarId: { type: 'string', description: 'Calendar id or email (default: the primary calendar).' },
  description: { type: 'string', description: 'Event description.' },
  location: { type: 'string', description: 'Event location.' },
  allDay: { type: 'boolean', description: 'If true, startTime and endTime are dates (only the day is used).' },
  timeZone: { type: 'string', description: 'IANA time zone name; overrides offsets in startTime and endTime.' },
  notificationLevel: NOTIFY,
  addGoogleMeetUrl: { type: 'boolean', description: 'Add a Google Meet link.' },
  visibility: { type: 'string', enum: ['default', 'public', 'private'] },
  colorId: { type: 'string', description: 'Color id "1" to "11".' },
  guestPermissions: guestShape,
  availability: { type: 'string', enum: ['AVAILABILITY_UNSPECIFIED', 'AVAILABILITY_BUSY', 'AVAILABILITY_FREE'] },
  overrideReminders: reminderShape,
};
const meet = (args: Args) => (args.addGoogleMeetUrl === true ? { conferenceData: { createRequest: { requestId: 'juno-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {});
const attachmentsOf = (items: Record<string, unknown>[]) => items.map((item) => ({ fileUrl: item.fileUrl, title: item.title }));

const TIME = 'RFC 3339 with an offset, e.g. 2026-10-20T09:00:00+08:00';

const eventOf = (event: Record<string, unknown>) => {
  const when = (value: unknown) => (typeof value === 'object' && value !== null ? Reflect.get(value, 'dateTime') ?? Reflect.get(value, 'date') : undefined);
  const attendees = Array.isArray(event.attendees) ? (event.attendees as Record<string, unknown>[]) : [];
  return {
    id: event.id,
    title: event.summary,
    start: when(event.start),
    end: when(event.end),
    location: event.location,
    description: typeof event.description === 'string' ? event.description.slice(0, 2000) : undefined,
    attendees: attendees.length > 0 ? attendees.map((person) => ({ email: person.email, response: person.responseStatus })) : undefined,
    meet: event.hangoutLink,
    status: event.status,
    url: event.htmlLink,
  };
};

export const CALENDAR_TOOLS: HostedTool[] = [
  {
    name: 'list_calendars',
    title: 'List calendars',
    description: "List the owner's calendars (their own, shared with them, subscribed) with ids and time zones.",
    properties: {},
    run: async (api) => ({
      calendars: itemsOf(await api('/users/me/calendarList', { maxResults: '250' })).map((calendar) => ({
        id: calendar.id, name: calendar.summaryOverride ?? calendar.summary, primary: calendar.primary === true, timeZone: calendar.timeZone, access: calendar.accessRole,
      })),
    }),
  },
  {
    name: 'list_events',
    title: 'List events',
    description: 'List events in a time range, in start order (repeating events come as their single occurrences). Optional text search.',
    properties: {
      calendarId: { type: 'string', description: 'Calendar id from list_calendars (default: the primary calendar).' },
      timeMin: { type: 'string', description: 'From (' + TIME + '); default now.' },
      timeMax: { type: 'string', description: 'Until (' + TIME + ').' },
      query: { type: 'string', description: 'Text to match in title, description, location or attendees.' },
      ...PAGE,
    },
    run: async (api, args) => {
      const calendarId = encodeURIComponent(str(args.calendarId) ?? 'primary');
      const body = await api('/calendars/' + calendarId + '/events', {
        singleEvents: 'true', orderBy: 'startTime', timeMin: str(args.timeMin) ?? new Date().toISOString(), timeMax: str(args.timeMax), q: str(args.query), ...page(args),
      });
      return { timeZone: body.timeZone, events: itemsOf(body).map(eventOf), ...nextPage(body) };
    },
  },
  {
    name: 'query_free_busy',
    title: 'Check free time',
    description: 'When calendars are busy in a time range, to find free time.',
    properties: {
      timeMin: { type: 'string', description: 'From (' + TIME + ').' },
      timeMax: { type: 'string', description: 'Until (' + TIME + ').' },
      calendarIds: { type: 'array', items: { type: 'string' }, description: 'Calendar ids (default: the primary calendar).' },
    },
    required: ['timeMin', 'timeMax'],
    // A query, not a change: POST is how the API takes the request body.
    run: async (api, args) => {
      const ids = Array.isArray(args.calendarIds) && args.calendarIds.length > 0 ? args.calendarIds.filter((id): id is string => typeof id === 'string') : ['primary'];
      const body = await api('/freeBusy', {}, { method: 'POST', body: { timeMin: str(args.timeMin), timeMax: str(args.timeMax), items: ids.map((id) => ({ id })) } });
      return { calendars: body.calendars };
    },
  },
  {
    name: 'get_event',
    title: 'Read an event',
    description: 'Read one event: time, place, attendees and their answers, Meet link.',
    properties: { eventId: { type: 'string', description: 'Event id from list_events.' }, calendarId: SHARED.calendarId },
    required: ['eventId'],
    run: async (api, args) => eventOf(await api('/calendars/' + calendarOf(args) + '/events/' + encodeURIComponent(str(args.eventId) ?? ''))),
  },
  {
    name: 'search_events',
    title: 'Search events',
    description: 'Search events on the primary calendar by words in the title, description, location or attendees.',
    properties: { query: { type: 'string', description: 'Words to find (case-insensitive).' }, pageSize: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results (default 10).' }, pageToken: PAGE.pageToken },
    required: ['query'],
    run: async (api, args) => {
      const body = await api('/calendars/primary/events', { q: str(args.query), singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(Date.now() - 365 * 86_400_000).toISOString(), ...page({ maxResults: args.pageSize, pageToken: args.pageToken }) });
      return { events: itemsOf(body).map(eventOf), ...nextPage(body) };
    },
  },
  {
    name: 'create_event',
    title: 'Add an event',
    description: 'Add an event to a calendar. Attendees get invitations according to notificationLevel.',
    properties: {
      summary: { type: 'string', description: 'Event title.' },
      startTime: { type: 'string', description: 'Start (ISO 8601, ' + TIME + ').' },
      endTime: { type: 'string', description: 'End (ISO 8601).' },
      attendees: { type: 'array', items: attendeeShape, description: 'Event attendees.' },
      attendeeEmails: { type: 'array', items: { type: 'string' }, description: 'Deprecated: use attendees.' },
      recurrenceData: { type: 'array', items: { type: 'string' }, description: 'Recurrence rules as RRULE, RDATE or EXDATE strings (RFC 5545).' },
      attachments: attachmentShape,
      ...SHARED,
    },
    required: ['summary', 'startTime', 'endTime'],
    writes: true,
    run: async (api, args) => {
      const attendees = [...objects(args.attendees).map(attendeeOf), ...strings(args.attendeeEmails).map((email) => ({ email }))];
      const event = await api('/calendars/' + calendarOf(args) + '/events', { sendUpdates: sendUpdates(args), conferenceDataVersion: args.addGoogleMeetUrl === true ? '1' : undefined, supportsAttachments: 'true' }, {
        method: 'POST',
        body: withoutUndefined({
          ...eventFields(args),
          ...(attendees.length > 0 ? { attendees: attendees.map(withoutUndefined) } : {}),
          ...(strings(args.recurrenceData).length > 0 ? { recurrence: strings(args.recurrenceData) } : {}),
          ...(objects(args.attachments).length > 0 ? { attachments: attachmentsOf(objects(args.attachments)) } : {}),
          ...meet(args),
        }),
      });
      return eventOf(event);
    },
  },
  {
    name: 'update_event',
    title: 'Change an event',
    description: 'Change an event: only the fields given are changed.',
    properties: {
      eventId: { type: 'string', description: 'Event id from list_events.' },
      summary: { type: 'string', description: 'New title.' },
      startTime: { type: 'string', description: 'New start (ISO 8601).' },
      endTime: { type: 'string', description: 'New end (ISO 8601).' },
      addedAttendees: { type: 'array', items: attendeeShape, description: 'Attendees to invite.' },
      addedAttendeeEmails: { type: 'array', items: { type: 'string' }, description: 'Deprecated: use addedAttendees.' },
      removedAttendeeEmails: { type: 'array', items: { type: 'string' }, description: 'Attendees to remove.' },
      addedAttachments: attachmentShape,
      removedAttachmentFileUrls: { type: 'array', items: { type: 'string' }, description: 'Attachments to remove, by fileUrl.' },
      ...SHARED,
    },
    required: ['eventId'],
    writes: true,
    run: async (api, args) => {
      const path = '/calendars/' + calendarOf(args) + '/events/' + encodeURIComponent(str(args.eventId) ?? '');
      const added = [...objects(args.addedAttendees).map(attendeeOf), ...strings(args.addedAttendeeEmails).map((email) => ({ email }))];
      const removed = strings(args.removedAttendeeEmails).map((email) => email.toLowerCase());
      const attachmentsChange = objects(args.addedAttachments).length > 0 || strings(args.removedAttachmentFileUrls).length > 0;
      // Attendees and attachments are replaced as a whole by PATCH, so the current lists are read first.
      const current = added.length > 0 || removed.length > 0 || attachmentsChange ? await api(path) : {};
      const kept = objects(current.attendees).filter((person) => !removed.includes(String(person.email).toLowerCase()));
      const attendees = [...kept, ...added.filter((person) => !kept.some((existing) => String(existing.email).toLowerCase() === String(person.email).toLowerCase()))];
      const attachments = [...objects(current.attachments).filter((item) => !strings(args.removedAttachmentFileUrls).includes(String(item.fileUrl))), ...attachmentsOf(objects(args.addedAttachments))];
      const event = await api(path, { sendUpdates: sendUpdates(args), conferenceDataVersion: args.addGoogleMeetUrl === true ? '1' : undefined, supportsAttachments: 'true' }, {
        method: 'PATCH',
        body: withoutUndefined({
          ...eventFields(args),
          ...(added.length > 0 || removed.length > 0 ? { attendees: attendees.map((person) => withoutUndefined(person as Record<string, unknown>)) } : {}),
          ...(attachmentsChange ? { attachments: attachments.map((item) => withoutUndefined(item as Record<string, unknown>)) } : {}),
          ...meet(args),
        }),
      });
      return eventOf(event);
    },
  },
  {
    name: 'delete_event',
    title: 'Delete an event',
    description: 'Delete an event from a calendar. Attendees are told according to notificationLevel.',
    properties: { eventId: { type: 'string', description: 'Event id.' }, calendarId: SHARED.calendarId, notificationLevel: NOTIFY },
    required: ['eventId'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/calendars/' + calendarOf(args) + '/events/' + encodeURIComponent(str(args.eventId) ?? ''), { sendUpdates: sendUpdates(args) }, { method: 'DELETE' });
      return { deleted: true, eventId: str(args.eventId) };
    },
  },
  {
    name: 'respond_to_event',
    title: 'Answer an invitation',
    description: "Accept, decline or answer maybe to an event the owner is invited to.",
    properties: {
      eventId: { type: 'string', description: 'Event id.' },
      responseStatus: { type: 'string', enum: ['accepted', 'declined', 'tentative'], description: "The owner's new answer." },
      responseComment: { type: 'string', description: 'A note sent with the answer.' },
      calendarId: SHARED.calendarId,
      notificationLevel: NOTIFY,
    },
    required: ['eventId', 'responseStatus'],
    writes: true,
    run: async (api, args) => {
      const path = '/calendars/' + calendarOf(args) + '/events/' + encodeURIComponent(str(args.eventId) ?? '');
      const attendees = objects((await api(path)).attendees);
      if (!attendees.some((person) => person.self === true)) throw new Error('The owner is not an attendee of this event');
      const event = await api(path, { sendUpdates: sendUpdates(args) }, {
        method: 'PATCH',
        body: { attendees: attendees.map((person) => (person.self === true ? withoutUndefined({ ...person, responseStatus: str(args.responseStatus), comment: str(args.responseComment) }) : person)) },
      });
      return eventOf(event);
    },
  },
  {
    name: 'suggest_time',
    title: 'Suggest meeting times',
    description: 'Find times when the owner and the attendees are all free for a meeting of a given length, within a range.',
    properties: {
      attendeeEmails: { type: 'array', items: { type: 'string' }, description: 'Attendees to find a common free time with (the owner is always included).' },
      startTime: { type: 'string', description: 'Start of the range to search (ISO 8601).' },
      endTime: { type: 'string', description: 'End of the range to search (ISO 8601).' },
      timeZone: { type: 'string', description: 'IANA time zone for the working hours (default: the offset of startTime).' },
      durationMinutes: { type: 'integer', minimum: 5, description: 'Length of the meeting (default 30).' },
      preferences: { type: 'object', properties: { startHour: { type: 'string', description: 'HH:mm, 24-hour.' }, endHour: { type: 'string', description: 'HH:mm, 24-hour.' }, excludeWeekends: { type: 'boolean' }, pageSize: { type: 'integer', description: 'Most slots returned (default 5).' } } },
    },
    required: ['attendeeEmails', 'startTime', 'endTime'],
    // A query, not a change: POST is how the API takes the request body.
    run: async (api, args) => {
      const from = new Date(str(args.startTime) ?? '');
      const until = new Date(str(args.endTime) ?? '');
      if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until <= from) throw new Error('startTime and endTime must be a range of ISO 8601 times');
      const body = await api('/freeBusy', {}, { method: 'POST', body: { timeMin: from.toISOString(), timeMax: until.toISOString(), ...(str(args.timeZone) === undefined ? {} : { timeZone: str(args.timeZone) }), items: ['primary', ...strings(args.attendeeEmails)].map((id) => ({ id })) } });
      const busy = Object.values((body.calendars ?? {}) as Record<string, { busy?: { start: string; end: string }[] }>).flatMap((calendar) => calendar.busy ?? []).map((period) => [Date.parse(period.start), Date.parse(period.end)] as const);
      const preferences = (typeof args.preferences === 'object' && args.preferences !== null ? args.preferences : {}) as Record<string, unknown>;
      const minutes = (value: unknown, fallback: number): number => {
        const match = /^(\d{1,2}):(\d\d)$/.exec(typeof value === 'string' ? value : '');
        return match === null ? fallback : Number(match[1]) * 60 + Number(match[2]);
      };
      const [open, close] = [minutes(preferences.startHour, 0), minutes(preferences.endHour, 24 * 60)];
      const zone = str(args.timeZone);
      const local = (time: number) => {
        if (zone === undefined) return { minute: new Date(time).getUTCHours() * 60 + new Date(time).getUTCMinutes(), weekday: new Date(time).getUTCDay() };
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(time).map((part) => [part.type, part.value]));
        return { minute: Number(parts.hour) * 60 + Number(parts.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday)) };
      };
      const length = (typeof args.durationMinutes === 'number' ? Math.max(5, Math.trunc(args.durationMinutes)) : 30) * 60_000;
      const limit = typeof preferences.pageSize === 'number' ? Math.max(1, Math.trunc(preferences.pageSize)) : 5;
      const slots: { start: string; end: string }[] = [];
      // Candidates start on the half hour; the hours and weekend rules apply to the start and the end.
      for (let start = Math.ceil(from.getTime() / 1_800_000) * 1_800_000; start + length <= until.getTime() && slots.length < limit; start += 1_800_000) {
        const end = start + length;
        const [first, last] = [local(start), local(end - 1)];
        const inHours = first.minute >= open && last.minute < close && last.minute >= first.minute;
        const weekend = preferences.excludeWeekends === true && (first.weekday === 0 || first.weekday === 6);
        if (inHours && !weekend && !busy.some(([from_, to]) => from_ < end && to > start)) slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      }
      return { timeSlots: slots.map((slot) => ({ start: { dateTime: slot.start }, end: { dateTime: slot.end } })) };
    },
  },
];
