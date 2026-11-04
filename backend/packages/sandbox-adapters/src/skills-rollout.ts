/**
 * Keeps every computer on the server's platform skills bundle (BACKEND §5.11b). One per computerd process, shared by the providers
 * (a new computer, a resume) and by the link hub's link-up hook (computerd restarted after a deploy and the computers redialled).
 * It remembers per link which version it last saw, so a computer already on the current version costs nothing; concurrent asks for
 * the same computer share one run. It never throws: a failure is logged and the next ask tries again.
 */
import { createLinkRuntime } from './link-runtime.js';
import type { LinkHub } from './link-hub.js';
import type { SkillsBundle } from './skills-bundle.js';
import { syncPlatformSkills } from './skills-sync.js';

const SYNC_BUDGET_MS = 120_000;

export interface SkillsRolloutReport {
  /** The version the server holds now. */
  bundle: string;
  /** Every computer this process has looked at since it started, with the version it was last seen on. */
  computers: Array<{ linkId: string; version: string; at: string }>;
}

export interface SkillsRollout {
  /**
   * Bring the computer behind `linkId` to the bundle (waits for its link). `label` names it in the log. Resolves when done or failed.
   * A computer already seen on the current version is skipped without any call, unless `verify` (a link coming up) asks to read its marker again.
   */
  ensure(linkId: string, label: string, options?: { verify?: boolean }): Promise<void>;
  report(): Promise<SkillsRolloutReport>;
}

export interface SkillsRolloutOptions {
  hub: LinkHub;
  bundle: () => Promise<SkillsBundle>;
  /** Where the computer keeps the skills (tests only). */
  dir?: string;
  log: (fields: Record<string, unknown>, message: string) => void;
}

export function createSkillsRollout(options: SkillsRolloutOptions): SkillsRollout {
  const seen = new Map<string, { version: string; at: string }>();
  const running = new Map<string, Promise<void>>();

  async function run(linkId: string, label: string, verify: boolean): Promise<void> {
    const signal = AbortSignal.timeout(SYNC_BUDGET_MS);
    try {
      const bundle = await options.bundle();
      if (!verify && seen.get(linkId)?.version === bundle.version) return;
      const root = createLinkRuntime({ hub: options.hub, linkId, signal });
      const result = await syncPlatformSkills(root, bundle, { signal, ...(options.dir === undefined ? {} : { dir: options.dir }) });
      seen.set(linkId, { version: bundle.version, at: new Date().toISOString() });
      const short = (version: string | undefined) => (version ?? 'none').slice(0, 12);
      if (result.changed) options.log({ computer: label, from: short(result.previous), to: short(bundle.version) }, `skills synced ${short(result.previous)}→${short(bundle.version)}`);
      else options.log({ computer: label, version: short(bundle.version) }, `skills current ${short(bundle.version)}`);
      if (result.requirementsChanged) options.log({ computer: label }, 'the skills\' Python requirements changed: the template must be rebuilt to install them');
    } catch (error) {
      options.log({ err: error, computer: label }, 'skills could not be synced; retried at the next look');
    }
  }

  return {
    ensure(linkId, label, ensureOptions) {
      let current = running.get(linkId);
      if (current === undefined) {
        current = run(linkId, label, ensureOptions?.verify === true).finally(() => running.delete(linkId));
        running.set(linkId, current);
      }
      return current;
    },
    async report() {
      return { bundle: (await options.bundle()).version, computers: [...seen].map(([linkId, value]) => ({ linkId, ...value })) };
    },
  };
}
