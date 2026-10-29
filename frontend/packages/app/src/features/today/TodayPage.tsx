import type { Agent, Goal, Request, TodayNeedsYouItem } from "@agent-desktop/client";
import { Button, ScrollArea, cn, toast } from "@agent-desktop/ui";
import { Check, ChevronRight, Loader2, Newspaper, Plus, Target } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { SECTION_LABEL } from "../../components/page/PageFrame";
import { LiveRequestCard } from "../../components/request/LiveRequestCard";
import { useFeed, useGoals, useNeedsYouRequests, useOpenIdeas, useRuns, useAgents } from "../../data/queries";
import { useAcceptIdea, useIdeaFeedback } from "../../data/mutations";
import { useMarkRunSeen, useToday } from "../../data/today";
import { CHARACTER_TINT, agentCharacter } from "../../lib/avatars";
import { t } from "../../lib/i18n";
import { timeLabel } from "../agents/card/parts";
import { SuggestionCard } from "../ideas/SuggestionCard";
import { goalsProgress } from "../goals/labels";
import { Aurora, useAccountFirstName } from "../chat/ReturningWelcome";
import { GLOW_TINTS } from "./Inspiration";

/** Rows per section before "All" takes over (owner-approved 2026-10-26: capped everywhere). */
const NEEDS_LIMIT = 3;
const PROGRESS_LIMIT = 3;
const UPDATES_LIMIT = 3;
const IDEAS_LIMIT = 3;
/** Agents shown in the stories row; the row scrolls sideways, this keeps it bounded. */
const STORY_LIMIT = 20;

type TodayData = ReturnType<typeof useToday>;
type AgentOf = (id: string) => Agent | undefined;

/** `hour` is the owner's local hour from the server; the device clock stands in until it arrives. Same bands as
 * the iPhone (World+Today.swift): late night 0–5 ("Still up, robin?"), morning 5–12, afternoon 12–18, evening 18–24. */
function greeting(name: string, hour = new Date().getHours()): string {
  if (hour < 5) return name ? t("today.lateNightNamed", { name }) : t("today.lateNight");
  const base = hour < 12 ? t("today.morning") : hour < 18 ? t("today.afternoon") : t("today.evening");
  return name ? `${base}, ${name}` : base;
}

/**
 * Today, the app's home (owner-approved 2026-10-26, look restored 2026-10-27): the Aurora wash and a big greeting, the
 * agents as stories (the ring is lit in the agent's tint while it works), then blocks, each capped, with "All ›" on the
 * block's header row: Needs you (every pending request, with its own action and "Open chat"), Progress (what agents did
 * and are doing, plus the goals card), Updates (the brief and the Feed) and Ideas (the open ideas as a row of suggestion
 * cards, Try or Never). A block with nothing to say does not show. Wide screens lay the first three in two columns.
 */
export function TodayPage() {
  const { data: agents } = useAgents();
  const today = useToday();
  const firstName = useAccountFirstName();
  const { data: pending } = useNeedsYouRequests();
  const { data: goals } = useGoals();
  const agentList = agents ?? [];
  const agentOf: AgentOf = (id) => agentList.find((agent) => agent.id === id);
  // No agent yet: Today welcomes the owner and offers the first one; the blocks below stay empty until then.
  const welcome = agentList.length === 0;
  const workingIds = new Set(today.working.map((entry) => entry.agentId));

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg">
      <ScrollArea className="min-h-0 flex-1">
        <div className="relative px-4 pb-10 pt-12">
          <Aurora agents={agentList} colors={GLOW_TINTS} />
          <div className="relative mx-auto flex w-full max-w-[640px] flex-col gap-6 lg:max-w-[1100px]">
            <header className="flex flex-col gap-1">
              <h1 className="text-[30px] font-bold leading-tight tracking-[-0.01em] text-fg">
                {welcome ? (firstName ? `${t("today.welcome")}, ${firstName}` : t("today.welcome")) : greeting(firstName, today.now?.hour)}
              </h1>
              {welcome ? <p className="text-[15px] text-fg-muted">{t("today.welcomeLine")}</p> : null}
            </header>
            {welcome ? <FirstAgentCard /> : <Stories agents={agentList} workingIds={workingIds} />}

            <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
              <div className="flex flex-col gap-6">
                <NeedsYouSection requests={pending ?? []} extra={(today.needsYou.items ?? []).filter((item) => item.kind !== "request")} />
                <ProgressSection today={today} agentOf={agentOf} goals={goals ?? []} />
              </div>
              <div className="flex flex-col gap-6">
                <UpdatesSection brief={today.brief} agentOf={agentOf} />
              </div>
            </div>
            <IdeasSection agentOf={agentOf} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/** The agents in a row like stories: character, name under it; the ring turns in the agent's tint while it works. A tap opens its page. */
function Stories({ agents, workingIds }: { agents: Agent[]; workingIds: Set<string> }) {
  return (
    <ul className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-1">
      {agents.slice(0, STORY_LIMIT).map((agent) => (
        <li key={agent.id} className="shrink-0">
          <Story agent={agent} active={workingIds.has(agent.id)} />
        </li>
      ))}
      <li className="shrink-0">
        <Link to="/new" aria-label={t("today.newAgent")} className="flex w-16 flex-col items-center gap-1.5 rounded-xl focus-ring">
          <span className="flex size-16 items-center justify-center rounded-full border border-dashed border-border text-fg-muted">
            <Plus className="size-6" />
          </span>
          <span className="max-w-full truncate text-xs text-fg-muted">{t("today.newAgent")}</span>
        </Link>
      </li>
    </ul>
  );
}

function Story({ agent, active }: { agent: Agent; active: boolean }) {
  const tint = CHARACTER_TINT[agentCharacter(agent.id, agent.avatar)];
  return (
    <Link to={`/agents/${agent.id}`} aria-label={t("today.agentPage", { name: agent.name })} className="flex w-16 flex-col items-center gap-1.5 rounded-xl focus-ring">
      <span className="relative flex size-16 items-center justify-center rounded-full border border-border">
        {active ? (
          <span
            aria-hidden="true"
            data-slot="story-ring"
            style={{ color: tint }}
            className="absolute -inset-px animate-spin rounded-full bg-[conic-gradient(currentColor,transparent_75%)] [mask-image:radial-gradient(farthest-side,transparent_calc(100%-3px),black_calc(100%-2px))] motion-reduce:animate-none"
          />
        ) : null}
        <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={52} className="shrink-0" />
      </span>
      <span className="max-w-full truncate text-xs text-fg-muted">{agent.name}</span>
    </Link>
  );
}

/** "All ›" at the right of a block's header row. `label` names it for assistive tech (and tells the blocks' buttons apart). */
function AllButton({ label, onClick, text = t("today.all") }: { label: string; onClick: () => void; text?: string }) {
  return (
    <Button variant="ghost" size="xs" aria-label={label} className="rounded-full text-fg-muted" onClick={onClick}>
      {text}
      <ChevronRight className="size-3.5" />
    </Button>
  );
}

/** The first-agent call to action for an account with no agents yet. */
function FirstAgentCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl bg-muted/70 p-4 text-center">
      <p className="text-[15px] text-fg-muted">{t("today.welcomeBody")}</p>
      <Button asChild variant="primary" size="lg" className="h-12 w-full rounded-full text-[15px]">
        <Link to="/new">
          <Plus className="size-4" />
          {t("today.firstAgent")}
        </Link>
      </Button>
    </div>
  );
}

/** A titled block; the title is the section's name for assistive tech too. */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className={SECTION_LABEL}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Every request that waits on the owner across all chats: the first few with their own actions, "All" for the rest. */
function NeedsYouSection({ requests, extra }: { requests: Request[]; extra: TodayNeedsYouItem[] }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const total = requests.length + extra.length;
  if (total === 0) return null;
  // Requests come first, then the memory items to review and the possible matches (the order the server gives).
  const shownRequests = expanded ? requests : requests.slice(0, NEEDS_LIMIT);
  const shownExtra = expanded ? extra : extra.slice(0, Math.max(0, NEEDS_LIMIT - shownRequests.length));
  return (
    <Section
      title={t("today.needsYouTitle")}
      action={
        total > NEEDS_LIMIT ? (
          <AllButton
            label={expanded ? t("today.showFewer") : t("today.allRequests", { count: total })}
            text={expanded ? t("today.showFewer") : t("today.all")}
            onClick={() => setExpanded((open) => !open)}
          />
        ) : undefined
      }
    >
      {shownRequests.map((request) => (
        <div key={request.id} className="flex flex-col gap-1.5">
          <LiveRequestCard request={request} />
          {request.conversationId ? (
            <div className="flex justify-end">
              <Button variant="ghost" size="xs" className="rounded-full" onClick={() => navigate(`/c/${request.conversationId}`)}>
                {t("today.openChat")}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {shownExtra.map((item) =>
        item.kind === "memory_review" ? (
          <button
            key={`memory-${item.itemId}`}
            type="button"
            onClick={() => navigate("/team/memory")}
            className="flex items-center gap-3 rounded-2xl bg-muted/70 p-3 text-left focus-ring"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.text}</span>
            <span className="shrink-0 text-xs text-fg-muted">{t("today.reviewMemory")}</span>
            <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
          </button>
        ) : item.kind === "possible_match" ? (
          <button
            key={`match-${item.accountId}`}
            type="button"
            onClick={() => navigate("/team/people")}
            className="flex items-center gap-3 rounded-2xl bg-muted/70 p-3 text-left focus-ring"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{`${item.accountName} · ${item.personName}`}</span>
            <span className="shrink-0 text-xs text-fg-muted">{t("today.possibleMatch")}</span>
            <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
          </button>
        ) : null,
      )}
    </Section>
  );
}

/** What agents are doing and finished (three rows at most, working first), then the goals card that opens the goals list. */
function ProgressSection({ today, agentOf, goals }: { today: TodayData; agentOf: AgentOf; goals: Goal[] }) {
  const navigate = useNavigate();
  const { data: runs } = useRuns();
  const seen = useMarkRunSeen();
  const rows = [
    ...today.working.map((entry) => ({ kind: "working" as const, ...entry })),
    ...today.completed.map((entry) => ({ kind: "done" as const, ...entry })),
  ].slice(0, PROGRESS_LIMIT);
  const chatOf = (runId: string) => runs?.find((run) => run.id === runId)?.conversationId;
  const active = goals.filter((goal) => goal.status === "active");
  const done = goals.filter((goal) => goal.status === "done").length;
  if (rows.length === 0 && goals.length === 0) return null;
  const leadGoal = active[0];
  const leadProgress = leadGoal ? goalsProgress(leadGoal) : undefined;

  return (
    <Section title={t("today.progress")} action={<AllButton label={t("today.allOf", { title: t("today.progress") })} onClick={() => navigate("/goals")} />}>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-muted/70">
          {rows.map((row) => {
            const agent = agentOf(row.agentId);
            const name = agent?.name ?? "";
            const conversationId = chatOf(row.runId);
            const open = () => {
              if (row.kind === "done") seen.mutate(row.runId);
              navigate(conversationId ? `/c/${conversationId}` : `/agents/${row.agentId}`);
            };
            return (
              <li key={`${row.kind}-${row.runId}`}>
                <button type="button" onClick={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left focus-ring">
                  {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={32} /> : null}
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {row.kind === "done" ? t("today.finished", { name, title: row.title }) : `${name}: ${row.title}`}
                  </span>
                  {row.kind === "done" ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-success text-white">
                      <Check className="size-3.5" />
                    </span>
                  ) : (
                    <Loader2 className={cn("size-4 animate-spin text-fg-muted motion-reduce:animate-none")} />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {goals.length > 0 ? (
        <button type="button" onClick={() => navigate("/goals")} className="flex items-center gap-3 rounded-2xl bg-muted/70 px-3 py-2.5 text-left focus-ring">
          <Target className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-fg-muted">{t("today.goalsTitle")}</span>
            <span className="block truncate text-sm text-fg">{leadGoal ? `${leadGoal.title}${leadProgress ? ` · ${leadProgress}` : ""}` : ""}</span>
          </span>
          <span className="shrink-0 text-xs text-fg-muted">{t("today.goalsSummary", { active: active.length, done })}</span>
          <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
        </button>
      ) : null}
    </Section>
  );
}

/** Today's brief first, then the newest Feed posts; "All" opens the full Feed. */
function UpdatesSection({ brief, agentOf }: { brief: TodayData["brief"]; agentOf: AgentOf }) {
  const navigate = useNavigate();
  const feed = useFeed();
  const posts = (feed.data?.pages.flatMap((page) => page.items) ?? []).filter((post) => post.feedback !== "less").slice(0, UPDATES_LIMIT);
  if (!brief && posts.length === 0) return null;
  return (
    <Section
      title={t("today.updatesTitle")}
      action={<AllButton label={t("today.allOf", { title: t("today.updatesTitle") })} onClick={() => navigate("/feed")} />}
    >
      <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-muted/70">
        {brief ? (
          <li>
            <button type="button" onClick={() => navigate("/feed")} className="flex w-full items-center gap-3 px-3 py-2.5 text-left focus-ring">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-muted">
                  <Newspaper className="size-3.5" />
                  {t("today.briefTitle", { time: timeLabel(brief.at) })}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-sm text-fg">{brief.summary}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
            </button>
          </li>
        ) : null}
        {posts.map((post) => {
          const agent = agentOf(post.agentId);
          return (
            <li key={post.id}>
              <button type="button" onClick={() => navigate(`/feed/${post.id}`)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left focus-ring">
                {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={32} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-fg">{post.title}</span>
                  <span className="block truncate text-[13px] text-fg-muted">{post.summary}</span>
                </span>
                <span className="shrink-0 text-xs text-fg-subtle">{timeLabel(post.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** The open ideas, three at most: Try starts the agent on it in a new chat, Never stops it being offered again. */
function IdeasSection({ agentOf }: { agentOf: AgentOf }) {
  const navigate = useNavigate();
  const { data: open } = useOpenIdeas();
  const accept = useAcceptIdea();
  const feedback = useIdeaFeedback();
  const ideas = (open ?? []).filter((idea) => agentOf(idea.agentId) !== undefined).slice(0, IDEAS_LIMIT);
  if (ideas.length === 0) return null;
  const busy = accept.isPending || feedback.isPending;

  const tryIdea = async (id: string) => {
    try {
      const started = await accept.mutateAsync(id);
      if (started.conversationId) navigate(`/c/${started.conversationId}`);
    } catch {
      // A failed accept leaves the idea in the list, so the owner can try again.
    }
  };

  return (
    <Section
      title={t("today.ideasTitle")}
      action={<AllButton label={t("today.allOf", { title: t("today.ideasTitle") })} onClick={() => navigate("/ideas")} />}
    >
      {/* The old "For you" row: cards side by side, the next one peeking at the edge. */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {ideas.map((idea) => (
          <li key={idea.id} className="flex w-[85%] max-w-[340px] shrink-0 snap-start sm:w-[320px]">
            <SuggestionCard className="w-full" agent={agentOf(idea.agentId)} title={idea.text} reason={idea.why}>
              <div className="mt-auto flex justify-end gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  className="rounded-full text-fg-muted"
                  disabled={busy}
                  onClick={() => feedback.mutate({ id: idea.id, action: "never", scope: "topic" }, { onError: () => toast.error(t("common.error")) })}
                >
                  {t("today.never")}
                </Button>
                <Button size="xs" className="rounded-full" disabled={busy} onClick={() => void tryIdea(idea.id)}>
                  {t("today.try")}
                </Button>
              </div>
            </SuggestionCard>
          </li>
        ))}
      </ul>
    </Section>
  );
}
