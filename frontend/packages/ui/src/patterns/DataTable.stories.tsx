import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { ColumnDef, SortingState, RowSelectionState } from "@tanstack/react-table";
import { DataTable } from "./DataTable";

const meta = {
  title: "Patterns/DataTable",
  component: DataTable,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DataTable>;

export default meta;
type Story = StoryObj<typeof DataTable>;

interface Task {
  id: string;
  title: string;
  status: "pending" | "in-progress" | "completed";
  priority: "low" | "medium" | "high";
  assignee: string;
}

const sampleData: Task[] = [
  {
    id: "1",
    title: "Review design mockups",
    status: "completed",
    priority: "high",
    assignee: "Juno",
  },
  {
    id: "2",
    title: "Fix login bug",
    status: "in-progress",
    priority: "high",
    assignee: "Patch",
  },
  {
    id: "3",
    title: "Update documentation",
    status: "pending",
    priority: "medium",
    assignee: "Ledger",
  },
  {
    id: "4",
    title: "Optimize database queries",
    status: "in-progress",
    priority: "medium",
    assignee: "Echo",
  },
];

const columns: ColumnDef<Task>[] = [
  {
    accessorKey: "title",
    header: "Title",
    cell: (info) => (
      <div className="font-medium text-fg">{info.getValue() as string}</div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: (info) => {
      const status = info.getValue() as string;
      const statusColors: Record<string, string> = {
        pending: "bg-warning-subtle text-warning",
        "in-progress": "bg-info-subtle text-info",
        completed: "bg-success-subtle text-success",
      };
      return (
        <span
          className={`inline-block px-2 py-1 rounded-sm text-xs font-medium ${statusColors[status]}`}
        >
          {status}
        </span>
      );
    },
  },
  {
    accessorKey: "priority",
    header: "Priority",
    cell: (info) => (
      <span className="text-sm text-fg-muted capitalize">
        {info.getValue() as string}
      </span>
    ),
  },
  {
    accessorKey: "assignee",
    header: "Assignee",
    cell: (info) => (
      <span className="text-sm text-fg">{info.getValue() as string}</span>
    ),
  },
];

export const Default: Story = {
  render: () => (
    <div className="p-4">
      <DataTable columns={columns} data={sampleData} getRowId={(row) => row.id} />
    </div>
  ),
};

export const Sortable: Story = {
  render: function SortableRender() {
    const [sorting, setSorting] = useState<SortingState>([]);

    return (
      <div className="p-4">
        <DataTable
          columns={columns}
          data={sampleData}
          getRowId={(row) => row.id}
          sorting={sorting}
          onSortingChange={setSorting}
        />
      </div>
    );
  },
};

export const Selectable: Story = {
  render: function SelectableRender() {
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

    return (
      <div className="p-4">
        <DataTable
          columns={columns}
          data={sampleData}
          getRowId={(row) => row.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
        />
      </div>
    );
  },
};

export const WithRowClick: Story = {
  render: () => (
    <div className="p-4">
      <DataTable
        columns={columns}
        data={sampleData}
        getRowId={(row) => row.id}
        onRowClick={(row) => alert(`Clicked: ${row.title}`)}
      />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="p-4">
      <DataTable
        columns={columns}
        data={[]}
        emptyState={
          <div className="text-center text-fg-muted">
            <p className="font-medium">No tasks found</p>
            <p className="text-xs mt-1">Create your first task to get started</p>
          </div>
        }
      />
    </div>
  ),
};
