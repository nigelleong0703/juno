import type { Agent, Skill } from "@agent-desktop/client";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScrollArea,
  toast,
} from "@agent-desktop/ui";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useAuthIdentity } from "../../auth/AuthContext";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useAssignSkills } from "../../data/skills";
import { canEditAgent } from "../agents/canEditAgent";
import { skillName } from "./skillModel";

/**
 * Assign one skill to the owner's agents by editing each agent's skillIds. Only agents the server
 * will accept are offered — editable by the signed-in owner — and
 * every update is sent as one batch so a pending save and a partial failure stay visible. Nothing
 * here introduces persona or other host instructions.
 */
export function SkillAgentAssignment({ skill, agents }: { skill: Skill; agents: Agent[] }) {
  const identity = useAuthIdentity();
  const ownerId = identity?.mode === "account" ? identity.user.id : undefined;
  const eligible = useMemo(
    () => agents.filter((agent) => canEditAgent(agent, ownerId)),
    [agents, ownerId],
  );
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const assign = useAssignSkills();

  // The draft is seeded when the dialog opens and never re-seeded by a background refetch, so an
  // in-progress selection is not silently reset while the user is choosing.
  const openDialog = () => {
    setSelectedIds(eligible.filter((agent) => agent.skillIds.includes(skill.id)).map((agent) => agent.id));
    setOpen(true);
  };

  const toggle = (agentId: string, next: boolean) => {
    if (assign.isPending) return;
    setSelectedIds((prev) =>
      next ? [...new Set([...prev, agentId])] : prev.filter((id) => id !== agentId),
    );
  };

  const submit = () => {
    const changed = eligible.filter(
      (agent) => agent.skillIds.includes(skill.id) !== selectedIds.includes(agent.id),
    );
    if (changed.length === 0) {
      setOpen(false);
      return;
    }
    const updates = changed.map((agent) => ({
      agentId: agent.id,
      skillIds: selectedIds.includes(agent.id)
        ? [...agent.skillIds, skill.id]
        : agent.skillIds.filter((id) => id !== skill.id),
    }));
    assign.mutate(updates, {
      onSuccess: (result) => {
        const plural = selectedIds.length === 1 ? "" : "s";
        if (result.failed.length === 0) {
          toast("Skill assignment updated", {
            description: skillName(skill) + " is now assigned to " + String(selectedIds.length) + " agent" + plural + ".",
          });
          setOpen(false);
          return;
        }
        toast("Some assignments could not be saved", {
          description:
            String(result.failed.length) + " of " + String(updates.length) +
            " agents could not be saved. Your selection is kept — retry to finish.",
        });
      },
    });
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={openDialog} disabled={eligible.length === 0}>
        <Users className="size-3.5" />
        Assign
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign “{skillName(skill)}”</DialogTitle>
            <DialogDescription>Choose which agents can load this skill.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-72">
            <ul className="flex flex-col gap-1 py-2">
              {eligible.map((agent) => (
                <li
                  key={agent.id}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40"
                >
                  <Checkbox
                    checked={selectedIds.includes(agent.id)}
                    disabled={assign.isPending}
                    onCheckedChange={(checked) => toggle(agent.id, checked === true)}
                    aria-label={agent.name}
                  />
                  <AgentAvatar agentId={agent.id} avatar={agent.avatar} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{agent.name}</span>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={assign.isPending}>
              {assign.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
