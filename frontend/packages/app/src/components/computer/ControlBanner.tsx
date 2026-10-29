import { Button, cn } from "@agent-desktop/ui";
import { Eye, Hand, KeyRound, Radio, SkipForward, Check } from "lucide-react";
import type { ReactNode } from "react";
import { tc } from "./i18n";
import { PILL } from "./surface";
import type { ComputerViewMode } from "./types";

export interface ControlBannerProps {
  mode: ComputerViewMode;
  agentName?: string;
  /**
   * External site awaiting a browser sign-in (e.g. linear.app). Shown explicitly: the app's
   * login is never the site's login, and a pending request never proves the model paused.
   */
  siteName?: string;
  /** Seconds elapsed while teaching (for the REC banner). */
  teachSeconds?: number;
  onTeachStop?: () => void;
  onSigninDone?: () => void;
  onSkipStep?: () => void;
  onContinue?: () => void;
  className?: string;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A banner stacks: the icon + text span the full width on the first row, so nothing truncates at
 * narrow pane widths; the actions sit right-aligned on a second row.
 */
function Banner({
  tone,
  icon,
  text,
  actions,
  className,
}: {
  tone: string;
  icon: ReactNode;
  text: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5 text-sm", tone, className)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex shrink-0 items-center">{icon}</span>
        <span className="min-w-0 flex-1">{text}</span>
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-1.5">{actions}</div>}
    </div>
  );
}

/**
 * The banner above the live screen (§6/§4.3). Rendered per `ComputerViewMode`: watching, in
 * control, teaching (REC), sign-in (model paused) or needs-you. The asleep state is handled by
 * `ComputerView` as a full overlay. The Take over / Return control toggle lives in the pane
 * header, so the watch and control banners stay text-only.
 */
export function ControlBanner({
  mode,
  agentName = "The agent",
  siteName = "",
  teachSeconds = 0,
  onTeachStop,
  onSigninDone,
  onSkipStep,
  onContinue,
  className,
}: ControlBannerProps) {
  switch (mode) {
    case "control":
      return (
        <Banner
          className={className}
          tone="bg-accent-subtle text-fg"
          icon={<Hand className="size-4 text-accent" />}
          text={tc("computer.mode.control.banner", { name: agentName })}
        />
      );

    case "teach":
      return (
        <Banner
          className={className}
          tone="bg-muted text-fg"
          icon={
            <span className="flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-danger" />
              </span>
              <Radio className="size-4 text-fg-muted" />
            </span>
          }
          text={tc("computer.mode.teach.banner", {
            name: agentName,
            time: formatClock(teachSeconds),
          })}
          actions={
            onTeachStop ? (
              <Button variant="ghost" size="sm" className={PILL} onClick={onTeachStop}>
                {tc("computer.mode.teach.stop")}
              </Button>
            ) : undefined
          }
        />
      );

    case "signin":
      return (
        <Banner
          className={className}
          tone="bg-muted text-fg"
          icon={<KeyRound className="size-4 text-fg-muted" />}
          text={
            <span className="flex flex-col">
              <span className="font-medium">{tc("computer.mode.signin.title")}</span>
              <span className="text-xs text-fg-muted">
                {tc("computer.mode.signin.body", { name: agentName, site: siteName })}
              </span>
            </span>
          }
          actions={
            onSigninDone ? (
              <Button variant="primary" size="sm" className={PILL} onClick={onSigninDone}>
                <Check className="size-3.5" />
                {tc("computer.mode.signin.done")}
              </Button>
            ) : undefined
          }
        />
      );

    case "needs-you":
      return (
        <Banner
          className={className}
          tone="bg-muted text-fg"
          icon={<span aria-hidden className="size-1.5 rounded-full bg-warning" />}
          text={
            <span className="flex flex-col">
              <span className="font-medium">{tc("computer.mode.needsYou.title")}</span>
              <span className="text-xs text-fg-muted">
                {tc("computer.mode.needsYou.body", { name: agentName })}
              </span>
            </span>
          }
          actions={
            <>
              {onSkipStep && (
                <Button variant="ghost" size="sm" className={PILL} onClick={onSkipStep}>
                  <SkipForward className="size-3.5" />
                  {tc("computer.mode.needsYou.skip")}
                </Button>
              )}
              {onContinue && (
                <Button variant="primary" size="sm" className={PILL} onClick={onContinue}>
                  <Check className="size-3.5" />
                  {tc("computer.mode.needsYou.continue")}
                </Button>
              )}
            </>
          }
        />
      );

    case "watch":
      return (
        <Banner
          className={className}
          tone="bg-bg-subtle text-fg-muted"
          icon={<Eye className="size-4" />}
          text={tc("computer.mode.watch.banner", { name: agentName })}
        />
      );

    case "asleep":
    default:
      return null;
  }
}
