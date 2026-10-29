import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListRow } from "./ListRow";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { StatusPill } from "./StatusPill";

const meta = {
  title: "Patterns/ListRow",
  component: ListRow,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ListRow>;

export default meta;
type Story = StoryObj<typeof ListRow>;

function Dot({ n, label }: { n: number; label: string }) {
  return (
    <Avatar style={{ width: 28, height: 28 }}>
      <AvatarFallback className="text-xs font-medium" style={{ background: `var(--color-agent-${n}-soft)`, color: `var(--agent-${n})` }}>
        {label}
      </AvatarFallback>
    </Avatar>
  );
}

export const ChatRow: Story = {
  render: () => (
    <div className="w-80 rounded-lg border border-border bg-card p-1">
      <ListRow
        leading={<Dot n={1} label="J" />}
        title="Juno"
        description="Triaged 42 messages and flagged 6 for you."
        meta="2m"
        unread={3}
        onClick={() => {}}
      />
    </div>
  ),
};

export const ChatList: Story = {
  render: () => (
    <div className="w-80 rounded-lg border border-border bg-card p-1">
      <ListRow
        leading={<Dot n={1} label="J" />}
        title="Juno"
        description="Triaged 42 messages and flagged 6 for you."
        meta="2m"
        unread={3}
        selected
        onClick={() => {}}
      />
      <ListRow
        leading={<Dot n={3} label="J" />}
        title="Patch"
        description="Opened a PR for the flaky checkout test."
        meta="18m"
        onClick={() => {}}
      />
      <ListRow
        leading={<Dot n={6} label="J" />}
        title="Ledger"
        description="Reconciled August invoices; 2 need approval."
        meta="1h"
        trailing={<StatusPill tone="warning" label="Needs you" size="sm" />}
        onClick={() => {}}
      />
    </div>
  ),
};

export const Dense: Story = {
  render: () => (
    <div className="w-80 rounded-lg border border-border bg-card p-1">
      <ListRow dense title="juno/routines" description="ignored" meta="folder" onClick={() => {}} />
      <ListRow dense title="juno/inbox" description="ignored" meta="folder" onClick={() => {}} />
    </div>
  ),
};
