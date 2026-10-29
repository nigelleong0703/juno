import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckCircle2, Clock, Grid3x3, List } from "lucide-react";
import { useState } from "react";
import { Button } from "../primitives";
import { FilterBar, FilterChip } from "./FilterBar";

const meta = {
  title: "Patterns/FilterBar",
  component: FilterBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FilterBar>;

export default meta;
type Story = StoryObj<typeof FilterBar>;

function WithChipsDemo() {
  const [activeStatus, setActiveStatus] = useState(false);
  const [activePriority, setActivePriority] = useState(false);

  return (
    <FilterBar
      onClear={() => {
        setActiveStatus(false);
        setActivePriority(false);
      }}
    >
      <FilterChip
        label="Status: Active"
        active={activeStatus}
        onClick={() => setActiveStatus(!activeStatus)}
        onRemove={() => setActiveStatus(false)}
        icon={<CheckCircle2 />}
      />
      <FilterChip
        label="Priority: High"
        active={activePriority}
        onClick={() => setActivePriority(!activePriority)}
        onRemove={() => setActivePriority(false)}
      />
    </FilterBar>
  );
}

export const WithChips: Story = {
  args: {},
  render: () => <WithChipsDemo />,
};

export const WithSort: Story = {
  args: {},
  render: () => (
    <FilterBar
      sort={
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">Sort by:</span>
          <Button variant="ghost" size="sm">
            Name
          </Button>
        </div>
      }
    >
      <FilterChip label="Status: Running" active icon={<Clock />} />
    </FilterBar>
  ),
};

export const WithViewSwitcher: Story = {
  args: {},
  render: () => (
    <FilterBar
      viewSwitcher={
        <div className="flex gap-1 border-l border-border pl-3">
          <Button variant="ghost" size="sm" asChild>
            <List />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Grid3x3 />
          </Button>
        </div>
      }
    >
      <FilterChip label="Status: Completed" active />
    </FilterBar>
  ),
};

function ComplexDemo() {
  const [filters, setFilters] = useState({ status: true, priority: false });

  return (
    <FilterBar
      sort={
        <select className="text-sm bg-surface border border-border rounded-sm px-2 py-1">
          <option>Newest first</option>
          <option>Oldest first</option>
          <option>A-Z</option>
        </select>
      }
      viewSwitcher={
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" asChild>
            <List />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Grid3x3 />
          </Button>
        </div>
      }
      onClear={() => setFilters({ status: false, priority: false })}
    >
      <FilterChip
        label="Status: Active"
        active={filters.status}
        onClick={() => setFilters({ ...filters, status: !filters.status })}
        onRemove={() => setFilters({ ...filters, status: false })}
        icon={<CheckCircle2 />}
      />
      <FilterChip
        label="Priority: High"
        active={filters.priority}
        onClick={() => setFilters({ ...filters, priority: !filters.priority })}
        onRemove={() => setFilters({ ...filters, priority: false })}
      />
    </FilterBar>
  );
}

export const Complex: Story = {
  args: {},
  render: () => <ComplexDemo />,
};

export const Empty: Story = {
  args: {
    children: <span className="text-sm text-fg-muted">No filters applied</span>,
  },
};
