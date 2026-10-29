import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../primitives";
import { EmptyState } from "./EmptyState";

const meta = {
  title: "Patterns/EmptyState",
  component: EmptyState,
  parameters: { layout: "centered" },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const NoTasks: Story = {
  args: {
    title: "No tasks yet",
    description: "Ask Juno to do something and it will show up here.",
    action: <Button variant="primary">New task</Button>,
  },
};

export const NoResults: Story = {
  args: {
    title: "No results",
    description: "Try a different search or clear your filters.",
  },
};

export const GetStarted: Story = {
  args: {
    title: "Meet Juno",
    description: "Juno handles your inbox, calendar and follow-ups while you work.",
    action: <Button variant="primary">Start a routine</Button>,
  },
};
