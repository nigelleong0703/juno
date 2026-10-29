import type { AppDetail } from "@agent-desktop/client";
import type { HttpError } from "@agent-desktop/client/http";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  toast,
} from "@agent-desktop/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { BrandIcon } from "../../components/BrandIcon";
import { usePlatform } from "../../data/ClientProvider";
import { useApp, useInstallApp, useOpenInstall, useRemoveInstallation, useReviewAppTools } from "../../data/apps";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import { useUiStore } from "../../store/ui";
import { DetailPage } from "../../templates/DetailPage";
import { ShowMore, useCapped } from "../agents/card/parts";
import { AppAccounts } from "./AppAccounts";
import { AppActions, AppAgents } from "./AppAgents";
import { canAdd, expiredInstallation, isAdded, sourceNote, stateLabel } from "../../lib/apps";
import { ChatConnectDialog } from "./chat/ChatConnectDialog";
import type { ChatKind } from "./chat/flows";
import { ConfigDialog } from "./ConfigDialog";

const CATEGORY_NAME: Record<AppDetail["category"], string> = {
  chat: "apps.pill.chat",
  work: "apps.pill.work",
  web: "apps.pill.web",
  custom: "apps.category.custom",
};

const STATE_NAME = {
  connected: "apps.state.connected",
  "sign-in": "apps.state.signIn",
  "not-added": "apps.state.notAdded",
  "coming-soon": "apps.state.comingSoon",
} as const;

const CHAT_KINDS: readonly string[] = ["telegram", "slack", "discord", "feishu"];

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-fg">{children}</span>
    </div>
  );
}

/** What to confirm before removing: one account or workspace, or the whole app. */
type Removal = { kind: "installation"; id: string; label: string } | { kind: "app" };

/**
 * One app: its icon and state with Connect (or Manage), what it is, things to try asking, which agents may use it, what they can do
 * through it (Read or Asks first, and the Actions policy per agent), the accounts or workspaces, and who makes it.
 */
export function AppDetailPage() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { openExternal } = usePlatform();
  const [waiting, setWaiting] = useState(false);
  const { data: app, isLoading, isError, refetch } = useApp(appId, waiting);
  const { data: agents } = useAgents();
  const install = useInstallApp();
  const openInstall = useOpenInstall();
  const remove = useRemoveInstallation();
  const review = useReviewAppTools();
  const setStarterText = useUiStore((state) => state.setStarterText);
  const [config, setConfig] = useState<{ connectionId?: string } | null>(null);
  const [chat, setChat] = useState(false);
  const [removing, setRemoving] = useState<Removal | null>(null);
  const capabilities = useCapped(app?.capabilities ?? [], 8);

  // After a sign-in page opens, watch the app until its accounts change (or give up after five minutes).
  const before = useRef("");
  const signature = app ? app.installations.map((entry) => `${entry.id}:${entry.status}`).join(",") : "";
  useEffect(() => {
    if (!waiting) return;
    if (signature !== before.current) {
      setWaiting(false);
      toast(t("apps.signedIn"));
      return;
    }
    const timer = window.setTimeout(() => setWaiting(false), 300_000);
    return () => window.clearTimeout(timer);
  }, [waiting, signature]);

  if (!app) {
    return (
      <DetailPage title={t("apps.title")} backTo="/apps" isLoading={isLoading} isError={isError} notFound={!isLoading && !isError} onRetry={() => void refetch()}>
        {null}
      </DetailPage>
    );
  }

  const state = stateLabel(app);
  const added = isAdded(app);
  const chatKind = CHAT_KINDS.includes(app.id) ? (app.id as ChatKind) : null;

  /** Start adding the app (or signing in again to one account). */
  const start = (connectionId?: string) => {
    if (app.category === "chat") {
      setChat(true);
      return;
    }
    if (app.userConfig.length > 0) {
      setConfig(connectionId ? { connectionId } : {});
      return;
    }
    install.mutate(
      { appId: app.id, input: connectionId ? { connectionId } : {} },
      {
        onSuccess: (response) => {
          if (response.openUrl) {
            before.current = signature;
            setWaiting(true);
          }
          openInstall(response, app.name);
        },
        onError: (error) => {
          if ((error as Partial<HttpError>).code === "CONNECTOR_CONFIG_REQUIRED") setConfig(connectionId ? { connectionId } : {});
          else toast.error(error instanceof Error && error.message ? error.message : t("apps.addFailed"));
        },
      },
    );
  };

  const confirmRemove = () => {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    const ids = target.kind === "app" ? app.installations.map((entry) => entry.id) : [target.id];
    for (const id of ids) {
      remove.mutate(
        { appId: app.id, installationId: id },
        { onError: (error) => toast.error(error instanceof Error && error.message ? error.message : t("apps.removeFailed")) },
      );
    }
  };

  const expired = expiredInstallation(app);
  const primary = (() => {
    if (state === "coming-soon") return <Button size="sm" disabled>{t("apps.state.comingSoon")}</Button>;
    if (!canAdd(app)) return <Button size="sm" disabled>{t("apps.unavailable")}</Button>;
    if (expired && app.category !== "chat") return <Button size="sm" disabled={install.isPending} onClick={() => start(expired.id)}>{t("apps.signInAgain")}</Button>;
    if (added) return <Button variant="secondary" size="sm" onClick={() => document.getElementById("app-accounts")?.scrollIntoView({ behavior: "smooth" })}>{t("apps.manage")}</Button>;
    return <Button size="sm" disabled={install.isPending} onClick={() => start()}>{t("apps.connect")}</Button>;
  })();

  const links = [
    { label: t("apps.info.website"), url: app.websiteUrl },
    { label: t("apps.info.privacy"), url: app.privacyPolicyUrl },
    { label: t("apps.info.terms"), url: app.termsOfServiceUrl },
  ].filter((entry): entry is { label: string; url: string } => entry.url !== undefined);

  return (
    <DetailPage title={t("apps.title")} backTo="/apps">
      <div className="flex flex-col gap-7">
        <header className="flex items-center gap-4">
          <BrandIcon id={app.id} symbol={app.icon} className="size-16 rounded-2xl" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold tracking-tight text-fg">{app.name}</h1>
            <p className="text-sm text-fg-muted">
              {t(CATEGORY_NAME[app.category])} · <span className={state === "sign-in" ? "text-warning" : undefined}>{t(STATE_NAME[state])}</span>
            </p>
          </div>
          {primary}
        </header>
        {sourceNote(app) ? <p className="-mt-3 text-sm text-fg-muted">{sourceNote(app)}</p> : null}
        {!app.available && state !== "coming-soon" ? <p className="-mt-3 text-sm text-fg-muted">{t("apps.notConfigured")}</p> : null}
        {waiting ? <p className="-mt-3 text-sm text-fg-muted">{t("apps.waitingSignIn")}</p> : null}

        <p className="text-base leading-relaxed text-fg">{app.description}</p>

        {app.tryAsking.length > 0 ? (
          <section aria-label={t("apps.tryAsking")} className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-fg">{t("apps.tryAsking")}</h2>
            <div className="flex flex-wrap gap-2">
              {app.tryAsking.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-2xl bg-muted px-3.5 py-2.5 text-left text-sm text-fg transition-colors hover:bg-interactive-hover focus-ring"
                  onClick={() => {
                    setStarterText(prompt);
                    navigate("/new");
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <AppAgents app={app} agents={agents ?? []} />

        {app.category === "web" && app.capabilities.length === 0 ? <p className="text-sm text-fg-muted">{t("apps.webNoSignIn")}</p> : null}
        {app.capabilities.length > 0 ? (
          <section aria-label={t("apps.canDo")} className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-fg">{t("apps.canDo")}</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {capabilities.shown.map((capability) => (
                <li key={capability.name} className="flex items-baseline justify-between gap-4">
                  <span className="min-w-0 text-fg">
                    {capability.title}
                    {capability.needsReview ? <span className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">{t("apps.new")}</span> : null}
                  </span>
                  <span className={capability.kind === "read" ? "shrink-0 text-fg-subtle" : "shrink-0 text-warning"}>
                    {capability.kind === "read" ? t("apps.read") : app.grants.actions ? t("apps.asksFirst") : t("apps.changes")}
                  </span>
                </li>
              ))}
            </ul>
            <ShowMore hidden={capabilities.hidden} onClick={capabilities.showMore} />
            {app.capabilities.some((capability) => capability.needsReview) ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-sm text-fg-muted">{t("apps.reviewHint")}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={review.isPending}
                  onClick={() => review.mutate({ appId: app.id }, { onError: (error) => toast.error(error instanceof Error && error.message ? error.message : t("apps.agentFailed")) })}
                >
                  {t("apps.markReviewed")}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        <AppActions app={app} agents={agents ?? []} />

        <AppAccounts
          app={app}
          busy={install.isPending || remove.isPending}
          onAddAnother={() => start()}
          onSignInAgain={(id) => start(id)}
          onRemove={(installation) => setRemoving({ kind: "installation", ...installation })}
          onCancelPending={(id) => remove.mutate({ appId: app.id, installationId: id })}
        />

        <section aria-label={t("apps.information")} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-fg">{t("apps.information")}</h2>
          <Info label={t("apps.info.category")}>{t(CATEGORY_NAME[app.category])}</Info>
          {app.developerName ? <Info label={t("apps.info.madeBy")}>{app.developerName}</Info> : null}
          {links.map((link) => (
            <Info key={link.label} label={link.label}>
              <button type="button" className="underline hover:text-fg-muted focus-ring" onClick={() => openExternal(link.url)}>
                {new URL(link.url).hostname}
              </button>
            </Info>
          ))}
        </section>

        {added ? (
          <div>
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRemoving({ kind: "app" })}>
              {t("apps.removeApp")}
            </Button>
          </div>
        ) : null}
      </div>

      {config ? (
        <ConfigDialog
          app={app}
          {...(config.connectionId ? { connectionId: config.connectionId } : {})}
          onClose={() => setConfig(null)}
          onDone={(response) => {
            setConfig(null);
            if (response.openUrl) {
              before.current = signature;
              setWaiting(true);
            }
            openInstall(response, app.name);
          }}
        />
      ) : null}
      {chatKind ? <ChatConnectDialog open={chat} onOpenChange={setChat} kind={chatKind} /> : null}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{removing?.kind === "installation" ? t("apps.removeNamed", { name: removing.label }) : t("apps.removeApp")}</AlertDialogTitle>
          <AlertDialogDescription>
            {removing?.kind === "installation" ? t("apps.removeInstallationConfirm", { name: app.name }) : t("apps.removeAppConfirm", { name: app.name })}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>{t("apps.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPage>
  );
}
