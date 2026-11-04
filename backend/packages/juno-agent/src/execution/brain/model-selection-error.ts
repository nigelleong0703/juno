import { TerminalError } from '@agent-desktop/durable';
import { MODEL_NEEDS_SETTINGS } from '../harness/logic/plain-errors.js';

export type ModelSelectionErrorCode =
  | 'unknown-model'
  | 'invalid-model'
  | 'unsupported-reasoning'
  | 'unverified-reasoning'
  | 'invalid-snapshot'
  | 'catalog-unavailable'
  | 'endpoint-changed'
  | 'unknown-provider'
  | 'provider-key-missing'
  | 'provider-key-unreadable'
  | 'reauth-required'
  | 'MODEL_PROVIDER_REQUIRED';

/**
 * Typed account model failure. Invalid selections and endpoint drift are permanent: the
 * run-loop and run services convert these to TerminalError so a bad selection finalizes
 * a failed run instead of retrying forever.
 */
export class ModelSelectionError extends Error {
  constructor(readonly code: ModelSelectionErrorCode, message: string) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}

/**
 * Convert a typed model failure to terminal; anything else passes through for retry. The run's error is the plain sentence (every one of these
 * is about the person's model choice or sign-in); the specific message stays in the metadata for the logs.
 */
export function toTerminalModelError(error: unknown): TerminalError | null {
  if (error instanceof ModelSelectionError) {
    return new TerminalError(MODEL_NEEDS_SETTINGS, { metadata: { code: error.code, detail: error.message } });
  }
  return null;
}
