import { z } from 'zod';
import type { HarnessId } from '../../../modules/harness/ids/index.js';
import { harnessText } from '../../../modules/harness/loader.js';

/** The bound computer facts the run context may name. Structural on purpose: the brain never
 * imports the sandbox client or HTTP code; whoever runs the loop injects the lookup. */
export interface RunComputerEnvironment {
  os: string;
  platform: string;
  user: string;
  home: string;
  workingDirectory: string;
  /** `mac` when the agent works on the owner's own Mac (My Mac). */
  kind?: string;
  /** A Mac only: the name and OS it declared, and the actions it says work right now. */
  device?: { name: string; osVersion: string; actions: string[] };
}

const runComputerEnvironmentSchema = z.object({
  os: z.string().min(1),
  platform: z.string().min(1),
  user: z.string().min(1),
  home: z.string().min(1),
  workingDirectory: z.string().min(1),
  kind: z.string().optional(),
  device: z.object({ name: z.string(), osVersion: z.string(), actions: z.array(z.string()) }).optional(),
});

/** Every action a Mac can declare, with what it means for the model's calls (the Mac lists only what the user has granted). */
const MAC_ACTIONS: Record<string, HarnessId> = {
  files: 'computer.action.files',
  shell: 'computer.action.shell',
  desktop: 'computer.action.desktop',
  browser: 'computer.action.browser',
  audio: 'computer.action.audio',
  apps: 'computer.action.apps',
};

/** What the Mac declared it can do right now, and what it did not (not granted on the Mac: a call for it is refused). */
function declaredActions(device: NonNullable<RunComputerEnvironment['device']>): string {
  const missing = Object.keys(MAC_ACTIONS).filter((action) => !device.actions.includes(action));
  const meaning = (action: string): string => {
    const unit = MAC_ACTIONS[action];
    return unit === undefined ? action : harnessText(unit);
  };
  const can = device.actions.map((action) => action + ' (' + meaning(action) + ')').join(', ');
  return ' ' + harnessText('computer.mac.declares', { name: JSON.stringify(device.name), osVersion: device.osVersion, actions: can === '' ? harnessText('computer.mac.none') : can })
    + (missing.length === 0 ? '' : ' ' + harnessText('computer.mac.missing', { missing: missing.join(', ') }));
}

/** Optional per-run lookup, injected by whoever runs the loop (the runner). `on: 'mac'` asks for the owner's Mac. */
export type ComputerEnvironmentSource = (agentId: string, on?: 'mac') => Promise<RunComputerEnvironment | null>;

/** What the model reads about one computer: its facts, or why they are not available. */
export type RunComputerEnvironmentView = RunComputerEnvironment | { unavailable: string } | { notStarted: true };

async function describeComputer(agentId: string, source: ComputerEnvironmentSource, on: 'mac' | undefined): Promise<RunComputerEnvironmentView> {
  try {
    const found = await source(agentId, on);
    if (!found) return { unavailable: harnessText(on === 'mac' ? 'computer.unavailable.mac' : 'computer.unavailable.sandbox') };
    return runComputerEnvironmentSchema.parse(found);
  } catch (error) {
    // The owner's computer is bound but this agent has no screen yet: the first computer/browser tool call starts it
    // (this context read stays read-only), so say that instead of claiming the sandbox is unavailable.
    if (on === undefined && error instanceof Error && 'code' in error && error.code === 'no_screen') return { notStarted: true };
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

const facts = (env: RunComputerEnvironment): string =>
  harnessText('computer.facts', {
    workingDirectory: JSON.stringify(env.workingDirectory),
    user: JSON.stringify(env.user),
    home: JSON.stringify(env.home),
    os: JSON.stringify(env.os),
    platform: JSON.stringify(env.platform),
  });

/**
 * The live state of the agent's computers, as its own section: a paused sandbox, a recreated one or a
 * Mac that just connected changes only this. The rules for working on them are static and live in
 * `buildComputerRules`, so a state change never re-sends them.
 */
export async function buildComputerFacts(
  agentId: string,
  source: ComputerEnvironmentSource | undefined,
  macAccess = false,
): Promise<string> {
  if (!source) return '';
  const sandbox = await describeComputer(agentId, source, undefined);
  const mac = macAccess ? await describeComputer(agentId, source, 'mac') : undefined;
  const sandboxLine = 'notStarted' in sandbox
    ? harnessText('computer.sandbox.not_started') + '\n'
    : 'unavailable' in sandbox
      ? harnessText('computer.sandbox.unavailable', { reason: sandbox.unavailable }) + '\n'
      : harnessText('computer.sandbox.facts', { facts: facts(sandbox) }) + '\n';
  const macLine = mac === undefined ? '' : (
    'notStarted' in mac ? '' // only the sandbox read can be "not started"
    : 'unavailable' in mac
      ? harnessText('computer.mac.unavailable', { reason: mac.unavailable }) + '\n'
      : harnessText('computer.mac.facts', { facts: facts(mac), actions: mac.device === undefined ? '' : declaredActions(mac.device) }) + '\n'
  );
  return harnessText('computer.heading') + '\n' + sandboxLine + macLine;
}

/**
 * How to work on those computers: static, so it is sent once and then cached, and a state change in
 * `buildComputerFacts` does not drag it along. Only rendered while a computer exists (the caller
 * decides, from whether a computer source is injected).
 */
export function buildComputerRules(macAccess = false): string {
  const choosing = macAccess ? harnessText('computer.rules.mac_choosing') + '\n' : '';
  return (
    harnessText('computer.rules.heading') + '\n' +
    choosing +
    harnessText('computer.rules.details') + '\n' +
    harnessText('computer.rules.browser_pages') + '\n' +
    harnessText('computer.rules.unexpected') + '\n' +
    harnessText('computer.rules.errands') + '\n' +
    harnessText('computer.rules.checkout')
  );
}

/** Facts and rules together, for a caller that wants the whole section in one string. */
export async function buildComputerSection(
  agentId: string,
  source: ComputerEnvironmentSource | undefined,
  macAccess = false,
): Promise<string> {
  const factsText = await buildComputerFacts(agentId, source, macAccess);
  if (factsText === '') return '';
  return factsText + buildComputerRules(macAccess);
}
