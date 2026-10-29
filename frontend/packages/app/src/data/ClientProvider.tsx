import type { ApiClient, EventSource } from "@agent-desktop/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PlatformAdapter } from "../platform";

/**
 * Injection points for the app (ARCHITECTURE §7 "ClientProvider"): the typed client and the
 * platform adapter both arrive as props so mock ↔ real backend and web ↔ Electron are single
 * swaps. Screens read them through `useClient()` / `usePlatform()`.
 */

interface ClientBundle {
  client: ApiClient;
  events: EventSource | null;
}

const ClientContext = createContext<ClientBundle | null>(null);
export { ClientContext };
const PlatformContext = createContext<PlatformAdapter | null>(null);

export interface ClientProviderProps {
  client: ApiClient;
  /** Optional live event source; when present `liveSync` keeps the cache warm. */
  events?: EventSource | null;
  platform?: PlatformAdapter;
  queryClient?: QueryClient;
  children: ReactNode;
}

function createDefaultQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function ClientProvider({
  client,
  events = null,
  platform,
  queryClient,
  children,
}: ClientProviderProps) {
  const bundle = useMemo<ClientBundle>(() => ({ client, events }), [client, events]);
  const qc = useMemo(() => queryClient ?? createDefaultQueryClient(), [queryClient]);

  const tree = (
    <QueryClientProvider client={qc}>
      <ClientContext value={bundle}>{children}</ClientContext>
    </QueryClientProvider>
  );

  return platform ? <PlatformContext value={platform}>{tree}</PlatformContext> : tree;
}

export function useClient(): ApiClient {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error("useClient must be used within a <ClientProvider>");
  return ctx.client;
}

/** The injected `EventSource`, if any (used by `liveSync`). */
export function useEventSource(): EventSource | null {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error("useEventSource must be used within a <ClientProvider>");
  return ctx.events;
}

export function usePlatform(): PlatformAdapter {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error("usePlatform must be used within a <ClientProvider platform=…>");
  return ctx;
}
