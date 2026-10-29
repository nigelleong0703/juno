import type { App } from "@agent-desktop/client";
import { Button, EmptyState, ErrorState, ListRow, LoadingState, PageHeader, ScrollArea, SearchField, SegmentedControl, toast } from "@agent-desktop/ui";
import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BrandIcon } from "../../components/BrandIcon";
import { useApps } from "../../data/apps";
import { t } from "../../lib/i18n";
import { SuggestionCard } from "../ideas/SuggestionCard";
import { APP_PILLS, APP_ROWS, defaultPill, featuredApps, filterApps, isAdded, rowState, type AppPill } from "../../lib/apps";
import { CustomAppDialog } from "./CustomAppDialog";
import { MacRow, macRowMatches } from "./MacRow";

/** One app: brand icon, name, one-line blurb, its state ("Sign in" in the warning colour) and a chevron. No box. */
export function AppRow({ app, onOpen }: { app: App; onOpen: () => void }) {
  const state = rowState(app);
  return (
    <ListRow
      onClick={onOpen}
      className="py-2.5"
      leading={<BrandIcon id={app.id} symbol={app.icon} className="size-11 rounded-xl" />}
      title={app.name}
      description={app.blurb}
      trailing={
        <span className="flex items-center gap-2">
          {state === "sign-in" ? <span className="text-xs text-warning">{t("apps.state.signIn")}</span> : null}
          {state === "coming-soon" ? <span className="text-xs text-fg-subtle">{t("apps.state.comingSoon")}</span> : null}
          <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
        </span>
      }
    />
  );
}

/** The banner row: apps with prompts to try, scrolling sideways; the lead is the first. */
function Featured({ apps, onOpen }: { apps: App[]; onOpen: (app: App) => void }) {
  if (apps.length === 0) return null;
  return (
    <section aria-label={t("apps.featured")} className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-1">
      {apps.map((app) => (
        <SuggestionCard
          key={app.id}
          className="w-72 shrink-0"
          fallbackLeading={<BrandIcon id={app.id} symbol={app.icon} className="size-9 rounded-lg" />}
          title={app.name}
          reason={app.tryAsking[0] ?? app.blurb}
          actionLabel={isAdded(app) ? t("apps.open") : t("apps.add")}
          onAction={() => onOpen(app)}
        />
      ))}
    </section>
  );
}

const PILL_LABEL: Record<AppPill, string> = {
  connected: "apps.pill.connected",
  chat: "apps.pill.chat",
  work: "apps.pill.work",
  web: "apps.pill.web",
};

/**
 * Apps: every integration the owner can give their agents, in one directory (a chat platform, a work app, later web and video).
 * Rows open the app; adding, signing in and per-agent switches are on its page. The OAuth return lands here with `?status=`.
 */
export function AppsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, isLoading, isError, refetch } = useApps();
  const [query, setQuery] = useState("");
  const [pill, setPill] = useState<AppPill | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [custom, setCustom] = useState(false);

  // The sign-in page returns here with ?status=; say how it went once, then drop the query.
  const status = params.get("status");
  useEffect(() => {
    if (status === null) return;
    if (status === "connected") toast(t("apps.signedIn"));
    else toast.error(t("apps.signInFailed"));
    const next = new URLSearchParams(params);
    next.delete("status");
    next.delete("connection");
    setParams(next, { replace: true });
  }, [status, params, setParams]);

  const apps = useMemo(() => data ?? [], [data]);
  const active = pill ?? defaultPill(apps);
  const visible = useMemo(() => filterApps(apps, active, query), [apps, active, query]);
  const shown = showAll || query.trim() !== "" ? visible : visible.slice(0, APP_ROWS);
  const open = (app: App) => navigate(`/apps/${encodeURIComponent(app.id)}`);
  const showMac = query.trim() === "" ? active === "work" : macRowMatches(query);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader title={t("apps.title")} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pb-10 pt-2">
          <SearchField size="md" value={query} onValueChange={setQuery} placeholder={t("apps.search")} />
          {isLoading ? (
            <LoadingState label={t("common.loading")} />
          ) : isError ? (
            <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
          ) : (
            <>
              {query.trim() === "" ? <Featured apps={featuredApps(apps)} onOpen={open} /> : null}
              {query.trim() === "" ? (
                <SegmentedControl
                  aria-label={t("apps.categories")}
                  value={active}
                  onValueChange={(value) => {
                    setPill(APP_PILLS.find((entry) => entry === value) ?? "chat");
                    setShowAll(false);
                  }}
                  items={APP_PILLS.map((entry) => ({ value: entry, label: t(PILL_LABEL[entry]) }))}
                />
              ) : null}
              {visible.length === 0 ? (
                <EmptyState
                  title={query.trim() ? t("apps.noMatch") : active === "connected" ? t("apps.noneAdded") : t("apps.noneHere")}
                  description={query.trim() ? t("apps.noMatchHint") : active === "connected" ? t("apps.noneAddedHint") : undefined}
                />
              ) : (
                <ul className="flex flex-col">
                  {shown.map((app) => (
                    <li key={app.id}>
                      <AppRow app={app} onOpen={() => open(app)} />
                    </li>
                  ))}
                </ul>
              )}
              {showMac ? <MacRow /> : null}
              {visible.length > shown.length ? (
                <div className="flex justify-center">
                  <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                    {t("common.showMore")} ({visible.length - shown.length})
                  </Button>
                </div>
              ) : null}
              {active === "work" && query.trim() === "" ? (
                <div>
                  <Button variant="ghost" size="sm" onClick={() => setCustom(true)}>
                    <Plus className="size-3.5" />
                    {t("apps.custom.title")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
      {custom ? <CustomAppDialog onClose={() => setCustom(false)} /> : null}
    </div>
  );
}
