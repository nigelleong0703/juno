import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef } from "@tanstack/react-table";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataView } from "./DataView";

interface Row {
  id: string;
  name: string;
}

const items: Row[] = [
  { id: "a1", name: "Alpha" },
  { id: "a2", name: "Beta" },
  { id: "a3", name: "Gamma" },
];

const getItemId = (item: Row) => item.id;

const columns: ColumnDef<Row, unknown>[] = [
  { header: "Name", accessorKey: "name" },
];

type ViewProps = ComponentProps<typeof DataView<Row>>;

function renderView(props: Partial<ViewProps> = {}) {
  return render(
    <DataView<Row>
      items={items}
      getItemId={getItemId}
      mode="list"
      renderItem={(item) => <span>{item.name}</span>}
      virtualize={false}
      {...props}
    />,
  );
}

describe("DataView", () => {
  it("renders items through the list render prop", () => {
    renderView();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("reports mode changes from the mode selector", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    renderView({ onModeChange });

    await user.click(screen.getByRole("radio", { name: "Table view" }));
    expect(onModeChange).toHaveBeenCalledWith("table");

    await user.click(screen.getByRole("radio", { name: "Grid view" }));
    expect(onModeChange).toHaveBeenCalledWith("grid");
  });

  it("renders the same items as a table in table mode", () => {
    renderView({ mode: "table", columns });
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(items.length + 1);
  });

  it("renders the same items as a grid in grid mode", () => {
    renderView({ mode: "grid", renderGridItem: (item) => <span>{item.name}</span> });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("selects a single item when its row is clicked", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderView({ selectedIds: new Set<string>(), onSelectionChange });

    await user.click(screen.getByText("Beta"));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange.mock.calls[0]?.[0]).toEqual(new Set(["a2"]));
  });

  it("selects every item from the header checkbox", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderView({ selectedIds: new Set<string>(), onSelectionChange });

    const [selectAll] = screen.getAllByRole("checkbox");
    await user.click(selectAll as HTMLElement);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["a1", "a2", "a3"]));
  });

  it("clears the selection from the bulk-action bar", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderView({ selectedIds: new Set(["a1", "a2"]), onSelectionChange });

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
  });

  it("shows the empty state when there are no items", () => {
    renderView({ items: [], emptyState: <span>No agents yet</span> });
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
  });

  it("shows the error content when loading fails", () => {
    renderView({ error: <span>Could not load agents</span> });
    expect(screen.getByText("Could not load agents")).toBeInTheDocument();
  });
});
