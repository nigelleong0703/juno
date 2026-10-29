import type { Step } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import {
  ArrowUpDown,
  Check,
  CircleAlert,
  Globe,
  Hourglass,
  Keyboard,
  Loader2,
  Lock,
  MousePointer2,
  Search,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { isRefusedPurchase, stepDomain, stepIconKey, stepLine, visibleSteps, type StepIconKey } from "../../lib/stepLine";
import { Reveal, StepDetail } from "./StepDetail";

const ICON: Record<StepIconKey, LucideIcon> = {
  search: Search,
  globe: Globe,
  click: MousePointer2,
  keyboard: Keyboard,
  scroll: ArrowUpDown,
  terminal: Terminal,
  lock: Lock,
  hourglass: Hourglass,
  check: Check,
};

export interface StepRowProps {
  step: Step;
  /** Every step of the run (hidden ones too): a click takes its label from an earlier page snapshot. */
  run?: readonly Step[];
  first?: boolean;
  last?: boolean;
}

/** One step in plain words: a round icon on the thread, one sentence, a muted domain. Click for detail. */
export function StepRow({ step, run = [step], first = true, last = true }: StepRowProps) {
  const [open, setOpen] = useState(false);
  const live = step.status === "running" || step.status === "pending";
  const failed = step.status === "failed" && !isRefusedPurchase(step);
  const Icon = failed ? CircleAlert : ICON[stepIconKey(step)];
  const domain = stepDomain(step);
  const thread = (hidden: boolean, className?: string) => (
    <span className={cn("w-px bg-border", hidden && "opacity-0", className)} />
  );
  return (
    <div className="flex items-stretch gap-2.5">
      <div className="flex w-6 shrink-0 flex-col items-center">
        {thread(first, "h-1.5")}
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle",
            failed ? "text-danger" : "text-fg-muted",
          )}
        >
          {live ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> : <Icon className="size-3" />}
        </span>
        {thread(last, "flex-1")}
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="block w-full pb-2.5 pt-2 text-left focus-ring"
        >
          {step.title ? (
            <>
              <span className="line-clamp-2 text-sm font-semibold text-fg">{step.title}</span>
              {step.detail ? <span className="line-clamp-3 block text-xs text-fg-muted">{step.detail}</span> : null}
            </>
          ) : (
            <span className="line-clamp-2 text-sm text-fg">{stepLine(step, run) ?? step.target}</span>
          )}
          {domain && !step.title ? <span className="block truncate text-xs text-fg-subtle">{domain}</span> : null}
        </button>
        <Reveal open={open}>
          <StepDetail step={step} />
        </Reveal>
      </div>
    </div>
  );
}

/** The steps as one timeline: a thread joins their icons, so they read as one piece of work. */
export function StepTimeline({ steps, limit }: { steps: readonly Step[]; limit?: number }) {
  const shown = visibleSteps(steps).slice(0, limit);
  return (
    <div className="flex flex-col">
      {shown.map((step, index) => (
        <StepRow key={step.id} step={step} run={steps} first={index === 0} last={index === shown.length - 1} />
      ))}
    </div>
  );
}
