import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot } from "lucide-react";
import { StatusPill } from "./StatusPill";

const meta = {
  title: "Patterns/StatusPill",
  component: StatusPill,
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusPill>;

export default meta;
type Story = StoryObj<typeof StatusPill>;

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone="neutral" label="Queued" />
      <StatusPill tone="accent" label="Working" />
      <StatusPill tone="success" label="Done" />
      <StatusPill tone="warning" label="Needs you" />
      <StatusPill tone="danger" label="Failed" />
      <StatusPill tone="info" label="Scheduled" />
    </div>
  ),
};

export const Small: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <StatusPill tone="success" label="Idle" size="sm" />
      <StatusPill tone="warning" label="Needs you" size="sm" />
    </div>
  ),
};

export const WithIcon: Story = {
  args: { tone: "accent", label: "Juno is working", icon: <Bot className="size-3.5" /> },
};
