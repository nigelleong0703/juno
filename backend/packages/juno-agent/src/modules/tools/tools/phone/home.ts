/**
 * The owner's home (HomeKit) through the iPhone. Listing homes, rooms and accessories with their last known state is a read.
 * Turning an accessory on or off, or setting a brightness, a target temperature or a position, is a change and asks the owner each
 * time. Locks, garage doors, doors and security systems are never operated: the phone refuses them whatever the agent asks.
 */
import { z } from 'zod';
import type { PhoneToolDef } from './def.js';

export const HOME_PROPERTIES = ['power', 'brightness', 'target_temperature', 'target_position'] as const;

export const HOME_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_home_list', call: 'home.list',
    description: '',
    properties: { home: { type: 'string', description: '' }, room: { type: 'string', description: '' } },
    schema: z.object({ home: z.string().trim().min(1).optional(), room: z.string().trim().min(1).optional() }).strict(),
  },
  {
    name: 'phone_home_set', call: 'home.set', decision: 'committing',
    description: '',
    properties: {
      accessory: { type: 'string', description: '' },
      property: { type: 'string', enum: [...HOME_PROPERTIES], description: '' },
      value: { anyOf: [{ type: 'boolean' }, { type: 'number' }], description: '' },
      room: { type: 'string', description: '' }, home: { type: 'string', description: '' },
    },
    required: ['accessory', 'property', 'value'],
    schema: z.object({
      accessory: z.string().trim().min(1).max(200), property: z.enum(HOME_PROPERTIES), value: z.union([z.boolean(), z.number()]),
      room: z.string().trim().min(1).optional(), home: z.string().trim().min(1).optional(),
    }).strict().refine((v) => (v.property === 'power' ? typeof v.value === 'boolean' : typeof v.value === 'number'), { message: 'power takes true or false; the others take a number' }),
  },
];
