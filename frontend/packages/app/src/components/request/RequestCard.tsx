import type { Agent, Request, ResolveRequestInput, SecureInputResult } from "@agent-desktop/client";
import { ActionCard, ActionSummaryRow, cn } from "@agent-desktop/ui";
import { Check, Minus, X } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { formatAgo } from "../../lib/format";
import { ApprovalBody, ComputerBody, ConnectBody, QuestionBody, SecureInputBody, SigninAdminBody, type CardBodyProps, type ComputerControl } from "./cards";
import { SecureInputDialog } from "./SecureInputDialog";
import { resolvedSummary } from "./summary";

/** True from the first time `open` is true: lazily mounted detail that then stays mounted for the close animation. */
function useOpened(open: boolean) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened;
}

const hasFieldErrors = (error: unknown) => Object.keys((error as { fields?: object } | null)?.fields ?? {}).length > 0;

/** The server refused an Allow because the 24-hour approval window passed: the card is closing as timed out, nothing to retry. */
const isExpired = (error: unknown) => (error as { status?: number; code?: string } | null)?.status === 409 && (error as { code?: string }).code === "REQUEST_EXPIRED";

export interface RequestCardProps {
  request: Request;
  agent?: Agent;
  submitting?: boolean;
  submitError?: unknown;
  onRetry?: () => void;
  onResolve?: (decision: ResolveRequestInput) => void;
  /** Types the user's secret values into the page; resolves with each field's outcome. */
  onSecureSubmit?: (values: Record<string, string>) => Promise<SecureInputResult>;
  onOpenSignin?: () => void;
  /** Take-over state for `computer` requests. */
  computer?: ComputerControl;
  /** Decided requests start as one slim row; `expanded` opens the full card (history lists). */
  defaultExpanded?: boolean;
  className?: string;
  /** The card sits in a direct chat with its agent (the question card drops its "Question ·" label). */
  inDirectChat?: boolean;
}

/**
 * One card for every kind of request (VISUAL.md "Request cards"). Pending: the interactive card.
 * Decided: a slim summary row; click expands the same card read-only, with who decided and when.
 * The asking agent's real name comes from `request.agentId`, never a fixed name.
 */
export function RequestCard({ request, agent, submitting, submitError, onRetry, onResolve, onSecureSubmit, onOpenSignin, computer, defaultExpanded = false, className, inDirectChat }: RequestCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const opened = useOpened(expanded);
  const [secureOpen, setSecureOpen] = useState(false);
  const pending = request.status === "pending";
  const agentName = agent?.name ?? t("request.agentFallback");

  const body: CardBodyProps = {
    request,
    inDirectChat,
    agentName,
    readOnly: !pending,
    disabled: submitting === true,
    errors: (submitError as { fields?: Record<string, string> } | null | undefined)?.fields,
    onResolve: (decision) => onResolve?.(decision),
  };

  const cards = (
    <>
      {request.payload.kind === "approval" ? <ApprovalBody {...body} /> : null}
      {request.payload.kind === "question" ? <QuestionBody {...body} /> : null}
      {request.payload.kind === "secure_input" ? <SecureInputBody {...body} onOpenSecure={() => setSecureOpen(true)} /> : null}
      {request.payload.kind === "connect" ? <ConnectBody {...body} /> : null}
      {request.payload.kind === "computer" ? <ComputerBody {...body} control={computer} /> : null}
      {request.payload.kind === "signin" || request.payload.kind === "admin" ? <SigninAdminBody {...body} onOpenSignin={() => onOpenSignin?.()} /> : null}
    </>
  );

  if (!pending) {
    const summary = resolvedSummary(request);
    return (
      <div className={className}>
        <ActionSummaryRow
          tone={summary.tone}
          title={summary.title}
          detail={summary.detail}
          icon={summary.tone === "danger" ? <X strokeWidth={3} /> : summary.tone === "neutral" ? <Minus strokeWidth={3} /> : <Check strokeWidth={3} />}
          onToggle={() => setExpanded((open) => !open)}
          expanded={expanded}
        >
          {/* Mounted on first open and kept, so closing animates instead of unmounting. */}
          {opened ? (
            <>
              {cards}
              <p className="mt-3 px-1 text-sm text-fg-subtle">{[agent?.name, formatAgo(request.resolvedAt ?? request.decision?.at)].filter(Boolean).join(" · ")}</p>
            </>
          ) : null}
        </ActionSummaryRow>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ActionCard data-kind={request.kind}>
        {cards}
        {submitError !== undefined && !hasFieldErrors(submitError) ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 px-1 text-xs">
            <span>{isExpired(submitError) ? t("request.sum.expired") : t("request.submitFailed")}</span>
            {onRetry && !isExpired(submitError) ? (
              <button type="button" disabled={submitting} onClick={onRetry} className="rounded-full px-2 py-1 font-medium underline hover:bg-muted">
                {t("request.retry")}
              </button>
            ) : null}
          </div>
        ) : null}
        {submitting === true ? <p role="status" className="mt-2 px-1 text-xs text-foreground/60">{t("request.submitting")}</p> : null}
      </ActionCard>
      {request.payload.kind === "secure_input" && onSecureSubmit ? (
        <SecureInputDialog open={secureOpen} onOpenChange={setSecureOpen} site={request.payload.site} fields={request.payload.fields} onSubmit={onSecureSubmit} />
      ) : null}
    </div>
  );
}
