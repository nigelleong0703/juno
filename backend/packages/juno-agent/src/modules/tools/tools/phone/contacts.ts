/**
 * Contacts on the iPhone (Contacts framework). Searching is a read. Adding a contact, or a phone number or email to one, asks the
 * owner (committing). Nothing here changes what the agent knows about people: a match is only shown to the agent, which may use it
 * and may tell the owner; the person memory is never merged with a contact automatically.
 */
import { z } from 'zod';
import { cap, type PhoneToolDef } from './def.js';

const list = (max: number) => z.array(z.string().trim().min(3).max(120)).max(max).optional();

export const CONTACTS_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_contacts_search', call: 'contacts.search',
    description: '',
    properties: { query: { type: 'string', description: '' }, limit: { type: 'number', description: '' } },
    required: ['query'], schema: z.object({ query: z.string().trim().min(2).max(120), limit: cap(20) }).strict(),
  },
  {
    name: 'phone_contacts_create', call: 'contacts.create', decision: 'committing',
    description: '',
    properties: {
      givenName: { type: 'string' }, familyName: { type: 'string' }, organization: { type: 'string' },
      phones: { type: 'array', items: { type: 'string' }, description: '' },
      emails: { type: 'array', items: { type: 'string' }, description: '' },
    },
    schema: z.object({
      givenName: z.string().trim().min(1).max(100).optional(), familyName: z.string().trim().min(1).max(100).optional(), organization: z.string().trim().min(1).max(120).optional(),
      phones: list(5), emails: list(5),
    }).strict().refine((value) => value.givenName !== undefined || value.familyName !== undefined || value.organization !== undefined, { message: 'a name or an organization is needed' }),
  },
  {
    name: 'phone_contacts_add_detail', call: 'contacts.add_detail', decision: 'committing',
    description: '',
    properties: { id: { type: 'string', description: '' }, phone: { type: 'string' }, email: { type: 'string' } },
    required: ['id'],
    schema: z.object({ id: z.string().min(1), phone: z.string().trim().min(3).max(60).optional(), email: z.string().trim().min(3).max(120).optional() }).strict()
      .refine((value) => value.phone !== undefined || value.email !== undefined, { message: 'a phone or an email is needed' }),
  },
];
