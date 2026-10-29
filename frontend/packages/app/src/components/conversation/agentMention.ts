import type { Agent } from "@agent-desktop/client";
import { type MessageResponseProps, defaultRemarkPlugins } from "@agent-desktop/ui";
import type { ComponentType, ReactElement } from "react";
import { ResolvedMention } from "./MentionText";

/**
 * Agent prose (@handle) mention presentation (CX-agent-mentions).
 *
 * An agent writes `@patch` in its Markdown reply. We only rewrite a handle that is a *known*
 * and *unambiguous* one from the workspace roster: exactly one agent owns that handle. The
 * rewrite happens on the parsed Markdown AST, so code spans/fences, links, email addresses and
 * raw text are never touched and the source string is never blindly rewritten. The custom tag
 * this pass emits is rendered by the app's existing `ResolvedMention` (tiny avatar + name +
 * identity popover whose Message action opens the canonical agent).
 */

/** Tag name and attribute the Markdown pass emits; also whitelisted through Streamdown's sanitizer. */
export const AGENT_MENTION_TAG = "agentmention";
export const AGENT_MENTION_ATTRIBUTE = "data-agent-id";

/**
 * `rehype-raw` re-parses the tree through parse5, which camel-cases the hast property to
 * `dataAgentId`; sanitizing then drops any name missing from this whitelist. List both spellings
 * so the attribute survives whichever pass produced it. The React prop stays `data-agent-id`.
 */
export const AGENT_MENTION_HAST_PROPERTY = "dataAgentId";

export const agentMentionAllowedTags: NonNullable<MessageResponseProps["allowedTags"]> = {
  [AGENT_MENTION_TAG]: [AGENT_MENTION_HAST_PROPERTY, AGENT_MENTION_ATTRIBUTE],
};

/** Minimal mdast shape: enough to walk text without importing `unified`/`mdast` types. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

export interface AgentMentionRoster {
  /** Lowercased handle -> the single agent that owns it; ambiguous handles are omitted. */
  byHandle: Map<string, Agent>;
  /** Canonical agent id -> agent, for the renderer. */
  byId: Map<string, Agent>;
  /** Changes whenever a mentioned agent's identity/name/handle changes. */
  revision: string;
}

const EMPTY_ROSTER: AgentMentionRoster = { byHandle: new Map(), byId: new Map(), revision: "" };

/** Containers whose text must never be reinterpreted as a mention. */
const OPAQUE_NODES = new Set([
  "inlineCode",
  "code",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "html",
  "definition",
  "yaml",
  "toml",
]);

export function buildAgentMentionRoster(agents: Agent[] | undefined): AgentMentionRoster {
  if (!agents || agents.length === 0) return EMPTY_ROSTER;
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = agent.handle.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(agent);
    else groups.set(key, [agent]);
  }
  const byHandle = new Map<string, Agent>();
  for (const [key, group] of groups) {
    const only = group[0];
    if (group.length === 1 && only) byHandle.set(key, only);
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
  const revision = agents
    .map((agent) => [agent.id, agent.handle, agent.name, JSON.stringify(agent.avatar)].join("\u0000"))
    .sort()
    .join("\u0001");
  return { byHandle, byId, revision };
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function handlePattern(handles: Iterable<string>): RegExp {
  const alternatives = [...handles].sort((a, b) => b.length - a.length).map(escapePattern);
  return new RegExp("@(" + alternatives.join("|") + ")", "giu");
}

/** Word/email/URL fragments cannot start a mention; a sentence-ending dot still can. */
function isMentionBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  if (/[\p{L}\p{N}_.@/\\:+-]/u.test(before)) return false;
  if (/[\p{L}\p{N}_@-]/u.test(after)) return false;
  if (after === "." && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? "")) return false;
  return true;
}

/** Split one text node into text/mention parts, or `null` when nothing resolves. */
function splitTextNode(node: MdNode, roster: AgentMentionRoster, pattern: RegExp): MdNode[] | null {
  const text = node.value ?? "";
  const parts: MdNode[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const handle = match[1];
    const start = match.index;
    if (handle === undefined || start === undefined) continue;
    const end = start + match[0].length;
    if (!isMentionBoundary(text, start, end)) continue;
    const agent = roster.byHandle.get(handle.toLowerCase());
    if (!agent) continue;
    if (start > cursor) parts.push({ type: "text", value: text.slice(cursor, start) });
    parts.push({
      type: "agentMention",
      data: { hName: AGENT_MENTION_TAG, hProperties: { [AGENT_MENTION_ATTRIBUTE]: agent.id } },
    });
    cursor = end;
  }
  if (parts.length === 0) return null;
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}

/** Walk phrasing containers, replacing known handles; returns new children or `null` when unchanged. */
function transformChildren(node: MdNode, roster: AgentMentionRoster, pattern: RegExp): MdNode[] | null {
  const children = node.children;
  if (!children) return null;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === "text") {
      const replaced = splitTextNode(child, roster, pattern);
      if (replaced) {
        next.push(...replaced);
        changed = true;
        continue;
      }
      next.push(child);
      continue;
    }
    if (OPAQUE_NODES.has(child.type)) {
      next.push(child);
      continue;
    }
    const replacedChildren = transformChildren(child, roster, pattern);
    if (replacedChildren) {
      next.push({ ...child, children: replacedChildren });
      changed = true;
      continue;
    }
    next.push(child);
  }
  return changed ? next : null;
}

/** Remark plugin: rewrite known unique handles in text nodes only (AST-aware, source untouched). */
export function agentMentionRemark(roster: AgentMentionRoster) {
  return () => (tree: MdNode): MdNode => {
    if (roster.byHandle.size === 0) return tree;
    const children = transformChildren(tree, roster, handlePattern(roster.byHandle.keys()));
    return children ? { ...tree, children } : tree;
  };
}

/**
 * The remark list to hand Streamdown: its defaults (Streamdown *replaces* the list when
 * `remarkPlugins` is set) plus the mention pass. Streamdown caches one unified processor per
 * plugin signature and the signature is built from each plugin's name/options — an anonymous
 * plugin shares one cache entry across rosters. The serializable options tie the cached
 * processor to a specific roster revision so a changed roster is not served a stale pass.
 */
export function agentMentionRemarkPlugins(
  roster: AgentMentionRoster,
): NonNullable<MessageResponseProps["remarkPlugins"]> {
  return [
    ...Object.values(defaultRemarkPlugins),
    [agentMentionRemark(roster), { agentMentionRoster: roster.revision }],
  ];
}

type MentionElementProps = Record<string, unknown> & { node?: unknown };

/** Streamdown `components` entry that renders an emitted mention through `ResolvedMention`. */
export function agentMentionComponents(
  roster: AgentMentionRoster,
  onOpenAgent?: (agentId: string) => void,
): NonNullable<MessageResponseProps["components"]> {
  const MentionTag: ComponentType<MentionElementProps> = (props): ReactElement | null => {
    const id = props[AGENT_MENTION_ATTRIBUTE];
    const agent = typeof id === "string" ? roster.byId.get(id) : undefined;
    if (!agent) return null;
    return ResolvedMention({ agent, onOpenAgent });
  };
  return { [AGENT_MENTION_TAG]: MentionTag };
}
