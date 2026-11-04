/**
 * How one `phone_*` tool is described (BACKEND 7.13). Each capability of the iPhone keeps its tools in its own file as a list of
 * these; `phoneTools.ts` turns the lists into tools. A tool only names the call: the app does the work, the declaration the app
 * made decides whether it is sent, and `decision` is what the owner is asked about before a change (absent = a read, never asked).
 */
import { z } from 'zod';
import type { PhoneCallAction } from '@agent-desktop/public-contracts';
import type { ToolContext, ToolResult } from '../../../../contracts/index.js';

/** The kind of decision a change puts to the owner (the decision brief's categories, BACKEND 8.1). */
export type PhoneDecision = 'committing' | 'irreversible' | 'sensitive';

export interface PhoneToolDef {
  name: string;
  call: PhoneCallAction;
  /** Always `''`: the text is a harness unit (`harness/tool/<name>.md`). */
  description: '';
  properties: Record<string, unknown>;
  required?: string[];
  schema: z.ZodType<Record<string, unknown>>;
  /** Present for every tool that changes something (or sends something private off the phone): policy asks first. */
  decision?: PhoneDecision;
  /** A change that is low-stakes and easy to undo (the owner's own music or reminders): it is run without asking, but it still is a change (never replayed, a lost answer is reported as "may have been applied"). */
  changes?: true;
  /** A decision stricter than `decision` for these arguments (a whole repeating series, say). */
  stricter?: (args: Record<string, unknown>) => PhoneDecision | undefined;
  /** Turns the phone's answer into the tool result when plain text is not enough (a photo that must reach the chat). */
  present?: (data: unknown, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** An optional whole number between 1 and `max`. */
export const cap = (max: number) => z.number().int().positive().max(max).optional();
