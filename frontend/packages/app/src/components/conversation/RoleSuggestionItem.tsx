import type { Agent } from "@agent-desktop/client";
import type { RoleSuggestionItem } from "../../lib/items";
import { Button, Input, Label, cn } from "@agent-desktop/ui";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { useAcceptRoleSuggestion, useDismissRoleSuggestion, useUpdateAgent } from "../../data/mutations";
import { useAgent } from "../../data/queries";
import { UNSET_ROLES } from "../../lib/agentRole";
import { t } from "../../lib/i18n";
import { AgentAvatar } from "../agent/AgentAvatar";

export type RoleSuggestionState = { kind: "pending" } | { kind: "set"; title: string } | { kind: "dismissed" };

/**
 * The card's state, derived from the agent (BACKEND §10.11). Pending while the agent still carries
 * this very suggestion. Otherwise "set" when the agent has a real role that was not dismissed after
 * the suggestion, and "dismissed" for everything else.
 */
export function roleSuggestionState(
  agent: Agent | undefined,
  item: Pick<RoleSuggestionItem, "suggestionAt">,
): RoleSuggestionState | undefined {
  if (agent === undefined) return undefined;
  if (agent.roleSuggestion?.createdAt === item.suggestionAt) return { kind: "pending" };
  const title = agent.title.trim();
  const dismissed =
    agent.roleSuggestionDismissedAt !== undefined &&
    Date.parse(agent.roleSuggestionDismissedAt) >= Date.parse(item.suggestionAt);
  if (UNSET_ROLES.has(title) || dismissed) return { kind: "dismissed" };
  return { kind: "set", title };
}

export interface RoleSuggestionItemProps {
  item: RoleSuggestionItem;
  className?: string;
}

/**
 * The suggested role from the first messages of a direct chat, as a card in the transcript (the
 * same family as RequestItem). Accept and dismiss emit `agent.updated`; this item never changes.
 */
export function RoleSuggestionItem({ item, className }: RoleSuggestionItemProps) {
  const { data: agent } = useAgent(item.agentId);
  const state = roleSuggestionState(agent, item);
  if (!agent || !state) return null;

  return (
    <div className={cn("py-1", className)}>
      {state.kind === "pending" ? (
        <PendingCard agent={agent} item={item} />
      ) : (
        <p className="flex items-center gap-1.5 px-1 text-xs text-fg-muted">
          {state.kind === "set" ? (
            <>
              <Check className="size-3.5 shrink-0" aria-hidden />
              <span>{t("roleSuggestion.set", { title: state.title })}</span>
            </>
          ) : (
            <span>{t("roleSuggestion.notNow")}</span>
          )}
        </p>
      )}
    </div>
  );
}

function PendingCard({ agent, item }: { agent: Agent; item: RoleSuggestionItem }) {
  const inputId = useId();
  const [title, setTitle] = useState(item.title);
  const accept = useAcceptRoleSuggestion();
  const dismiss = useDismissRoleSuggestion();
  const update = useUpdateAgent();
  const busy = accept.isPending || dismiss.isPending || update.isPending;
  const finalTitle = title.trim() || item.title;

  // Accept first (it sets the title to the suggestion and clears it), then rename if the name was
  // edited. The card unmounts once accept lands, so the rename is awaited through the promise.
  const handleUse = async () => {
    try {
      await accept.mutateAsync(agent.id);
    } catch {
      return; // the card stays pending and shows the failure, so the user can retry
    }
    if (finalTitle !== item.title) {
      await update.mutateAsync({ id: agent.id, patch: { title: finalTitle } }).catch(() => undefined);
    }
  };

  return (
    <div className="flex w-full max-w-[min(80%,560px)] items-start gap-1.5">
      <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={24} flat className="mt-0.5" />
      <div className="min-w-0 flex-1 rounded-2xl bg-bubble-agent px-3 py-2 text-sm text-bubble-agent-foreground">
        <p className="text-fg-muted">{t("roleSuggestion.lead", { name: agent.name })}</p>
        <p className="mt-0.5 text-base font-semibold text-fg">{item.title}</p>
        <p className="mt-0.5 text-fg-muted">{item.description}</p>
        <div className="mt-2.5 grid gap-1.5">
          <Label htmlFor={inputId}>{t("roleSuggestion.field")}</Label>
          <Input id={inputId} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </div>
        {accept.isError ? (
          <p role="alert" className="mt-2 text-xs text-fg">
            {t("roleSuggestion.failed")}
          </p>
        ) : null}
        <div className="mt-2.5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => dismiss.mutate(agent.id)}>
            {t("roleSuggestion.notNow")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void handleUse()}>
            {t("roleSuggestion.use")}
          </Button>
        </div>
      </div>
    </div>
  );
}
