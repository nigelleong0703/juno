import type { Agent, Mention } from "@agent-desktop/client";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@agent-desktop/ui";
import { AgentAvatar } from "../agent/AgentAvatar";
import { t } from "../../lib/i18n";
import { presentMentions } from "./mentionPresentation";

export interface ResolvedMentionProps {
  agent: Agent;
  onOpenAgent?: (agentId: string) => void;
}

export function ResolvedMention({ agent, onOpenAgent }: ResolvedMentionProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-agent-id={agent.id}
          className="inline cursor-pointer rounded-[2px] align-baseline font-medium text-inherit hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-current"
          style={{ lineHeight: "inherit", padding: 0, border: 0, background: "transparent" }}
        >
          <span aria-hidden="true" className="mr-0.5 inline-block align-[-2px] leading-[0]">
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={16} />
          </span>
          <strong className="font-bold">{agent.name}</strong>
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" sideOffset={4} className="w-60 p-3">
        <div className="flex items-center gap-2.5">
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={32} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{agent.name}</p>
            {agent.title ? <p className="truncate text-xs text-fg-muted">{agent.title}</p> : null}
          </div>
        </div>
        {onOpenAgent ? (
          <Button size="sm" className="mt-2.5 w-full" onClick={() => onOpenAgent(agent.id)}>
            {t("mention.message")}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Presentation only: the original message and canonical recipient IDs remain unchanged. */
export function MentionText({ text, mentions, agentById, onOpenAgent }: {
  text: string;
  mentions: Mention[];
  agentById?: (id: string) => Agent | undefined;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { parts, beforeBody } = presentMentions(text, mentions, agentById);
  return <>
    {beforeBody.length > 0 ? <div data-slot="message-recipients" className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-bubble-user-foreground">
      {beforeBody.map((recipient) => "agent" in recipient
        ? <ResolvedMention key={recipient.agent.id} agent={recipient.agent} onOpenAgent={onOpenAgent} />
        : <span key={recipient.key}>{recipient.label}</span>)}
    </div> : null}
    <p className="whitespace-pre-wrap">{parts.map((part, index) => typeof part === "string" ? part : <ResolvedMention key={index} agent={part.agent} onOpenAgent={onOpenAgent} />)}</p>
  </>;
}
