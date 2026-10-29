import { Wizard, cn, type WizardStep } from "@agent-desktop/ui";
import type { ReactNode } from "react";

export interface WizardPageProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  steps: WizardStep[];
  activeStep: number;
  onBack?: () => void;
  onNext?: () => void;
  onFinish?: () => void;
  nextLabel?: string;
  backLabel?: string;
  finishLabel?: string;
  canGoNext?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * The Wizard template (ARCHITECTURE §5.5): the ui `Wizard` (stepper + body + footer) under a
 * page heading. The New agent flow and onboarding both use it.
 */
export function WizardPage({
  title,
  subtitle,
  steps,
  activeStep,
  onBack,
  onNext,
  onFinish,
  nextLabel,
  backLabel,
  finishLabel,
  canGoNext,
  children,
  className,
}: WizardPageProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-bg", className)}>
      {title && (
        <header className="border-b border-border px-6 py-4">
          <h1 className="text-lg font-semibold text-fg">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
        </header>
      )}
      <Wizard
        className="min-h-0 flex-1"
        steps={steps}
        activeStep={activeStep}
        onBack={onBack}
        onNext={onNext}
        onFinish={onFinish}
        nextLabel={nextLabel}
        backLabel={backLabel}
        finishLabel={finishLabel}
        canGoNext={canGoNext}
      >
        {children}
      </Wizard>
    </div>
  );
}
