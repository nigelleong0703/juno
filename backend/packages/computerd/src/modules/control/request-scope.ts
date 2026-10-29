/**
 * Ties the control gateway's admissions to the HTTP request that made them. A route only calls `requireAgentControl(agent, signal, …)`;
 * the request wrapper (`transport/http.ts handle`) opens the scope, so when the request ends every admission is released, when control
 * moves and the action outlives the drain window the request's own AbortSignal fires, and a result that arrived after the change says so.
 */
import type { Admission } from './gateway.js';

interface Scope {
  abort(reason: unknown): void;
  admissions: Admission[];
}

const scopes = new WeakMap<AbortSignal, Scope>();

/** Open the scope for one request; `finish()` releases its admissions and tells whether control changed while it ran. */
export function openRequestScope(controller: AbortController): { finish(): boolean } {
  const scope: Scope = { abort: (reason) => controller.abort(reason), admissions: [] };
  scopes.set(controller.signal, scope);
  return {
    finish() {
      scopes.delete(controller.signal);
      // Every admission must be released (no short-circuit), then any one saying "changed" decides.
      return scope.admissions.map((admission) => admission.done()).some(Boolean);
    },
  };
}

/** Attach an admission to the request; false when the request has no scope (the caller then releases it at once). */
export function attachAdmission(signal: AbortSignal, admission: Admission): boolean {
  const scope = scopes.get(signal);
  if (!scope) return false;
  scope.admissions.push(admission);
  admission.signal.addEventListener('abort', () => scope.abort(admission.signal.reason), { once: true });
  return true;
}
