import type { Run } from "@agent-desktop/client";
import { Button, cn } from "@agent-desktop/ui";
import { CircleAlert } from "lucide-react";
import { useNavigate } from "react-router";
import { isModelSetupError } from "../../data/model-providers";
import { useModelProviders } from "../../data/queries";
import { t } from "../../lib/i18n";

/**
 * A quiet capsule above the composer, shaped like the agent-status pill. It shows the newest
 * top-level run's failure when a model-provider setting fixes it (no provider, key rejected, ChatGPT
 * sign-in expired: the backend names "Settings > Models"), because such a run fails before it posts
 * anything to the transcript. Otherwise it shows while the account cannot run an agent at all
 * (`usable: false`). The first-agent form shows the same capsule under its create button.
 */
export function ModelProviderNotice({ runs, className }: { runs?: readonly Run[]; className?: string }) {
  const navigate = useNavigate();
  const providers = useModelProviders();
  const failure = newestSetupFailure(runs);
  if (failure === undefined && providers.data?.usable !== false) return null;
  return (
    <div data-slot="model-provider-notice" className={cn("relative z-[6] mx-auto flex w-full max-w-[760px] px-4 pb-1", className)}>
      <div
        role="status"
        title={failure}
        className={cn(
          "flex min-h-7 max-w-full min-w-0 items-center gap-2 rounded-[14px] border border-border bg-muted px-2.5 py-1 text-[13px] leading-[18px] text-fg-muted",
          failure !== undefined && "border-danger/40 bg-danger-subtle text-danger",
        )}
      >
        <CircleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="line-clamp-2 min-w-0">{failure ?? t("models.notice")}</span>
        <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-xs" onClick={() => navigate("/settings/models")}>
          {failure === undefined ? t("models.add") : t("models.runError.open")}
        </Button>
      </div>
    </div>
  );
}

/** The newest top-level run's error, when it failed for a reason Settings > Models fixes. */
function newestSetupFailure(runs: readonly Run[] | undefined): string | undefined {
  const newest = (runs ?? [])
    .filter((run) => run.parentRunId === undefined)
    .reduce<Run | undefined>((latest, run) => (latest === undefined || run.startedAt > latest.startedAt ? run : latest), undefined);
  return newest?.status === "failed" && isModelSetupError(newest.error) ? newest.error : undefined;
}
