import type { ReactNode } from "react";
import { Spinner } from "../primitives";
import { cn } from "@/lib/utils";

export interface LoadingStateProps {
  label?: ReactNode;
  className?: string;
}

/** Centred spinner with an optional label. */
export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div
      data-slot="loading-state"
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <Spinner className="size-5 text-muted-foreground" />
      {label && <div className="text-sm text-muted-foreground">{label}</div>}
    </div>
  );
}
