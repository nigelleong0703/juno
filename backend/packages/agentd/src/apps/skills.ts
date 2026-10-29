/**
 * The how-to skills an app package ships (BACKEND 10.18) live in the platform skill store (memory-graph/skills/platform.ts, BACKEND 5.15), as rows
 * with `source = 'app:<appId>'`: versioned, with exposure and outcome counters, and improved by the same canary rules as the image's skills.
 * There is no second skill store for packs. This file maps a package's `skills` to those rows and says who may read them.
 *
 * A pack skill's row id is `app-<appId>-<skill>` and its name `<appId>/<skill>` (two apps may both ship a `triage`); `skill_read` finds it by that
 * name. Writing a package (create or edit) seeds its skills: a skill whose text is unchanged is left alone, a changed one becomes a new version
 * (the old one retired, its counters kept). A skill a later edit drops stays in the store but no longer reads as part of the package.
 */
import { createHash } from 'node:crypto';
import type { PlatformSkillFile, PlatformSkillsService, SkillReader, SourceGate } from '@agent-desktop/memory-graph/skills';
import type { AppCatalogRow, Store } from 'juno-agent/contracts';
import { agentAppSettings, usableApps } from 'juno-agent/modules/apps/agent-apps';
import type { ConnectorCatalog } from 'juno-agent/modules/mcp/catalog';
import { listAll } from 'juno-agent/modules/memory/util';
import { docOwnerId } from '../routes/relationships.js';

export const APP_SKILL_SOURCE = 'app:';

/** The platform skill files of one package: its skills, the onboarding skill first. */
export function appSkillFiles(row: Pick<AppCatalogRow, 'appId' | 'skills' | 'onboardingSkill' | 'status'>): PlatformSkillFile[] {
  if (row.status === 'retired') return [];
  const files = row.skills.map((skill): PlatformSkillFile => ({
    id: 'app-' + row.appId + '-' + skill.name,
    name: row.appId + '/' + skill.name,
    description: skill.description,
    instructions: skill.instructions,
    hash: createHash('sha256').update(JSON.stringify([skill.name, skill.description, skill.instructions])).digest('hex'),
    source: APP_SKILL_SOURCE + row.appId,
  }));
  return [...files.filter((file) => file.name.endsWith('/' + (row.onboardingSkill ?? '\0'))), ...files.filter((file) => !file.name.endsWith('/' + (row.onboardingSkill ?? '\0')))];
}

/** Seed the skills of the given packages into the platform store (a no-op for a package that ships none). */
export async function syncAppSkills(service: PlatformSkillsService, rows: readonly AppCatalogRow[]): Promise<number> {
  const files = rows.flatMap(appSkillFiles);
  if (files.length > 0) await service.seed(files);
  return files.length;
}

/**
 * Whether the reader may load a skill of this source: only an `app:<appId>` source, and only while the catalog still has the app (a retired one
 * does not) and the owner has it added, signed in and turned on for this agent: the same rule as the app's tools. `catalog` is read per call
 * (it is bound after the platform store is built at boot).
 */
export function appSkillGate(deps: { store: () => Store; catalog: () => ConnectorCatalog | undefined }): SourceGate {
  return async (source: string, reader: SkillReader): Promise<boolean> => {
    if (!source.startsWith(APP_SKILL_SOURCE)) return false;
    const appId = source.slice(APP_SKILL_SOURCE.length);
    const catalog = deps.catalog();
    if (catalog?.get(appId) === undefined && catalog?.web?.(appId) === undefined) return false;
    const store = deps.store();
    const scoped = store.forOwner?.(reader.ownerId) ?? store;
    const connections = (await listAll(scoped, 'connections')).filter((row) => docOwnerId(row) === reader.ownerId);
    return usableApps(connections, await agentAppSettings(scoped, reader.agentId)).has(appId);
  };
}
