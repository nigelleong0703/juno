import type { Meta, StoryObj } from "@storybook/react-vite";
import { Download, Maximize2, MoreVertical } from "lucide-react";
import { Button } from "../primitives";
import { Toolbar } from "./Toolbar";

const meta = {
  title: "Patterns/Toolbar",
  component: Toolbar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Toolbar>;

export default meta;
type Story = StoryObj<typeof Toolbar>;

export const Default: Story = {
  args: {
    left: <span className="text-sm text-fg-muted">5 items selected</span>,
    right: (
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" asChild>
          <Download />
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <MoreVertical />
        </Button>
      </div>
    ),
  },
};

export const LeftOnly: Story = {
  args: {
    left: <span className="text-sm font-medium text-fg">Export</span>,
  },
};

export const RightOnly: Story = {
  args: {
    right: (
      <div className="flex gap-2">
        <Button variant="secondary" size="sm">
          Cancel
        </Button>
        <Button variant="primary" size="sm">
          Apply
        </Button>
      </div>
    ),
  },
};

export const Compact: Story = {
  args: {
    left: <span className="text-xs text-fg-muted uppercase tracking-wide">Compact</span>,
    right: (
      <Button variant="ghost" size="sm" asChild>
        <Maximize2 />
      </Button>
    ),
  },
};
