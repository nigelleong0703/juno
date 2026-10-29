import type { Goal, GoalCategory, GoalStatus } from "@agent-desktop/client";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingState,
  RelativeTime,
  ScrollArea,
  StatusPill,
  Timeline,
  type TimelineItem,
  cn,
} from "@agent-desktop/ui";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useCheckGoal, useDeleteGoal, useUpdateGoal } from "../../data/goals";
import { useAgents, useGoal } from "../../data/queries";
import { t } from "../../lib/i18n";
import { ShowMore, dayLabel, timeLabel, useCapped } from "../agents/card/parts";
import { cardClass, DETAIL_COLUMN, PageAction, PageFrame, SECTION_LABEL } from "../../components/page/PageFrame";
import { OptionScopeButton } from "../../components/page/OptionScopeButton";
import { GOAL_CATEGORIES } from "./categories";
import { goalStatusTone, goalsProgress, milestoneTone } from "./labels";

/**
 * One goal (BACKEND §10.10): where it stands, its checklist, category, status controls, and the
 * activity timeline (what the user or an agent changed, newest first, capped with "Show more").
 */
export function GoalDetailPage({ embedded = false }: { /** In the wide layout's right pane: no back chevron. */ embedded?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: goal, isLoading, isError, refetch } = useGoal(id);
  const { data: agents } = useAgents();
  const update = useUpdateGoal();
  const remove = useDeleteGoal();
  const check = useCheckGoal();
  const [confirming, setConfirming] = useState(false);
  const agent = agents?.find((entry) => entry.id === goal?.agentId);

  const setStatus = (status: GoalStatus) => goal && update.mutate({ id: goal.id, patch: { status } });
  const setCategory = (category: GoalCategory) => goal && update.mutate({ id: goal.id, patch: { category } });
  const toggleStep = (index: number, done: boolean) => {
    if (!goal?.steps) return;
    const steps = goal.steps.map((step, at) => (at === index ? { ...step, done } : step));
    update.mutate({ id: goal.id, patch: { steps } });
  };

  const subtitle = goal ? [agent?.name, t(`goals.kind.${goal.kind}`)].filter(Boolean).join(" · ") : undefined;
  const state = isLoading ? (
    <LoadingState label={t("common.loading")} />
  ) : isError ? (
    <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
  ) : !goal ? (
    <EmptyState centered title={t("detail.notFound")} description={t("detail.notFoundHint")} />
  ) : null;
  const body = (
    <>
      {state}
      {goal ? (
        <div className="space-y-6">
          <header className="flex items-start gap-3">
            {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} status={agent.status} size={40} /> : null}
            <div className="min-w-0 flex-1 space-y-1">
              {goal.summary ? <p className="text-base text-fg">{goal.summary}</p> : null}
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <StatusPill tone={goalStatusTone[goal.status]} label={t(`goals.status.${goal.status}`)} size="sm" />
                {goalsProgress(goal) ? <span>{goalsProgress(goal)}</span> : null}
              </div>
            </div>
          </header>

          <section className="flex flex-wrap items-center gap-2">
            {goal.status === "active" ? (
              <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setStatus("paused")}>
                {t("goals.detail.pause")}
              </Button>
            ) : goal.status === "paused" ? (
              <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setStatus("active")}>
                {t("goals.detail.resume")}
              </Button>
            ) : null}
            {goal.status === "active" ? (
              <Button variant="secondary" size="sm" className="rounded-full" disabled={check.isPending || check.isSuccess} onClick={() => check.mutate(goal.id)}>
                {check.isSuccess ? t("goals.detail.checkQueued") : t("goals.detail.checkNow")}
              </Button>
            ) : null}
            {goal.status === "done" ? (
              <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setStatus("active")}>
                {t("goals.detail.resume")}
              </Button>
            ) : (
              <Button size="sm" className="rounded-full" onClick={() => setStatus("done")}>
                {t("goals.detail.markDone")}
              </Button>
            )}
            <div className="ml-auto">
              <OptionScopeButton
                label={t("goals.detail.category")}
                value={goal.category ?? "other"}
                onChange={(value) => setCategory(value as GoalCategory)}
                options={GOAL_CATEGORIES.map((item) => ({ value: item, label: t(`goals.category.${item}`) }))}
              />
            </div>
          </section>

          <PlanSection goal={goal} />

          {goal.steps?.length ? <Steps goal={goal} onToggle={toggleStep} /> : null}

          <ActivitySection goal={goal} />

          <section>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">{t("goals.detail.deleteConfirm")}</span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(goal.id, { onSuccess: () => navigate("/goals") })}
                >
                  {t("goals.detail.delete")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                {t("goals.detail.delete")}
              </Button>
            )}
          </section>
        </div>
      ) : null}
    </>
  );

  // Wide: the right pane, a reading column like Feed's. Narrow: its own page with a way back.
  if (embedded) {
    return (
      <div className={DETAIL_COLUMN}>
        <h2 className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-fg">{goal?.title}</h2>
        {subtitle ? <p className="mb-6 text-sm text-fg-muted">{subtitle}</p> : <div className="mb-6" />}
        {body}
      </div>
    );
  }
  return (
    <PageFrame title={goal?.title ?? ""} back={<PageAction icon={ChevronLeft} label={t("detail.back")} onClick={() => navigate("/goals")} />}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-5 pb-10">
          {subtitle ? <p className="mb-6 text-sm text-fg-muted">{subtitle}</p> : null}
          {body}
        </div>
      </ScrollArea>
    </PageFrame>
  );
}

/** The agent's action plan (milestones, capped with "Show more") and when it checks in next. */
function PlanSection({ goal }: { goal: Goal }) {
  const milestones = goal.milestones ?? [];
  const capped = useCapped(milestones);
  const quotesOf = (milestoneId: string) => (goal.activity ?? []).filter((entry) => entry.kind === "quote" && entry.milestoneId === milestoneId);
  return (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL}>{t("goals.detail.milestones")}</h3>
      {milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">{goal.status === "active" ? t("goals.detail.planPending") : t("goals.detail.activityEmpty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {capped.shown.map((milestone) => (
              <li key={milestone.id} className={cn("flex flex-wrap items-center gap-2.5 px-3.5 py-3", cardClass())}>
                <span className={cn("min-w-0 flex-1 text-sm", milestone.status === "done" ? "text-muted-foreground line-through" : "text-foreground")}>
                  {milestone.title}
                  {milestone.due ? (
                    <span className="ml-2 text-xs text-muted-foreground">{t("goals.milestone.due", { date: dayLabel(milestone.due) })}</span>
                  ) : null}
                </span>
                <StatusPill tone={milestoneTone[milestone.status]} label={t(`goals.milestone.${milestone.status}`)} size="sm" />
                {quotesOf(milestone.id).length > 0 ? (
                  <details className="basis-full text-xs text-muted-foreground">
                    <summary className="cursor-pointer">{t(quotesOf(milestone.id).length === 1 ? "goals.quote.one" : "goals.quote.many", { n: quotesOf(milestone.id).length })}</summary>
                    <ul className="mt-1 space-y-1">
                      {quotesOf(milestone.id).map((quote, index) => (
                        <li key={`${quote.at}-${index}`}>{quote.text}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </>
      )}
      {goal.status === "active" && goal.nextCheckAt ? (
        <p className="text-xs text-muted-foreground">
          {t("goals.detail.nextCheck")}: <RelativeTime date={goal.nextCheckAt} />
          {goal.lastCheckedAt ? (
            <>
              {" · "}
              {t("goals.detail.lastCheck")} <RelativeTime date={goal.lastCheckedAt} />
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function Steps({ goal, onToggle }: { goal: Goal; onToggle: (index: number, done: boolean) => void }) {
  return (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL}>{t("goals.detail.steps")}</h3>
      <ul className="flex flex-col gap-1.5">
        {(goal.steps ?? []).map((step, index) => (
          <li key={`${index}-${step.text}`} className={cn("flex items-center gap-2.5 px-3.5 py-3", cardClass())}>
            <Checkbox
              checked={step.done}
              aria-label={step.text}
              onCheckedChange={(checked) => onToggle(index, checked === true)}
            />
            <span className={cn("text-sm", step.done ? "text-muted-foreground line-through" : "text-foreground")}>{step.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ACTIVITY_TONE: Record<string, TimelineItem["tone"]> = { created: "success", status: "warning" };

/** The timeline, newest first; a "Show more" keeps a long history from pushing the page down. */
function ActivitySection({ goal }: { goal: Goal }) {
  const entries = (goal.activity ?? []).filter((entry) => !(entry.kind === "quote" && entry.milestoneId));
  const capped = useCapped(entries);
  const items: TimelineItem[] = capped.shown.map((entry, index) => ({
    id: `${entry.at}-${index}`,
    title: entry.text,
    description: t(entry.actor === "user" ? "goals.actor.user" : "goals.actor.agent"),
    timestamp: `${dayLabel(entry.at)} · ${timeLabel(entry.at)}`,
    tone: ACTIVITY_TONE[entry.kind] ?? "default",
  }));
  return (
    <section className="space-y-3">
      <h3 className={SECTION_LABEL}>{t("goals.detail.activity")}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("goals.detail.activityEmpty")}</p>
      ) : (
        <>
          <Timeline items={items} />
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </>
      )}
    </section>
  );
}
