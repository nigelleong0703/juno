/**
 * skill_read: the instructions of one skill, by name.
 *
 * The skills section lists a name and a description only, so the model never has to know where skills
 * live (a home layout, a slug, a platform directory): a selected skill's text is on its store row, and
 * a platform skill ships as SKILL.md inside the computer and is found by its directory. Unknown names
 * come back with the names that do exist instead of a path to guess at.
 */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { readSkillSelection, resolveSelectedSkills, type LoadedSkill, type SkillSource } from '../../../execution/brain/resources/skills.js';
import type { RunSkill } from '@agent-desktop/public-contracts';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';
import { recordRunSkill } from './skillExposure.js';
import { skillSource } from './skillCatalog.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { computerFailure } from '../computer/shared.js';

/** One skill body is bounded: a SKILL.md that huge is a mistake, not a manual. */
const MAX_BODY_CHARS = 20_000;
/** Where the platform ships its skills inside every computer (BACKEND 5.1). */
const PLATFORM_SKILLS_DIR = '/opt/juno/skills';

const inputSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const slugOf = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function bounded(body: string): string {
  const text = body.trim();
  return text.length <= MAX_BODY_CHARS ? text : text.slice(0, MAX_BODY_CHARS) + '\n[truncated: the skill file is longer than this tool returns]';
}

/** A skill the agent selected and may load now (active version, connectors connected): its body comes from the skill store. */
async function selectedSkill(source: SkillSource, agentId: string, name: string): Promise<LoadedSkill | undefined> {
  const selection = await readSkillSelection(source.store, agentId);
  if (selection === null) return undefined;
  const resolved = await resolveSelectedSkills(source, selection, agentId);
  return resolved.authorized.find((skill) => sameName(skill.name, name) || sameName(skill.id, name));
}

/** A platform skill: `SKILL.md` under its directory inside the computer. */
async function platformSkill(client: ComputerClient, agentId: string, name: string, signal: AbortSignal): Promise<string | undefined> {
  const slug = slugOf(name);
  if (slug === '') return undefined;
  const listing = await client.runShell(agentId, { command: 'ls -1 ' + PLATFORM_SKILLS_DIR, timeoutMs: 10_000 }, signal);
  if (listing.exitCode !== 0) return undefined;
  const dirs = listing.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (!dirs.includes(slug)) return undefined;
  const file = await client.readFile(agentId, PLATFORM_SKILLS_DIR + '/' + slug + '/SKILL.md', signal);
  return file.content;
}

/** The names this agent can read, for the error message: selected skills first, then the platform's. */
async function availableNames(source: SkillSource, agentId: string, client: ComputerClient | undefined, signal: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  const selection = await readSkillSelection(source.store, agentId);
  if (selection !== null) {
    const resolved = await resolveSelectedSkills(source, selection, agentId);
    names.push(...resolved.authorized.map((skill) => skill.name));
  }
  if (client !== undefined) {
    const listing = await client.runShell(agentId, { command: 'ls -1 ' + PLATFORM_SKILLS_DIR, timeoutMs: 10_000 }, signal).catch(() => undefined);
    if (listing !== undefined && listing.exitCode === 0) names.push(...listing.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== ''));
  }
  return names;
}

/** Exposure is bookkeeping: if it cannot be written the skill is still read. */
async function expose(ctx: ToolContext, skill: RunSkill): Promise<void> {
  try {
    await recordRunSkill(ctx.store, ctx.runId, skill);
  } catch {
    // The run document is not required to read a skill.
  }
}

export function createSkillReadTool(opts: { computer?: ComputerClientProvider; skills?: SkillsService; platformSkills?: PlatformSkillsService }): Tool {
  return {
    name: 'skill_read',
    description: '',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '' } },
      required: ['name'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments('skill_read', args, parsed.error);
      const name = parsed.data.name;
      const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
      try {
        const source = skillSource(ctx, opts.skills);
        const selected = await selectedSkill(source, ctx.agentId, name);
        if (selected !== undefined) {
          await opts.skills?.recordUse(ctx.ownerId, selected.versionId);
          await expose(ctx, { skillId: selected.id, versionId: selected.versionId });
          return { content: [{ type: 'text', text: bounded(selected.instructions) }] };
        }
        // A platform skill: the version this run is served (the active one, or the candidate for the canary share) from the platform rows.
        const served = await opts.platformSkills?.resolve(name, ctx.runId, { ownerId: ctx.ownerId, agentId: ctx.agentId });
        if (served !== null && served !== undefined) {
          await opts.platformSkills?.recordUse(served.versionId);
          await expose(ctx, { skillId: served.skillId, versionId: served.versionId, platform: true });
          return { content: [{ type: 'text', text: bounded(served.instructions) }] };
        }
        const client = opts.computer?.();
        if (client !== undefined) {
          const platform = await platformSkill(client, ctx.agentId, name, ctx.signal);
          if (platform !== undefined) return { content: [{ type: 'text', text: bounded(platform) }] };
        }
        const names = await availableNames(source, ctx.agentId, client, ctx.signal);
        return fail('Error: no skill is called ' + JSON.stringify(name) + '. Available: ' + (names.length === 0 ? 'none' : names.join(', ')) + '.');
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
