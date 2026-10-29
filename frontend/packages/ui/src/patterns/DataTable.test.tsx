import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { header: "Name", accessorKey: "name" },
];

const data: Row[] = [
  { id: "1", name: "Charlie" },
  { id: "2", name: "Alice" },
  { id: "3", name: "Bob" },
];

const getRowId = (row: Row) => row.id;

function rowNames(): (string | null)[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td")?.textContent ?? null);
}

describe("DataTable", () => {
  it("renders a column header and a row per item", () => {
    render(<DataTable columns={columns} data={data} getRowId={getRowId} />);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(data.length + 1);
    expect(rowNames()).toEqual(["Charlie", "Alice", "Bob"]);
  });

  it("toggles sort order as the header is clicked", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={data} getRowId={getRowId} />);

    await user.click(screen.getByRole("columnheader", { name: /Name/ }));
    expect(rowNames()).toEqual(["Alice", "Bob", "Charlie"]);

    await user.click(screen.getByRole("columnheader", { name: /Name/ }));
    expect(rowNames()).toEqual(["Charlie", "Bob", "Alice"]);
  });

  it("adds a selection column and selects every row from the header checkbox", async () => {
    const user = userEvent.setup();
    const onRowSelectionChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={data}
        getRowId={getRowId}
        rowSelection={{}}
        onRowSelectionChange={onRowSelectionChange}
      />,
    );

    const [selectAll] = screen.getAllByRole("checkbox");
    await user.click(selectAll as HTMLElement);

    expect(onRowSelectionChange).toHaveBeenCalledWith({
      "1": true,
      "2": true,
      "3": true,
    });
  });

  it("selects a single row from its checkbox", async () => {
    const user = userEvent.setup();
    const onRowSelectionChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={data}
        getRowId={getRowId}
        rowSelection={{}}
        onRowSelectionChange={onRowSelectionChange}
      />,
    );

    const [, firstRow] = screen.getAllByRole("checkbox");
    await user.click(firstRow as HTMLElement);

    expect(onRowSelectionChange).toHaveBeenCalledWith({ "1": true });
  });

  it("calls onRowClick with the clicked row", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={data}
        getRowId={getRowId}
        onRowClick={onRowClick}
      />,
    );

    await user.click(screen.getByText("Bob"));

    expect(onRowClick).toHaveBeenCalledWith(data[2]);
  });

  it("renders the empty state when there is no data", () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        emptyState={<span>No agents</span>}
      />,
    );
    expect(screen.getByText("No agents")).toBeInTheDocument();
  });
});
