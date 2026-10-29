import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyValueList } from "./KeyValueList";

const meta = {
  title: "Patterns/KeyValueList",
  component: KeyValueList,
  parameters: { layout: "centered" },
} satisfies Meta<typeof KeyValueList>;

export default meta;
type Story = StoryObj<typeof KeyValueList>;

export const AgentDetails: Story = {
  render: () => (
    <div className="w-96 rounded-lg border border-border bg-card p-4">
      <KeyValueList
        items={[
          { key: "status", label: "Status", value: "Working" },
          { key: "model", label: "Model", value: "Juno 1.4" },
          { key: "schedule", label: "Schedule", value: "Every weekday, 9:00" },
          { key: "lastRun", label: "Last run", value: "12 minutes ago" },
        ]}
      />
    </div>
  ),
};

export const TwoColumns: Story = {
  render: () => (
    <div className="w-[32rem] rounded-lg border border-border bg-card p-4">
      <KeyValueList
        columns={2}
        items={[
          { key: "id", label: "Agent ID", value: "agt_9f3c21", mono: true },
          { key: "owner", label: "Owner", value: "Robin" },
          { key: "runtime", label: "Runtime", value: "42h 18m" },
          { key: "runs", label: "Runs", value: "1,204" },
          { key: "region", label: "Region", value: "eu-west-1" },
          { key: "created", label: "Created", value: "2026-08-02" },
        ]}
      />
    </div>
  ),
};
