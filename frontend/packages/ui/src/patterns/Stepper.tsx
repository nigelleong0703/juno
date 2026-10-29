import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: string;
  label: ReactNode;
  description?: ReactNode;
}

export interface StepperProps {
  steps: StepperStep[];
  currentStep: number;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

/** Progress indicator for multi-step flows; done steps show a check. */
export function Stepper({
  steps,
  currentStep,
  orientation = "horizontal",
  className,
}: StepperProps) {
  const isVertical = orientation === "vertical";

  return (
    <div
      data-slot="stepper"
      className={cn(
        isVertical ? "flex flex-col gap-4" : "flex items-start gap-2",
        className,
      )}
    >
      {steps.map((step, index) => {
        const stepNum = index + 1;
        const isDone = index < currentStep;
        const isCurrent = index === currentStep;
        const isLast = index === steps.length - 1;

        return (
          <div
            key={step.id}
            className={cn(
              "flex items-start gap-3",
              isVertical ? "w-full" : "flex-1 flex-col items-center",
            )}
          >
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                isDone || isCurrent
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground",
              )}
            >
              {isDone ? <Check className="size-4" /> : <span>{stepNum}</span>}
            </div>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm font-medium",
                  isDone || isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
              </p>
              {step.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
              )}
            </div>

            {!isLast && isVertical && (
              <div className="ml-3 h-6 w-px shrink-0 bg-border" />
            )}

            {!isLast && !isVertical && (
              <div
                className={cn("mx-2 my-3 h-px flex-1", isDone ? "bg-primary" : "bg-border")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
