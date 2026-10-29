import type { CreateGoalInput, GoalCategory, GoalKind } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@agent-desktop/ui";
import { useState, type FormEvent } from "react";
import { useCreateGoal } from "../../data/goals";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import { GOAL_CATEGORIES } from "./categories";

/**
 * Create a goal for one of the user's agents (BACKEND §10.10): agent, kind (a concrete watch or a
 * longer aim), the goal itself, where it stands, and a category. Mounted only while open, so every
 * opening starts from a blank form.
 */
export function CreateGoalDialog({
  defaultAgentId,
  onOpenChange,
  onCreated,
}: {
  defaultAgentId?: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (goalId: string) => void;
}) {
  const { data: agents } = useAgents();
  const create = useCreateGoal();
  const [agentId, setAgentId] = useState<string | undefined>(defaultAgentId);
  const [kind, setKind] = useState<GoalKind>("goal");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<GoalCategory>("other");
  const chosenAgent = agentId ?? agents?.[0]?.id;
  const canSubmit = Boolean(chosenAgent) && title.trim().length > 0 && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosenAgent || !canSubmit) return;
    const input: CreateGoalInput = {
      agentId: chosenAgent,
      kind,
      title: title.trim(),
      category,
      ...(summary.trim() ? { summary: summary.trim() } : {}),
    };
    create.mutate(input, { onSuccess: (goal) => onCreated(goal.id) });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("goals.dialog.title")}</DialogTitle>
        </DialogHeader>
        {agents?.length ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label>{t("goals.dialog.agent")}</Label>
              <Select value={chosenAgent} onValueChange={setAgentId}>
                <SelectTrigger aria-label={t("goals.dialog.agent")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("goals.dialog.kind")}</Label>
              <SegmentedControl
                fill
                aria-label={t("goals.dialog.kind")}
                value={kind}
                onValueChange={(value) => setKind(value === "tracking" ? "tracking" : "goal")}
                items={[
                  { value: "goal", label: t("goals.kind.goal") },
                  { value: "tracking", label: t("goals.kind.tracking") },
                ]}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="goal-title">{t("goals.dialog.goalName")}</Label>
              <Input
                id="goal-title"
                autoFocus
                value={title}
                placeholder={t("goals.dialog.goalPlaceholder")}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="goal-summary">{t("goals.dialog.summary")}</Label>
              <Input
                id="goal-summary"
                value={summary}
                placeholder={t("goals.dialog.summaryPlaceholder")}
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("goals.dialog.category")}</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as GoalCategory)}>
                <SelectTrigger aria-label={t("goals.dialog.category")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GOAL_CATEGORIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`goals.category.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {t("goals.dialog.submit")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t("goals.dialog.noAgents")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
