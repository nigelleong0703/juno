/** Result shaping shared by the computer tools: screenshots as image blocks and capability errors as tool errors. */

import { z } from 'zod';
import type { ToolContext, ToolResult } from '../../../contracts/index.js';
import type { Screenshot } from '../../../ports/computer/index.js';
import { NOT_CONFIGURED_PREFIX } from './client.js';
import { isComputerError } from './contract.js';
import { approvalSchema } from '../../../execution/harness/services/decision/approval-arg.js';

/** A screenshot as a tool result: the model sees the image, the run row stores the display and size. */
export function screenshotResult(result: Screenshot): ToolResult {
  const where = result.displayNo > 0 ? ` on display :${result.displayNo}` : '';
  return {
    content: [
      { type: 'text', text: `Captured screen${where} (${result.width}x${result.height})` },
      { type: 'image', mimeType: result.mimeType, data: result.data },
    ],
    details: { width: result.width, height: result.height, displayNo: result.displayNo },
  };
}

/**
 * BACKEND 8.0/8.1: the model itself says when an action needs the user's OK (it knows a click is "Place
 * order"; the click arguments do not). `approval` is the decision brief (sentence, reason, "if denied"); `confirm` is the
 * older one-sentence form and counts as just the sentence. Either one makes the policy ask first, the same approval as
 * every other tool, and the user sees the sentence on the card.
 */
export const APPROVAL_PROPERTY = {
  approval: approvalSchema(false),
  confirm: {
    type: 'string',
    description: '',
  },
};

/**
 * Every file and shell tool acts on one of the agent's two computers per call: its sandbox (the default) or the owner's Mac.
 * Policy reads the same `on` argument (a Mac call asks first, and is refused when the agent has no Mac access).
 */
export const ON_VALUES = ['sandbox', 'mac'] as const;
export const ON_SCHEMA = z.enum(ON_VALUES).optional();
export const ON_PROPERTY = {
  on: { type: 'string', enum: [...ON_VALUES], description: '' },
};

/** A short, human-readable success result whose details carry the same fields for the step row. */
export function actionResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) };
}

/**
 * Map a ComputerError onto a tool error the model can act on: a capability the sandbox does not offer, a screen the
 * user has taken over, or a refused action. An abort (or a stop that already aborted the run signal) is rethrown so
 * the run fence records an interruption instead of a tool error, and any other error falls through to the harness.
 */
export function computerFailure(error: unknown, signal?: AbortSignal): ToolResult {
  if (signal?.aborted || isAbort(error)) throw error;
  if (isComputerError(error) && error.code === 'user_control') {
    // Not a failure: the person holds, or has stopped, this surface. A neutral pause keeps the model from giving up; one text for every
    // surface and cause (BACKEND 7.8b), carrying which surface it is and who holds it.
    const surface = error.details?.['surface'] === 'mac' ? 'mac' : 'screen';
    const holder = error.details?.['holder'] === 'stopped' ? 'stopped' : error.details?.['holder'] === 'agent' ? 'agent' : 'user';
    return {
      content: [{ type: 'text', text: pausedText(surface, holder) }],
      details: { code: 'user_control', paused: true, surface, holder },
    };
  }
  if (isComputerError(error) && error.code === 'computer_recovering') {
    // Not a failure to route around: the platform is replacing the computer and retrying until it works.
    return { content: [{ type: 'text', text: COMPUTER_RECOVERING_TEXT }], details: { code: error.code, recovering: true } };
  }
  if (isComputerError(error) && error.code === 'unavailable' && !error.message.startsWith(NOT_CONFIGURED_PREFIX)) {
    // Nothing the agent can do fixes this (the platform already tried to recover the computer), and the cause text may name
    // operator-only steps: the model gets one stable instruction and the raw reason stays in the step details.
    return { content: [{ type: 'text', text: COMPUTER_UNAVAILABLE_TEXT }], isError: true, details: { code: error.code, reason: error.message } };
  }
  if (isComputerError(error)) {
    return { content: [{ type: 'text', text: `Computer: ${error.message}` }], isError: true, details: { code: error.code } };
  }
  throw error;
}

export const COMPUTER_RECOVERING_TEXT =
  'The computer is being restored and will be ready shortly (the platform is replacing it automatically; your files are safe). ' +
  'Wait a little (for example wake_at in 30 seconds) and retry the same action. Do not switch to a different method such as web_fetch for work that needs the computer.';

/** What the model reads when the computer cannot be used right now (a failure that is not a recovery in progress). */
export const COMPUTER_UNAVAILABLE_TEXT =
  'The computer is temporarily unavailable. The platform already tried to recover it automatically. ' +
  'Tell the user that your computer is having a problem and will need a moment (they can try again shortly). ' +
  'Do not silently switch to a different method such as web_fetch for work that needs the computer, and do not try to fix the computer yourself.';

/** The one "paused" result for a surface a person holds or stopped (non-error, so the run keeps living on a short wake_at). */
export function pausedText(surface: 'screen' | 'mac', holder: 'user' | 'stopped' | 'agent'): string {
  if (holder === 'agent') {
    return 'Paused: control of this screen changed hands since you last looked. Take a fresh screenshot or snapshot first, then repeat the action.';
  }
  const why = surface === 'mac' ? 'Stopped by the user on the Mac' : 'the user is in control of this screen';
  const back = surface === 'mac' ? 'they resume it on the Mac' : 'they hand control back';
  return `Paused: ${why}. Do not end the task or retry now. Call wake_at (+90s); you are woken early with a note when ${back}.`;
}

function isAbort(error: unknown): boolean {
  if (isComputerError(error)) return error.code === 'aborted';
  return error instanceof Error && error.name === 'AbortError';
}

const restartedCalls = new WeakSet<object>();

/** Record that this tool call's browser had been relaunched (the result's `restarted` flag). */
export function noteBrowserRestart(ctx: object, page: { restarted?: true }): void {
  if (page.restarted) restartedCalls.add(ctx);
}

/** Wrap a browser tool so a call served by a relaunched browser tells the model, once, in its result. */
export function withRestartNote<T extends { execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }>(tool: T): T {
  return {
    ...tool,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(args, ctx);
      if (!restartedCalls.delete(ctx)) return result;
      return { ...result, content: [...result.content, { type: 'text', text: 'Note: the browser had closed and was restarted; tabs may have reset.' }] };
    },
  };
}

const recreatedAgents = new Set<string>();
const controlChangedAgents = new Set<string>();

/** An action of this agent finished after control of its surface moved (the person may have acted): the next computer tool result says so, once. */
export function noteControlChanged(agentId: string): void {
  controlChangedAgents.add(agentId);
}

export const CONTROL_CHANGED_TEXT = 'Note: control changed during this action; inspect the current state before continuing.';

/** computerd replaced this agent's owner's computer while serving a call: the next computer tool result of that agent says so, once. */
export function noteComputerRecreated(agentId: string): void {
  recreatedAgents.add(agentId);
}

/** Wrap a computer tool so the first result after a recovery tells the model that processes and screens were reset. */
export function withRecreatedNote<T extends { execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }>(tool: T): T {
  return {
    ...tool,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(args, ctx);
      const notes = [
        ...(recreatedAgents.delete(ctx.agentId) ? ['Note: the computer was restarted on a new machine; your files are intact, but running processes and open browser tabs were reset.'] : []),
        ...(controlChangedAgents.delete(ctx.agentId) ? [CONTROL_CHANGED_TEXT] : []),
      ];
      return notes.length === 0 ? result : { ...result, content: [...result.content, ...notes.map((text) => ({ type: 'text' as const, text }))] };
    },
  };
}
