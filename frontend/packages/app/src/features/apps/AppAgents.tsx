import type { ActionsPolicy, Agent, AppDetail, AppInstallation, AppProblem } from "@agent-desktop/client";
import { SegmentedControl, cn, toast } from "@agent-desktop/ui";
import { Check, Plus } from "lucide-react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useSetAgentApp, useSetWorkspaceAgent } from "../../data/apps";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { appProblem, enabledAgentIds, policyOf } from "../../lib/apps";

function toastError(error: unknown, fallback: string): void {
  toast.error(error instanceof Error && error.message ? error.message : fallback);
}

/** An agent as a tappable avatar: a check badge when it is on, faded with a plus when it is off. */
function AgentToggle({ agent, on, disabled, onToggle }: { agent: Agent; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t(on ? "apps.agentOn" : "apps.agentOff", { agent: agent.name })}
      disabled={disabled}
      onClick={onToggle}
      className={cn("flex flex-col items-center gap-1 focus-ring rounded-lg", !on && "opacity-55 grayscale")}
    >
      <span className="relative flex size-[52px] items-center justify-center">
        <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={50} />
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 flex size-[19px] items-center justify-center rounded-full border-2 border-bg text-white",
            on ? "bg-success" : "bg-fg",
          )}
        >
          {on ? <Check className="size-2.5" strokeWidth={3.6} aria-hidden /> : <Plus className="size-2.5 text-bg" strokeWidth={3.6} aria-hidden />}
        </span>
      </span>
      <span className="max-w-16 truncate text-xs font-medium text-fg">{agent.name}</span>
    </button>
  );
}

/**
 * Which agents may use the app. A work or custom app is one row of avatars (on means the agent has the app). A chat app has one row
 * per workspace: on means the agent is in that workspace and people can @-mention it there.
 */
export function AppAgents({ app, agents }: { app: AppDetail; agents: Agent[] }) {
  const setAgent = useSetAgentApp();
  const setWorkspaceAgent = useSetWorkspaceAgent();
  if (app.installations.length === 0 || agents.length === 0) return null;

  if (app.category === "chat") {
    return (
      <>
        {app.installations.map((installation) => (
          <WorkspaceRow
            key={installation.id}
            title={app.installations.length > 1 || installation.label ? t("apps.agentsIn", { place: installation.label }) : t("apps.agentsIn", { place: app.name })}
            installation={installation}
            agents={agents}
            busy={setWorkspaceAgent.isPending}
            onToggle={(agent, on) =>
              setWorkspaceAgent.mutate(
                { appId: app.id, installationId: installation.id, agentId: agent.id, enabled: on },
                { onError: (error) => toastError(error, t("apps.agentFailed")) },
              )
            }
          />
        ))}
      </>
    );
  }
  const on = new Set(enabledAgentIds(app));
  return (
    <section aria-label={t("apps.agentsUse")} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg">{t("apps.agentsUse")}</h2>
      <div className="flex flex-wrap gap-[18px]">
        {agents.map((agent) => (
          <AgentToggle
            key={agent.id}
            agent={agent}
            on={on.has(agent.id)}
            disabled={setAgent.isPending}
            onToggle={() =>
              setAgent.mutate({ agentId: agent.id, appId: app.id, enabled: !on.has(agent.id) }, { onError: (error) => toastError(error, t("apps.agentFailed")) })
            }
          />
        ))}
      </div>
    </section>
  );
}

function WorkspaceRow({
  title,
  installation,
  agents,
  busy,
  onToggle,
}: {
  title: string;
  installation: AppInstallation;
  agents: Agent[];
  busy: boolean;
  onToggle: (agent: Agent, on: boolean) => void;
}) {
  const inside = new Map(installation.agents.map((entry) => [entry.agentId, entry]));
  // An agent's own bot belongs to that agent alone: it is shown, not switched.
  const own = installation.agentId;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      <div className="flex flex-wrap gap-[18px]">
        {agents.map((agent) => (
          <AgentToggle
            key={agent.id}
            agent={agent}
            on={own ? own === agent.id : inside.has(agent.id)}
            disabled={busy || own !== undefined}
            onToggle={() => onToggle(agent, !inside.has(agent.id))}
          />
        ))}
      </div>
      {installation.agents.map((entry) =>
        entry.statusMessage ? (
          <p key={entry.agentId} className="text-xs text-warning">
            {entry.statusMessage}
          </p>
        ) : null,
      )}
    </section>
  );
}

const POLICIES: { value: ActionsPolicy; label: string }[] = [
  { value: "ask", label: "apps.policy.ask" },
  { value: "allow", label: "apps.policy.allow" },
  { value: "off", label: "apps.policy.off" },
];

/** The agent's one access state for the app, in the words the connect card uses (`ready` when nothing is in the way). */
const access = (app: AppDetail, agentId: string): AppProblem | "ready" => appProblem(app, agentId) ?? "ready";

/** What each agent that has the app may change through it: Ask first (the default), Allow, or Off (the tools are hidden). */
export function AppActions({ app, agents }: { app: AppDetail; agents: Agent[] }) {
  const setAgent = useSetAgentApp();
  const on = new Set(enabledAgentIds(app));
  const capped = useCapped(
    agents.filter((agent) => on.has(agent.id)),
    6,
  );
  if (app.category === "chat" || !app.grants.actions || capped.shown.length === 0) return null;
  return (
    <section aria-label={t("apps.actions")} className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">{t("apps.actions")}</h2>
        <p className="mt-0.5 text-sm text-fg-muted">{t("apps.actionsHint")}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {capped.shown.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-3">
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{agent.name}</span>
              <span className={access(app, agent.id) === "ready" ? "block truncate text-xs text-fg-muted" : "block truncate text-xs text-warning"}>{t(`apps.access.${access(app, agent.id)}`)}</span>
            </span>
            <SegmentedControl
              aria-label={t("apps.actionsFor", { agent: agent.name })}
              value={policyOf(app, agent.id)}
              disabled={setAgent.isPending}
              onValueChange={(value) => {
                const next = POLICIES.find((entry) => entry.value === value)?.value;
                if (next) setAgent.mutate({ agentId: agent.id, appId: app.id, enabled: true, actionsPolicy: next }, { onError: (error) => toastError(error, t("apps.agentFailed")) });
              }}
              items={POLICIES.map((entry) => ({ value: entry.value, label: t(entry.label) }))}
            />
          </li>
        ))}
      </ul>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}
