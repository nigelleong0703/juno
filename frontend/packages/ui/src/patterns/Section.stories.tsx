import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../primitives";
import { Section } from "./Section";

const meta = {
  title: "Patterns/Section",
  component: Section,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Section>;

export default meta;
type Story = StoryObj<typeof Section>;

export const Default: Story = {
  render: () => (
    <div className="w-[28rem]">
      <Section
        title="Routines"
        description="What Juno runs on a schedule."
        actions={<Button size="sm" variant="outline">New routine</Button>}
      >
        <div className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          Morning inbox triage · every weekday at 9:00
        </div>
      </Section>
    </div>
  ),
};

export const TitleOnly: Story = {
  render: () => (
    <div className="w-[28rem]">
      <Section title="Recent activity">
        <div className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          No activity yet.
        </div>
      </Section>
    </div>
  ),
};
