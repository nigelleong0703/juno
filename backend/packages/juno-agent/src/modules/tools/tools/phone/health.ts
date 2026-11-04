/**
 * Health data on the iPhone (HealthKit), read only. One tool: totals and averages over a date range for one metric, never raw
 * samples. There is no write tool at all. HealthKit does not tell the app which data types the owner refused, so "nothing found"
 * can also mean "not allowed in the Health app"; the phone's answer says so and the tool text tells the agent.
 */
import { z } from 'zod';
import type { PhoneToolDef } from './def.js';

export const HEALTH_METRICS = ['steps', 'active_energy', 'workouts', 'sleep', 'body_mass'] as const;

export const HEALTH_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_health_read', call: 'health.query',
    description: '',
    properties: {
      metric: { type: 'string', enum: [...HEALTH_METRICS], description: '' },
      from: { type: 'string', description: '' },
      to: { type: 'string', description: '' },
    },
    required: ['metric', 'from', 'to'],
    schema: z.object({ metric: z.enum(HEALTH_METRICS), from: z.string().min(1), to: z.string().min(1) }).strict(),
  },
];
