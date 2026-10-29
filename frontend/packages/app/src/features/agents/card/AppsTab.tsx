import type { ActionsPolicy, Agent, App, AppInstallation } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Label, ListRow, Section, Switch, toast } from "@agent-desktop/ui";
import { Check } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuthIdentity } from "../../../auth/AuthContext";
import { BrandIcon } from "../../../components/BrandIcon";
import { ChannelIcon } from "../../../components/channel/platforms";
import { useApps, useRemoveInstallation, useSetAgentApp, useSetWorkspaceAgent } from "../../../data/apps";
import { t } from "../../../lib/i18n";
import { enabledAgentIds, isAdded, policyOf } from "../../../lib/apps";
import { ChatConnectDialog } from "../../apps/chat/ChatConnectDialog";
import type { ChatKind } from "../../apps/chat/flows";
import { canEditAgent } from "../canEditAgent";
import { ShowMore, useCapped } from "./parts";

/** The Actions policies, as the dialog's single-select list offers them (title and one-line explanation) and as a row's subtitle words them. */
const POLICIES: { value: ActionsPolicy; choice: string; hint: string; state: string }[] = [
  { value: "ask", choice: "agentApps.choice.ask", hint: "agentApps.choice.askHint", state: "agentApps.state.ask" },
  { value: "allow", choice: "agentApps.choice.allow", hint: "agentApps.choice.allowHint", state: "agentApps.state.allow" },
  { value: "off", choice: "agentApps.choice.off", hint: "agentApps.choice.offHint", state: "agentApps.state.off" },
];

function toastError(error: unknown, fallback: string): void {
  toast.error(error instanceof Error && error.message ? error.message : fallback);
}

const signInExpired = (app: App): boolean => app.installations.some((installation) => installation.status !== "connected");

/** A row's subtitle: an expired sign-in first, else the Actions policy in words; an app with no change capability keeps its blurb. */
function appState(app: App, agentId: string): { text: string; warning: boolean } {
  if (signInExpired(app)) return { text: t("agentApps.signInAgain"), warning: true };
  if (!app.grants.actions) return { text: app.blurb, warning: false };
  const policy = POLICIES.find((entry) => entry.value === policyOf(app, agentId)) ?? POLICIES[0];
  return { text: t(policy?.state ?? ""), warning: false };
}

/**
 * "<Agent> can use": the work and custom apps the owner added, each a row with its switch and, under the name, what it may do
 * (the Actions policy in words). A tap on the row opens the app's dialog: the switch, and for an app that can change things the
 * single-select "When it changes things".
 */
function CanUse({ agent, apps, editable }: { agent: Agent; apps: App[]; editable: boolean }) {
  const setAgentApp = useSetAgentApp();
  const capped = useCapped(apps, 8);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const open = apps.find((app) => app.id === openId);
  return (
    <Section title={t("agentApps.canUse", { agent: agent.name })} description={t("agentApps.canUseHint")}>
      {apps.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("agentApps.noneAdded")}</p>
      ) : (
        <ul className="flex flex-col">
          {capped.shown.map((app) => {
            const on = enabledAgentIds(app).includes(agent.id);
            const state = appState(app, agent.id);
            return (
              <li key={app.id}>
                <ListRow
                  dense={false}
                  leading={<BrandIcon id={app.id} symbol={app.icon} className="size-9 rounded-lg" />}
                  title={app.name}
                  description={<span className={state.warning ? "text-warning" : undefined}>{state.text}</span>}
                  onClick={() => setOpenId(app.id)}
                  trailing={
                    // The switch is its own control: a tap on it must not open the dialog.
                    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                      <Switch
                        aria-label={t("agentApps.toggle", { app: app.name, agent: agent.name })}
                        checked={on}
                        disabled={!editable}
                        onCheckedChange={(enabled) => setAgentApp.mutate({ agentId: agent.id, appId: app.id, enabled }, { onError: (error) => toastError(error, t("apps.agentFailed")) })}
                      />
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
      {open ? <AppDialog app={open} agent={agent} editable={editable} onClose={() => setOpenId(undefined)} /> : null}
    </Section>
  );
}

/**
 * One app for this agent, titled with the app's name: the switch "<Agent> can use <App>" and, only for an app that can change things,
 * the single-select "When it changes things" (Ask first, Allow, Don't allow changes). Every change is sent at once; there is no confirm.
 */
function AppDialog({ app, agent, editable, onClose }: { app: App; agent: Agent; editable: boolean; onClose: () => void }) {
  const setAgentApp = useSetAgentApp();
  const on = enabledAgentIds(app).includes(agent.id);
  const policy = policyOf(app, agent.id);
  const send = (input: { enabled: boolean; actionsPolicy?: ActionsPolicy }) =>
    setAgentApp.mutate({ agentId: agent.id, appId: app.id, ...input }, { onError: (error) => toastError(error, t("apps.agentFailed")) });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{app.name}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`agent-app-${app.id}`} className="text-sm font-medium text-fg">
            {t("agentApps.use", { agent: agent.name, app: app.name })}
          </Label>
          <Switch id={`agent-app-${app.id}`} checked={on} disabled={!editable} onCheckedChange={(enabled) => send({ enabled })} />
        </div>
        {app.grants.actions ? (
          <section aria-labelledby={`agent-app-changes-${app.id}`} className="flex flex-col gap-1">
            <h3 id={`agent-app-changes-${app.id}`} className="text-sm font-semibold text-fg">
              {t("agentApps.changes")}
            </h3>
            <ul role="radiogroup" aria-labelledby={`agent-app-changes-${app.id}`} className="flex flex-col">
              {POLICIES.map((entry) => (
                <li key={entry.value} className={on ? undefined : "opacity-50"}>
                  <ListRow
                    role="radio"
                    dense={false}
                    selected={policy === entry.value}
                    title={t(entry.choice)}
                    description={<span className="block whitespace-normal">{t(entry.hint, { agent: agent.name })}</span>}
                    trailing={policy === entry.value ? <Check className="size-4 text-fg" aria-hidden="true" /> : <span className="size-4" />}
                    onClick={!on || !editable ? undefined : () => send({ enabled: true, actionsPolicy: entry.value })}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Place = { app: App; installation: AppInstallation; inside: boolean; own: boolean; handle: string | null };

/** The workspaces of the added chat apps, each with whether this agent is in it. */
function placesOf(chatApps: App[], agent: Agent): Place[] {
  return chatApps.flatMap((app) =>
    app.installations
      // Another agent's own bot is not a place to reach this one.
      .filter((installation) => installation.agentId === undefined || installation.agentId === agent.id)
      .map((installation) => {
        const entry = installation.agents.find((candidate) => candidate.agentId === agent.id);
        const own = installation.agentId === agent.id;
        return { app, installation, inside: own || entry !== undefined, own, handle: entry?.handle ?? null };
      }),
  );
}

/** "Where people reach <Agent>": its workspaces and bots with the @handle people use, Add for the ones it is not in, and the way to more platforms. */
function Reach({ agent, apps, editable }: { agent: Agent; apps: App[]; editable: boolean }) {
  const navigate = useNavigate();
  const setWorkspaceAgent = useSetWorkspaceAgent();
  const remove = useRemoveInstallation();
  const [ownBot, setOwnBot] = useState(false);
  const [reconnect, setReconnect] = useState<ChatKind | null>(null);
  const places = placesOf(apps, agent);
  const capped = useCapped(places, 8);
  return (
    <Section title={t("agentApps.reach", { agent: agent.name })} description={t("agentApps.reachHint")}>
      {places.length === 0 ? <p className="text-sm text-fg-muted">{t("agentApps.noPlaces")}</p> : null}
      <ul className="flex flex-col">
        {capped.shown.map(({ app, installation, inside, own, handle }) => {
          // A Slack or Discord bot made with the agent's own token can no longer run: it comes back through the shared Juno app.
          const needsShared = own && installation.status !== "connected" && (app.id === "slack" || app.id === "discord");
          const statusMessage = installation.agents.find((entry) => entry.agentId === agent.id)?.statusMessage;
          return (
          <li key={installation.id}>
            <ListRow
              leading={<ChannelIcon kind={app.id} className="size-9" />}
              title={`${app.name} · ${installation.label}`}
              description={
                <span className={statusMessage || needsShared ? "text-warning" : undefined}>
                  {needsShared ? t("agentApps.reconnectShared") : (statusMessage ?? (handle ? `@${handle}` : own ? t("agentApps.ownBot") : t("agentApps.notIn", { agent: agent.name })))}
                </span>
              }
              trailing={
                own ? (
                  <span className="flex items-center gap-1">
                    {needsShared ? (
                      <Button variant="secondary" size="xs" disabled={!editable} onClick={() => setReconnect(app.id as ChatKind)}>
                        {t("agentApps.reconnect")}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="xs" disabled={!editable || remove.isPending} onClick={() => remove.mutate({ appId: app.id, installationId: installation.id }, { onError: (error) => toastError(error, t("apps.removeFailed")) })}>
                      {t("apps.remove")}
                    </Button>
                  </span>
                ) : inside ? (
                  <Switch
                    aria-label={t("agentApps.toggleIn", { agent: agent.name, place: installation.label })}
                    checked
                    disabled={!editable || setWorkspaceAgent.isPending}
                    onCheckedChange={() => setWorkspaceAgent.mutate({ appId: app.id, installationId: installation.id, agentId: agent.id, enabled: false }, { onError: (error) => toastError(error, t("apps.agentFailed")) })}
                  />
                ) : (
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={!editable || setWorkspaceAgent.isPending}
                    onClick={() => setWorkspaceAgent.mutate({ appId: app.id, installationId: installation.id, agentId: agent.id, enabled: true }, { onError: (error) => toastError(error, t("apps.agentFailed")) })}
                  >
                    {t("agentApps.add", { agent: agent.name })}
                  </Button>
                )
              }
            />
          </li>
          );
        })}
      </ul>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/apps")}>
          {t("agentApps.moreInApps")}
        </Button>
        {editable ? (
          <Button variant="ghost" size="sm" onClick={() => setOwnBot(true)}>
            {t("agentApps.ownBotAdd", { agent: agent.name })}
          </Button>
        ) : null}
      </div>
      {ownBot ? <ChatConnectDialog open onOpenChange={setOwnBot} agentId={agent.id} /> : null}
      {reconnect ? <ChatConnectDialog open onOpenChange={() => setReconnect(null)} kind={reconnect} /> : null}
    </Section>
  );
}

/** The agent's Apps tab (replaces Channels): which added apps it may use, and where people reach it. Only the owner changes them. */
export function AppsTab({ agent }: { agent: Agent }) {
  const identity = useAuthIdentity();
  const editable = canEditAgent(agent, identity?.mode === "account" ? identity.user.id : undefined);
  const { data } = useApps();
  const apps = data ?? [];
  return (
    <div className="flex flex-col gap-8 px-2">
      <CanUse agent={agent} apps={apps.filter((app) => app.category !== "chat" && app.category !== "web" && isAdded(app))} editable={editable} />
      <Reach agent={agent} apps={apps.filter((app) => app.category === "chat" && isAdded(app))} editable={editable} />
    </div>
  );
}
