import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, Mail, Play, ShieldCheck } from "lucide-react";
import { Timeline } from "./Timeline";

const meta = {
  title: "Patterns/Timeline",
  component: Timeline,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof Timeline>;

export const TaskRun: Story = {
  render: () => (
    <div className="w-[28rem] rounded-lg border border-border bg-card p-4">
      <Timeline
        items={[
          {
            id: "1",
            title: "Run started",
            description: "Juno picked up the morning routine.",
            timestamp: "09:00",
            icon: <Play className="size-4 text-muted-foreground" />,
            tone: "default",
          },
          {
            id: "2",
            title: "Inbox triaged",
            description: "42 messages sorted, 6 flagged for you.",
            timestamp: "09:03",
            icon: <Mail className="size-4 text-muted-foreground" />,
            tone: "success",
          },
          {
            id: "3",
            title: "Approval needed",
            description: "Juno wants to reply to the Acme thread.",
            timestamp: "09:05",
            icon: <ShieldCheck className="size-4 text-muted-foreground" />,
            tone: "warning",
          },
          {
            id: "4",
            title: "Run finished",
            description: "Summary posted to the Juno chat.",
            timestamp: "09:06",
            icon: <Check className="size-4 text-muted-foreground" />,
            tone: "success",
          },
        ]}
      />
    </div>
  ),
};

export const Failures: Story = {
  render: () => (
    <div className="w-[28rem] rounded-lg border border-border bg-card p-4">
      <Timeline
        items={[
          { id: "1", title: "Deploy preview", description: "Shipped to preview.", tone: "success" },
          { id: "2", title: "Smoke test", description: "Checkout flow returned a 500.", tone: "danger" },
        ]}
      />
    </div>
  ),
};
