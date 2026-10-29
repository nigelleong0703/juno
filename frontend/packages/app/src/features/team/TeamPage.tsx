import type { Agent, Goal } from "@agent-desktop/client";
import { ScrollArea, SegmentedControl } from "@agent-desktop/ui";
import { Bot, Brain, ChevronLeft, Plus, Search, UserRound } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { PageAction, PageFrame } from "../../components/page/PageFrame";
import { useAgents, useGoals } from "../../data/queries";
import { CHARACTER_TINT, agentCharacter } from "../../lib/avatars";
import { agentRole } from "../../lib/agentRole";
import { agentStatusMeta, statusLabel } from "../../lib/status";
import { t } from "../../lib/i18n";
import { Aurora } from "../chat/ReturningWelcome";
import { goalsProgress } from "../goals/labels";
import { GLOW_TINTS } from "../today/Inspiration";
import { ShowMore, useCapped, useDoingLine } from "../agents/card/parts";
import { useWideLayout } from "../../lib/useSplitSelection";
import { SettingsPage } from "../../templates/SettingsPage";
import { MATCHES_ID, PeopleSegment, PersonMenu } from "./PeopleSegment";
import { MemoryHeaderLine, MemorySegment, REVIEW_ID, SEARCH_ID } from "./MemorySegment";

/** The three Team segments, in order. The first one is the default. */
const SEGMENTS = ["agents", "people", "memory"] as const;
type Segment = (typeof SEGMENTS)[number];

/** Agents per page before "Show more". */
const AGENT_LIMIT = 10;

/**
 * Team (owner-approved 2026-10-26, "No boxes"): the agents, the people and the memory the agents keep. The segment is the
 * second path part (`/team/agents`, `/team/people`, `/team/memory`), so the segmented control survives a reload and the
 * browser back button; a third part opens one person (`/team/people/:id`), the possible matches (`/team/people/matches`) or
 * one of Memory's screens (`/team/memory/review`, `/team/memory/search`) as a page of its own. Agents and Memory sit under the aurora wash.
 */
export function TeamPage() {
  const navigate = useNavigate();
  const params = useParams();
  const segment = params.segment;
  const active: Segment = (SEGMENTS as readonly string[]).includes(segment ?? "") ? (segment as Segment) : "agents";
  // Memory has no item pages any more (a fact opens a sheet): only its review and search screens are sub-pages.
  const memoryScreen = params.id === REVIEW_ID || params.id === SEARCH_ID;
  const detailId = active === "agents" ? undefined : active === "memory" && !memoryScreen ? undefined : params.id;
  // Wide screens list the three segments as sub-items in a sidebar, as Library and Settings do; narrow screens keep the
  // segmented control at the top of the page.
  const wide = useWideLayout();
  const select = (value: string) => navigate(`/team/${value}`);
  const { data: agents } = useAgents();
  const { data: goals } = useGoals();

  const title = detailId
    ? t(detailId === REVIEW_ID ? "team.reviewTitle" : detailId === SEARCH_ID ? "team.memorySearch" : detailId === MATCHES_ID ? "team.possibleMatches" : "team.person")
    : active === "agents"
      ? t("team.yourTeam")
      : active === "memory"
        ? t("team.memoryHeading")
        : t("team.people");
  const subtitle = detailId
    ? undefined
    : active === "agents"
      ? statusLine(agents ?? [], goals ?? [])
      : active === "memory"
        ? <MemoryHeaderLine />
        : t("team.peopleSubtitle");
  // A person's page carries Rename in a "…" menu; the other sub-pages have no actions.
  const actions = detailId ? (
    active === "people" && detailId !== MATCHES_ID ? <PersonMenu personId={detailId} /> : undefined
  ) : active === "agents" ? (
    <PageAction icon={Plus} label={t("team.newAgent")} onClick={() => navigate("/new")} />
  ) : active === "memory" ? (
    <PageAction icon={Search} label={t("team.memorySearch")} onClick={() => navigate(`/team/memory/${SEARCH_ID}`)} />
  ) : undefined;

  const page = (
    <PageFrame
      title={active === "memory" && !detailId ? <span className="block whitespace-normal text-[26px] leading-[1.15]">{title}</span> : title}
      subtitle={subtitle}
      actions={actions}
      back={detailId ? <PageAction icon={ChevronLeft} label={t("common.back")} onClick={() => navigate(`/team/${active}`)} /> : undefined}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="relative">
          {detailId || active === "people" ? null : (
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-10 h-[360px]">
              <Aurora agents={[]} colors={GLOW_TINTS} />
            </div>
          )}
          <div className="relative mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-10">
            {wide || detailId ? null : (
              <SegmentedControl
                aria-label={t("team.segments")}
                className="self-center"
                value={active}
                onValueChange={select}
                items={[
                  { value: "agents", label: t("team.agents") },
                  { value: "people", label: t("team.people") },
                  { value: "memory", label: t("team.memory") },
                ]}
              />
            )}
            {active === "agents" ? <AgentsSegment /> : null}
            {active === "people" ? <PeopleSegment detailId={detailId} /> : null}
            {active === "memory" ? <MemorySegment detailId={detailId} /> : null}
          </div>
        </div>
      </ScrollArea>
    </PageFrame>
  );

  if (!wide) return page;
  return (
    <SettingsPage
      bare
      activeId={active}
      onSelect={select}
      sections={[
        { id: "agents", label: t("team.agents"), icon: <Bot className="size-4" /> },
        { id: "people", label: t("team.people"), icon: <UserRound className="size-4" /> },
        { id: "memory", label: t("team.memory"), icon: <Brain className="size-4" /> },
      ]}
    >
      {page}
    </SettingsPage>
  );
}

const activeGoals = (goals: readonly Goal[], agentId?: string): Goal[] =>
  goals.filter((goal) => goal.status === "active" && (agentId === undefined || goal.agentId === agentId));

/** "2 working now · 2 goals in progress". */
function statusLine(agents: readonly Agent[], goals: readonly Goal[]): string {
  const working = agents.filter((agent) => agent.status === "working").length;
  const active = activeGoals(goals).length;
  const parts = [working > 0 ? t("team.workingNow", { count: working }) : t("team.nobodyWorking")];
  if (active > 0) parts.push(t(active === 1 ? "team.goalInProgressOne" : "team.goalsInProgress", { count: active }));
  return parts.join(" · ");
}

/** The goal line under an agent: its one active goal with the plan's progress, or how many it has. */
function goalLine(goals: readonly Goal[]): string | undefined {
  const [only] = goals;
  if (!only) return undefined;
  if (goals.length > 1) return t("team.goalsInProgress", { count: goals.length });
  return [only.title, goalsProgress(only)].filter(Boolean).join(" · ");
}

/** Every agent, open on the page: no card, no border. A tap opens the agent's page; "+" in the top bar starts a new one. */
function AgentsSegment() {
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { data: goals } = useGoals();
  const list = agents ?? [];
  const capped = useCapped(list, AGENT_LIMIT);

  return (
    <>
      {list.length === 0 ? <p className="px-1 text-sm text-fg-muted">{t("team.noAgents")}</p> : null}
      <ul aria-label={t("team.agents")} className="flex flex-col gap-1.5">
        {capped.shown.map((agent) => (
          <li key={agent.id}>
            <AgentRow agent={agent} goals={activeGoals(goals ?? [], agent.id)} onOpen={() => navigate(`/agents/${agent.id}`)} />
          </li>
        ))}
      </ul>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </>
  );
}

/** The character large on a soft glow of its own tint, then the name, the role, the doing line with its live dot and the goal line. */
function AgentRow({ agent, goals, onOpen }: { agent: Agent; goals: readonly Goal[]; onOpen: () => void }) {
  const doing = useDoingLine(agent);
  const live = doing !== undefined || agent.status === "working";
  const line = doing ?? (agent.status === "idle" ? t("team.agentFree") : statusLabel(agentStatusMeta[agent.status]));
  const role = agentRole(agent);
  const goal = goalLine(goals);
  const tint = CHARACTER_TINT[agentCharacter(agent.id, agent.avatar)];
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-4 py-2.5 text-left focus-ring">
      <span className="relative flex size-[84px] shrink-0 items-center justify-center">
        <span aria-hidden="true" className="absolute -inset-1.5 rounded-full" style={{ backgroundImage: `radial-gradient(closest-side, ${tint}bf, ${tint}00)` }} />
        <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={70} className="relative" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[21px] font-bold tracking-[-0.01em] text-fg">{agent.name}</span>
          {role ? <span className="truncate text-sm text-fg-subtle">{role}</span> : null}
        </span>
        {/* The 8px dot sits on the first line (22px line height: 11 - 4 = 7px down), also when the text wraps to a second line. */}
        <span className="flex min-w-0 items-start gap-1.5 text-[15px] leading-[22px] text-fg-muted">
          <span aria-hidden="true" className={live ? "mt-[7px] size-2 shrink-0 rounded-full bg-success" : "mt-[7px] size-2 shrink-0 rounded-full bg-fg-subtle/50"} />
          <span className="line-clamp-2">{line}</span>
        </span>
        {goal ? <span className="truncate text-[13px] text-fg-subtle">{goal}</span> : null}
      </span>
    </button>
  );
}
