import { useRun } from "../../data/queries";
import { isFailedRunRow } from "../../lib/stepLine";
import type { RunItem } from "../../lib/items";
import { RunStatusRow } from "../run/RunStatusRow";

export interface RunItemProps {
  item: RunItem;
  onOpenThread?: (runId: string) => void;
}

/**
 * A run in the transcript. Live work is the typing dots and the status pill; the only run row is a
 * failed or stopped task (iPhone Items.swift), and a run that is missing is skipped.
 */
export function RunItem({ item, onOpenThread }: RunItemProps) {
  const { data: run } = useRun(item.runId);
  if (!isFailedRunRow(run)) return null;
  return (
    <div className="py-0.5">
      <RunStatusRow run={run} onOpen={onOpenThread} />
    </div>
  );
}
