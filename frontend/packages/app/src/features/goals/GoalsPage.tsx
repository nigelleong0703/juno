import type { Agent, Goal, GoalCategory, Routine } from "@agent-desktop/client";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  EmptyState,
  ErrorState,
  LoadingState,
  ListRow,
  ScrollArea,
  SplitView,
  cn,
} from "@agent-desktop/ui";
import { MessageSquare, Plus } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { AgentScopeButton } from "../../components/agent/AgentScopeButton";
import { cardClass, PageAction, PageFrame, SECTION_LABEL, SPLIT_NO_DIVIDER } from "../../components/page/PageFrame";
import { OptionScopeButton } from "../../components/page/OptionScopeButton";
import { useAgents, useConversations, useGoals, useRoutines } from "../../data/queries";
import { useUiStore } from "../../store/ui";
import { t } from "../../lib/i18n";
import { useSplitSelection, useWideLayout } from "../../lib/useSplitSelection";
import { ShowMore, timeLabel, useCapped } from "../agents/card/parts";
import { directChatOf } from "../feed/useFeedActions";
import { GOAL_CATEGORIES } from "./categories";
import { CreateGoalDialog } from "./CreateGoalDialog";
import { GoalDetailPage } from "./GoalDetailPage";
import { goalsProgress } from "./labels";

/** Rows per group before "Show more". */
const GROUP_LIMIT = 8;

/**
 * Goals (BACKEND §10.10, Muse's Goals page): what the agents are working toward for the user, grouped Tracking / Goals
 * and, last, "Later today" (routines due before midnight), filterable by agent and category. A row opens the goal with its
 * activity timeline; "Discuss in chat" opens that agent's chat with a draft about it.
 */
export function GoalsPage() {
  const wide = useWideLayout();
  const selectedId = useParams().id;
  // Narrow: a goal is its own page. Wide: it is the right pane of the list.
  if (!wide && selectedId) return <GoalDetailPage />;
  return <GoalsList wide={wide} selectedId={selectedId} />;
}

function GoalsList({ wide, selectedId }: { wide: boolean; selectedId: string | undefined }) {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState("all");
  const [category, setCategory] = useState<"all" | "done" | GoalCategory>("all");
  const [creating, setCreating] = useState(false);
  const { data: goals, isLoading, isError, refetch } = useGoals(agentId === "all" ? undefined : { agentId });
  const { data: agents } = useAgents();
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  const ordered = useMemo(
    () =>
      (goals ?? [])
        // Done goals are off the list (the iPhone drops them); the capsule's "Done" option brings them back.
        .filter((goal) => (category === "done" ? goal.status === "done" : goal.status !== "done" && (category === "all" || (goal.category ?? "other") === category)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [goals, category],
  );
  const { data: routines } = useRoutines(agentId === "all" ? undefined : { agentId });
  const { data: conversations } = useConversations();
  const setComposerPrefill = useUiStore((state) => state.setComposerPrefill);
  const later = useMemo(() => dueToday(routines), [routines]);
  const open = useCallback((id: string | undefined) => navigate(id ? `/goals/${id}` : "/goals"), [navigate]);
  const shown = useMemo(() => [...ordered.filter((goal) => goal.kind === "tracking"), ...ordered.filter((goal) => goal.kind !== "tracking")], [ordered]);
  useSplitSelection(useMemo(() => shown.map((goal) => goal.id), [shown]), selectedId, open, wide);

  const discuss = (goal: Goal) => {
    const chat = directChatOf(conversations, goal.agentId);
    if (!chat) return;
    setComposerPrefill({ conversationId: chat.id, text: t("goals.discussDraft", { title: goal.title }) });
    navigate(`/c/${chat.id}`);
  };
  const group = (title: string, items: Goal[]) => (
    <GoalGroup
      title={title}
      items={items}
      renderRow={(goal) => (
        <GoalRow
          key={goal.id}
          goal={goal}
          agent={agentById.get(goal.agentId)}
          selected={goal.id === selectedId}
          onOpen={() => open(goal.id)}
          onDiscuss={directChatOf(conversations, goal.agentId) ? () => discuss(goal) : undefined}
        />
      )}
    />
  );

  const content = isLoading ? (
    <LoadingState label={t("common.loading")} />
  ) : isError ? (
    <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
  ) : ordered.length === 0 && later.length === 0 ? (
    <EmptyState title={t("goals.empty")} description={t("goals.emptyHint")} />
  ) : (
    <div className="flex flex-col gap-6">
      {group(t("goals.group.tracking"), ordered.filter((goal) => goal.kind === "tracking"))}
      {group(t("goals.group.goals"), ordered.filter((goal) => goal.kind !== "tracking"))}
      <LaterToday routines={later} agentById={agentById} />
    </div>
  );

  return (
    <PageFrame
      title={t("goals.title")}
      scope={<AgentScopeButton bubble agents={agents} value={agentId} onChange={setAgentId} />}
      actions={
        <>
          <OptionScopeButton
            label={t("goals.allCategories")}
            value={category}
            onChange={(value) => setCategory(value as "all" | "done" | GoalCategory)}
            options={[{ value: "all", label: t("goals.allCategories") }, ...GOAL_CATEGORIES.map((item) => ({ value: item, label: t(`goals.category.${item}`) })), { value: "done", label: t("goals.status.done") }]}
          />
          <PageAction icon={Plus} label={t("goals.create")} onClick={() => setCreating(true)} />
        </>
      }
    >
      {wide ? (
        <SplitView
          list={<div className="px-4 pb-6 pt-1">{content}</div>}
          detail={selectedId ? <GoalDetailPage key={selectedId} embedded /> : undefined}
          placeholder={t("goals.pickGoal")}
          listWidth={400}
          className={SPLIT_NO_DIVIDER}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-4 pb-10">{content}</div>
        </ScrollArea>
      )}

      {creating ? (
        <CreateGoalDialog
          defaultAgentId={agentId === "all" ? undefined : agentId}
          onOpenChange={setCreating}
          onCreated={(id) => navigate(`/goals/${id}`)}
        />
      ) : null}
    </PageFrame>
  );
}

/** Routines that are on and next run before local midnight, soonest first. */
function dueToday(routines: Routine[] | undefined, now = new Date()): Routine[] {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return (routines ?? [])
    .filter((routine) => routine.enabled && routine.nextRunAt && Date.parse(routine.nextRunAt) < end)
    .sort((a, b) => Date.parse(a.nextRunAt ?? "") - Date.parse(b.nextRunAt ?? ""));
}

function GoalGroup({ title, items, renderRow }: { title: string; items: Goal[]; renderRow: (goal: Goal) => ReactNode }) {
  const capped = useCapped(items, GROUP_LIMIT);
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className={SECTION_LABEL}>{title}</h2>
      {capped.shown.map(renderRow)}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}

function LaterToday({ routines, agentById }: { routines: Routine[]; agentById: Map<string, Agent> }) {
  const capped = useCapped(routines, GROUP_LIMIT);
  if (routines.length === 0) return null;
  return (
    <section aria-label={t("goals.group.later")} className="flex flex-col gap-2">
      <h2 className={SECTION_LABEL}>{t("goals.group.later")}</h2>
      {capped.shown.map((routine) => {
        const agent = agentById.get(routine.agentId);
        return (
          <ListRow
            key={routine.id}
            dense
            className={cn(cardClass(), "px-3.5 py-3")}
            leading={agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={28} /> : undefined}
            title={routine.name}
            trailing={<span className="text-sm text-muted-foreground">{routine.nextRunAt ? timeLabel(routine.nextRunAt) : ""}</span>}
          />
        );
      })}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}

function GoalRow({ goal, agent, selected, onOpen, onDiscuss }: { goal: Goal; agent?: Agent; selected: boolean; onOpen: () => void; onDiscuss?: (() => void) | undefined }) {
  const progress = goalsProgress(goal);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-split-id={goal.id}>
          <ListRow
            selected={selected}
            className={cn(cardClass({ interactive: true, selected }), "p-3.5")}
            leading={agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={28} /> : undefined}
            title={<span className={cn(goal.status === "done" && "text-muted-foreground line-through")}>{goal.title}</span>}
            description={
              <span className="flex flex-col gap-0.5">
                <span>{goal.summary}</span>
                <span className="text-xs text-muted-foreground">
                  {[progress, goal.category ? t(`goals.category.${goal.category}`) : undefined].filter(Boolean).join(" · ")}
                </span>
              </span>
            }
            trailing={
              <span className="flex items-center gap-1">
                {onDiscuss ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-full"
                    aria-label={t("goals.discuss")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDiscuss();
                    }}
                  >
                    <MessageSquare className="size-4" />
                  </Button>
                ) : null}
              </span>
            }
            onClick={onOpen}
          />
        </div>
      </ContextMenuTrigger>
      {onDiscuss ? (
        <ContextMenuContent>
          <ContextMenuItem onSelect={onDiscuss}>
            <MessageSquare className="size-4" />
            {t("goals.discuss")}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
