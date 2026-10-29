import type { Meta, StoryObj } from "@storybook/react-vite";
import { Meter } from "./Meter";

const meta = {
  title: "Patterns/Meter",
  component: Meter,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Meter>;

export default meta;
type Story = StoryObj<typeof Meter>;

export const Default: Story = {
  args: { label: "Context used", value: 62 },
};

export const Tones: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Meter label="Tasks done" value={82} tone="success" />
      <Meter label="Budget used" value={64} tone="warning" />
      <Meter label="Rate limit" value={95} tone="danger" />
    </div>
  ),
};

export const CustomRange: Story = {
  args: { label: "Tokens", value: 128000, max: 200000, formatValue: (v, m) => `${Math.round(v / 1000)}k / ${Math.round(m / 1000)}k` },
};
