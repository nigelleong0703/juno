/**
 * The write tools of the first-party Google and Microsoft connectors, against a fake REST API that records what it was asked: the request each
 * tool makes (method, path, query, body), how it is classified (read or change, destructive), and how a missing scope surfaces.
 */
import { describe, expect, it } from 'vitest';
import { resolveCatalog, validateCatalog } from '../modules/connector-catalog.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';
import { handleGoogleMcp, SERVICES } from '../modules/google-mcp.js';

const API = { gmail: 'https://gmail.test/gmail/v1', calendar: 'https://cal.test/calendar/v3', drive: 'https://drive.test/drive/v3', graph: 'https://graph.test/v1.0' };
const deps = (fetchImpl: typeof fetch) => ({ publicUrl: 'https://gw.example.com', apis: API, fetchImpl });

interface Seen { method: string; path: string; query: Record<string, string>; body: unknown; raw: string; headers: Headers }

/** Routes by "METHOD /path" (the path after the API's base); a function replies per request. */
function fake(routes: Record<string, unknown | ((seen: Seen) => unknown)>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/(gmail\/v1|calendar\/v3|drive\/v3|v1\.0)/, ''));
    const raw = typeof init?.body === 'string' ? init.body : '';
    const entry: Seen = { method, path, query: Object.fromEntries(url.searchParams), raw, body: raw.startsWith('{') ? JSON.parse(raw) : undefined, headers: new Headers(init?.headers) };
    seen.push(entry);
    const reply = routes[method + ' ' + path];
    if (reply === undefined) return Response.json({ error: { code: 404, message: 'no route ' + method + ' ' + path } }, { status: 404 });
    const value = typeof reply === 'function' ? (reply as (s: Seen) => unknown)(entry) : reply;
    return value instanceof Response ? value : value === null ? new Response(null, { status: 204 }) : Response.json(value);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function call(fetchImpl: typeof fetch, service: string, name: string, args: Record<string, unknown> = {}) {
  const response = await handleGoogleMcp(deps(fetchImpl), service, new Request('https://gw.example.com/mcp/google/' + service, {
    method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  if (response.status !== 200) return { status: response.status, challenge: response.headers.get('www-authenticate') ?? '', text: '', json: undefined as unknown, isError: false };
  const result = ((await response.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  const text = result.content[0]?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined; // the Microsoft tools answer in text
  }
  return { status: 200, challenge: '', text, json, isError: result.isError === true };
}

async function tools(service: string): Promise<Map<string, { annotations: Record<string, unknown> }>> {
  const response = await handleGoogleMcp(deps(fetch), service, new Request('https://gw.example.com/x', {
    method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }));
  const list = ((await response.json()) as { result: { tools: { name: string; annotations: Record<string, unknown> }[] } }).result.tools;
  return new Map(list.map((tool) => [tool.name, tool]));
}

const b64 = (value: string) => Buffer.from(value).toString('base64url');
const decodeRaw = (raw: unknown) => Buffer.from(String((raw as { raw: string }).raw), 'base64url').toString('utf8');

describe('tool set and classification', () => {
  it('carries the official tool names, and every change is flagged so it asks first; sending and deleting are destructive', async () => {
    const calendar = await tools('calendar');
    for (const name of ['create_event', 'update_event', 'delete_event', 'respond_to_event', 'get_event', 'search_events', 'suggest_time', 'list_calendars', 'list_events']) expect(calendar.has(name), name).toBe(true);
    const mutating = (list: Map<string, { annotations: Record<string, unknown> }>) => [...list].filter(([, tool]) => tool.annotations.readOnlyHint === false).map(([name]) => name).sort();
    expect(mutating(calendar)).toEqual(['create_event', 'delete_event', 'respond_to_event', 'update_event']);
    expect(calendar.get('delete_event')?.annotations.destructiveHint).toBe(true);
    expect(calendar.get('create_event')?.annotations.destructiveHint).toBe(false);
    expect(calendar.get('suggest_time')?.annotations.readOnlyHint).toBe(true);

    const gmail = await tools('gmail');
    expect(mutating(gmail)).toEqual(['create_draft', 'label_message', 'label_thread', 'send_draft', 'send_message', 'unlabel_message', 'unlabel_thread']);
    expect(gmail.get('send_message')?.annotations.destructiveHint).toBe(true);
    expect(gmail.get('send_draft')?.annotations.destructiveHint).toBe(true);
    expect(gmail.get('list_drafts')?.annotations.readOnlyHint).toBe(true);

    const drive = await tools('drive');
    for (const name of ['create_file', 'copy_file', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'read_file_content', 'search_files']) expect(drive.has(name), name).toBe(true);
    expect(mutating(drive)).toEqual(['copy_file', 'create_file']);

    const mail = await tools('outlook-mail');
    expect(mutating(mail)).toEqual(['create_draft', 'flag_message', 'forward_message', 'move_message', 'reply_all', 'reply_to_message', 'send_draft']);
    for (const name of ['send_draft', 'reply_all', 'reply_to_message', 'forward_message']) expect(mail.get(name)?.annotations.destructiveHint, name).toBe(true);
    expect(mail.get('move_message')?.annotations.destructiveHint).toBe(false);
    expect([...await tools('outlook-calendar')].filter(([, tool]) => tool.annotations.destructiveHint === true).map(([name]) => name)).toEqual(['delete_event']);
    expect((await tools('microsoft-todo')).get('delete_task')?.annotations.destructiveHint).toBe(true);
  });

  it('the catalog asks Google and Microsoft for the scopes the tools need, and the new apps and tags are valid', () => {
    expect(() => validateCatalog(CONNECTOR_CATALOG)).not.toThrow();
    const entry = (id: string) => CONNECTOR_CATALOG.find((candidate) => candidate.id === id);
    expect(entry('google-calendar')?.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(entry('gmail')?.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify']);
    expect(entry('google-drive')?.scopes).toEqual(['https://www.googleapis.com/auth/drive']);
    expect(entry('onedrive')?.scopes).toEqual(['Files.ReadWrite', 'offline_access']);
    expect(entry('microsoft-contacts')?.scopes).toEqual(['Contacts.ReadWrite', 'offline_access']);
    expect(entry('google-calendar')?.provides).toContain('calendar.write');
    expect(entry('gmail')?.provides).toContain('mail.send');
    expect(entry('stripe')?.provides).toContain('payments.write');
    expect(entry('stripe')?.toolAccess?.stripe_api_write).toBe('change');
  });
});

describe('a missing scope', () => {
  it('Google 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT is HTTP 403 insufficient_scope naming the service scopes, so the app shows scope_missing and signs in again', async () => {
    const { fetchImpl } = fake({ 'POST /calendars/primary/events': () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, { status: 403 }) });
    const result = await call(fetchImpl, 'calendar', 'create_event', { summary: 'x', startTime: '2026-11-02T09:00:00+08:00', endTime: '2026-11-02T10:00:00+08:00' });
    expect(result.status).toBe(403);
    expect(result.challenge).toContain('error="insufficient_scope"');
    expect(result.challenge).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(result.challenge).toContain('resource_metadata="https://gw.example.com/.well-known/oauth-protected-resource/mcp/google/calendar"');
  });

  it('a permission error that is not about scopes stays an ordinary tool error', async () => {
    const { fetchImpl } = fake({ 'DELETE /calendars/primary/events/e1': () => Response.json({ error: { code: 403, message: 'Forbidden' } }, { status: 403 }) });
    const result = await call(fetchImpl, 'calendar', 'delete_event', { eventId: 'e1' });
    expect(result).toMatchObject({ status: 200, isError: true, text: 'Google API 403: Forbidden' });
  });

  it('Microsoft Graph Authorization_RequestDenied is the same signal', async () => {
    const { fetchImpl } = fake({ 'POST /me/contacts': () => Response.json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }, { status: 403 }) });
    const result = await call(fetchImpl, 'microsoft-contacts', 'create_contact', { name: 'Ada' });
    expect(result.status).toBe(403);
    expect(result.challenge).toContain('Contacts.ReadWrite');
    expect(result.challenge).not.toContain('offline_access');
  });
});

describe('Google Calendar', () => {
  it('create_event sends the official argument shape as an event, invites by notificationLevel and adds a Meet link', async () => {
    const { fetchImpl, seen } = fake({ 'POST /calendars/primary/events': { id: 'e1', summary: 'Sync', start: { dateTime: '2026-11-02T09:00:00+08:00' }, end: { dateTime: '2026-11-02T09:30:00+08:00' }, htmlLink: 'https://cal/e1' } });
    const result = await call(fetchImpl, 'calendar', 'create_event', {
      summary: 'Sync', startTime: '2026-11-02T09:00:00+08:00', endTime: '2026-11-02T09:30:00+08:00', timeZone: 'Asia/Singapore',
      attendees: [{ email: 'ada@example.com', optionalAttendee: true }], attendeeEmails: ['bob@example.com'], addGoogleMeetUrl: true, notificationLevel: 'NONE', availability: 'AVAILABILITY_FREE',
      overrideReminders: [{ method: 'popup', minutes: 10 }], recurrenceData: ['RRULE:FREQ=WEEKLY'], guestPermissions: { guestsCanModify: false },
    });
    expect(result.json).toMatchObject({ id: 'e1', title: 'Sync' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query).toMatchObject({ sendUpdates: 'none', conferenceDataVersion: '1' });
    expect(seen[0]?.body).toMatchObject({
      summary: 'Sync',
      start: { dateTime: '2026-11-02T09:00:00', timeZone: 'Asia/Singapore' },
      end: { dateTime: '2026-11-02T09:30:00', timeZone: 'Asia/Singapore' },
      attendees: [{ email: 'ada@example.com', optional: true }, { email: 'bob@example.com' }],
      transparency: 'transparent', guestsCanModify: false, recurrence: ['RRULE:FREQ=WEEKLY'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
  });

  it('create_event with allDay sends dates', async () => {
    const { fetchImpl, seen } = fake({ 'POST /calendars/team@example.com/events': { id: 'e2' } });
    await call(fetchImpl, 'calendar', 'create_event', { calendarId: 'team@example.com', summary: 'Offsite', startTime: '2026-11-05', endTime: '2026-11-06', allDay: true });
    expect(seen[0]?.body).toMatchObject({ start: { date: '2026-11-05' }, end: { date: '2026-11-06' } });
  });

  it('update_event changes only the given fields and merges attendees instead of replacing them', async () => {
    const { fetchImpl, seen } = fake({
      'GET /calendars/primary/events/e1': { id: 'e1', attendees: [{ email: 'ada@example.com', responseStatus: 'accepted' }, { email: 'cy@example.com' }] },
      'PATCH /calendars/primary/events/e1': { id: 'e1', summary: 'Renamed' },
    });
    await call(fetchImpl, 'calendar', 'update_event', { eventId: 'e1', summary: 'Renamed', addedAttendees: [{ email: 'dee@example.com' }], removedAttendeeEmails: ['CY@example.com'] });
    const patch = seen.find((request) => request.method === 'PATCH');
    expect(patch?.query.sendUpdates).toBe('all');
    expect(patch?.body).toEqual({ summary: 'Renamed', attendees: [{ email: 'ada@example.com', responseStatus: 'accepted' }, { email: 'dee@example.com' }] });
  });

  it('update_event without attendee changes does not read the event first', async () => {
    const { fetchImpl, seen } = fake({ 'PATCH /calendars/primary/events/e1': { id: 'e1' } });
    await call(fetchImpl, 'calendar', 'update_event', { eventId: 'e1', location: 'Room 2' });
    expect(seen.map((request) => request.method)).toEqual(['PATCH']);
    expect(seen[0]?.body).toEqual({ location: 'Room 2' });
  });

  it('delete_event is a DELETE with the notification choice and no body', async () => {
    const { fetchImpl, seen } = fake({ 'DELETE /calendars/primary/events/e1': null });
    const result = await call(fetchImpl, 'calendar', 'delete_event', { eventId: 'e1', notificationLevel: 'EXTERNAL_ONLY' });
    expect(result.json).toEqual({ deleted: true, eventId: 'e1' });
    expect(seen[0]).toMatchObject({ method: 'DELETE', query: { sendUpdates: 'externalOnly' }, raw: '' });
  });

  it('respond_to_event sets only the owner\'s own attendee entry, and refuses an event the owner is not invited to', async () => {
    const { fetchImpl, seen } = fake({
      'GET /calendars/primary/events/e1': { attendees: [{ email: 'me@example.com', self: true, responseStatus: 'needsAction' }, { email: 'ada@example.com', responseStatus: 'accepted' }] },
      'PATCH /calendars/primary/events/e1': { id: 'e1' },
      'GET /calendars/primary/events/e2': { attendees: [{ email: 'ada@example.com' }] },
    });
    await call(fetchImpl, 'calendar', 'respond_to_event', { eventId: 'e1', responseStatus: 'declined', responseComment: 'Clash' });
    expect(seen.find((request) => request.method === 'PATCH')?.body).toEqual({ attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined', comment: 'Clash' }, { email: 'ada@example.com', responseStatus: 'accepted' }] });
    const refused = await call(fetchImpl, 'calendar', 'respond_to_event', { eventId: 'e2', responseStatus: 'accepted' });
    expect(refused).toMatchObject({ isError: true, text: 'The owner is not an attendee of this event' });
    expect(seen.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('search_events uses the query on the primary calendar; get_event reads one event', async () => {
    const { fetchImpl, seen } = fake({ 'GET /calendars/primary/events': { items: [{ id: 'e1', summary: 'Dentist' }], nextPageToken: 'n' }, 'GET /calendars/primary/events/e1': { id: 'e1', summary: 'Dentist' } });
    const found = await call(fetchImpl, 'calendar', 'search_events', { query: 'dentist', pageSize: 5 });
    expect(seen[0]?.query).toMatchObject({ q: 'dentist', maxResults: '5' });
    expect(found.json).toMatchObject({ events: [{ id: 'e1' }], nextPageToken: 'n' });
    expect((await call(fetchImpl, 'calendar', 'get_event', { eventId: 'e1' })).json).toMatchObject({ title: 'Dentist' });
  });

  it('suggest_time returns the first free slots of the right length inside working hours, skipping busy periods and weekends', async () => {
    const { fetchImpl, seen } = fake({
      'POST /freeBusy': { calendars: { primary: { busy: [{ start: '2026-11-02T09:00:00Z', end: '2026-11-02T10:00:00Z' }] }, 'ada@example.com': { busy: [{ start: '2026-11-02T10:30:00Z', end: '2026-11-02T11:00:00Z' }] } } },
    });
    // Mon 2 Nov 2026 UTC; the range starts on Saturday 31 Oct to exercise excludeWeekends.
    const result = await call(fetchImpl, 'calendar', 'suggest_time', {
      attendeeEmails: ['ada@example.com'], startTime: '2026-10-31T00:00:00Z', endTime: '2026-11-02T12:00:00Z', durationMinutes: 60, timeZone: 'UTC',
      preferences: { startHour: '09:00', endHour: '12:00', excludeWeekends: true, pageSize: 2 },
    });
    expect((seen[0]?.body as { items: unknown[] }).items).toEqual([{ id: 'primary' }, { id: 'ada@example.com' }]);
    // Weekend days are skipped; on Monday 09:00-11:00 is taken by the two busy periods, so 11:00-12:00 is the only hour left in the 09:00-12:00 window.
    expect(result.json).toEqual({ timeSlots: [{ start: { dateTime: '2026-11-02T11:00:00.000Z' }, end: { dateTime: '2026-11-02T12:00:00.000Z' } }] });
  });
});

describe('Gmail', () => {
  it('send_message sends a new message through messages.send with a raw RFC 2822 body', async () => {
    const { fetchImpl, seen } = fake({ 'POST /users/me/messages/send': { id: 'm1', threadId: 't1' } });
    const result = await call(fetchImpl, 'gmail', 'send_message', { to: 'ada@example.com', subject: 'Hello', body: 'Hi Ada', cc: 'bob@example.com' });
    expect(result.json).toMatchObject({ messageId: 'm1', threadId: 't1' });
    const text = decodeRaw(seen[0]?.body);
    expect(text).toContain('To: ada@example.com');
    expect(text).toContain('Cc: bob@example.com');
    expect(text).toContain('Subject: Hello');
    expect(text.split('\r\n\r\n')[1]).toBe(Buffer.from('Hi Ada').toString('base64'));
    expect((seen[0]?.body as { threadId?: string }).threadId).toBeUndefined();
  });

  it('send_message with threadId replies under the last message: In-Reply-To from its Message-ID, subject Re:, same thread', async () => {
    const { fetchImpl, seen } = fake({
      'GET /users/me/threads/t1': { messages: [{ payload: { headers: [{ name: 'Message-Id', value: '<first@x>' }] } }, { payload: { headers: [{ name: 'Subject', value: 'Lunch?' }, { name: 'Message-Id', value: '<last@x>' }] } }] },
      'POST /users/me/messages/send': { id: 'm2', threadId: 't1' },
    });
    await call(fetchImpl, 'gmail', 'send_message', { to: 'ada@example.com', body: 'Yes', threadId: 't1' });
    const sent = seen.find((request) => request.method === 'POST');
    const text = decodeRaw(sent?.body);
    expect(text).toContain('Subject: Re: Lunch?');
    expect(text).toContain('In-Reply-To: <last@x>');
    expect((sent?.body as { threadId: string }).threadId).toBe('t1');
  });

  it('send_draft posts the draft id; label tools modify by id on the message or the thread', async () => {
    const { fetchImpl, seen } = fake({
      'POST /users/me/drafts/send': { id: 'm3', threadId: 't3' },
      'POST /users/me/messages/m1/modify': { id: 'm1', labelIds: ['STARRED'] },
      'POST /users/me/threads/t1/modify': { id: 't1' },
    });
    await call(fetchImpl, 'gmail', 'send_draft', { draftId: 'd1' });
    await call(fetchImpl, 'gmail', 'label_message', { messageId: 'm1', labelIds: ['STARRED'] });
    await call(fetchImpl, 'gmail', 'unlabel_thread', { threadId: 't1', labelIds: ['INBOX', 'UNREAD'] });
    expect(seen.map((request) => request.body)).toEqual([{ id: 'd1' }, { addLabelIds: ['STARRED'] }, { removeLabelIds: ['INBOX', 'UNREAD'] }]);
  });

  it('list_drafts lists drafts with their messages', async () => {
    const message = { id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', filename: '', headers: [{ name: 'Subject', value: 'Draft one' }], body: { data: b64('hello') } } };
    const { fetchImpl, seen } = fake({ 'GET /users/me/drafts': { drafts: [{ id: 'd1', message: { id: 'm1' } }] }, 'GET /users/me/messages/m1': message });
    const result = await call(fetchImpl, 'gmail', 'list_drafts', { query: 'to:ada', pageSize: 5 });
    expect(seen[0]?.query).toMatchObject({ q: 'to:ada', maxResults: '5' });
    expect(result.json).toMatchObject({ drafts: [{ draftId: 'd1', subject: 'Draft one', body: 'hello' }] });
  });
});

describe('Google Drive', () => {
  it('create_file with text uploads multipart and converts text to a Google Doc unless told not to', async () => {
    const { fetchImpl, seen } = fake({ 'POST /upload/drive/v3/files': { id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' } });
    await call(fetchImpl, 'drive', 'create_file', { title: 'Notes', contentMimeType: 'text/plain', textContent: 'line one', parentId: 'folder1' });
    await call(fetchImpl, 'drive', 'create_file', { title: 'raw.txt', contentMimeType: 'text/plain', textContent: 'x', disableConversionToGoogleType: true });
    expect(seen[0]?.path).toBe('/upload/drive/v3/files');
    expect(seen[0]?.query.uploadType).toBe('multipart');
    expect(seen[0]?.headers.get('content-type')).toMatch(/^multipart\/related; boundary=/);
    expect(seen[0]?.raw).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(seen[0]?.raw).toContain('"parents":["folder1"]');
    expect(seen[0]?.raw).toContain('line one');
    expect(seen[1]?.raw).not.toContain('google-apps');
  });

  it('create_file without content makes a folder by metadata only; both content kinds together are refused', async () => {
    const { fetchImpl, seen } = fake({ 'POST /files': { id: 'folder1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' } });
    await call(fetchImpl, 'drive', 'create_file', { title: 'Reports', mimeType: 'application/vnd.google-apps.folder' });
    expect(seen[0]?.body).toEqual({ name: 'Reports', mimeType: 'application/vnd.google-apps.folder' });
    expect(await call(fetchImpl, 'drive', 'create_file', { title: 'x', contentMimeType: 'text/plain', textContent: 'a', base64Content: 'YQ==' })).toMatchObject({ isError: true });
  });

  it('copy_file, get_file_permissions and list_recent_files use the Drive endpoints', async () => {
    const { fetchImpl, seen } = fake({
      'POST /files/f1/copy': { id: 'f2', name: 'Copy of Plan' },
      'GET /files/f1/permissions': { permissions: [{ type: 'user', role: 'writer', emailAddress: 'ada@example.com' }, { type: 'anyone', role: 'reader' }] },
      'GET /files': { files: [{ id: 'f1', name: 'Plan' }] },
    });
    expect((await call(fetchImpl, 'drive', 'copy_file', { fileId: 'f1', title: 'Plan v2', parentId: 'p1' })).json).toMatchObject({ id: 'f2' });
    expect(seen[0]?.body).toEqual({ name: 'Plan v2', parents: ['p1'] });
    expect((await call(fetchImpl, 'drive', 'get_file_permissions', { fileId: 'f1' })).json).toEqual({ permissions: [{ type: 'user', role: 'writer', email: 'ada@example.com' }, { type: 'anyone', role: 'reader' }] });
    await call(fetchImpl, 'drive', 'list_recent_files', { orderBy: 'lastModifiedByMe', pageSize: 3 });
    expect(seen.at(-1)?.query).toMatchObject({ orderBy: 'modifiedByMeTime desc', pageSize: '3' });
  });
});

describe('Microsoft Graph', () => {
  it('Outlook mail: reply, reply all and forward post at once; move and flag are plain changes', async () => {
    const { fetchImpl, seen } = fake({
      'POST /me/messages/m1/reply': null, 'POST /me/messages/m1/replyAll': null, 'POST /me/messages/m1/forward': null,
      'POST /me/messages/m1/move': { id: 'm9' }, 'PATCH /me/messages/m1': { id: 'm1' },
    });
    await call(fetchImpl, 'outlook-mail', 'reply_to_message', { messageId: 'm1', body: 'Thanks' });
    await call(fetchImpl, 'outlook-mail', 'reply_all', { messageId: 'm1', body: 'Thanks all' });
    await call(fetchImpl, 'outlook-mail', 'forward_message', { messageId: 'm1', to: 'ada@example.com, bob@example.com', body: 'FYI' });
    expect((await call(fetchImpl, 'outlook-mail', 'move_message', { messageId: 'm1', folderId: 'archive' })).text).toContain('m9');
    await call(fetchImpl, 'outlook-mail', 'flag_message', { messageId: 'm1', status: 'complete' });
    expect(seen.map((request) => request.method + ' ' + request.path)).toEqual(['POST /me/messages/m1/reply', 'POST /me/messages/m1/replyAll', 'POST /me/messages/m1/forward', 'POST /me/messages/m1/move', 'PATCH /me/messages/m1']);
    expect(seen[0]?.body).toEqual({ comment: 'Thanks' });
    expect(seen[2]?.body).toEqual({ comment: 'FYI', toRecipients: [{ emailAddress: { address: 'ada@example.com' } }, { emailAddress: { address: 'bob@example.com' } }] });
    expect(seen[3]?.body).toEqual({ destinationId: 'archive' });
    expect(seen[4]?.body).toEqual({ flag: { flagStatus: 'complete' } });
  });

  it('Outlook calendar: delete_event deletes, respond_to_event posts the answer and validates it', async () => {
    const { fetchImpl, seen } = fake({ 'DELETE /me/events/e1': null, 'POST /me/events/e1/tentativelyAccept': null });
    await call(fetchImpl, 'outlook-calendar', 'delete_event', { eventId: 'e1' });
    await call(fetchImpl, 'outlook-calendar', 'respond_to_event', { eventId: 'e1', response: 'tentativelyAccept', comment: 'Maybe', sendResponse: false });
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[1]?.body).toEqual({ comment: 'Maybe', sendResponse: false });
    expect(await call(fetchImpl, 'outlook-calendar', 'respond_to_event', { eventId: 'e1', response: 'maybe' })).toMatchObject({ isError: true });
    expect(seen).toHaveLength(2);
  });

  it('To Do: update_task patches only the given fields (and clears the due date), delete_task deletes', async () => {
    const { fetchImpl, seen } = fake({
      'GET /me/todo/lists': { value: [{ id: 'L1', wellknownListName: 'defaultList' }] },
      'PATCH /me/todo/lists/L1/tasks/t1': { id: 't1', title: 'New title' }, 'DELETE /me/todo/lists/L1/tasks/t1': null,
    });
    await call(fetchImpl, 'microsoft-todo', 'update_task', { taskId: 't1', title: 'New title', due: 'none', importance: 'high' });
    await call(fetchImpl, 'microsoft-todo', 'delete_task', { taskId: 't1' });
    expect(seen.find((request) => request.method === 'PATCH')?.body).toEqual({ title: 'New title', dueDateTime: null, importance: 'high' });
    expect(seen.at(-1)?.method).toBe('DELETE');
  });

  it('OneDrive: create_folder, upload_file (PUT of text, size-limited) and copy_file (with the drive id for a target folder)', async () => {
    const item = { id: 'i1', name: 'n', size: 1, lastModifiedDateTime: '2026-10-29T00:00:00Z', webUrl: 'https://od/i1', file: {} };
    const { fetchImpl, seen } = fake({
      'POST /me/drive/root/children': item, 'PUT /me/drive/root:/notes.md:/content': item, 'GET /me/drive': { id: 'drive9' }, 'POST /me/drive/items/i1/copy': null,
    });
    await call(fetchImpl, 'onedrive', 'create_folder', { name: 'Reports' });
    await call(fetchImpl, 'onedrive', 'upload_file', { name: 'notes.md', textContent: '# Notes', contentType: 'text/markdown' });
    await call(fetchImpl, 'onedrive', 'copy_file', { fileId: 'i1', name: 'copy.md', parentId: 'folder2' });
    expect(seen[0]?.body).toMatchObject({ name: 'Reports', folder: {} });
    expect(seen[1]).toMatchObject({ method: 'PUT', raw: '# Notes' });
    expect(seen[1]?.headers.get('content-type')).toBe('text/markdown');
    expect(seen.at(-1)?.body).toEqual({ name: 'copy.md', parentReference: { driveId: 'drive9', id: 'folder2' } });
    expect(await call(fetchImpl, 'onedrive', 'upload_file', { name: 'big.txt', textContent: 'x'.repeat(4_000_001) })).toMatchObject({ isError: true });
  });

  it('Contacts: get_contact prints details, create_contact posts a contact', async () => {
    const { fetchImpl, seen } = fake({
      'GET /me/contacts/c1': { id: 'c1', displayName: 'Ada Lovelace', emailAddresses: [{ address: 'ada@example.com' }], companyName: 'Analytical', businessPhones: ['+44 1'] },
      'POST /me/contacts': { id: 'c2' },
    });
    const read = await call(fetchImpl, 'microsoft-contacts', 'get_contact', { contactId: 'c1' });
    expect(read.text).toContain('Ada Lovelace');
    expect(read.text).toContain('Email: ada@example.com');
    expect(read.text).toContain('Company: Analytical');
    await call(fetchImpl, 'microsoft-contacts', 'create_contact', { name: 'Bob', email: 'bob@example.com', jobTitle: 'Engineer' });
    expect(seen.at(-1)?.body).toEqual({ displayName: 'Bob', emailAddresses: [{ address: 'bob@example.com', name: 'Bob' }], jobTitle: 'Engineer' });
  });
});

describe('hosted catalog', () => {
  it('every hosted service entry resolves with its gateway scopes', () => {
    const resolved = resolveCatalog(CONNECTOR_CATALOG, 'https://gw.example.com', {});
    expect(resolved.find((entry) => entry.id === 'google-calendar')?.url).toBe('https://gw.example.com/mcp/google/calendar');
    expect(SERVICES.calendar?.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
  });
});
