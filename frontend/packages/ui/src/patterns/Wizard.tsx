import type { ReactNode } from "react";
import { Button } from "../primitives";
import { Stepper, type StepperStep } from "./Stepper";
import { cn } from "@/lib/utils";

export interface WizardStep {
  id: string;
  label: ReactNode;
  description?: ReactNode;
}

export interface WizardProps {
  steps: WizardStep[];
  activeStep: number;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  onFinish?: () => void;
  nextLabel?: string;
  backLabel?: string;
  finishLabel?: string;
  canGoNext?: boolean;
  className?: string;
}

/** Multi-step flow: stepper header, step body and a Back / Continue footer. */
export function Wizard({
  steps,
  activeStep,
  children,
  onBack,
  onNext,
  onFinish,
  nextLabel = "Continue",
  backLabel = "Back",
  finishLabel = "Finish",
  canGoNext = true,
  className,
}: WizardProps) {
  const isFirstStep = activeStep === 0;
  const isLastStep = activeStep === steps.length - 1;
  const stepperSteps: StepperStep[] = steps;

  return (
    <div
      data-slot="wizard"
      className={cn("flex min-h-screen flex-col bg-background", className)}
    >
      <div className="px-6 pt-6">
        <Stepper steps={stepperSteps} currentStep={activeStep} orientation="horizontal" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>

      <div className="flex items-center justify-between gap-4 border-t border-border px-6 py-4">
        <div>
          {!isFirstStep && (
            <Button variant="ghost" onClick={onBack}>
              {backLabel}
            </Button>
          )}
        </div>
        <div>
          {isLastStep ? (
            <Button variant="primary" onClick={onFinish}>
              {finishLabel}
            </Button>
          ) : (
            <Button variant="primary" onClick={onNext} disabled={!canGoNext}>
              {nextLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
