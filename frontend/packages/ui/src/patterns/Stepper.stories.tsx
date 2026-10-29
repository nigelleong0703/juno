import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stepper } from "./Stepper";

const meta = {
  title: "Patterns/Stepper",
  component: Stepper,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof Stepper>;

const steps = [
  { id: "1", label: "Setup", description: "Configure basic settings" },
  { id: "2", label: "Connect", description: "Link your data source" },
  { id: "3", label: "Review", description: "Verify your configuration" },
  { id: "4", label: "Deploy", description: "Launch your agent" },
];

export const Horizontal: Story = {
  args: {},
  render: () => (
    <div className="w-full max-w-2xl">
      <Stepper steps={steps} currentStep={1} orientation="horizontal" />
    </div>
  ),
};

export const HorizontalAtStart: Story = {
  args: {},
  render: () => (
    <div className="w-full max-w-2xl">
      <Stepper steps={steps} currentStep={0} orientation="horizontal" />
    </div>
  ),
};

export const HorizontalComplete: Story = {
  args: {},
  render: () => (
    <div className="w-full max-w-2xl">
      <Stepper steps={steps} currentStep={4} orientation="horizontal" />
    </div>
  ),
};

export const Vertical: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <Stepper steps={steps} currentStep={1} orientation="vertical" />
    </div>
  ),
};

export const VerticalAtStart: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <Stepper steps={steps} currentStep={0} orientation="vertical" />
    </div>
  ),
};

export const VerticalComplete: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <Stepper steps={steps} currentStep={4} orientation="vertical" />
    </div>
  ),
};

export const SimpleSteps: Story = {
  args: {},
  render: () => (
    <div className="w-full max-w-lg">
      <Stepper
        steps={[
          { id: "1", label: "Create account" },
          { id: "2", label: "Verify email" },
          { id: "3", label: "Set password" },
        ]}
        currentStep={1}
        orientation="horizontal"
      />
    </div>
  ),
};
