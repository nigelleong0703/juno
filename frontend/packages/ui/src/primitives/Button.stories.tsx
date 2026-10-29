import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Send } from "lucide-react";
import { Button } from "./index";

const meta = {
  title: "Primitives/Button",
  component: Button,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof Button>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">New task</Button>
      <Button variant="secondary">Duplicate</Button>
      <Button variant="outline">Cancel</Button>
      <Button variant="ghost">Skip</Button>
      <Button variant="link">Learn more</Button>
      <Button variant="danger">Delete</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="xs" variant="outline">xs</Button>
      <Button size="sm" variant="outline">sm</Button>
      <Button size="md" variant="outline">md</Button>
      <Button size="lg" variant="outline">lg</Button>
    </div>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">
        <Plus /> New routine
      </Button>
      <Button variant="secondary">
        Open <ArrowRight />
      </Button>
      <Button size="icon" variant="primary" aria-label="Send">
        <Send />
      </Button>
    </div>
  ),
};
