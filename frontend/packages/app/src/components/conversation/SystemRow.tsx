import type { SystemItem } from "../../lib/items";
import { Button, cn } from "@agent-desktop/ui";
import { AlertTriangle, Info, MonitorPlay, RotateCcw, XCircle } from "lucide-react";
import { t } from "../../lib/i18n";

export interface SystemRowProps {
  item: SystemItem;
  onAction?: (command: string) => void;
  className?: string;
}

const LEVEL_ICON = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
} as const;

/** Low-key system note inside a transcript, with its optional action button. */
export function SystemRow({ item, onAction, className }: SystemRowProps) {
  const Icon = LEVEL_ICON[item.level];
  const tone =
    item.level === "error"
      ? "text-danger"
      : item.level === "warning"
        ? "text-warning"
        : "text-fg-subtle";

  const action = item.action;
  const actionIcon =
    action?.command === "computer.open" ? (
      <MonitorPlay className="size-3.5" />
    ) : action?.command === "run.retry" ? (
      <RotateCcw className="size-3.5" />
    ) : null;

  return (
    <div className={cn("flex items-center gap-2 py-1.5 text-xs text-fg-muted", className)}>
      <Icon className={cn("size-3.5 shrink-0", tone)} />
      <span className={cn("min-w-0 flex-1", item.level === "error" && "text-danger")}>
        {item.text}
      </span>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={() => onAction?.(action.command)}
        >
          {actionIcon}
          {action.command === "run.retry" ? t("system.retry") : action.label}
        </Button>
      )}
    </div>
  );
}
