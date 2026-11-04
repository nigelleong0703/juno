import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, waitForToolActivity } from '../harness/client';
import { DECLARATION, approveNext, openPhone } from '../harness/phone';

/**
 * The newer iPhone capabilities (BACKEND 7.13b) ride the same device-call path as calendar and reminders, so this walks one
 * read and one write of the Contacts capability through the whole stack with a fake phone: the read is answered without asking,
 * the write asks the owner first and reaches the phone only after the approval, and a capability the phone did not declare is
 * refused with the words that point at Settings > iPhone access, without anything being sent.
 */
const contactsData = (action: string) => (action === 'contacts.search'
  ? [{ id: 'c-1', name: 'Mei Tan', phones: [{ label: 'mobile', number: '+65 8123 4567' }], emails: [] }]
  : { id: 'c-new', name: 'Lee Wei' });

describe('iPhone access: contacts', () => {
  it('answers a search at once and a new contact only after the owner approves it', async () => {
    const account = await createAccount('phone-contacts');
    const agent = await account.api('POST', '/v1/agents', { name: 'Helper' });
    const phone = await openPhone(account, () => 'answer', contactsData);
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('c1', 'phone_contacts_search', { query: 'Mei' })] },
        { toolCalls: [toolCall('c2', 'phone_contacts_create', { givenName: 'Lee', familyName: 'Wei', phones: ['+65 9000 1111'] })] },
        { text: 'CONTACTS-DONE' },
      ], 'find Mei, then save Lee Wei');
      const request = await approveNext(account, events, conversationId);
      expect(request.payload.brief?.categories).toEqual(['committing']);
      expect(request.payload.brief?.platform?.name).toBe('Your iPhone');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('CONTACTS-DONE'), 40_000);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 2);
      expect(activity.results.map((r) => [r.toolName, r.isError])).toEqual([['phone_contacts_search', false], ['phone_contacts_create', false]]);
      expect(activity.results[0]?.text).toContain('Mei Tan');
      expect(phone.calls.map((c) => c.action)).toEqual(['contacts.search', 'contacts.create']);
      expect(phone.calls[1]?.args).toMatchObject({ givenName: 'Lee', familyName: 'Wei', phones: ['+65 9000 1111'] });
    } finally {
      phone.close();
      events.close();
    }
  });

  it('refuses a capability the phone did not declare, naming the settings row, and sends nothing', async () => {
    const account = await createAccount('phone-contacts-off');
    const agent = await account.api('POST', '/v1/agents', { name: 'Helper' });
    const phone = await openPhone(account, () => 'answer', contactsData, { ...DECLARATION, actions: ['calendar.read'] });
    try {
      const { sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('o1', 'phone_contacts_search', { query: 'Mei' })] },
        { text: 'OFF-SEEN' },
      ], 'find Mei');
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 1);
      expect(activity.results[0]).toMatchObject({ toolName: 'phone_contacts_search', isError: true });
      expect(activity.results[0]?.text).toContain('Contacts in Juno > Settings > iPhone access');
      expect(activity.results[0]?.text).toContain('nothing was done');
      expect(phone.calls).toEqual([]);
    } finally {
      phone.close();
    }
  });
});
