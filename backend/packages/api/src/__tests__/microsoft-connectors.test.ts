import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MICROSOFT_ISSUER } from '@agent-desktop/contracts/mcp';
import { resolveCatalog, validateCatalog } from '../modules/connector-catalog.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';
import { googleMcpResourceMetadata, handleGoogleMcp, SERVICES } from '../modules/google-mcp.js';

const GRAPH = 'https://graph.test/v1.0';
const deps = (fetchImpl: typeof fetch) => ({ publicUrl: 'https://gw.example.com', apis: { graph: GRAPH }, fetchImpl });

interface Seen { method: string; path: string; query: Record<string, string>; body: unknown; headers: Headers }

/** A fake Graph: routes by "METHOD /path" to a JSON (or bytes/text) reply, recording what was asked. */
function graph(routes: Record<string, unknown>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push({ method, path: decodeURIComponent(url.pathname.replace('/v1.0', '')), query: Object.fromEntries(url.searchParams), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) });
    const reply = routes[method + ' ' + decodeURIComponent(url.pathname.replace('/v1.0', ''))];
    if (reply === undefined) return Response.json({ error: { code: 'NotFound', message: 'no route' } }, { status: 404 });
    if (reply instanceof Response) return reply;
    return Response.json(reply);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

async function call(fetchImpl: typeof fetch, service: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const response = await handleGoogleMcp(deps(fetchImpl), service, new Request('https://gw.example.com/mcp/google/' + service, {
    method: 'POST',
    headers: { authorization: 'Bearer ms-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const result = ((await response.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

async function tools(service: string): Promise<{ name: string; title: string; annotations: Record<string, unknown> }[]> {
  const response = await handleGoogleMcp(deps(fetch), service, new Request('https://gw.example.com/mcp/google/' + service, {
    method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }));
  return ((await response.json()) as { result: { tools: { name: string; title: string; annotations: Record<string, unknown> }[] } }).result.tools;
}

describe('Microsoft 365 catalog entries', () => {
  const ids = ['outlook-mail', 'outlook-calendar', 'microsoft-todo', 'onedrive', 'microsoft-contacts', 'teams'];

  it('are featured, hosted here, keyed to the common authority and ask for minimal scopes with offline_access', () => {
    expect(() => validateCatalog(CONNECTOR_CATALOG)).not.toThrow();
    for (const id of ids) {
      const entry = CONNECTOR_CATALOG.find((candidate) => candidate.id === id);
      expect(entry, id).toMatchObject({ url: '/mcp/google/' + id, configuredClientIssuer: MICROSOFT_ISSUER });
      expect(entry?.platformKey).toBeUndefined();
      expect(entry?.revocationEndpoint).toBeUndefined();
      expect(entry?.scopes).toContain('offline_access');
      expect(entry?.scopes).toEqual(SERVICES[id]?.scopes);
      expect(entry?.scopes?.every((scope) => !scope.includes('.All') || id === 'teams')).toBe(true);
    }
    expect(CONNECTOR_CATALOG.find((entry) => entry.id === 'teams')?.description).toMatch(/admin/);
    expect(CONNECTOR_CATALOG.find((entry) => entry.id === 'outlook-mail')?.scopes).toEqual(['Mail.ReadWrite', 'Mail.Send', 'offline_access']);
  });

  it('are left out without PUBLIC_URL, like every hosted entry', () => {
    const resolved = resolveCatalog(CONNECTOR_CATALOG, 'https://gw.example.com', {}).filter((entry) => ids.includes(entry.id));
    expect(resolved.map((entry) => entry.url)).toContain('https://gw.example.com/mcp/google/outlook-mail');
    expect(resolveCatalog(CONNECTOR_CATALOG, undefined, {}).some((entry) => ids.includes(entry.id))).toBe(false);
  });

  it('name Microsoft as the authorization server in their resource metadata', () => {
    expect(googleMcpResourceMetadata({ publicUrl: 'https://gw.example.com', issuer: 'http://127.0.0.1:1' }, 'outlook-mail')).toMatchObject({
      resource: 'https://gw.example.com/mcp/google/outlook-mail', authorization_servers: [MICROSOFT_ISSUER], scopes_supported: ['Mail.ReadWrite', 'Mail.Send', 'offline_access'],
    });
  });

  it('every tool has a title and read/write hints; what sends or deletes is destructive; Teams is read-only', async () => {
    const destructive = ['send_draft', 'reply_to_message', 'reply_all', 'forward_message', 'delete_event', 'delete_task'];
    for (const id of ids) {
      for (const tool of await tools(id)) {
        expect(tool.title, id + '/' + tool.name).not.toBe('');
        expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
        if (tool.annotations.readOnlyHint === false) expect(tool.annotations.destructiveHint, id + '/' + tool.name).toBe(destructive.includes(tool.name));
      }
    }
    const writes = async (id: string) => (await tools(id)).filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name);
    expect(await writes('outlook-mail')).toEqual(['create_draft', 'send_draft', 'reply_to_message', 'reply_all', 'forward_message', 'move_message', 'flag_message']);
    expect(await writes('outlook-calendar')).toEqual(['create_event', 'update_event', 'delete_event', 'respond_to_event']);
    expect(await writes('microsoft-todo')).toEqual(['create_task', 'complete_task', 'update_task', 'delete_task']);
    expect(await writes('onedrive')).toEqual(['create_folder', 'upload_file', 'copy_file']);
    expect(await writes('microsoft-contacts')).toEqual(['create_contact']);
    expect(await writes('teams')).toEqual([]);
  });
});

describe('Outlook mail on Graph', () => {
  const messages = {
    value: [
      { id: 'm1', conversationId: 'c1', subject: 'Budget', from: { emailAddress: { name: 'Ann', address: 'ann@x.com' } }, receivedDateTime: '2026-10-19T01:30:00Z', bodyPreview: 'Numbers attached', hasAttachments: true, isRead: false },
    ],
    '@odata.nextLink': GRAPH + '/me/messages?$top=1&$skiptoken=abc',
  };

  it('searches with $search, shapes compact text in the asked zone, forwards the token and pages by opaque token', async () => {
    const { fetchImpl, seen } = graph({ 'GET /me/messages': messages });
    const result = await call(fetchImpl, 'outlook-mail', 'search_messages', { query: 'budget', maxResults: 1, timeZone: 'Asia/Singapore' });
    expect(result.text).toBe('[m1] 2026-10-19 09:30 Asia/Singapore Ann <ann@x.com> | Budget (unread) (attachments)\n    conversation c1: Numbers attached\nMore results: pageToken=/me/messages?$top=1&$skiptoken=abc');
    expect(seen[0]?.query).toMatchObject({ $search: '"budget"', $top: '1' });
    expect(seen[0]?.query.$orderby).toBeUndefined();
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer ms-token');
    expect(seen[0]?.headers.get('prefer')).toContain('outlook.timezone="UTC"');

    await call(fetchImpl, 'outlook-mail', 'search_messages', { pageToken: '/me/messages?$top=1&$skiptoken=abc' });
    expect(seen[1]?.query).toEqual({ $top: '1', $skiptoken: 'abc' });
  });

  it('without a query lists newest first, and times stay ISO UTC without a zone', async () => {
    const { fetchImpl, seen } = graph({ 'GET /me/messages': { value: messages.value } });
    const result = await call(fetchImpl, 'outlook-mail', 'search_messages');
    expect(result.text).toContain('2026-10-19T01:30:00Z');
    expect(seen[0]?.query.$orderby).toBe('receivedDateTime desc');
  });

  it('refuses a pageToken that is not a path on Graph (the bearer token must not go elsewhere)', async () => {
    const { fetchImpl, seen } = graph({});
    const result = await call(fetchImpl, 'outlook-mail', 'search_messages', { pageToken: 'https://evil.example/steal' });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('reads a message and a conversation (oldest first), lists folders', async () => {
    const full = { id: 'm1', subject: 'Budget', from: { emailAddress: { name: 'Ann', address: 'ann@x.com' } }, toRecipients: [{ emailAddress: { address: 'me@x.com', name: 'me@x.com' } }], receivedDateTime: '2026-10-19T01:30:00Z', body: { contentType: 'html', content: '<p>Hello&nbsp;there</p><p>Bye</p>' }, attachments: [{ name: 'q3.xlsx' }], webLink: 'https://outlook.office.com/m1' };
    const { fetchImpl } = graph({
      'GET /me/messages/m1': full,
      'GET /me/messages': { value: [{ ...full, id: 'm2', receivedDateTime: '2026-10-19T03:00:00Z' }, full] },
      'GET /me/mailFolders': { value: [{ id: 'f1', displayName: 'Inbox', unreadItemCount: 2, totalItemCount: 40 }] },
    });
    const one = (await call(fetchImpl, 'outlook-mail', 'get_message', { messageId: 'm1' })).text;
    expect(one).toContain('From: Ann <ann@x.com>');
    expect(one).toContain('To: me@x.com');
    expect(one).toContain('Attachments: q3.xlsx');
    expect(one).toContain('Hello there\nBye');
    const thread = (await call(fetchImpl, 'outlook-mail', 'get_thread', { conversationId: "c'1" })).text;
    expect(thread.indexOf('Message m1')).toBeLessThan(thread.indexOf('Message m2'));
    expect((await call(fetchImpl, 'outlook-mail', 'list_folders')).text).toBe('[f1] Inbox (2 unread of 40)');
  });

  it('creates a draft without sending, and sending is a separate call', async () => {
    const { fetchImpl, seen } = graph({ 'POST /me/messages': { id: 'd1', webLink: 'https://outlook.office.com/d1' }, 'POST /me/messages/d1/send': new Response(null, { status: 202 }) });
    const drafted = await call(fetchImpl, 'outlook-mail', 'create_draft', { to: 'a@x.com, b@x.com', subject: 'Hi', body: 'Text' });
    expect(drafted.text).toContain('not sent');
    expect(seen.map((request) => request.path)).toEqual(['/me/messages']);
    expect(seen[0]?.body).toMatchObject({ subject: 'Hi', body: { contentType: 'Text', content: 'Text' }, toRecipients: [{ emailAddress: { address: 'a@x.com' } }, { emailAddress: { address: 'b@x.com' } }] });
    expect((await call(fetchImpl, 'outlook-mail', 'send_draft', { draftId: 'd1' })).text).toBe('Sent.');
    expect(seen[1]).toMatchObject({ method: 'POST', path: '/me/messages/d1/send' });
  });

  it('a rejected token is HTTP 401 with the resource metadata challenge; other Graph errors name Graph', async () => {
    const rejected = await handleGoogleMcp(deps((async () => new Response(null, { status: 401 })) as typeof fetch), 'outlook-mail', new Request('https://gw.example.com/x', {
      method: 'POST', headers: { authorization: 'Bearer old', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_folders', arguments: {} } }),
    }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp/google/outlook-mail');
    const failed = await call(graph({}).fetchImpl, 'outlook-mail', 'list_folders');
    expect(failed).toEqual({ text: 'Microsoft Graph 404: no route', isError: true });
  });
});

describe('Outlook calendar on Graph', () => {
  const event = { id: 'e1', subject: 'Standup', start: { dateTime: '2026-10-20T01:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T01:30:00.0000000', timeZone: 'UTC' }, location: { displayName: 'Room 4' }, attendees: [{ emailAddress: { name: 'Bo', address: 'bo@x.com' } }], onlineMeeting: { joinUrl: 'https://teams.example/j' } };

  it('lists events in a range read in the owner zone, with paging', async () => {
    const { fetchImpl, seen } = graph({ 'GET /me/calendar/calendarView': { value: [event], '@odata.nextLink': GRAPH + '/me/calendar/calendarView?startDateTime=a&$skip=10' } });
    const result = await call(fetchImpl, 'outlook-calendar', 'list_events', { start: '2026-10-20T00:00:00', end: '2026-10-21T00:00:00', timeZone: 'Asia/Singapore', query: "o'clock" });
    expect(seen[0]?.query).toMatchObject({ startDateTime: '2026-10-19T16:00:00.000Z', endDateTime: '2026-10-20T16:00:00.000Z', $filter: "contains(subject,'o''clock')" });
    expect(result.text).toBe('[e1] 2026-10-20 09:00 Asia/Singapore to 2026-10-20 09:30 Asia/Singapore | Standup\n    Where: Room 4\n    With: Bo <bo@x.com>\n    Join: https://teams.example/j\nMore results: pageToken=/me/calendar/calendarView?startDateTime=a&$skip=10');
  });

  it('lists calendars and shows free/busy periods for the owner by default', async () => {
    const { fetchImpl, seen } = graph({
      'GET /me/calendars': { value: [{ id: 'k1', name: 'Calendar', isDefaultCalendar: true, canEdit: true }, { id: 'k2', name: 'Holidays', canEdit: false }] },
      'GET /me': { mail: 'me@x.com' },
      'POST /me/calendar/getSchedule': { value: [{ scheduleId: 'me@x.com', scheduleItems: [{ status: 'busy', start: { dateTime: '2026-10-20T01:00:00.0000000' }, end: { dateTime: '2026-10-20T02:00:00.0000000' } }, { status: 'free', start: { dateTime: '2026-10-20T03:00:00.0000000' }, end: { dateTime: '2026-10-20T04:00:00.0000000' } }] }] },
    });
    expect((await call(fetchImpl, 'outlook-calendar', 'list_calendars')).text).toBe('[k1] Calendar (default)\n[k2] Holidays (read-only)');
    const busy = await call(fetchImpl, 'outlook-calendar', 'query_free_busy', { start: '2026-10-20T00:00:00Z', end: '2026-10-21T00:00:00Z' });
    expect(busy.text).toBe('me@x.com: busy\n  2026-10-20T01:00:00Z to 2026-10-20T02:00:00Z busy');
    expect(seen.at(-1)?.body).toMatchObject({ schedules: ['me@x.com'], startTime: { dateTime: '2026-10-20T00:00:00.000', timeZone: 'UTC' } });
  });

  it('creates and updates events with UTC times converted from the owner zone', async () => {
    const { fetchImpl, seen } = graph({ 'POST /me/calendar/events': event, 'PATCH /me/events/e1': event });
    const created = await call(fetchImpl, 'outlook-calendar', 'create_event', { title: 'Standup', start: '2026-10-20T09:00:00', end: '2026-10-20T09:30:00+08:00', timeZone: 'Asia/Singapore', attendees: ['bo@x.com'], location: 'Room 4' });
    expect(created.text).toMatch(/^Event created\./);
    expect(seen[0]?.body).toMatchObject({ subject: 'Standup', start: { dateTime: '2026-10-20T01:00:00.000', timeZone: 'UTC' }, end: { dateTime: '2026-10-20T01:30:00.000', timeZone: 'UTC' }, attendees: [{ type: 'required', emailAddress: { address: 'bo@x.com' } }], location: { displayName: 'Room 4' } });
    await call(fetchImpl, 'outlook-calendar', 'update_event', { eventId: 'e1', title: 'Moved' });
    expect(seen[1]).toMatchObject({ method: 'PATCH', body: { subject: 'Moved' } });
  });
});

describe('Microsoft To Do on Graph', () => {
  it('lists lists and open tasks of the default list, adds a task with a due date and completes one', async () => {
    const { fetchImpl, seen } = graph({
      'GET /me/todo/lists': { value: [{ id: 'L2', displayName: 'Other' }, { id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' }] },
      'GET /me/todo/lists/L1/tasks': { value: [{ id: 't1', title: 'Pay rent', status: 'notStarted', dueDateTime: { dateTime: '2026-10-25T00:00:00.0000000' }, importance: 'high' }], '@odata.nextLink': GRAPH + '/me/todo/lists/L1/tasks?$skip=10' },
      'POST /me/todo/lists/L1/tasks': { id: 't2', title: 'Call Bo', status: 'notStarted' },
      'PATCH /me/todo/lists/L1/tasks/t2': { id: 't2', title: 'Call Bo', status: 'completed' },
    });
    expect((await call(fetchImpl, 'microsoft-todo', 'list_task_lists')).text).toBe('[L2] Other\n[L1] Tasks (default)');
    const tasks = await call(fetchImpl, 'microsoft-todo', 'list_tasks');
    expect(tasks.text).toBe('[t1] Pay rent | due 2026-10-25T00:00:00Z | important\nMore results: pageToken=/me/todo/lists/L1/tasks?$skip=10');
    expect(seen.at(-1)?.query.$filter).toBe("status ne 'completed'");
    await call(fetchImpl, 'microsoft-todo', 'create_task', { title: 'Call Bo', due: '2026-10-26', timeZone: 'Asia/Singapore' });
    expect(seen.at(-1)?.body).toMatchObject({ title: 'Call Bo', dueDateTime: { dateTime: '2026-10-25T16:00:00.000', timeZone: 'UTC' } });
    expect((await call(fetchImpl, 'microsoft-todo', 'complete_task', { taskId: 't2' })).text).toContain('(done)');
  });
});

/** A minimal stored-entry zip, enough to feed the Office reader: [name, content] pairs. */
function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name), 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, Buffer.from(name), data);
    central.push(header, Buffer.from(name));
    offset += 30 + Buffer.byteLength(name) + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe('OneDrive on Graph', () => {
  const file = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, size: 100, file: { mimeType: 'application/octet-stream' }, lastModifiedDateTime: '2026-10-18T10:00:00Z', webUrl: 'https://onedrive.example/' + id, ...extra });

  it('searches with an escaped q and lists a folder newest first', async () => {
    const { fetchImpl, seen } = graph({
      "GET /me/drive/root/search(q='o''brien plan')": { value: [file('f1', 'plan.docx')] },
      'GET /me/drive/root/children': { value: [file('f2', 'notes.txt')], '@odata.nextLink': GRAPH + '/me/drive/root/children?$skiptoken=z' },
    });
    expect((await call(fetchImpl, 'onedrive', 'search_files', { query: "o'brien plan" })).text).toBe('[f1] plan.docx | 100 bytes | modified 2026-10-18T10:00:00Z | https://onedrive.example/f1');
    const listed = await call(fetchImpl, 'onedrive', 'list_folder');
    expect(seen.at(-1)?.query.$orderby).toBe('lastModifiedDateTime desc');
    expect(listed.text).toContain('More results: pageToken=/me/drive/root/children?$skiptoken=z');
  });

  it('reads docx, xlsx and text as text, and gives details only for a PDF', async () => {
    const docx = zip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>']]);
    const xlsx = zip([
      ['xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Total</t></si></sst>'],
      ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Ann</t></is></c><c r="B2"><v>5</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>'],
    ]);
    const { fetchImpl } = graph({
      'GET /me/drive/items/d1': file('d1', 'brief.docx'),
      'GET /me/drive/items/d1/content': new Response(docx),
      'GET /me/drive/items/x1': file('x1', 'sales.xlsx'),
      'GET /me/drive/items/x1/content': new Response(xlsx),
      'GET /me/drive/items/t1': file('t1', 'notes.txt', { file: { mimeType: 'text/plain' } }),
      'GET /me/drive/items/t1/content': new Response('plain notes'),
      'GET /me/drive/items/p1': file('p1', 'report.pdf', { file: { mimeType: 'application/pdf' } }),
    });
    expect((await call(fetchImpl, 'onedrive', 'read_file', { fileId: 'd1' })).text).toMatch(/\n\nHello world & co\nSecond$/);
    expect((await call(fetchImpl, 'onedrive', 'read_file', { fileId: 'x1' })).text).toMatch(/\n\nName\t\tTotal\nAnn\t5\t42$/);
    expect((await call(fetchImpl, 'onedrive', 'read_file', { fileId: 't1' })).text).toMatch(/\n\nplain notes$/);
    const pdf = await call(fetchImpl, 'onedrive', 'read_file', { fileId: 'p1' });
    expect(pdf.text).toContain('Not a file this can read as text');
    expect(pdf.text).toContain('https://onedrive.example/p1');
  });
});

describe('Outlook contacts and Teams on Graph', () => {
  it('searches contacts across pages by name, email or company', async () => {
    const { fetchImpl, seen } = graph({
      'GET /me/contacts': { value: [{ displayName: 'Zed', emailAddresses: [{ address: 'zed@x.com' }] }], '@odata.nextLink': GRAPH + '/me/contacts?$skiptoken=2' },
    });
    // the second page is the same fake route: the loop must stop at the match limit or the scan cap, not run forever
    const found = await call(fetchImpl, 'microsoft-contacts', 'search_contacts', { query: 'zed@x', maxResults: 2 });
    expect(found.text).toBe('Zed | zed@x.com\nZed | zed@x.com');
    expect(seen).toHaveLength(2);
    expect((await call(fetchImpl, 'microsoft-contacts', 'search_contacts', { query: 'nobody' })).isError).toBe(false);
  });

  it('lists chats, reads chat and channel messages as text, read only', async () => {
    const msg = { createdDateTime: '2026-10-19T02:00:00Z', from: { user: { displayName: 'Cy' } }, body: { contentType: 'html', content: '<p>Lunch?</p>' } };
    const { fetchImpl, seen } = graph({
      'GET /me/chats': { value: [{ id: 'ch1', chatType: 'oneOnOne', members: [{ displayName: 'Cy' }, { displayName: 'Me' }], lastMessagePreview: { createdDateTime: '2026-10-19T02:00:00Z' } }] },
      'GET /me/chats/ch1/messages': { value: [msg] },
      'GET /me/joinedTeams': { value: [{ id: 'tm1', displayName: 'Eng' }] },
      'GET /teams/tm1/channels': { value: [{ id: 'cn1', displayName: 'General', membershipType: 'standard' }] },
      'GET /teams/tm1/channels/cn1/messages': { value: [{ ...msg, subject: 'Plan' }] },
    });
    expect((await call(fetchImpl, 'teams', 'list_chats')).text).toBe('[ch1] oneOnOne | Cy, Me | last 2026-10-19T02:00:00Z');
    expect((await call(fetchImpl, 'teams', 'get_chat_messages', { chatId: 'ch1' })).text).toBe('2026-10-19T02:00:00Z Cy: Lunch?');
    expect((await call(fetchImpl, 'teams', 'list_teams')).text).toBe('[tm1] Eng');
    expect((await call(fetchImpl, 'teams', 'list_channels', { teamId: 'tm1' })).text).toBe('[cn1] General (standard)');
    expect((await call(fetchImpl, 'teams', 'get_channel_messages', { teamId: 'tm1', channelId: 'cn1' })).text).toBe('2026-10-19T02:00:00Z Cy: [Plan] Lunch?');
    expect(seen.every((request) => request.method === 'GET')).toBe(true);
  });
});
