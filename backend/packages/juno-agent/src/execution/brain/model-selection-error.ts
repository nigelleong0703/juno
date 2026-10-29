import { TerminalError } from '@agent-desktop/durable';

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

/** Convert a typed model failure to terminal; anything else passes through for retry. */
export function toTerminalModelError(error: unknown): TerminalError | null {
  if (error instanceof ModelSelectionError) {
    return new TerminalError(error.message, { metadata: { code: error.code } });
  }
  return null;
}
