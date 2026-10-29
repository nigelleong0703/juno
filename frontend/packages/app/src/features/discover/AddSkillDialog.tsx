import type { Skill } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@agent-desktop/ui";
import { useMemo, useState } from "react";
import { useAuthIdentity } from "../../auth/AuthContext";
import { useAgents } from "../../data/queries";
import { useAssignSkills } from "../../data/skills";
import { t } from "../../lib/i18n";
import { canEditAgent } from "../agents/canEditAgent";
import { skillName } from "../skills/skillModel";

/**
 * "Add" on a skill (Discover): asks which of the owner's agents should get it, then adds the skill to that agent's skill ids
 * through the existing assignment call. Only agents the owner may edit are offered, and agents that already have it are left out.
 */
export function AddSkillDialog({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const identity = useAuthIdentity();
  const ownerId = identity?.mode === "account" ? identity.user.id : undefined;
  const { data: agents } = useAgents();
  const eligible = useMemo(
    () => (agents ?? []).filter((agent) => canEditAgent(agent, ownerId) && !agent.skillIds.includes(skill.id)),
    [agents, ownerId, skill.id],
  );
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const chosen = eligible.find((agent) => agent.id === picked) ?? eligible[0];
  const assign = useAssignSkills();

  const add = () => {
    if (!chosen) return;
    assign.mutate([{ agentId: chosen.id, skillIds: [...chosen.skillIds, skill.id] }], {
      onSuccess: (result) => {
        if (result.failed.length > 0) toast.error(t("common.error"));
        else toast(t("discover.added", { skill: skillName(skill), agent: chosen.name }));
        onClose();
      },
      onError: () => toast.error(t("common.error")),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("discover.addTitle", { skill: skillName(skill) })}</DialogTitle>
          <DialogDescription>{eligible.length > 0 ? t("discover.addHint") : t("discover.addNoAgents")}</DialogDescription>
        </DialogHeader>
        {eligible.length > 0 ? (
          <RadioGroup value={chosen?.id ?? ""} onValueChange={setPicked} className="gap-2">
            {eligible.map((agent) => (
              <Label key={agent.id} className="flex items-center gap-2 text-sm text-fg">
                <RadioGroupItem value={agent.id} />
                {agent.name} · {agent.title}
              </Label>
            ))}
          </RadioGroup>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!chosen || assign.isPending} onClick={add}>
            {t("discover.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
