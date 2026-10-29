import type { Agent } from "@agent-desktop/client";
import { Button, cn } from "@agent-desktop/ui";
import { Heart, MessageCircle, Pencil } from "lucide-react";
import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { useAuthIdentity } from "../../../auth/AuthContext";
import { t } from "../../../lib/i18n";
import { AgentIdentityDialog } from "../AgentIdentityDialog";
import { canEditAgent } from "../canEditAgent";
import { LearnedReplyStyle } from "./LearnedReplyStyle";

/** A gradient tile (the iPhone's MemoryCard): title and subtitle on top, the icon bottom-right. */
function MemoryCard({ title, subtitle, icon: Icon, gradient, onClick }: { title: string; subtitle: string; icon: ComponentType<{ className?: string }>; gradient: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex h-[130px] min-w-0 flex-1 flex-col rounded-[22px] bg-linear-to-br p-3.5 text-left text-white focus-ring", gradient)}
    >
      <span className="text-base font-bold">{title}</span>
      <span className="text-[9px] text-white/70">{subtitle}</span>
      <Icon className="mt-auto size-[18px] self-end text-white/60" />
    </button>
  );
}

/**
 * Memory, after the iPhone's MemoryTab: the agent's name, Edit and two cards - Identity (its four identity files in a
 * dialog) and Memory (the page shared by every agent) - then what it learned about how to answer you. The header
 * pencil is the other editor (name, role, avatar).
 */
export function MemoryTab({ agent }: { agent: Agent }) {
  const identity = useAuthIdentity();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const ownerId = identity?.mode === "account" ? identity.user.id : undefined;
  return (
    <div className="flex flex-col gap-3.5 px-2">
      <h3 className="text-sm font-semibold text-foreground">{agent.name}</h3>
      <Button variant="secondary" size="lg" className="w-full" onClick={() => setEditing(true)}>
        <Pencil /> {t("agentCard.editIdentity")}
      </Button>
      <div className="flex gap-3">
        <MemoryCard title={t("agentCard.identity")} subtitle={t("agentCard.identityHint")} icon={Heart} gradient="from-[#4a3a66] to-[#8d72ad]" onClick={() => setEditing(true)} />
        <MemoryCard title={t("agentCard.memoryTitle")} subtitle={t("agentCard.memoryShared")} icon={MessageCircle} gradient="from-[#4f5a12] to-[#1d2208]" onClick={() => navigate("/memories")} />
      </div>
      <LearnedReplyStyle agent={agent} />
      <AgentIdentityDialog agent={agent} open={editing} onOpenChange={setEditing} readOnly={!canEditAgent(agent, ownerId)} />
    </div>
  );
}
