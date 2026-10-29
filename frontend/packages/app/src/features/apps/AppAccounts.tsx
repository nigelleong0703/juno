import type { AppDetail } from "@agent-desktop/client";
import { Button, ListRow } from "@agent-desktop/ui";
import { usePlatform } from "../../data/ClientProvider";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";

export interface AppAccountsProps {
  app: AppDetail;
  busy: boolean;
  onAddAnother: () => void;
  onSignInAgain: (installationId: string) => void;
  onRemove: (installation: { id: string; label: string }) => void;
  onCancelPending: (pendingId: string) => void;
}

/**
 * The accounts (work apps) or workspaces and bots (chat apps) the app is added with, the installs the platform is still finishing,
 * and "Add another". Remove asks first (the page confirms).
 */
export function AppAccounts({ app, busy, onAddAnother, onSignInAgain, onRemove, onCancelPending }: AppAccountsProps) {
  const { openExternal } = usePlatform();
  const chat = app.category === "chat";
  const capped = useCapped(app.installations, 6);
  if (app.installations.length === 0 && app.pending.length === 0) return null;
  const waiting = app.pending.filter((entry) => entry.status === "pending");
  return (
    <section id="app-accounts" aria-label={chat ? t("apps.workspaces") : t("apps.accounts")} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-fg">{chat ? t("apps.workspaces") : t("apps.accounts")}</h2>
      <ul className="flex flex-col">
        {capped.shown.map((installation) => {
          const signedOut = installation.status !== "connected";
          return (
            <li key={installation.id}>
              <ListRow
                dense
                title={installation.label}
                meta={signedOut ? <span className="text-warning">{t("apps.state.expired")}</span> : undefined}
                trailing={
                  <span className="flex items-center gap-1">
                    {signedOut && !chat ? (
                      <Button variant="ghost" size="xs" disabled={busy} onClick={() => onSignInAgain(installation.id)}>
                        {t("apps.signInAgain")}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="xs" aria-label={t("apps.removeNamed", { name: installation.label })} onClick={() => onRemove(installation)}>
                      {t("apps.remove")}
                    </Button>
                  </span>
                }
              />
            </li>
          );
        })}
        {waiting.map((entry) => (
          <li key={entry.id}>
            <ListRow
              dense
              title={t("apps.finishing")}
              trailing={
                <span className="flex items-center gap-1">
                  {entry.openUrl ? (
                    <Button variant="ghost" size="xs" onClick={() => openExternal(entry.openUrl ?? "")}>
                      {t("apps.openAgain")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="xs" onClick={() => onCancelPending(entry.id)}>
                    {t("common.cancel")}
                  </Button>
                </span>
              }
            />
          </li>
        ))}
      </ul>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
      {app.category === "custom" ? null : (
        <div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onAddAnother}>
            {chat ? t("apps.addAnotherWorkspace") : t("apps.addAnotherAccount")}
          </Button>
        </div>
      )}
    </section>
  );
}
