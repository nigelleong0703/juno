/**
 * The agent package: the shareable part of one agent (app/reports/agent-marketplace-research.md §5.1, memory-graph design §7). It is an
 * allowlist: `buildAgentPackage` copies each field it names and never spreads a record, so a field added to a source later is not shared by
 * accident. It never carries memory, people, accounts, credentials, conversations, knowledge files, ids or targets. No route or UI uses it yet.
 */
import type { SkillDep, SkillsService } from '@agent-desktop/memory-graph/skills';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { readRows } from '../home/mirror.js';
import { agentFilePath } from '../home/paths.js';
import { splitAgentsFile } from '../home/render.js';
import { listAll } from '../memory/util.js';

export type PackageDep = { type: 'tool'; name: string } | { type: 'connector'; catalogId: string };

export interface PackageAgent {
  name: string;
  description: string;
  /** IDENTITY.md and SOUL.md, joined. */
  persona: string;
  /** AGENTS.md above its reach-out section. */
  instructions: string;
}

export interface PackageSkill {
  name: string;
  description: string;
  instructions: string;
  deps: PackageDep[];
}

export interface PackageRoutine {
  name: string;
  instructions: string;
  /** A schedule only (no targets or recipients): the time the owner set, not who it was for. */
  schedule?: { cron?: string; human: string; tz: string };
}

export interface AgentPackage {
  agent: PackageAgent;
  skills: PackageSkill[];
  routines: PackageRoutine[];
  /** Catalog ids of the connectors the skills need; the installer connects them itself. */
  connectors: string[];
}

/** What the package is built from: exactly these fields are read. */
export interface PackageSource {
  agent: { name: string; description?: string; persona?: string; instructions?: string };
  skills: Array<{ name: string; description: string; instructions: string; deps: SkillDep[] }>;
  routines: Array<{ name: string; instructions: string; schedule?: { cron?: string; human: string; tz: string } }>;
}

function packageDep(dep: SkillDep): PackageDep {
  return dep.type === 'tool' ? { type: 'tool', name: dep.name } : { type: 'connector', catalogId: dep.catalogId };
}

/** The package from its source, field by field. Pure. */
export function buildAgentPackage(source: PackageSource): AgentPackage {
  const skills = source.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    deps: skill.deps.map(packageDep),
  }));
  const connectors = [...new Set(skills.flatMap((skill) => skill.deps.flatMap((dep) => (dep.type === 'connector' ? [dep.catalogId] : []))))].sort();
  const routines = source.routines.map((routine) => ({
    name: routine.name,
    instructions: routine.instructions,
    ...(routine.schedule === undefined ? {} : { schedule: { ...(routine.schedule.cron === undefined ? {} : { cron: routine.schedule.cron }), human: routine.schedule.human, tz: routine.schedule.tz } }),
  }));
  return {
    agent: {
      name: source.agent.name,
      description: source.agent.description ?? '',
      persona: source.agent.persona ?? '',
      instructions: source.agent.instructions ?? '',
    },
    skills,
    routines,
    connectors,
  };
}

/**
 * The package of one agent of `ownerId`: its selected, active skills (scope-allowed), its schedules, and the text of its home files.
 * Null when the agent is not the owner's.
 */
export async function exportAgentPackage(deps: { store: Store; skills?: SkillsService }, ownerId: string, agentId: string): Promise<AgentPackage | null> {
  const agent = await deps.store.get('agents', agentId);
  if (agent === null || docOwner(agent) !== ownerId) return null;
  const rows = await readRows(deps.store, ownerId, agentId);
  const text = (file: string): string => rows.get(agentFilePath(agentId, file))?.content ?? '';
  const agentsFile = splitAgentsFile(text('AGENTS.md'));
  const selected = new Set(agent.skillIds);
  const views = deps.skills === undefined ? [] : await deps.skills.list(ownerId);
  const skills = views.flatMap((view) => {
    if (view.active === null || !selected.has(view.def.id)) return [];
    if (view.def.scope === 'agent' && view.def.agentId !== agentId) return [];
    return [{ name: view.active.name, description: view.active.description, instructions: view.active.instructions, deps: view.active.deps }];
  });
  const routines = (await listAll(deps.store, 'routines', { where: { agentId } })).filter((routine) => docOwner(routine) === ownerId);
  return buildAgentPackage({
    agent: {
      name: agent.name,
      ...(agent.description === undefined ? {} : { description: agent.description }),
      persona: [text('IDENTITY.md'), text('SOUL.md')].filter((part) => part.trim() !== '').join('\n\n'),
      instructions: agentsFile.instructions,
    },
    skills,
    routines: routines.map((routine) => ({
      name: routine.name,
      instructions: routine.instructions,
      ...(routine.trigger.kind !== 'schedule' ? {} : { schedule: { ...(routine.trigger.cron === undefined ? {} : { cron: routine.trigger.cron }), human: routine.trigger.human, tz: routine.trigger.tz } }),
    })),
  });
}
