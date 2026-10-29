import type { Meta, StoryObj } from "@storybook/react-vite";
import { FilePreview } from "./FilePreview";

const meta = {
  title: "Patterns/FilePreview",
  component: FilePreview,
  parameters: { layout: "centered" },
} satisfies Meta<typeof FilePreview>;

export default meta;
type Story = StoryObj<typeof FilePreview>;

export const Single: Story = {
  args: {
    name: "runbook.md",
    size: "12 KB",
  },
};

export const AttachmentList: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-2">
      <FilePreview name="runbook.md" size="12 KB" meta={<span>edited 2h ago</span>} />
      <FilePreview name="invoices-2026-q3.csv" size="48 KB" />
      <FilePreview name="juno-walkthrough.mp4" size="18.4 MB" meta={<span>02:14</span>} />
      <FilePreview name="contract.pdf" size="220 KB" onRemove={() => {}} />
    </div>
  ),
};
