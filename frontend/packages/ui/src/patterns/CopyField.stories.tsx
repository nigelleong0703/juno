import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyField } from "./CopyField";

const meta = {
  title: "Patterns/CopyField",
  component: CopyField,
  parameters: { layout: "centered" },
} satisfies Meta<typeof CopyField>;

export default meta;
type Story = StoryObj<typeof CopyField>;

export const Webhook: Story = {
  args: {
    label: "Webhook URL",
    value: "https://hooks.agent-desktop.dev/juno/9f3c21",
  },
};

export const Stack: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-4">
      <CopyField label="Webhook URL" value="https://hooks.agent-desktop.dev/juno/9f3c21" />
      <CopyField label="Agent ID" value="agt_9f3c21b7e4" />
    </div>
  ),
};
