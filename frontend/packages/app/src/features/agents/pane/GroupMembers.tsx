import type { Agent, Conversation } from "@agent-desktop/client";
import { ListRow, Section } from "@agent-desktop/ui";
import { Users } from "lucide-react";
import { AgentAvatar } from "../../../components/agent/AgentAvatar";
import { AgentAvatarGroup } from "../../../components/agent/AgentAvatarGroup";
import { GroupMemberRunStatus } from "../../../components/conversation/GroupMemberRunStatus";
import { useAuthIdentity } from "../../../auth/AuthContext";
import { t } from "../../../lib/i18n";

/**
 * The dropdown for a group chat, in the agent panel's style: the stacked avatars, the group's name and a
 * members list. Each agent opens its own agent panel; people are listed after the agents.
 */
export function GroupMembers({
  conversation,
  members,
  onOpen,
}: {
  conversation: Conversation;
  members: Agent[];
  onOpen: (agentId: string) => void;
}) {
  const identity = useAuthIdentity();
  const owner = identity?.mode === "account" ? identity.user : undefined;
  const ownerIncluded = owner !== undefined && conversation.memberIds.includes(owner.id);
  const others = conversation.memberIds.length - (ownerIncluded ? 1 : 0);
  const title = conversation.title ?? members.map((member) => member.name).join(", ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col items-center px-6 pt-6 text-center">
        <AgentAvatarGroup agents={members} size={72} max={3} label={title} />
        <h2 className="mt-3 max-w-full truncate text-[22px] font-bold leading-tight text-fg">{title}</h2>
        <p className="mt-1.5 text-sm font-medium text-fg-muted">{t("agentPanel.memberCount", { count: members.length + (ownerIncluded ? 1 : 0) + Math.max(0, others) })}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-5">
        <Section title={t("agentPanel.members")} className="gap-1 px-2" contentClassName="flex flex-col">
          {members.map((member) => (
            <ListRow
              key={member.id}
              leading={<AgentAvatar agentId={member.id} avatar={member.avatar} status={member.status} size={40} />}
              title={member.name}
              description={`@${member.handle}`}
              trailing={<GroupMemberRunStatus conversationId={conversation.id} agentId={member.id} />}
              onClick={() => onOpen(member.id)}
            />
          ))}
          {ownerIncluded && owner ? (
            <ListRow
              leading={<span className="flex size-10 items-center justify-center rounded-full bg-muted text-sm font-medium text-fg-muted">{owner.name.slice(0, 1)}</span>}
              title={owner.name}
              description={t("agentPanel.you")}
            />
          ) : null}
          {others > 0 ? (
            <ListRow
              leading={<span className="flex size-10 items-center justify-center rounded-full bg-muted text-fg-muted"><Users className="size-4" /></span>}
              title={others === 1 ? t("agentPanel.oneUser") : t("agentPanel.manyUsers", { count: others })}
            />
          ) : null}
        </Section>
      </div>
    </div>
  );
}
