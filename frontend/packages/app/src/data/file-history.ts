import type { FileHistoryComputer, FileSnapshot } from "@agent-desktop/client";
import { toast } from "@agent-desktop/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "../lib/i18n";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";
import { errorCode } from "./model-providers";

/** The kept earlier versions of one file an agent overwrote, newest first (`GET /v1/files/history`). */
export function useFileHistory(agentId: string, path: string, on: FileHistoryComputer) {
  const client = useClient();
  return useQuery({
    queryKey: [...qk.fileHistory(agentId, path), on],
    queryFn: async () => (await client.files.history({ agentId, path, on })).items,
    retry: false,
  });
}

/** Put a kept version back. The version it replaces is kept too, so the list grows by one and the restore can be undone. */
export function useRestoreFile(agentId: string, path: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (snapshot: FileSnapshot) => client.files.restore({ snapshotId: snapshot.id }),
    onSuccess: () => toast(t("fileVersions.restored")),
    onError: (error) => {
      const status = errorCode(error).status;
      toast.error(t(status === 409 || status === 503 ? "fileVersions.computerAway" : "fileVersions.failed"));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.fileHistory(agentId, path) }),
  });
}
