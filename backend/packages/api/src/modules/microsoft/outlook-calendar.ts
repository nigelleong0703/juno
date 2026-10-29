/** Outlook calendar on Microsoft Graph: calendars, events in a range (`calendarView`), free/busy, create and update events. */
import { str, type Args, type HostedTool } from '../google/shared.js';
import { escapeOData, graphTime, instantOf, listPage, MS_PAGE, MS_ZONE, none, people, size, when, zoneOf } from './shared.js';

export const OUTLOOK_CALENDAR_SCOPES = ['Calendars.ReadWrite', 'offline_access'];
const FIELDS = 'id,subject,start,end,isAllDay,location,attendees,organizer,bodyPreview,onlineMeeting,isCancelled,webLink';
const TIME = 'ISO 8601, e.g. 2026-10-20T09:00:00+08:00, or without an offset in timeZone';

const calendarPath = (args: Args) => (str(args.calendarId) === undefined ? '/me/calendar' : '/me/calendars/' + encodeURIComponent(str(args.calendarId) ?? ''));

function eventLine(event: Record<string, unknown>, zone: string | undefined): string {
  const start = (event.start ?? {}) as Record<string, unknown>;
  const end = (event.end ?? {}) as Record<string, unknown>;
  const place = typeof event.location === 'object' && event.location !== null ? Reflect.get(event.location, 'displayName') : undefined;
  const join = typeof event.onlineMeeting === 'object' && event.onlineMeeting !== null ? Reflect.get(event.onlineMeeting, 'joinUrl') : undefined;
  const attendees = Array.isArray(event.attendees) ? people(event.attendees.map((item) => ({ emailAddress: Reflect.get(item as object, 'emailAddress') }))) : '';
  const span = event.isAllDay === true ? String(start.dateTime ?? '').slice(0, 10) + ' (all day)' : when(start.dateTime, zone) + ' to ' + when(end.dateTime, zone);
  return [
    '[' + String(event.id) + '] ' + span + ' | ' + String(event.subject ?? '(no title)') + (event.isCancelled === true ? ' (cancelled)' : ''),
    ...(typeof place === 'string' && place !== '' ? ['    Where: ' + place] : []),
    ...(attendees === '' ? [] : ['    With: ' + attendees]),
    ...(typeof join === 'string' ? ['    Join: ' + join] : []),
  ].join('\n');
}

const eventBody = (args: Args): Record<string, unknown> => {
  const zone = zoneOf(args);
  const start = str(args.start);
  const end = str(args.end);
  const attendees = Array.isArray(args.attendees) ? args.attendees.filter((entry): entry is string => typeof entry === 'string') : undefined;
  return {
    ...(str(args.title) === undefined ? {} : { subject: str(args.title) }),
    ...(start === undefined ? {} : { start: graphTime(start, zone) }),
    ...(end === undefined ? {} : { end: graphTime(end, zone) }),
    ...(str(args.location) === undefined ? {} : { location: { displayName: str(args.location) } }),
    ...(str(args.description) === undefined ? {} : { body: { contentType: 'Text', content: str(args.description) } }),
    ...(attendees === undefined ? {} : { attendees: attendees.map((address) => ({ type: 'required', emailAddress: { address } })) }),
  };
};

const FIELDS_WRITE = {
  title: { type: 'string', description: 'Event title.' },
  start: { type: 'string', description: 'Start (' + TIME + ').' },
  end: { type: 'string', description: 'End (' + TIME + ').' },
  location: { type: 'string', description: 'Place.' },
  description: { type: 'string', description: 'Plain-text details.' },
  attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses; they get invitations.' },
  ...MS_ZONE,
};

export const OUTLOOK_CALENDAR_TOOLS: HostedTool[] = [
  {
    name: 'list_calendars',
    title: 'List calendars',
    description: "List the owner's calendars with ids and whether they can be edited.",
    properties: {},
    run: async (api) => {
      const body = await api('/me/calendars', { $top: '50', $select: 'id,name,owner,canEdit,isDefaultCalendar' });
      const calendars = Array.isArray(body.value) ? (body.value as Record<string, unknown>[]) : [];
      return calendars.length === 0 ? none('calendars') : calendars.map((calendar) => '[' + String(calendar.id) + '] ' + String(calendar.name) + (calendar.isDefaultCalendar === true ? ' (default)' : '') + (calendar.canEdit === true ? '' : ' (read-only)')).join('\n');
    },
  },
  {
    name: 'list_events',
    title: 'List events',
    description: 'List events in a time range, in start order (repeating events come as their occurrences). Optional text match on the title.',
    properties: {
      calendarId: { type: 'string', description: 'Calendar id from list_calendars (default: the main calendar).' },
      start: { type: 'string', description: 'From (' + TIME + '); default now.' },
      end: { type: 'string', description: 'Until; default 7 days after start.' },
      query: { type: 'string', description: 'Only events whose title contains this.' },
      ...MS_PAGE,
      ...MS_ZONE,
    },
    run: async (api, args) => {
      const zone = zoneOf(args);
      const from = instantOf(str(args.start) ?? new Date().toISOString(), zone);
      const until = str(args.end) === undefined ? (from === undefined ? undefined : new Date(from.getTime() + 7 * 86_400_000)) : instantOf(str(args.end) ?? '', zone);
      if (from === undefined || until === undefined) throw new Error('start and end must be dates and times');
      const query = str(args.query);
      const { items, more } = await listPage(api, args, calendarPath(args) + '/calendarView', {
        startDateTime: from.toISOString(), endDateTime: until.toISOString(), $top: size(args), $orderby: 'start/dateTime', $select: FIELDS,
        ...(query === undefined ? {} : { $filter: "contains(subject,'" + escapeOData(query) + "')" }),
      });
      return items.length === 0 ? none('events in that range') : items.map((event) => eventLine(event, zone)).join('\n') + more;
    },
  },
  {
    name: 'query_free_busy',
    title: 'Check free time',
    description: "When people or the owner are busy in a time range (30-minute slots shown as busy periods), to find free time.",
    properties: {
      start: { type: 'string', description: 'From (' + TIME + ').' },
      end: { type: 'string', description: 'Until.' },
      emails: { type: 'array', items: { type: 'string' }, description: "Email addresses to check (default: the owner)." },
      ...MS_ZONE,
    },
    required: ['start', 'end'],
    // A query, not a change: POST is how Graph takes the request body.
    run: async (api, args) => {
      const zone = zoneOf(args);
      const given = Array.isArray(args.emails) ? args.emails.filter((entry): entry is string => typeof entry === 'string') : [];
      const me = given.length > 0 ? {} : await api('/me', { $select: 'mail,userPrincipalName' });
      const emails = given.length > 0 ? given : [String(me.mail ?? me.userPrincipalName ?? '')];
      const body = await api('/me/calendar/getSchedule', {}, { method: 'POST', body: { schedules: emails, startTime: graphTime(str(args.start) ?? '', zone), endTime: graphTime(str(args.end) ?? '', zone), availabilityViewInterval: 30 } });
      const out = (Array.isArray(body.value) ? (body.value as Record<string, unknown>[]) : []).map((schedule) => {
        const items = Array.isArray(schedule.scheduleItems) ? (schedule.scheduleItems as Record<string, unknown>[]) : [];
        const busy = items.filter((item) => item.status !== 'free').map((item) => {
          const start = (item.start ?? {}) as Record<string, unknown>;
          const end = (item.end ?? {}) as Record<string, unknown>;
          return '  ' + when(start.dateTime, zone) + ' to ' + when(end.dateTime, zone) + ' ' + String(item.status);
        });
        return String(schedule.scheduleId) + (busy.length === 0 ? ': free throughout' : ': busy\n' + busy.join('\n'));
      });
      return out.length === 0 ? none('availability returned') : out.join('\n');
    },
  },
  {
    name: 'create_event',
    title: 'Add an event',
    description: 'Add an event to a calendar. Attendees, if any, are emailed invitations.',
    properties: { calendarId: { type: 'string', description: 'Calendar id (default: the main calendar).' }, ...FIELDS_WRITE },
    required: ['title', 'start', 'end'],
    writes: true,
    run: async (api, args) => {
      const event = await api(calendarPath(args) + '/events', {}, { method: 'POST', body: eventBody(args) });
      return 'Event created.\n' + eventLine(event, zoneOf(args));
    },
  },
  {
    name: 'update_event',
    title: 'Change an event',
    description: 'Change an event: only the fields given are changed.',
    properties: { eventId: { type: 'string', description: 'Event id from list_events.' }, ...FIELDS_WRITE },
    required: ['eventId'],
    writes: true,
    run: async (api, args) => {
      const event = await api('/me/events/' + encodeURIComponent(str(args.eventId) ?? ''), {}, { method: 'PATCH', body: eventBody(args) });
      return 'Event updated.\n' + eventLine(event, zoneOf(args));
    },
  },
  {
    name: 'delete_event',
    title: 'Delete an event',
    description: 'Delete an event from the calendar. If the owner organised it, attendees get a cancellation.',
    properties: { eventId: { type: 'string', description: 'Event id from list_events.' } },
    required: ['eventId'],
    writes: true,
    destructive: true,
    run: async (api, args) => {
      await api('/me/events/' + encodeURIComponent(str(args.eventId) ?? ''), {}, { method: 'DELETE' });
      return 'Event deleted.';
    },
  },
  {
    name: 'respond_to_event',
    title: 'Answer an invitation',
    description: 'Accept, tentatively accept or decline an invitation. The organiser is told unless sendResponse is false.',
    properties: {
      eventId: { type: 'string', description: 'Event id from list_events.' },
      response: { type: 'string', enum: ['accept', 'tentativelyAccept', 'decline'], description: "The owner's answer." },
      comment: { type: 'string', description: 'A note sent with the answer.' },
      sendResponse: { type: 'boolean', description: 'Tell the organiser (default true).' },
    },
    required: ['eventId', 'response'],
    writes: true,
    run: async (api, args) => {
      const response = str(args.response);
      if (response === undefined || !['accept', 'tentativelyAccept', 'decline'].includes(response)) throw new Error('response must be accept, tentativelyAccept or decline');
      await api('/me/events/' + encodeURIComponent(str(args.eventId) ?? '') + '/' + response, {}, { method: 'POST', body: { comment: str(args.comment) ?? '', sendResponse: args.sendResponse !== false } });
      return 'Answered: ' + response + '.';
    },
  },
];
