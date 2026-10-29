/** Outlook contacts on Microsoft Graph (`/me/contacts`, `Contacts.ReadWrite`): search by name, email or company, read one, add one. */
import { str, type HostedTool } from '../google/shared.js';
import { none, rows, nextToken } from './shared.js';

export const CONTACTS_SCOPES = ['Contacts.ReadWrite', 'offline_access'];
const FIELDS = 'id,displayName,emailAddresses,mobilePhone,businessPhones,homePhones,companyName,jobTitle';
/** Graph cannot search contacts server-side across fields, so pages are read and matched here, up to this many contacts. */
const SCAN_LIMIT = 1000;

export const CONTACTS_TOOLS: HostedTool[] = [
  {
    name: 'search_contacts',
    title: 'Search contacts',
    description: "Find people in the owner's Outlook contacts by name, email address, company or phone number; without a query, lists the first contacts.",
    properties: { query: { type: 'string', description: 'Part of a name, email, company or number.' }, maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results (default 10).' } },
    run: async (api, args) => {
      const query = str(args.query)?.toLowerCase();
      const limit = typeof args.maxResults === 'number' ? Math.min(50, Math.max(1, Math.trunc(args.maxResults))) : 10;
      const matches: string[] = [];
      let scanned = 0;
      let body = await api('/me/contacts', { $top: '100', $select: FIELDS, $orderby: 'displayName' });
      for (;;) {
        for (const contact of rows(body)) {
          scanned += 1;
          const emails = Array.isArray(contact.emailAddresses) ? (contact.emailAddresses as Record<string, unknown>[]).map((entry) => String(entry.address)) : [];
          const phones = [contact.mobilePhone, ...(Array.isArray(contact.businessPhones) ? contact.businessPhones : []), ...(Array.isArray(contact.homePhones) ? contact.homePhones : [])].filter((phone): phone is string => typeof phone === 'string' && phone !== '');
          const text = [String(contact.displayName ?? ''), String(contact.companyName ?? ''), ...emails, ...phones].join('\n').toLowerCase();
          if (query === undefined || text.includes(query)) {
            matches.push([String(contact.displayName ?? '(no name)'), emails.join(', '), phones.join(', '), [contact.jobTitle, contact.companyName].filter((part) => typeof part === 'string' && part !== '').join(' at ')].filter((part) => part !== '').join(' | '));
          }
        }
        const next = nextToken(body);
        if (matches.length >= limit || next === undefined || scanned >= SCAN_LIMIT) break;
        body = await api(next);
      }
      return matches.length === 0 ? none('matching contacts') : matches.slice(0, limit).join('\n');
    },
  },
  {
    name: 'get_contact',
    title: 'Read a contact',
    description: 'All details of one contact: emails, phones, company, job title, address and notes.',
    properties: { contactId: { type: 'string', description: 'Contact id from search_contacts.' } },
    required: ['contactId'],
    run: async (api, args) => {
      const contact = await api('/me/contacts/' + encodeURIComponent(str(args.contactId) ?? ''), { $select: FIELDS + ',homeAddress,businessAddress,personalNotes,birthday' });
      const address = (value: unknown) => (typeof value === 'object' && value !== null ? ['street', 'city', 'state', 'postalCode', 'countryOrRegion'].map((key) => Reflect.get(value, key)).filter((part) => typeof part === 'string' && part !== '').join(', ') : '');
      const emails = Array.isArray(contact.emailAddresses) ? (contact.emailAddresses as Record<string, unknown>[]).map((entry) => String(entry.address)) : [];
      return [
        String(contact.displayName ?? '(no name)') + ' [' + String(contact.id) + ']',
        ...(emails.length > 0 ? ['Email: ' + emails.join(', ')] : []),
        ...[['Mobile', contact.mobilePhone], ['Work phone', Array.isArray(contact.businessPhones) ? contact.businessPhones.join(', ') : ''], ['Home phone', Array.isArray(contact.homePhones) ? contact.homePhones.join(', ') : ''], ['Company', contact.companyName], ['Job title', contact.jobTitle], ['Home address', address(contact.homeAddress)], ['Work address', address(contact.businessAddress)], ['Birthday', contact.birthday], ['Notes', contact.personalNotes]]
          .filter(([, value]) => typeof value === 'string' && value !== '').map(([label, value]) => label + ': ' + String(value)),
      ].join('\n');
    },
  },
  {
    name: 'create_contact',
    title: 'Add a contact',
    description: 'Add a person to the owner\'s Outlook contacts.',
    properties: {
      name: { type: 'string', description: 'Full name.' },
      email: { type: 'string', description: 'Email address.' },
      mobilePhone: { type: 'string', description: 'Mobile number.' },
      companyName: { type: 'string', description: 'Company.' },
      jobTitle: { type: 'string', description: 'Job title.' },
      notes: { type: 'string', description: 'Notes about the person.' },
    },
    required: ['name'],
    writes: true,
    run: async (api, args) => {
      const email = str(args.email);
      const contact = await api('/me/contacts', {}, {
        method: 'POST',
        body: {
          displayName: str(args.name),
          ...(email === undefined ? {} : { emailAddresses: [{ address: email, name: str(args.name) }] }),
          ...(str(args.mobilePhone) === undefined ? {} : { mobilePhone: str(args.mobilePhone) }),
          ...(str(args.companyName) === undefined ? {} : { companyName: str(args.companyName) }),
          ...(str(args.jobTitle) === undefined ? {} : { jobTitle: str(args.jobTitle) }),
          ...(str(args.notes) === undefined ? {} : { personalNotes: str(args.notes) }),
        },
      });
      return 'Contact added. Id: ' + String(contact.id);
    },
  },
];
