/**
 * Where one outer step's wall time goes: the model call, the tools, and our own harness work
 * (context rebuild, store writes, budget charges), with the rest being Restate journaling and
 * waits that run outside any action (inbox drain, cancel peek). Only actions that really execute
 * are timed, so a replayed step (no action runs) logs nothing.
 */
import type { RunContext, RunServices } from './run-types.js';

const kindOf = (name: string): 'model' | 'tool' | 'harness' =>
  name.startsWith('model:') ? 'model' : name.startsWith('tool:') ? 'tool' : 'harness';

export interface StepTimer {
  /** The step's context: identical, except every `run` action is timed. */
  ctx: RunContext;
  /** Log one `step timing` line when the step really ran its model call. */
  report(log: RunServices['log'], fields: Record<string, unknown>): void;
}

export function createStepTimer(ctx: RunContext): StepTimer {
  const started = Date.now();
  const totals = { model: 0, tool: 0, harness: 0 };
  const harness = new Map<string, number>();
  let actions = 0;
  let modelCalls = 0;
  const timed: RunContext = {
    ...ctx,
    run: (name, action) => ctx.run(name, async () => {
      const at = Date.now();
      try {
        return await action();
      } finally {
        const ms = Date.now() - at;
        const kind = kindOf(name);
        totals[kind] += ms;
        actions += 1;
        if (kind === 'model') modelCalls += 1;
        if (kind === 'harness') {
          // Group per-step names (`context:3`, `turn:3`, `step:<id>:fence`) by their first segment.
          const label = name.split(':')[0] ?? name;
          harness.set(label, (harness.get(label) ?? 0) + ms);
        }
      }
    }),
  };
  return {
    ctx: timed,
    report(log, fields) {
      if (log === undefined || modelCalls === 0) return;
      const wallMs = Date.now() - started;
      const slowest = [...harness.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, ms]) => `${label}=${String(ms)}`);
      log({
        ...fields,
        wallMs,
        modelMs: totals.model,
        toolMs: totals.tool,
        harnessMs: totals.harness,
        // Journal round trips, inbox drain, cancel peeks and plain JS between actions.
        otherMs: Math.max(0, wallMs - totals.model - totals.tool - totals.harness),
        actions,
        modelCalls,
        harnessTop: slowest.join(' '),
      }, 'step timing');
    },
  };
}
