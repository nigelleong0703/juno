import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "../primitives";
import { PageHeader } from "./PageHeader";

const meta = {
  title: "Patterns/PageHeader",
  component: PageHeader,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof PageHeader>;

export const Default: Story = {
  args: {
    title: "Agents",
    subtitle: "Manage and monitor your agents",
  },
};

export const WithActions: Story = {
  args: {
    title: "Agents",
    subtitle: "Manage and monitor your agents",
    actions: <Button variant="primary">Create agent</Button>,
  },
};

export const WithBack: Story = {
  args: {
    title: "Agent Details",
    back: <Button variant="ghost" size="sm" asChild><ArrowLeft /></Button>,
    actions: (
      <div className="flex gap-2">
        <Button variant="secondary">Edit</Button>
        <Button variant="danger">Delete</Button>
      </div>
    ),
  },
};

export const WithTabs: Story = {
  args: {
    title: "Agent Settings",
    tabs: (
      <div className="flex border-b border-border">
        <button className="px-4 py-2 text-sm text-accent border-b-2 border-accent">
          Overview
        </button>
        <button className="px-4 py-2 text-sm text-fg-muted hover:text-fg">
          Configuration
        </button>
        <button className="px-4 py-2 text-sm text-fg-muted hover:text-fg">
          History
        </button>
      </div>
    ),
  },
};

export const Complex: Story = {
  args: {
    title: "Tasks",
    subtitle: "3 active, 12 completed",
    back: <Button variant="ghost" size="sm" asChild><ArrowLeft /></Button>,
    actions: (
      <Button variant="primary">
        <Plus />
        New task
      </Button>
    ),
  },
};
