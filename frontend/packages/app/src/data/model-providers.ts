import type { CreateModelProviderInput, Id, UpdateModelProviderInput } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/**
 * Model provider mutations (BACKEND §10.14). Keys are write-only: they travel in the request and
 * are never kept in a cache, so the cache only ever sees the provider row (`hasKey`).
 */
export function useCreateProvider() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateModelProviderInput) => client.modelProviders.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.modelProviders() });
      void qc.invalidateQueries({ queryKey: qk.settings() }); // the "Auto" models may now resolve differently
    },
  });
}

export function useUpdateProvider() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: UpdateModelProviderInput }) =>
      client.modelProviders.update(id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.modelProviders() }),
  });
}

/** Removing a provider can clear the default model server-side, so settings are refetched too. */
export function useDeleteProvider() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => client.modelProviders.delete(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.modelProviders() });
      void qc.invalidateQueries({ queryKey: qk.settings() });
    },
  });
}

export function useStartChatGPTLogin() {
  const client = useClient();
  return useMutation({ mutationFn: () => client.modelProviders.startChatGPTLogin() });
}

export function useCompleteChatGPTLogin() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loginId: Id; callbackUrl: string }) => client.modelProviders.completeChatGPTLogin(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.modelProviders() }),
  });
}

/**
 * Where a sign-in stands, polled while it is pending: the desktop engine finishes the login itself when
 * the browser reaches its callback, and this is how the dialog finds out. Off when `loginId` is null.
 */
export function useChatGPTLoginStatus(loginId: Id | null) {
  const client = useClient();
  return useQuery({
    queryKey: ["chatgpt-login", loginId] as const,
    queryFn: () => client.modelProviders.chatGPTLoginStatus(loginId as Id),
    enabled: loginId !== null,
    refetchInterval: (query) => (query.state.data === undefined || query.state.data.status === "pending" ? 1500 : false),
    gcTime: 0,
  });
}

export function useCancelChatGPTLogin() {
  const client = useClient();
  return useMutation({ mutationFn: (loginId: Id) => client.modelProviders.cancelChatGPTLogin(loginId) });
}

/**
 * Run failures arrive only as free text. Every backend message that a model-provider setting fixes
 * names "Settings > Models", so that phrase is the one signal for "offer the settings link".
 */
export function isModelSetupError(message: string | null | undefined): boolean {
  return /settings\s*>\s*models/i.test(message ?? "");
}

/** Status/code carried by both the HTTP client and the mock on a rejected call. */
export function errorCode(error: unknown): { status?: number; code?: string; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  return {
    status: typeof status === "number" ? status : undefined,
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}
