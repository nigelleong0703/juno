/**
 * The format of ALIGNMENT_SYNTHESIS.md (the learned reply style) that the backend writes and every client reads: one definition,
 * so the prompt of an agent and the web card of that agent always show the same rules.
 *
 * Shared rules come first. A rule that applies to one agent only sits under the canonical heading `## <name>（<agentId>）`.
 * Rule lines are `- <sentence>` and may end with `[claim:<id>]` (a memory claim) and/or `[src:<itemId>]` (a message of the user):
 * the evidence the rule rests on.
 */

/** The heading line of the section written for one agent. */
export const agentSectionHeading = (name: string, agentId: string): string => '## ' + name.replace(/[\r\n]+/g, ' ').trim() + '（' + agentId + '）';

const AGENT_SECTION = /^##[ \t]+.+[（(]([^\s（）()]+)[）)][ \t]*$/;

/** The agent id of a canonical `## <name>（<agentId>）` heading line, else undefined. */
export const agentSectionId = (line: string): string | undefined => AGENT_SECTION.exec(line)?.[1];

/** A heading that says it is an agent's section by its first word (`## Agent: "Mint"`, `## Assistant Mint`, `## 助手：Mint`). */
const AGENT_NAMED = /^##[ \t]+(?:agent|assistant|助手|智能体)(?![\p{L}\p{N}])[ \t]*[:：-]?[ \t]*(.*)$/iu;

/**
 * The display name in a non-canonical agent heading (`## Agent: "Mint"` gives `Mint`, a bare `## Agent` gives the empty string),
 * or undefined when the heading is not about an agent or is canonical (it names its id).
 */
export function agentNameInHeading(line: string): string | undefined {
  if (agentSectionId(line) !== undefined) return undefined;
  const named = AGENT_NAMED.exec(line);
  return named === null ? undefined : (named[1] ?? '').trim().replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').trim();
}

/**
 * The synthesis for one agent: the shared part plus that agent's own canonical section. A section of another agent is left out,
 * and so is a section that names an agent without its id: nobody can tell whose it is, so it belongs to nobody.
 */
export function replyStyleFor(text: string, agentId: string): string {
  const kept: string[] = [];
  let keep = true;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const section = agentSectionId(line);
      keep = section === undefined ? agentNameInHeading(line) === undefined : section === agentId;
    }
    if (keep) kept.push(line);
  }
  return kept.join('\n').trim();
}

/** `[claim:<id>]` and `[src:<itemId>]`: where a rule line gets its evidence. */
const TAGS = /\s*\[(claim|src):([^\]\s]+)\]/g;

/** A rule line without its evidence tags, and the first claim id and message id they carried. */
export function splitRuleTags(line: string): { text: string; claimId?: string; sourceId?: string } {
  let claimId: string | undefined;
  let sourceId: string | undefined;
  const text = line.replace(TAGS, (_tag, kind: string, id: string) => {
    if (kind === 'claim') claimId ??= id;
    else sourceId ??= id;
    return '';
  }).trim();
  return { text, ...(claimId === undefined ? {} : { claimId }), ...(sourceId === undefined ? {} : { sourceId }) };
}

/** The tags a written rule line ends with. */
export const ruleTags = (evidence: { claimId?: string; sourceId?: string }): string =>
  (evidence.claimId === undefined ? '' : ' [claim:' + evidence.claimId + ']') + (evidence.sourceId === undefined ? '' : ' [src:' + evidence.sourceId + ']');
