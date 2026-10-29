import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { DataView } from "./DataView";
import { StatusPill } from "./StatusPill";
import { Button } from "../primitives";
import { Trash2 } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

const meta = {
  title: "Patterns/DataView",
  component: DataView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DataView>;

export default meta;
type Story = StoryObj<typeof DataView>;
type ViewMode = "list" | "table" | "grid";

interface Agent {
  id: string;
  name: string;
  runtime: string;
  status: "Online" | "Idle" | "Busy" | "Offline";
  tasks: number;
}

const sampleItems: Agent[] = [
  { id: "1", name: "Juno", runtime: "task runner", status: "Online", tasks: 12 },
  { id: "2", name: "Patch", runtime: "file editor", status: "Idle", tasks: 8 },
  { id: "3", name: "Ledger", runtime: "analyst", status: "Busy", tasks: 24 },
  { id: "4", name: "Echo", runtime: "logger", status: "Offline", tasks: 0 },
];

const statusTone = {
  Online: "success",
  Idle: "neutral",
  Busy: "warning",
  Offline: "neutral",
} as const;

const columns: ColumnDef<Agent>[] = [
  {
    accessorKey: "name",
    header: "Agent",
    cell: (info) => (
      <div className="flex flex-col">
        <span className="font-medium text-fg">{info.getValue() as string}</span>
        <span className="text-xs text-fg-muted">{info.row.original.runtime}</span>
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: (info) => {
      const status = info.getValue() as Agent["status"];
      return <StatusPill size="sm" tone={statusTone[status]} label={status} />;
    },
  },
  {
    accessorKey: "tasks",
    header: "Tasks",
    cell: (info) => info.getValue(),
    enableSorting: true,
  },
];

function AgentListRow({ item }: { item: Agent }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium text-fg">{item.name}</div>
        <div className="text-xs text-fg-muted">{item.runtime}</div>
      </div>
      <div className="flex items-center gap-3">
        <StatusPill size="sm" tone={statusTone[item.status]} label={item.status} />
        <span className="text-sm text-fg-muted">{item.tasks} tasks</span>
      </div>
    </div>
  );
}

/** Stateful wrapper so every mode shows the toolbar, selection and bulk actions. */
function AgentsDataView({ initialMode }: { initialMode: ViewMode }) {
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  return (
    <div className="p-4">
      <DataView
        items={sampleItems}
        getItemId={(item) => item.id}
        mode={mode}
        onModeChange={setMode}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        renderItem={(item) => <AgentListRow item={item} />}
        columns={columns}
        renderGridItem={(item) => (
          <div className="flex flex-col items-start gap-2">
            <div className="font-medium text-fg">{item.name}</div>
            <div className="text-xs text-fg-muted">{item.runtime}</div>
            <StatusPill size="sm" tone={statusTone[item.status]} label={item.status} />
            <div className="text-sm text-fg-muted">{item.tasks} tasks</div>
          </div>
        )}
        bulkActions={
          <Button size="sm" variant="danger">
            <Trash2 className="size-4" />
            Delete
          </Button>
        }
      />
    </div>
  );
}

export const List: Story = {
  render: () => <AgentsDataView initialMode="list" />,
};

export const Table: Story = {
  render: () => <AgentsDataView initialMode="table" />,
};

export const Grid: Story = {
  render: () => <AgentsDataView initialMode="grid" />,
};

export const WithSelection: Story = {
  render: function WithSelectionRender() {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(
      () => new Set(["1", "3"]),
    );

    return (
      <div className="p-4">
        <DataView
          items={sampleItems}
          getItemId={(item) => item.id}
          mode="list"
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onModeChange={() => {}}
          renderItem={(item) => <AgentListRow item={item} />}
          bulkActions={
            <Button size="sm" variant="danger">
              <Trash2 className="size-4" />
              Delete
            </Button>
          }
        />
      </div>
    );
  },
};

export const Empty: Story = {
  render: () => (
    <div className="p-4">
      <DataView
        items={[]}
        getItemId={(item: Agent) => item.id}
        mode="list"
        renderItem={(item: Agent) => item.name}
        emptyState={
          <div className="text-center text-fg-muted">
            <p className="font-medium">No agents found</p>
            <p className="text-xs mt-1">Create your first agent to get started</p>
          </div>
        }
      />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="p-4">
      <DataView
        items={[]}
        getItemId={(item: Agent) => item.id}
        mode="list"
        renderItem={(item: Agent) => item.name}
        loading
      />
    </div>
  ),
};

export const Error: Story = {
  render: () => (
    <div className="p-4">
      <DataView
        items={[]}
        getItemId={(item: Agent) => item.id}
        mode="list"
        renderItem={(item: Agent) => item.name}
        error={
          <div className="text-center text-danger">
            <p className="font-medium">Failed to load agents</p>
            <p className="text-xs mt-1">Please try again later</p>
          </div>
        }
      />
    </div>
  ),
};
