import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { Wizard, type WizardStep } from "./Wizard";

const steps: WizardStep[] = [
  { id: "one", label: "Account" },
  { id: "two", label: "Workspace" },
  { id: "three", label: "Review" },
];

function renderWizard(overrides: Partial<ComponentProps<typeof Wizard>> = {}) {
  return render(
    <Wizard steps={steps} activeStep={0} {...overrides}>
      <p>Step content</p>
    </Wizard>,
  );
}

describe("Wizard", () => {
  it("renders the current step content and the stepper", () => {
    renderWizard();
    expect(screen.getByText("Step content")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("hides Back on the first step and calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    renderWizard({ onNext });

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("shows Back and Finish on the last step", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onFinish = vi.fn();
    renderWizard({ activeStep: 2, onBack, onFinish });

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("disables Next when canGoNext is false", () => {
    renderWizard({ canGoNext: false });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("supports custom action labels", () => {
    renderWizard({ activeStep: 2, finishLabel: "Create agent" });
    expect(
      screen.getByRole("button", { name: "Create agent" }),
    ).toBeInTheDocument();
  });
});
