import type { PhoneDecision } from '../tools/phone/def.js';

/**
 * One valid call of every phone tool beyond calendar and reminders, and the decision a change puts to the owner (undefined = a
 * read). The gating test (phone-tools.test.ts) and the approval test (tool-policy.test.ts) both walk this list, and the first
 * checks that no phone tool is missing from it, so a new tool cannot ship unclassified.
 */
export const PHONE_ACCESS_CASES: ReadonlyArray<{ tool: string; args: Record<string, unknown>; decision: PhoneDecision | undefined }> = [
  { tool: 'phone_contacts_search', args: { query: 'Mei' }, decision: undefined },
  { tool: 'phone_contacts_create', args: { givenName: 'Mei', phones: ['+65 8123 4567'] }, decision: 'committing' },
  { tool: 'phone_contacts_add_detail', args: { id: 'c1', email: 'mei@example.com' }, decision: 'committing' },
  { tool: 'phone_location_current', args: { precise: false }, decision: undefined },
  { tool: 'phone_health_read', args: { metric: 'steps', from: '2026-10-01', to: '2026-10-07' }, decision: undefined },
  { tool: 'phone_photos_search', args: { from: '2026-10-01', place: 'Kyoto', limit: 5 }, decision: undefined },
  { tool: 'phone_photos_send', args: { id: 'ABC/L0/001' }, decision: 'sensitive' },
  { tool: 'phone_music_now_playing', args: {}, decision: undefined },
  { tool: 'phone_music_play', args: { query: 'Blinding Lights The Weeknd', kind: 'song' }, decision: undefined },
  { tool: 'phone_music_control', args: { action: 'pause' }, decision: undefined },
  { tool: 'phone_home_list', args: { room: 'Study' }, decision: undefined },
  { tool: 'phone_home_set', args: { accessory: 'Desk lamp', property: 'power', value: true }, decision: 'committing' },
];

/** The calendar and reminders tools, covered by their own tests since 7.13. */
export const PHONE_CALENDAR_TOOLS: readonly string[] = [
  'phone_calendar_list_calendars', 'phone_calendar_list_events', 'phone_calendar_create_event', 'phone_calendar_update_event', 'phone_calendar_delete_event',
  'phone_reminders_list', 'phone_reminders_create', 'phone_reminders_update', 'phone_reminders_delete',
];
