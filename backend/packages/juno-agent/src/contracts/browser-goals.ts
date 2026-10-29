/** Internal orchestration state, never a frontend document. */
import { z } from 'zod';

const matchSchema = z.object({
  label: z.string().min(1).max(79).optional(),
  text: z.string().min(1).max(79).optional(), placeholder: z.string().min(1).max(59).optional(),
  name: z.string().min(1).max(79).optional(), frame: z.string().min(1).max(240).optional(),
}).strict().refine(m => !!(m.label || m.text || m.placeholder || m.name), 'Identify a control by observed text, label, placeholder or name; indexes/refs are not stable conditions');
export const browserCompletionSchema = z.array(z.object({
  match: matchSchema,
  property: z.enum(['count', 'value', 'checked', 'expanded', 'disabled']),
  equals: z.union([z.string().max(200), z.number().int().min(0).max(10000), z.boolean()]),
}).strict().refine(c => c.property === 'count' ? typeof c.equals === 'number' : c.property === 'value' ? typeof c.equals === 'string' : typeof c.equals === 'boolean', 'Use a number for count, string for value, boolean for control state')).min(1).max(8);
export type BrowserCompletion = z.infer<typeof browserCompletionSchema>;
export interface BrowserVerification {
  passed: boolean;
  conditions: Array<{ condition: BrowserCompletion[number]; passed: boolean; reason: string; observed?: string | number | boolean }>;
}
export interface BrowserGoalGate {
  id: string; ownerId: string; agentId: string; conversationId: string; runId: string;
  stageId: string; goal: string; completion: BrowserCompletion;
  on: 'sandbox' | 'mac'; tab?: string;
  status: 'pending' | 'verified' | 'abandoned';
  verification?: BrowserVerification; reason?: string; updatedAt: string;
}
