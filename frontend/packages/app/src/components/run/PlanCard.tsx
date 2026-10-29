import type { Todo } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { Check, ChevronDown, CircleAlert, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { t } from "../../lib/i18n";

export interface PlanCardProps {
  plan?: { title?: string; todos: Todo[] };
  title?: string;
  className?: string;
}

interface TodoMark {
  box: string;
  glyph: ReactNode;
}

/** Checkbox mark per todo status. A blocked todo reads as an alert, never as done. */
function todoMark(status: Todo["status"]): TodoMark {
  if (status === "done") {
    return { box: "border-success bg-success text-white", glyph: <Check className="size-3" /> };
  }
  if (status === "in_progress") {
    return { box: "border-accent text-accent", glyph: <Loader2 className="size-3 animate-spin" /> };
  }
  if (status === "blocked") {
    return { box: "border-warning text-warning", glyph: <CircleAlert className="size-3" /> };
  }
  return { box: "border-border-strong text-transparent", glyph: null };
}

const RUNNING_ROWS = 3;

/** Compact checklist: while running, the active todos then the next pending ones; all done collapses to the header. */
export function PlanCard({ plan, title, className }: PlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const todos = plan?.todos ?? [];
  const heading = title ?? plan?.title ?? t("run.plan");
  const done = todos.filter((todo) => todo.status === "done").length;
  const remaining = todos.length - done;
  const allDone = todos.length > 0 && remaining === 0;
  const active = todos.filter((todo) => todo.status === "in_progress" || todo.status === "blocked");
  const pending = todos.filter((todo) => todo.status === "pending");
  const preview = [...active, ...pending].slice(0, RUNNING_ROWS);
  const rows = expanded ? todos : allDone ? [] : preview;
  const hidden = todos.length - preview.length;
  const toggle = allDone || (!expanded && hidden > 0);

  return (
    <div className={cn("rounded-xl border border-border bg-surface", className)}>
      <button
        type="button"
        disabled={!allDone}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={allDone ? expanded : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
          rows.length > 0 && "border-b border-border",
          !allDone && "cursor-default",
        )}
      >
        <span className="text-sm font-medium text-fg">{heading}</span>
        <span className="flex items-center gap-1 text-xs text-fg-subtle">
          {allDone ? (
            <>
              <Check className="size-3 text-success" />
              {t("goals.status.done")}
              <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            </>
          ) : (
            t("run.plan.todo.remaining", { count: remaining })
          )}
        </span>
      </button>
      <ul className="divide-y divide-border">
        {rows.map((todo) => {
          const mark = todoMark(todo.status);
          return (
            <li key={todo.id} className="flex items-start gap-2.5 px-3 py-2">
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border",
                  mark.box,
                )}
              >
                {mark.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm",
                    todo.status === "done" ? "text-fg-muted line-through" : "text-fg",
                  )}
                >
                  {todo.text}
                </p>
                {todo.note && <p className="mt-0.5 text-xs text-fg-subtle">{todo.note}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      {!allDone && toggle && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-border px-3 py-2 text-left text-xs text-fg-muted hover:text-fg"
        >
          {t("plan.more", { count: hidden })}
        </button>
      )}
      {!allDone && expanded && hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-border px-3 py-2 text-left text-xs text-fg-muted hover:text-fg"
        >
          {t("common.showLess")}
        </button>
      )}
      {todos.length > 0 && (
        <div className="h-0.5 w-full overflow-hidden bg-bg-subtle">
          <div
            className="h-full bg-accent transition-all duration-300"
            style={{ width: `${(done / todos.length) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
