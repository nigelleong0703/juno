import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../primitives";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Custom action node; takes precedence over the retry button. */
  action?: ReactNode;
  /** Convenience retry handler; renders a retry button when given. */
  onRetry?: () => void;
  retryLabel?: string;
  icon?: ReactNode;
  className?: string;
}

/** Error placeholder, defaults to a warning icon and generic copy. */
export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  onRetry,
  retryLabel = "Try again",
  icon,
  className,
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-danger/10 text-danger">
        {icon ?? <AlertTriangle className="size-5" />}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && (
          <div className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {action ? (
        <div className="mt-1">{action}</div>
      ) : onRetry ? (
        <div className="mt-1">
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
