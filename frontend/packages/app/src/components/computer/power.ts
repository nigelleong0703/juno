import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient } from "../../data/ClientProvider";

/**
 * Reboot / reset for a computer (E2). These two live outside `data/mutations.ts` (E1) because they
 * are destructive machine actions surfaced only from the Computer pane's "more" menu.
 */
export function useComputerPower() {
  const client = useClient();
  const qc = useQueryClient();

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["computers"] });

  const reboot = useMutation({
    mutationFn: (id: string) => client.computers.reboot(id),
    onSettled: invalidate,
  });

  const reset = useMutation({
    mutationFn: (id: string) => client.computers.reset(id),
    onSettled: invalidate,
  });

  return { reboot, reset };
}
