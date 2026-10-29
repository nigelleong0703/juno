import type { Doc, NativeWebSearch } from '../../../contracts/index.js';
import type { RunContext, RunServices } from './run-types.js';
import { boundedSummary } from './tool-projection.js';
import { stepAddedEvent } from './agui-events.js';
import { appendRunStep } from './run-steps.js';
import type { ReplyCitation } from './final-reply.js';

/** Steps of a turn's native searches sort after the turn's tool steps by index; the run's step list keeps the real order. */
const NATIVE_STEP_OFFSET = 500;

/**
 * Record the searches the model provider ran inside one model call as the same "Looked up <query>" step Juno's own
 * web_search produces (query in, links out), and return their sources as reply citations. The searches already happened,
 * so each step is written completed. Keyed by the model attempt, so a replay writes nothing twice.
 */
export async function recordNativeSearches(
  ctx: RunContext, services: RunServices, runId: string, stepIndex: number, attemptKey: string, searches: NativeWebSearch[], durationMs: number,
): Promise<ReplyCitation[]> {
  const citations: ReplyCitation[] = [];
  for (const [position, search] of searches.entries()) {
    const step: Doc<'steps'> = {
      id: `stp_${ctx.rand.uuidv4()}`,
      runId,
      index: stepIndex * 1000 + NATIVE_STEP_OFFSET + position,
      kind: 'mcp',
      verb: 'Looked up',
      target: search.query.slice(0, 60),
      status: 'completed',
      startedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(durationMs / searches.length)),
      input: { summary: boundedSummary({ query: search.query }) },
      output: { summary: boundedSummary(`Web search results for query: "${search.query}"\n\nLinks: ${JSON.stringify(search.sources)}`) },
    };
    await ctx.run(`native-search:${attemptKey}:${position}`, async () => {
      await services.store.put('steps', step, { runId });
      await services.store.emit(stepAddedEvent(step));
      await appendRunStep(services.store, runId, step);
    });
    for (const source of search.sources) citations.push({ id: 'web:' + source.url, title: source.title, url: source.url, source: 'web_search' });
  }
  return citations;
}
