import type { Request } from "@agent-desktop/client";
import { Button, Kbd, ListRow, cn } from "@agent-desktop/ui";
import { MessageSquare } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { AgentAvatar } from "../../../components/agent/AgentAvatar";
import { requestSentence } from "../../../components/request";
import { LiveRequestCard } from "../../../components/request/LiveRequestCard";
import { useAgents } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { timeLabel } from "../card/parts";

/**
 * What waits on the user, handled like an inbox (Linear / Gmail): the list on top, the selected
 * request in full below, Deny / Allow on it, J/K or ↑/↓ to move, and the next one selected after
 * a decision. The list scrolls however long it gets; nothing folds. `showAgent` (home page)
 * leads each row with the asking agent.
 */
export function ApprovalQueue({ requests, showAgent = false }: { requests: Request[]; showAgent?: boolean }) {
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const index = Math.max(0, requests.findIndex((request) => request.id === selectedId));
  const selected = requests[index];

  if (!selected) return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("agentPane.nothingWaiting")}</p>;

  const move = (delta: number) => {
    const next = requests[Math.min(requests.length - 1, Math.max(0, index + delta))];
    if (next) setSelectedId(next.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "j" || event.key === "ArrowDown") move(1);
    else if (event.key === "k" || event.key === "ArrowUp") move(-1);
    else return;
    event.preventDefault();
  };
  const agentOf = (id: string) => agents?.find((agent) => agent.id === id);

  return (
    <div tabIndex={0} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col outline-none">
      <div role="listbox" aria-label={t("agentPane.waiting")} className="max-h-[45%] shrink-0 overflow-y-auto px-2 py-1">
        {requests.map((request) => {
          const agent = agentOf(request.agentId);
          return (
            <ListRow
              key={request.id}
              dense
              selected={request.id === selected.id}
              leading={
                showAgent && agent ? (
                  <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={20} />
                ) : (
                  <span className={cn("block size-1.5 rounded-full", request.kind === "approval" ? "bg-warning" : "bg-info")} />
                )
              }
              title={showAgent && agent ? `${agent.name} · ${requestSentence(request)}` : requestSentence(request)}
              meta={timeLabel(request.createdAt)}
              onClick={() => setSelectedId(request.id)}
            />
          );
        })}
      </div>

      <article className="min-h-0 flex-1 overflow-y-auto border-t border-border px-4 py-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd>
            {t("agentPane.toMove")}
          </span>
          <span>
            {index + 1} / {requests.length}
          </span>
        </div>
        <LiveRequestCard key={selected.id} request={selected} />
        {selected.conversationId ? (
          <Button variant="ghost" className="mt-3 rounded-full" onClick={() => navigate(`/c/${selected.conversationId}`)}>
            <MessageSquare className="size-4" />
            {selected.kind === "question" ? t("agentPane.answerInChat") : t("agentPane.openChat")}
          </Button>
        ) : null}
      </article>
    </div>
  );
}
