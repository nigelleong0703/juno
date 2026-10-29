import type { DecisionCategory, Request, RequestOutcome } from "@agent-desktop/client";
import { Badge, Button, Section, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@agent-desktop/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { briefOf, categoryLabel, factsOf, keyConsequence, outcomeLabel } from "../../../components/request/decision";
import { LiveRequestCard } from "../../../components/request/LiveRequestCard";
import { PlatformIcon } from "../../../components/request/PlatformIcon";
import { useRequestHistory } from "../../../data/tasks";
import { formatAgo } from "../../../lib/format";
import { t } from "../../../lib/i18n";

const HISTORY_PAGE = 8;
const CATEGORIES: DecisionCategory[] = ["spending", "speaking", "public", "committing", "irreversible", "sensitive", "sharing", "setup", "choice"];
const OUTCOMES: RequestOutcome[] = ["allowed_once", "allowed_rule", "denied", "revised", "timed_out", "cancelled", "handed_back"];

/** A compact filter menu: "All" or one value. */
function FilterMenu<T extends string>({ label, value, values, name, onChange }: { label: string; value: T | "all"; values: readonly T[]; name: (value: T) => string; onChange: (value: T | "all") => void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T | "all")}>
      <SelectTrigger size="sm" aria-label={label} className="h-8 gap-1 border-0 bg-transparent px-2 text-fg-muted shadow-none hover:bg-transparent">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectItem value="all">{`${label}: ${t("decision.history.all")}`}</SelectItem>
        {values.map((entry) => (
          <SelectItem key={entry} value={entry}>
            {name(entry)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A decided request as a row: platform icon, the sentence, its key consequence, how it ended and when; a tap opens why and the facts. */
function HistoryRow({ request }: { request: Request }) {
  const [open, setOpen] = useState(false);
  const brief = briefOf(request);
  if (!brief || !request.outcome) return <LiveRequestCard request={request} />;
  const category = brief.primary ?? brief.categories[0];
  const meta = [keyConsequence(brief), outcomeLabel(request.outcome), formatAgo(request.resolvedAt ?? request.decision?.at)].filter(Boolean).join(" · ");
  return (
    <div className="rounded-xl bg-muted">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-ring">
        <PlatformIcon platform={brief.platform} category={category} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{brief.sentence}</span>
          <span className="block truncate text-xs text-fg-muted">{meta}</span>
        </span>
        {category ? (
          <Badge variant="outline" className="shrink-0 px-2 py-0 text-[11px] font-normal text-fg-muted">
            {categoryLabel(category)}
          </Badge>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 px-3 pb-3 text-[13px] leading-[18px] text-fg-muted">
          {brief.why ? <p>{brief.why}</p> : null}
          {brief.ifDenied ? <p>{t("decision.ifDenied", { text: brief.ifDenied })}</p> : null}
          {factsOf(brief).map((fact) => (
            <p key={fact.id} className={fact.declared ? "text-fg-subtle" : undefined}>
              {fact.text}
              {fact.declared ? ` · ${t("decision.fact.agentSays")}` : ""}
            </p>
          ))}
          {request.decision?.note ? <p className="text-fg">{request.decision.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Rule-allowed decisions that follow each other fold into one row, so a busy agent does not drown the history. */
function AutoGroup({ requests }: { requests: Request[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-10 items-center gap-2 rounded-xl bg-muted px-3 text-left text-sm text-fg-muted focus-ring">
        <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
        {t("decision.history.autoGroup", { count: requests.length })}
      </button>
      {open ? requests.map((request) => <HistoryRow key={request.id} request={request} />) : null}
    </div>
  );
}

type Entry = { requests: Request[]; auto: boolean };

/** Consecutive `allowed_rule` rows (two or more) become one group; every other row stands alone. */
function groupAutoAllowed(requests: Request[]): Entry[] {
  const out: Entry[] = [];
  for (const request of requests) {
    const auto = request.outcome === "allowed_rule" && briefOf(request) !== undefined;
    const last = out[out.length - 1];
    if (auto && last?.auto) last.requests.push(request);
    else out.push({ requests: [request], auto });
  }
  return out;
}

/** The agent's decided requests, newest first: filter by kind and result, eight at a time. */
export function DecisionHistory({ agentId }: { agentId: string }) {
  const [category, setCategory] = useState<DecisionCategory | "all">("all");
  const [outcome, setOutcome] = useState<RequestOutcome | "all">("all");
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const history = useRequestHistory(agentId, HISTORY_PAGE, { ...(category === "all" ? {} : { category }), ...(outcome === "all" ? {} : { outcome }) });
  const past = history.data?.pages.flatMap((page) => page.items) ?? [];
  const showMore = () => {
    setLimit(limit + HISTORY_PAGE);
    if (past.length < limit + HISTORY_PAGE && history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  };
  return (
    <Section
      title={t("perm.history")}
      contentClassName="flex flex-col gap-2.5"
      actions={
        <>
          <FilterMenu label={t("decision.history.filterCategory")} value={category} values={CATEGORIES} name={categoryLabel} onChange={setCategory} />
          <FilterMenu label={t("decision.history.filterOutcome")} value={outcome} values={OUTCOMES} name={outcomeLabel} onChange={setOutcome} />
        </>
      }
    >
      {past.length ? (
        groupAutoAllowed(past.slice(0, limit)).map((entry) =>
          entry.auto && entry.requests.length > 1 ? <AutoGroup key={entry.requests[0]?.id} requests={entry.requests} /> : entry.requests.map((request) => <HistoryRow key={request.id} request={request} />),
        )
      ) : (
        <p className="text-sm text-fg-subtle">{history.isLoading ? t("common.loading") : category === "all" && outcome === "all" ? t("perm.historyEmpty") : t("decision.history.nothing")}</p>
      )}
      {past.length > limit || history.hasNextPage ? (
        <Button variant="secondary" className="w-full" disabled={history.isFetchingNextPage} onClick={showMore}>
          {t("common.showMore")}
        </Button>
      ) : null}
    </Section>
  );
}
