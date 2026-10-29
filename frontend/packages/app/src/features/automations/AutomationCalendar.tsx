import type { Agent, AgentCalendarItem, Routine } from "@agent-desktop/client";
import { Button, SegmentedControl, cn } from "@agent-desktop/ui";
import { AlertCircle, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useAgentCalendar } from "../../data/calendar";
import { CHARACTER_TINT, agentCharacter } from "../../lib/avatars";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { triggerText } from "../routines/RoutineSheet";
import { CalendarItemDialog, KIND_ICON, kindLabel } from "./CalendarItemDialog";
import { addDays, calendarBlocks, dimReason, expandRoutine, isTimed, startOfDay, type CalendarBlock, type Occurrence } from "./occurrences";

type Mode = "day" | "week" | "month";

const HOUR_PX = 48;
const BLOCK_MINUTES = 40;
const GUTTER = "3rem";
/** Visible hour at the top when the grid opens. */
const OPEN_AT_HOUR = 7;

const dayKey = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const timeText = (date: Date): string => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const mondayOf = (date: Date): Date => addDays(startOfDay(date), -((date.getDay() + 6) % 7));

function rangeFor(mode: Mode, anchor: Date): { days: Date[]; title: string } {
  const day = startOfDay(anchor);
  if (mode === "day") return { days: [day], title: day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) };
  if (mode === "week") {
    const first = mondayOf(day);
    const days = Array.from({ length: 7 }, (_, index) => addDays(first, index));
    const last = days[6] as Date;
    // formatRange collapses the shared month and year ("Oct 19 – 25, 2026"); a day-and-year-only format reads oddly in some locales.
    const title = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).formatRange(first, last);
    return { days, title };
  }
  const first = mondayOf(new Date(day.getFullYear(), day.getMonth(), 1));
  return { days: Array.from({ length: 42 }, (_, index) => addDays(first, index)), title: day.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

function step(mode: Mode, anchor: Date, direction: 1 | -1): Date {
  if (mode === "day") return addDays(anchor, direction);
  if (mode === "week") return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** One thing on the grid: a routine occurrence, or an item from an agent's own calendar. */
type Entry = { type: "routine"; start: Date; occurrence: Occurrence } | { type: "item"; start: Date; block: CalendarBlock };

interface Lane {
  entry: Entry;
  lane: number;
  lanes: number;
}

/** Side-by-side lanes for blocks that overlap in time within one day column. */
function layoutDay(entries: Entry[]): Lane[] {
  const minutes = (o: Entry) => o.start.getHours() * 60 + o.start.getMinutes();
  const result: Lane[] = [];
  let cluster: Lane[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const item of cluster) item.lanes = laneEnds.length;
    result.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const entry of entries) {
    const start = minutes(entry);
    if (start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = start + BLOCK_MINUTES;
    clusterEnd = Math.max(clusterEnd, start + BLOCK_MINUTES);
    cluster.push({ entry, lane, lanes: 1 });
  }
  flush();
  return result;
}

const STRIPES = "repeating-linear-gradient(135deg, transparent 0 5px, rgb(0 0 0 / 0.07) 5px 8px)";

function blockStyle(tint: string, occurrence: Occurrence, dimmed: boolean): CSSProperties {
  const failed = occurrence.past && occurrence.run?.status === "failed";
  const fill = occurrence.past ? 38 : 16;
  return {
    backgroundColor: `color-mix(in srgb, ${tint} ${fill}%, transparent)`,
    borderLeft: `3px solid ${tint}`,
    ...(failed ? { outline: "1.5px solid var(--color-danger, #e5484d)", outlineOffset: -1.5 } : {}),
    ...(dimmed && !occurrence.past ? { backgroundImage: STRIPES, opacity: 0.6 } : {}),
  };
}

function dimLabel(routine: Routine): string | undefined {
  const reason = dimReason(routine);
  return reason === "needs_setup" ? t("automations.cal.needsSetup") : reason === "error" ? t("automations.cal.error") : reason === "paused" ? t("automations.cal.paused") : undefined;
}

function occurrenceTitle(occurrence: Occurrence): string {
  const { routine, run } = occurrence;
  const state = occurrence.past ? (run?.status === "failed" ? t("automations.cal.failed") : run?.status === "completed" ? t("automations.cal.done") : "") : (dimLabel(routine) ?? "");
  return [routine.name, timeText(occurrence.start), state].filter(Boolean).join(" · ");
}

function itemTitle(block: CalendarBlock): string {
  const { item } = block;
  const state = block.missed ? t("automations.cal.missed") : item.status === "done" ? t("automations.cal.done") : "";
  return [item.title, kindLabel(item.kind), timeText(block.start), state].filter(Boolean).join(" · ");
}

/** The agent's own calendar item as a small block: kind icon + title, a check when done, amber outline when missed. */
function itemStyle(tint: string, block: CalendarBlock): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${tint} ${block.item.status === "done" ? 30 : 12}%, var(--color-bg, transparent))`,
    border: `1.5px ${block.missed ? "solid" : "dashed"} ${block.missed ? "var(--color-warning, #f59e0b)" : tint}`,
  };
}

function ItemIcon({ block }: { block: CalendarBlock }) {
  const Icon = KIND_ICON[block.item.kind];
  return <Icon className="size-3 shrink-0" aria-hidden />;
}

interface CalendarProps {
  routines: Routine[];
  agents: Agent[] | undefined;
  /** Only this agent's calendar items (routines arrive already filtered). */
  agentId?: string;
  onOpen: (routine: Routine) => void;
  onSlot: (slot: Date) => void;
}

/** The agents' own calendar: every agent is a colour; blocks are routine runs (past) and fire times (future), and the agents' own calendar items. */
export function AutomationCalendar({ routines, agents, agentId, onOpen, onSlot }: CalendarProps) {
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [now, setNow] = useState(() => new Date());
  const { days, title } = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const timed = useMemo(() => routines.filter(isTimed), [routines]);
  const onDemand = useMemo(() => routines.filter((routine) => !isTimed(routine)), [routines]);
  const agentOf = (routine: Routine) => agents?.find((agent) => agent.id === routine.agentId);
  const tintOfAgent = (id: string) => CHARACTER_TINT[agentCharacter(id, agents?.find((agent) => agent.id === id)?.avatar)];
  const tintOf = (routine: Routine) => tintOfAgent(routine.agentId);

  const rangeFrom = days[0] as Date;
  const rangeTo = addDays(days[days.length - 1] as Date, 1);
  const calendar = useAgentCalendar({ from: rangeFrom, to: rangeTo }, agentId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = calendar.data?.find((item) => item.id === selectedId);

  const { byDay, denseByDay } = useMemo(() => {
    const from = days[0] as Date;
    const end = addDays(days[days.length - 1] as Date, 1);
    const grouped = new Map<string, Entry[]>();
    const add = (entry: Entry) => {
      const key = dayKey(entry.start);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    };
    const dense = new Map<string, Routine[]>();
    for (const routine of timed) {
      const result = expandRoutine(routine, from, end, now);
      for (const occurrence of result.occurrences) add({ type: "routine", start: occurrence.start, occurrence });
      if (result.dense) for (const day of days) if (addDays(day, 1) > now) dense.set(dayKey(day), [...(dense.get(dayKey(day)) ?? []), routine]);
    }
    for (const block of calendarBlocks(calendar.data ?? [], from, end)) add({ type: "item", start: block.start, block });
    for (const [key, entries] of grouped) grouped.set(key, entries.sort((a, b) => a.start.getTime() - b.start.getTime()));
    return { byDay: grouped, denseByDay: dense };
  }, [timed, days, now, calendar.data]);
  const hasItems = [...byDay.values()].some((entries) => entries.some((entry) => entry.type === "item"));

  const today = dayKey(now);
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
      <Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
        {t("automations.cal.today")}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={t("automations.cal.prev")} onClick={() => setAnchor(step(mode, anchor, -1))}>
        <ChevronLeft className="size-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={t("automations.cal.next")} onClick={() => setAnchor(step(mode, anchor, 1))}>
        <ChevronRight className="size-4" />
      </Button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</h2>
      <SegmentedControl
        aria-label={t("automations.view")}
        value={mode}
        onValueChange={(value) => setMode(value as Mode)}
        items={[
          { value: "day", label: t("automations.cal.day") },
          { value: "week", label: t("automations.cal.week") },
          { value: "month", label: t("automations.cal.month") },
        ]}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      {/* The grid always shows (the agents' calendar is still a calendar when empty); the hint sits above it. */}
      {timed.length === 0 && !hasItems && <p className="px-1 pb-2 text-sm text-fg-muted">{t("automations.cal.empty")}. {t("automations.cal.emptyHint")}</p>}
      {mode === "month" ? (
        <MonthGrid
          days={days}
          month={anchor.getMonth()}
          today={today}
          byDay={byDay}
          denseByDay={denseByDay}
          tintOf={tintOf}
          tintOfAgent={tintOfAgent}
          onOpen={onOpen}
          onItem={(item) => setSelectedId(item.id)}
          onDay={(day) => {
            setAnchor(day);
            setMode("day");
          }}
        />
      ) : (
        <TimeGrid
          key={mode}
          days={days}
          now={now}
          today={today}
          byDay={byDay}
          denseByDay={denseByDay}
          agentOf={agentOf}
          tintOf={tintOf}
          tintOfAgent={tintOfAgent}
          onOpen={onOpen}
          onItem={(item) => setSelectedId(item.id)}
          onSlot={onSlot}
        />
      )}
      <OnDemand routines={onDemand} tintOf={tintOf} onOpen={onOpen} />
      {selected ? <CalendarItemDialog key={selected.id} item={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function DenseChips({ routines, tintOf, onOpen }: { routines: Routine[]; tintOf: (r: Routine) => string; onOpen: (r: Routine) => void }) {
  const shown = routines.slice(0, 2);
  return (
    <>
      {shown.map((routine) => (
        <button
          key={routine.id}
          type="button"
          title={`${routine.name} · ${triggerText(routine)}`}
          onClick={() => onOpen(routine)}
          className="flex w-full min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-fg"
          style={{ backgroundColor: `color-mix(in srgb, ${tintOf(routine)} 25%, transparent)` }}
        >
          <span className="truncate">{routine.name} · {t("automations.cal.hourly")}</span>
        </button>
      ))}
      {routines.length > shown.length ? <span className="px-1 text-[11px] text-fg-subtle">{t("automations.cal.more", { n: routines.length - shown.length })}</span> : null}
    </>
  );
}

interface GridProps {
  days: Date[];
  today: string;
  byDay: Map<string, Entry[]>;
  denseByDay: Map<string, Routine[]>;
  tintOf: (routine: Routine) => string;
  tintOfAgent: (agentId: string) => string;
  onOpen: (routine: Routine) => void;
  onItem: (item: AgentCalendarItem) => void;
}

function TimeGrid({ days, now, today, byDay, denseByDay, agentOf, tintOf, tintOfAgent, onOpen, onItem, onSlot }: GridProps & { now: Date; agentOf: (routine: Routine) => Agent | undefined; onSlot: (slot: Date) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = OPEN_AT_HOUR * HOUR_PX;
  }, []);
  const columns = { gridTemplateColumns: `${GUTTER} repeat(${days.length}, minmax(0, 1fr))` };
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;
  const hasDense = days.some((day) => (denseByDay.get(dayKey(day))?.length ?? 0) > 0);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto border-t border-border">
      <div className="sticky top-0 z-20 border-b border-border bg-bg">
        <div className="grid" style={columns}>
          <span />
          {days.map((day) => (
            <div key={dayKey(day)} className="py-1.5 text-center text-xs text-fg-muted">
              {day.toLocaleDateString(undefined, { weekday: "short" })}{" "}
              <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-sm", dayKey(day) === today ? "bg-danger text-white" : "text-fg")}>{day.getDate()}</span>
            </div>
          ))}
        </div>
        {hasDense ? (
          <div className="grid pb-1" style={columns}>
            <span />
            {days.map((day) => (
              <div key={dayKey(day)} className="min-w-0 space-y-0.5 px-0.5">
                <DenseChips routines={denseByDay.get(dayKey(day)) ?? []} tintOf={tintOf} onOpen={onOpen} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="relative grid" style={{ ...columns, height: 24 * HOUR_PX }}>
        <div className="relative">
          {Array.from({ length: 23 }, (_, index) => (
            <span key={index} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-fg-subtle" style={{ top: (index + 1) * HOUR_PX }}>
              {new Date(2000, 0, 1, index + 1).toLocaleTimeString(undefined, { hour: "numeric" })}
            </span>
          ))}
        </div>
        {days.map((day) => (
          <div
            key={dayKey(day)}
            data-testid={`day-${dayKey(day)}`}
            className="relative border-l border-border"
            style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_PX - 1}px, var(--color-border, rgb(128 128 128 / 0.2)) ${HOUR_PX - 1}px ${HOUR_PX}px)` }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const minutes = Math.floor(((event.clientY - rect.top) / HOUR_PX) * 4) * 15;
              onSlot(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes));
            }}
          >
            {layoutDay(byDay.get(dayKey(day)) ?? []).map(({ entry, lane, lanes }) => {
              const position = {
                top: ((entry.start.getHours() * 60 + entry.start.getMinutes()) / 60) * HOUR_PX,
                height: (BLOCK_MINUTES / 60) * HOUR_PX - 2,
                left: `calc(${(lane / lanes) * 100}% + 1px)`,
                width: `calc(${100 / lanes}% - 3px)`,
              };
              if (entry.type === "item") {
                const { block } = entry;
                return (
                  <button
                    key={`item-${block.item.id}`}
                    type="button"
                    title={itemTitle(block)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onItem(block.item);
                    }}
                    className="absolute flex flex-col overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight text-fg"
                    style={{ ...position, ...itemStyle(tintOfAgent(block.item.agentId), block) }}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      <ItemIcon block={block} />
                      <span className="min-w-0 flex-1 truncate font-medium">{block.item.title}</span>
                      {block.item.status === "done" ? <Check className="size-3 shrink-0" /> : null}
                    </span>
                    <span className="truncate text-fg-muted">{block.missed ? t("automations.cal.missed") : timeText(block.start)}</span>
                  </button>
                );
              }
              const { occurrence } = entry;
              const { routine, start } = occurrence;
              const dimmed = dimReason(routine) !== undefined;
              const failed = occurrence.past && occurrence.run?.status === "failed";
              return (
                <button
                  key={`${routine.id}-${start.getTime()}`}
                  type="button"
                  title={occurrenceTitle(occurrence)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(routine);
                  }}
                  className="absolute flex flex-col overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight text-fg"
                  style={{
                    ...position,
                    ...blockStyle(tintOf(routine), occurrence, dimmed),
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1">
                    <AgentAvatar agentId={routine.agentId} avatar={agentOf(routine)?.avatar} size={14} />
                    <span className="min-w-0 flex-1 truncate font-medium">{routine.name}</span>
                    {occurrence.past && occurrence.run?.status === "completed" ? <Check className="size-3 shrink-0" /> : null}
                    {failed ? <AlertCircle className="size-3 shrink-0 text-danger" /> : null}
                  </span>
                  <span className="truncate text-fg-muted">{timeText(start)}</span>
                </button>
              );
            })}
            {dayKey(day) === today ? (
              <div className="pointer-events-none absolute inset-x-0 z-10 h-px bg-danger" style={{ top: nowTop }}>
                <span className="absolute -left-1 -top-[3px] size-[7px] rounded-full bg-danger" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const MONTH_CHIPS = 3;

function MonthGrid({ days, month, today, byDay, denseByDay, tintOf, tintOfAgent, onOpen, onItem, onDay }: GridProps & { month: number; onDay: (day: Date) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="grid grid-cols-7 border-b border-border py-1 text-center text-xs text-fg-muted">
        {days.slice(0, 7).map((day) => (
          <span key={day.getDay()}>{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto" style={{ gridAutoRows: "minmax(5.5rem, 1fr)" }}>
        {days.map((day) => {
          const key = dayKey(day);
          const occurrences = byDay.get(key) ?? [];
          const dense = denseByDay.get(key) ?? [];
          const total = occurrences.length + dense.length;
          return (
            <div
              key={key}
              className={cn("min-w-0 cursor-pointer space-y-0.5 border-b border-l border-border p-1", day.getMonth() !== month && "bg-bg-subtle")}
              onClick={() => onDay(day)}
            >
              <span className={cn("inline-flex size-5 items-center justify-center rounded-full text-xs", key === today ? "bg-danger text-white" : day.getMonth() === month ? "text-fg" : "text-fg-subtle")}>{day.getDate()}</span>
              {dense.slice(0, 1).map((routine) => (
                <button key={routine.id} type="button" className="block w-full truncate rounded px-1 text-left text-[11px] text-fg" style={{ backgroundColor: `color-mix(in srgb, ${tintOf(routine)} 25%, transparent)` }} onClick={(event) => { event.stopPropagation(); onOpen(routine); }}>
                  {routine.name} · {t("automations.cal.hourly")}
                </button>
              ))}
              {occurrences.slice(0, MONTH_CHIPS - Math.min(1, dense.length)).map((entry) => {
                if (entry.type === "item") {
                  const { block } = entry;
                  return (
                    <button
                      key={`item-${block.item.id}`}
                      type="button"
                      title={itemTitle(block)}
                      className="flex w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] text-fg"
                      style={itemStyle(tintOfAgent(block.item.agentId), block)}
                      onClick={(event) => {
                        event.stopPropagation();
                        onItem(block.item);
                      }}
                    >
                      <ItemIcon block={block} />
                      <span className="min-w-0 flex-1 truncate">{block.item.title}</span>
                      {block.item.status === "done" ? <Check className="size-3 shrink-0" /> : null}
                    </button>
                  );
                }
                const occurrence = entry.occurrence;
                return (
                <button
                  key={`${occurrence.routine.id}-${occurrence.start.getTime()}`}
                  type="button"
                  title={occurrenceTitle(occurrence)}
                  className={cn("flex w-full min-w-0 items-center gap-1 rounded px-1 text-left text-[11px] text-fg", occurrence.past && occurrence.run?.status === "failed" && "outline outline-1 outline-danger", !occurrence.past && dimReason(occurrence.routine) && "opacity-50")}
                  style={{ backgroundColor: `color-mix(in srgb, ${tintOf(occurrence.routine)} ${occurrence.past ? 38 : 16}%, transparent)` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(occurrence.routine);
                  }}
                >
                  <span className="truncate">{timeText(occurrence.start)} {occurrence.routine.name}</span>
                </button>
                );
              })}
              {total > MONTH_CHIPS ? <span className="px-1 text-[11px] text-fg-subtle">{t("automations.cal.more", { n: total - MONTH_CHIPS })}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OnDemand({ routines, tintOf, onOpen }: { routines: Routine[]; tintOf: (r: Routine) => string; onOpen: (r: Routine) => void }) {
  const capped = useCapped(routines, 4);
  if (routines.length === 0) return null;
  return (
    <section className="max-h-44 shrink-0 overflow-y-auto border-t border-border px-5 py-3">
      <h3 className="mb-1.5 text-xs font-medium text-fg-muted">{t("automations.cal.onDemand")}</h3>
      <div className="flex flex-wrap gap-1.5">
        {capped.shown.map((routine) => (
          <button
            key={routine.id}
            type="button"
            title={triggerText(routine)}
            onClick={() => onOpen(routine)}
            className="flex max-w-60 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-fg"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tintOf(routine) }} />
            <span className="truncate">{routine.name}</span>
            <span className="truncate text-fg-subtle">{triggerText(routine)}</span>
          </button>
        ))}
      </div>
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}
