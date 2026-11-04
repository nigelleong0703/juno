/**
 * Where the iPhone is (Core Location, When In Use only: the app asks for one fix when called, nothing runs in the background).
 * A read. Coarse by default; precise only when the agent asks and the owner's system setting allows it. "Remind me when I get to
 * the office" is not a tool of its own: it is `phone_reminders_create` with a `place` (a location alarm in Reminders, calendar.ts).
 */
import { z } from 'zod';
import type { PhoneToolDef } from './def.js';

export const LOCATION_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_location_current', call: 'location.current',
    description: '',
    properties: { precise: { type: 'boolean', description: '' } },
    schema: z.object({ precise: z.boolean().optional() }).strict(),
  },
];
