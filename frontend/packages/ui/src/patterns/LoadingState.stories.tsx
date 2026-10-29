import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoadingState } from "./LoadingState";

const meta = {
  title: "Patterns/LoadingState",
  component: LoadingState,
  parameters: { layout: "centered" },
} satisfies Meta<typeof LoadingState>;

export default meta;
type Story = StoryObj<typeof LoadingState>;

export const Default: Story = {
  args: { label: "Loading Juno's tasks…" },
};

export const WithoutLabel: Story = {
  args: {},
};

export const InPanel: Story = {
  render: () => (
    <div className="w-96 rounded-lg border border-border bg-card">
      <LoadingState label="Reading the inbox…" />
    </div>
  ),
};
