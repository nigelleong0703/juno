import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Input } from "../primitives";
import { Wizard } from "./Wizard";

const meta = {
  title: "Patterns/Wizard",
  component: Wizard,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Wizard>;

export default meta;
type Story = StoryObj<typeof Wizard>;

const steps = [
  { id: "1", label: "Setup", description: "Configure basic settings" },
  { id: "2", label: "Connect", description: "Link your data source" },
  { id: "3", label: "Review", description: "Verify your configuration" },
];

const WizardDemo = ({ onFinish }: { onFinish?: () => void }) => {
  const [activeStep, setActiveStep] = useState(0);

  const handleNext = () => {
    if (activeStep < steps.length - 1) {
      setActiveStep(activeStep + 1);
    }
  };

  const handleBack = () => {
    if (activeStep > 0) {
      setActiveStep(activeStep - 1);
    }
  };

  const handleFinish = () => {
    onFinish?.();
  };

  return (
    <Wizard
      steps={steps}
      activeStep={activeStep}
      onNext={handleNext}
      onBack={handleBack}
      onFinish={handleFinish}
    >
      {activeStep === 0 && (
        <div className="max-w-lg space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-fg mb-2">
              Configure basic settings
            </h2>
            <p className="text-sm text-fg-muted mb-6">
              Enter the name and description for your agent.
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-fg">Agent name</label>
              <Input placeholder="e.g., Task Runner" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-fg">
                Description
              </label>
              <textarea
                placeholder="What does this agent do?"
                className="w-full h-20 mt-1 px-2 py-2 border border-border bg-surface rounded-sm text-base focus-ring focus-visible:border-accent"
              />
            </div>
          </div>
        </div>
      )}
      {activeStep === 1 && (
        <div className="max-w-lg space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-fg mb-2">
              Connect your data source
            </h2>
            <p className="text-sm text-fg-muted mb-6">
              Configure how your agent connects to your data.
            </p>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-fg">API key</label>
              <Input type="password" placeholder="sk-..." className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-fg">Endpoint</label>
              <Input
                placeholder="https://api.acme.dev/v1/runners"
                className="mt-1"
              />
            </div>
          </div>
        </div>
      )}
      {activeStep === 2 && (
        <div className="max-w-lg space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-fg mb-2">
              Review your configuration
            </h2>
            <p className="text-sm text-fg-muted mb-6">
              Please review everything before creating your agent.
            </p>
          </div>
          <div className="bg-surface border border-border rounded-md p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-fg-muted">Agent name:</span>
              <span className="text-fg font-medium">Task Runner</span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg-muted">Endpoint:</span>
              <span className="text-fg font-medium">
                https://api.acme.dev/v1/runners
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-fg-muted">Status:</span>
              <span className="text-success font-medium">Configured</span>
            </div>
          </div>
        </div>
      )}
    </Wizard>
  );
};

export const Basic: Story = {
  args: {},
  render: () => <WizardDemo />,
};

export const AtFirstStep: Story = {
  args: {},
  render: () => (
    <Wizard steps={steps} activeStep={0}>
      <div className="max-w-lg">
        <h2 className="text-lg font-semibold text-fg mb-2">Step 1: Setup</h2>
        <p className="text-sm text-fg-muted">
          Configure the basic settings for your agent.
        </p>
      </div>
    </Wizard>
  ),
};

export const AtLastStep: Story = {
  args: {},
  render: () => (
    <Wizard steps={steps} activeStep={2}>
      <div className="max-w-lg">
        <h2 className="text-lg font-semibold text-fg mb-2">Step 3: Review</h2>
        <p className="text-sm text-fg-muted">
          Review your configuration before proceeding.
        </p>
      </div>
    </Wizard>
  ),
};

export const CustomLabels: Story = {
  args: {},
  render: () => (
    <Wizard
      steps={steps}
      activeStep={1}
      nextLabel="Next step"
      backLabel="Previous"
      finishLabel="Create agent"
    >
      <div className="max-w-lg">
        <h2 className="text-lg font-semibold text-fg mb-2">Step 2: Connect</h2>
        <p className="text-sm text-fg-muted">
          Link your data source to the agent.
        </p>
      </div>
    </Wizard>
  ),
};

export const DisabledNext: Story = {
  args: {},
  render: () => (
    <Wizard steps={steps} activeStep={0} canGoNext={false}>
      <div className="max-w-lg">
        <h2 className="text-lg font-semibold text-fg mb-2">Step 1: Setup</h2>
        <p className="text-sm text-fg-muted">
          The Next button is disabled because required fields are not filled.
        </p>
      </div>
    </Wizard>
  ),
};
