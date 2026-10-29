/**
 * Map computerd HTTP statuses and error bodies onto the stable ComputerError codes the tools already understand, so a
 * user takeover, a missing screen and a refused action all reach the model as a distinct, actionable reason.
 */

import { ComputerError, type ComputerErrorCode } from '../../../modules/tools/index.js';
import { isRecord } from './codec.js';

const KNOWN_CODES: readonly ComputerErrorCode[] = [
  'unavailable',
  'no_screen',
  'user_control',
  'not_allowed',
  'aborted',
  'home_conflict',
  'computer_recovering',
  'failed',
];

function isKnownCode(code: string): code is ComputerErrorCode {
  return KNOWN_CODES.some((known) => known === code);
}

export function codeForStatus(status: number): ComputerErrorCode {
  if (status === 401 || status === 403) return 'not_allowed';
  if (status === 409) return 'user_control';
  if (status === 404) return 'no_screen';
  if (status === 408 || status === 499) return 'aborted';
  if (status === 503) return 'unavailable';
  return 'failed';
}

/** Keep the server's code when it is one we know; otherwise derive one from the status. */
export function toComputerError(status: number, body: unknown, path: string): ComputerError {
  const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : undefined;
  const message = isRecord(body) && typeof body['message'] === 'string' ? body['message'] : undefined;
  const resolved = code && isKnownCode(code) ? code : codeForStatus(status);
  // A refusal by user control names the surface and who holds it (screen|mac, user|stopped|agent), so the model's text can say which.
  const details = resolved === 'user_control' && isRecord(body)
    ? Object.fromEntries(['surface', 'holder', 'reason'].flatMap((key) => (typeof body[key] === 'string' ? [[key, body[key]]] : [])))
    : undefined;
  return new ComputerError(resolved, message ?? `computerd ${status} for ${path}`, details);
}
