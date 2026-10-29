import type { Request } from "@agent-desktop/client";
import { useResolveRequest } from "../../data/mutations";
import { useAgent, useConversations } from "../../data/queries";
import { useSecureInputSubmit } from "../../data/secureInput";
import { RequestCard } from "./RequestCard";
import { useComputerControl } from "./useComputerControl";

/** A request card wired to the real actions: resolve, secure-input submit and take-over. */
export function LiveRequestCard({ request, onOpenSignin, defaultExpanded, className }: { request: Request; onOpenSignin?: (request: Request) => void; defaultExpanded?: boolean; className?: string }) {
  const { data: agent } = useAgent(request.agentId);
  const { data: conversations } = useConversations();
  const resolve = useResolveRequest();
  const secureSubmit = useSecureInputSubmit(request);
  const computer = useComputerControl(request);
  return (
    <RequestCard
      className={className}
      inDirectChat={conversations?.find((entry) => entry.id === request.conversationId)?.kind === "direct"}
      request={request}
      agent={agent ?? undefined}
      defaultExpanded={defaultExpanded}
      submitting={resolve.isPending}
      submitError={resolve.error ?? undefined}
      computer={computer}
      onSecureSubmit={secureSubmit}
      onRetry={() => {
        if (resolve.isPending) return;
        const decision = resolve.variables?.decision;
        if (decision) resolve.mutate({ id: request.id, decision });
      }}
      onResolve={(decision) => {
        if (resolve.isPending) return;
        resolve.mutate({ id: request.id, decision });
      }}
      onOpenSignin={() => onOpenSignin?.(request)}
    />
  );
}
