import type { PlanItem } from "../../lib/items";
import { cn } from "@agent-desktop/ui";
import { useRun } from "../../data/queries";
import { PlanCard } from "../run/PlanCard";

export interface PlanItemProps {
  item: PlanItem;
  className?: string;
}

/** The agent's live checklist, embedded in the transcript. */
export function PlanItem({ item, className }: PlanItemProps) {
  const { data: run } = useRun(item.runId);
  return (
    <div className={cn("py-1", className)}>
      <PlanCard plan={{ title: run?.title, todos: item.todos }} />
    </div>
  );
}
