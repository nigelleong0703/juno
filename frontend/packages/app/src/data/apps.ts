import type { ActionsPolicy, InstallAppResponse } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@agent-desktop/ui";
import { t } from "../lib/i18n";
import { useClient, usePlatform } from "./ClientProvider";

type InstallInput = Parameters<ReturnType<typeof useClient>["apps"]["install"]>[1];

/** Every app with what the owner added and which agents may use it (`GET /v1/apps`). */
export function useApps() {
  const client = useClient();
  return useQuery({ queryKey: ["apps"], queryFn: () => client.apps.list() });
}

/** One app with its capabilities and the installs the platform is still finishing; `poll` refetches while a chat install is under way. */
export function useApp(id: string | undefined, poll = false) {
  const client = useClient();
  return useQuery({
    queryKey: ["apps", id],
    queryFn: () => client.apps.get(id ?? ""),
    enabled: id !== undefined,
    refetchInterval: poll ? 3000 : false,
  });
}

function useInvalidateApps() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["apps"] });
    // The capability gate re-checks after an app write; the open requests (connect cards) follow.
    void qc.invalidateQueries({ queryKey: ["requests"] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };
}

/** Add an app (or sign in again): the answer says what to open, or that it is added already. */
export function useInstallApp() {
  const client = useClient();
  const invalidate = useInvalidateApps();
  return useMutation<InstallAppResponse, Error, { appId: string; input?: InstallInput }>({
    mutationFn: ({ appId, input }) => client.apps.install(appId, input),
    onSettled: invalidate,
  });
}

/** Look at an MCP server by address before adding it: its login kind and tools with a suggested read / change mark. Stores nothing. */
export function useProbeCustomApp() {
  const client = useClient();
  return useMutation({ mutationFn: (url: string) => client.apps.probeCustom(url) });
}

/** What to do with an install's answer: open the sign-in / install page (the system browser in the desktop app), else say it is added. */
export function useOpenInstall() {
  const { openExternal } = usePlatform();
  return (response: InstallAppResponse, name: string) => {
    if (response.openUrl !== null) openExternal(response.openUrl);
    else if (response.installation !== null) toast(t("apps.added", { name }));
  };
}

export function useRemoveInstallation() {
  const client = useClient();
  const invalidate = useInvalidateApps();
  return useMutation({
    mutationFn: (input: { appId: string; installationId: string }) => client.apps.removeInstallation(input.appId, input.installationId),
    onSettled: invalidate,
  });
}

type SetAgentAppInput = { agentId: string; appId: string; enabled: boolean; actionsPolicy?: ActionsPolicy };

/** An app (list row or detail) as it reads once `input` is applied: the agent's row added, changed or removed. */
function withAgentApp<T extends { id: string; enabledAgents: { agentId: string; actionsPolicy?: ActionsPolicy }[] }>(app: T, input: SetAgentAppInput): T {
  if (app.id !== input.appId) return app;
  const others = app.enabledAgents.filter((entry) => entry.agentId !== input.agentId);
  if (!input.enabled) return { ...app, enabledAgents: others };
  const current = app.enabledAgents.find((entry) => entry.agentId === input.agentId);
  return { ...app, enabledAgents: [...others, { ...current, agentId: input.agentId, actionsPolicy: input.actionsPolicy ?? current?.actionsPolicy ?? "ask" }] };
}

/** A work or custom app for one agent: on or off, and its actions policy. The change shows at once and is put back if the server refuses it. */
export function useSetAgentApp() {
  const client = useClient();
  const qc = useQueryClient();
  const invalidate = useInvalidateApps();
  return useMutation({
    mutationFn: (input: SetAgentAppInput) =>
      client.apps.setAgentApp(input.agentId, input.appId, {
        enabled: input.enabled,
        ...(input.actionsPolicy ? { actionsPolicy: input.actionsPolicy } : {}),
      }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["apps"] });
      const previous = qc.getQueriesData({ queryKey: ["apps"] });
      qc.setQueriesData({ queryKey: ["apps"] }, (data: unknown) => (Array.isArray(data) ? data.map((app) => withAgentApp(app, input)) : data && typeof data === "object" && "enabledAgents" in data ? withAgentApp(data as Parameters<typeof withAgentApp>[0], input) : data));
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) qc.setQueryData(key, data);
    },
    onSettled: invalidate,
  });
}

/** A chat app: one agent in one workspace. */
export function useSetWorkspaceAgent() {
  const client = useClient();
  const invalidate = useInvalidateApps();
  return useMutation({
    mutationFn: (input: { appId: string; installationId: string; agentId: string; enabled: boolean }) =>
      client.apps.setWorkspaceAgent(input.appId, input.installationId, input.agentId, { enabled: input.enabled }),
    onSettled: invalidate,
  });
}

/** The owner has looked at the app's new or changed tools: they go back to the normal rules (all of them, or the named ones). */
export function useReviewAppTools() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { appId: string; tools?: string[] }) => client.apps.reviewTools(input.appId, input.tools ? { tools: input.tools } : {}),
    onSuccess: (_answer, input) => void qc.invalidateQueries({ queryKey: ["apps", input.appId] }),
  });
}
