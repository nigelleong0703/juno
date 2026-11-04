import { describe, expect, it } from 'vitest';
import { TerminalError } from '@agent-desktop/durable';
import { ModelSelectionError, toTerminalModelError } from '../../brain/model-selection-error.js';
import type { ToolOrigin } from '../../../contracts/index.js';
import { evaluateToolPolicy, type ToolPolicyConfig } from '../services/tool-policy.js';
import { blockedReason } from '../services/task-hooks.js';
import {
  CONVERSATION_TOO_LONG, MODEL_BUSY, MODEL_NEEDS_SETTINGS, MODEL_UNREACHABLE, NO_REPLY_FAILURE, REFUSED_FAILURE, SOMETHING_WENT_WRONG,
  failureLineOf, plainProviderFailure,
} from './plain-errors.js';

describe('what a person reads when a model call fails for good', () => {
  it.each([
    ['quota', MODEL_BUSY],
    ['transient', MODEL_UNREACHABLE],
    ['auth', MODEL_NEEDS_SETTINGS],
    ['context_overflow', CONVERSATION_TOO_LONG],
    ['invalid_request', SOMETHING_WENT_WRONG],
  ] as const)('%s', (kind, sentence) => {
    expect(plainProviderFailure(kind)).toBe(sentence);
  });

  it('an account model problem (no provider, a missing or expired key, an unknown model) points at Settings; the detail rides along for the log', () => {
    const terminal = toTerminalModelError(new ModelSelectionError('provider-key-missing', 'The key for provider "x" is missing'));
    expect(terminal).toBeInstanceOf(TerminalError);
    expect(terminal?.message).toBe(MODEL_NEEDS_SETTINGS);
    expect(terminal?.metadata).toMatchObject({ code: 'provider-key-missing', detail: 'The key for provider "x" is missing' });
  });
});

describe('the line a task shows for a run that did not finish', () => {
  it('shows our own plain sentences and a blocked run\'s reason as they are, and hides anything else behind the generic sentence', () => {
    for (const sentence of [MODEL_BUSY, CONVERSATION_TOO_LONG, NO_REPLY_FAILURE, REFUSED_FAILURE]) expect(failureLineOf({ status: 'failed', error: sentence })).toBe(sentence);
    expect(failureLineOf({ status: 'blocked', error: 'run blocked: step limit reached with 1 open task(s): "send the brief"' })).toBe('run blocked: step limit reached with 1 open task(s): "send the brief"');
    // Rows stored before the mapping existed.
    expect(failureLineOf({ status: 'failed', error: 'Model quota exhausted (429): {"error":{"code":"rate_limit"}} Retry later.' })).toBe(SOMETHING_WENT_WRONG);
    expect(failureLineOf({ status: 'failed', error: 'run refused: missing_owner' })).toBe(SOMETHING_WENT_WRONG);
    expect(failureLineOf({ status: 'failed' })).toBeUndefined();
  });

  it('a task plan that cannot be read is the generic sentence, not the parse detail', () => {
    expect(blockedReason({ kind: 'unreadable', reason: 'Unexpected token } in JSON at position 41' }, 'unreadable')).toBe(SOMETHING_WENT_WRONG);
  });
});

describe('what the model is told when the policy refuses a tool', () => {
  const config = (change: Partial<ToolPolicyConfig>): ToolPolicyConfig => ({ exposed: new Set(), rules: [], plugins: [], disconnectedPluginIds: new Set(), unreadable: false, ...change });
  const origin: ToolOrigin = { connectionId: 'c1', connectionName: 'Gmail', toolName: 'send_email', title: 'Send email', access: 'action' };

  it('names the tool the way a person would, never its model-facing name', () => {
    const verdict = evaluateToolPolicy(config({ origins: new Map([['gmail_send_email_x7', origin]]) }), 'gmail_send_email_x7', undefined, {});
    expect(verdict).toMatchObject({ kind: 'deny' });
    if (verdict.kind === 'deny') {
      expect(verdict.reason).toBe('Cannot send email in Gmail: it is not turned on for this agent, so it was not run');
      expect(verdict.reason).not.toContain('gmail_send_email_x7');
    }
  });
});
