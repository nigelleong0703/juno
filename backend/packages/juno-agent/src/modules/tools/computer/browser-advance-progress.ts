import type { AdvanceProgressEntry } from './browser-advance-types.js';

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

export function renderProgress(progress: AdvanceProgressEntry[]): string {
  if (progress.length === 0) return '(none)';
  return progress.slice(0, 6).map((entry) => {
    const target = entry.target.slice(0, 12).map((item) => item.role + ' ' + JSON.stringify(clip(item.label, 120)) + (item.valueLabel === undefined ? '' : ' using value for ' + JSON.stringify(clip(item.valueLabel, 120)))).join('; ');
    const observed = entry.observed.slice(0, 6).map((effect) => {
      const bounded = Object.fromEntries(Object.entries(effect).map(([key, value]) => [key, typeof value === 'string' ? clip(value, 160) : value]));
      return JSON.stringify(bounded);
    }).join(', ');
    return '- ' + entry.action + ' ' + target + ' → ' + entry.result + ': ' + (observed === '' ? '(no detail)' : observed) + (entry.error === undefined ? '' : ' Error: ' + clip(entry.error, 240));
  }).join('\n');
}

export function stopMessage(reason: string): string {
  switch (reason) {
    case 'form-filled': return 'The form stage has no further eligible typing actions after the observed fill. MAIN must verify the supplied values in the latest snapshot; opening controls, submitting and comparison are separate stages.';
    case 'form-no-inputs': return 'No eligible editable field needs the supplied values in this snapshot. Fields may already match, be readonly, be sensitive or not yet observed; MAIN must inspect the full state. No native decision or fill was made.';
    case 'native-unavailable': return 'No native Jev decision was available. No further browser action was taken; MAIN should continue with ordinary browser tools.';
    case 'timeout': return 'The native Jev decision timed out. No action was taken for that decision; MAIN should verify the state and continue.';
    case 'low-confidence': return 'The native Jev choice was below the confidence gate. No further action was taken; MAIN should decide the next step.';
    case 'invalid-decision': return 'The native Jev answer did not name one of the offered observed actions. No further action was taken; MAIN should continue.';
    case 'ask-error': return 'The native Jev decision failed. No action was taken for that decision; MAIN should verify the state and continue.';
    case 'no-candidates': return 'No closed observed target was available for this goal. MAIN should read the page or choose another approach.';
    case 'observation-limit': return 'The bounded observation/decision budget was reached. Uninspected controls remain unknown, not absent. MAIN receives the full snapshot and should continue with ordinary browser tools.';
    case 'dialog': return 'A native browser dialog blocks the page. MAIN must handle it explicitly before continuing.';
    case 'done-requested': return 'Native Jev requested DONE. This is a request for MAIN to verify the latest observation, not evidence that the task succeeded.';
    case 'deferred': return 'Native Jev deferred to MAIN. No further action was taken.';
    case 'max-actions': return 'The bounded browser advancement reached its action limit. MAIN must inspect the latest state before deciding whether more work is needed.';
    case 'stalled': return 'The chosen action produced no observed change, so browser advancement stopped instead of repeating it. MAIN must re-observe and decide.';
    case 'action-error': return 'A nested browser action failed. Browser advancement stopped before the next action; MAIN should inspect the error and latest state.';
    case 'snapshot-error': return 'The browser could not provide a fresh canonical full snapshot. Browser advancement stopped; MAIN should re-observe before acting.';
    case 'suspended': return 'A nested browser action suspended the run. No later action was attempted.';
    case 'read': return 'The native browser step read the current tab. MAIN should use the page text and latest state to continue.';
    case 'blocked-repeat': return 'This browser stage previously ended without usable native progress. It was not probed again because the goal, supplied values and observed scope are unchanged.';
    default: return 'Browser advancement stopped. MAIN should verify the latest state.';
  }
}
