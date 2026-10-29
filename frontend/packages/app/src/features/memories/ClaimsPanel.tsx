import type { MemoryClaim } from "@agent-desktop/client";
import { Button, Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, ErrorState, LoadingState, RelativeTime, toast } from "@agent-desktop/ui";
import { useState } from "react";
import { useForgetMemory, useMemoryClaims } from "../../data/memories";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";

function ClaimRow({ claim, selected, onToggle }: { claim: MemoryClaim; selected?: boolean; onToggle?: () => void }) {
  const quote = claim.evidence[0]?.quote;
  const fromLog = claim.evidence[0]?.itemId.startsWith("log:") ?? false;
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2.5">
      {onToggle !== undefined && <Checkbox className="mt-1" checked={selected ?? false} onCheckedChange={onToggle} aria-label={t("memories.select", { text: claim.text })} />}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{claim.text}</p>
        {quote !== undefined && (
          <p className="mt-1 text-xs italic text-fg-muted">
            “{quote}”{fromLog && ` (${t("memories.fromLog")})`}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
          <span>{t("memories.confidence", { percent: Math.round(claim.confidence * 100) })}</span>
          {claim.target !== undefined && (
            <>
              <span>·</span>
              <span>{claim.target.line === undefined ? claim.target.path : `${claim.target.path}:${claim.target.line}`}</span>
            </>
          )}
          <span>·</span>
          <RelativeTime date={claim.createdAt} />
        </div>
      </div>
    </li>
  );
}

/** What I know and why: the active claims with the words that back them, multi-select Forget; superseded and retracted ones under History. */
export function ClaimsPanel() {
  const { data, isLoading, isError, refetch } = useMemoryClaims();
  const forget = useForgetMemory();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const active = (data ?? []).filter((c) => c.status === "active");
  const history = (data ?? []).filter((c) => c.status !== "active");
  const activeCapped = useCapped(active);
  const historyCapped = useCapped(history, 5);

  if (isLoading) return <LoadingState label={t("common.loading")} />;
  if (isError) return <ErrorState title={t("common.error")} onRetry={() => void refetch()} />;

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const ids = selected.filter((id) => active.some((c) => c.id === id));
  const run = () =>
    forget.mutate(ids, {
      onSuccess: () => {
        setSelected([]);
        setConfirming(false);
        toast(t("memories.forgotten"));
      },
      onError: () => toast(t("common.error")),
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t("memories.claimsHint")}</p>
      {ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-3 py-2">
          {confirming ? (
            <>
              <span className="text-sm text-fg">{t("memories.forgetConfirm", { count: ids.length })}</span>
              <Button variant="destructive" size="sm" disabled={forget.isPending} onClick={run}>
                {t("memories.forget")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              {t("memories.forgetSelected", { count: ids.length })}
            </Button>
          )}
        </div>
      )}
      {active.length === 0 ? (
        <p className="py-2 text-sm text-fg-muted">{t("memories.claimsEmpty")}</p>
      ) : (
        <ul>
          {activeCapped.shown.map((claim) => (
            <ClaimRow key={claim.id} claim={claim} selected={selected.includes(claim.id)} onToggle={() => toggle(claim.id)} />
          ))}
        </ul>
      )}
      <ShowMore hidden={activeCapped.hidden} onClick={activeCapped.showMore} />
      {history.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger>{t("memories.history", { count: history.length })}</CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="opacity-70">
              {historyCapped.shown.map((claim) => (
                <ClaimRow key={claim.id} claim={claim} />
              ))}
            </ul>
            <ShowMore hidden={historyCapped.hidden} onClick={historyCapped.showMore} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
