import type { Meta, StoryObj } from "@storybook/react-vite";
import { RelativeTime } from "./RelativeTime";

const meta = {
  title: "Patterns/RelativeTime",
  component: RelativeTime,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RelativeTime>;

export default meta;
type Story = StoryObj<typeof RelativeTime>;

const now = new Date();

export const NowISH: Story = {
  args: {
    date: new Date(now.getTime() - 5 * 1000),
  },
};

export const FewMinutesAgo: Story = {
  args: {
    date: new Date(now.getTime() - 3 * 60 * 1000),
  },
};

export const OneHourAgo: Story = {
  args: {
    date: new Date(now.getTime() - 60 * 60 * 1000),
  },
};

export const FewHoursAgo: Story = {
  args: {
    date: new Date(now.getTime() - 5 * 60 * 60 * 1000),
  },
};

export const Yesterday: Story = {
  args: {
    date: new Date(now.getTime() - 24 * 60 * 60 * 1000),
  },
};

export const WeekAgo: Story = {
  args: {
    date: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  },
};

export const MonthAgo: Story = {
  args: {
    date: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
  },
};

export const YearAgo: Story = {
  args: {
    date: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
  },
};

export const WithString: Story = {
  args: {
    date: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
  },
};

export const WithTimestamp: Story = {
  args: {
    date: now.getTime() - 30 * 60 * 1000,
  },
};
