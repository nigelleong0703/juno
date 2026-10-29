import type { Agent, Conversation } from "@agent-desktop/client";
import type { ReactElement } from "react";
import { Button, cn } from "@agent-desktop/ui";
import { Link } from "react-router";
import { useAuthIdentity } from "../../auth/AuthContext";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useRuns } from "../../data/queries";
import { CHARACTER_TINT, agentCharacter } from "../../lib/avatars";
import { resolveDoingLine } from "../../lib/doingLine";

/**
 * Pieces of the Today landing that continue a conversation: the account's first name, the glow
 * behind the top of the page, and "Continue with <latest chat>" plus up to two recent chats.
 * Real data only; nothing is created here.
 */
export const RETURNING_WELCOME_COPY = {
  continueLatest: "Continue with {name}",
  recentChats: "Recent chats",
  directChat: "Direct chat",
  groupChat: "Group chat",
  untitledChat: "Untitled chat",
} as const;

interface ReturningWelcomeProps {
  /** Own direct/room conversations, newest first. Never task/peer threads. */
  conversations: Conversation[];
  /** The account's actual agents as start-chat links. */
  agents: Agent[];
}

function conversationLabel(conversation: Conversation, agentById: Map<string, Agent>): string {
  const title = conversation.title?.trim();
  if (title) return title;
  const names: string[] = [];
  for (const id of conversation.agentIds) {
    const agent = agentById.get(id);
    if (agent) names.push(agent.name);
  }
  if (names.length > 0) return names.join(", ");
  return RETURNING_WELCOME_COPY.untitledChat;
}

function conversationKindLabel(kind: Conversation["kind"]): string {
  return kind === "room" ? RETURNING_WELCOME_COPY.groupChat : RETURNING_WELCOME_COPY.directChat;
}

function ConversationAvatars({
  conversation,
  agentById,
}: {
  conversation: Conversation;
  agentById: Map<string, Agent>;
}): ReactElement | null {
  const ids = conversation.agentIds.slice(0, 3);
  if (ids.length === 0) return null;
  return (
    <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
      {ids.map((id) => (
        <AgentAvatar
          key={id}
          agentId={id}
          avatar={agentById.get(id)?.avatar}
          size={28}
          className="shrink-0"
        />
      ))}
    </span>
  );
}

/**
 * Gemini-style glow behind the top of the page: large, heavily blurred blobs in the agents' own colours that
 * melt into the page (same as iOS AuroraBackground). Decoration only.
 */
export function Aurora({ agents, colors: fixed }: { agents: Agent[]; colors?: string[] }) {
  const colors = fixed ?? agents.slice(0, 3).map((agent) => CHARACTER_TINT[agentCharacter(agent.id, agent.avatar)]);
  const palette = colors.length > 0 ? colors : ["#8b5cf6", "#14b8a6", "#f59e0b"];
  const spots = [
    { left: "15%", top: "-60px" },
    { left: "60%", top: "-90px" },
    { left: "38%", top: "40px" },
  ];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-[460px] overflow-hidden opacity-55 [mask-image:linear-gradient(to_bottom,black,rgba(0,0,0,0.6),transparent)]"
    >
      {palette.map((color, index) => (
        <span
          key={index}
          className="absolute size-[300px] rounded-full blur-[90px]"
          style={{ background: color, left: spots[index]?.left, top: spots[index]?.top }}
        />
      ))}
    </div>
  );
}

/** The signed-in person's first name; empty for a legacy token session (transport, not identity). */
export function useAccountFirstName(): string {
  const identity = useAuthIdentity();
  const name = identity?.mode === "account" ? (identity.user.name ?? "").trim() : "";
  return name.split(/\s+/)[0] ?? "";
}

/** "Continue with <latest>" and up to two further recent chats (never a duplicate of the continued one).
 * `part` lets a two-column page place the button and the list separately; by default both render, stacked. */
export function ContinueChats({ conversations, agents, part = "all" }: ReturningWelcomeProps & { part?: "all" | "button" | "list" }) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const { data: runs } = useRuns();
  // What the agent of a direct chat last did (its latest task's short title); groups keep "Group chat".
  const recentLine = (conversation: Conversation): string => {
    const only = conversation.kind === "direct" ? conversation.agentIds[0] : undefined;
    const agent = only ? agentById.get(only) : undefined;
    const doing = agent ? resolveDoingLine({ agentId: agent.id, status: agent.status, agentDoing: agent.doing, runs }) : undefined;
    return doing ?? conversationKindLabel(conversation.kind);
  };
  const mostRecent = conversations[0];
  const remaining = conversations.slice(1, 3);
  if (!mostRecent) return null;

  return (
    <>
      {part !== "list" ? (
        <Button asChild variant="primary" size="lg" className={cn("h-12 self-center rounded-full px-7 text-[15px]", part === "all" && "mt-6")}>
          <Link to={`/c/${mostRecent.id}`}>
            {RETURNING_WELCOME_COPY.continueLatest.replace("{name}", conversationLabel(mostRecent, agentById))}
          </Link>
        </Button>
      ) : null}
      {part !== "button" && remaining.length > 0 ? (
        <section aria-label={RETURNING_WELCOME_COPY.recentChats} className={cn("w-full text-left", part === "all" && "mt-8")}>
          <h2 className="text-sm font-semibold text-fg-muted">{RETURNING_WELCOME_COPY.recentChats}</h2>
          <ul className="mt-2.5 flex w-full flex-col gap-2">
            {remaining.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  to={`/c/${conversation.id}`}
                  className="flex items-center gap-3 rounded-2xl bg-muted/70 p-3 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-interactive-hover"
                >
                  <ConversationAvatars conversation={conversation} agentById={agentById} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-fg">
                      {conversationLabel(conversation, agentById)}
                    </span>
                    <span className="block truncate text-[13px] text-fg-muted">{recentLine(conversation)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
