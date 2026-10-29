import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives";
import { cn } from "@/lib/utils";

export interface DataTableProps<T> {
  /** Column definitions. */
  columns: ColumnDef<T, unknown>[];
  /** Table data. */
  data: T[];
  /** Function to get a stable row id. */
  getRowId?: (row: T) => string;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  onRowClick?: (row: T) => void;
  /** Empty state content. */
  emptyState?: ReactNode;
  className?: string;
}

/** Sortable, optionally selectable data table on the shadcn Table recipe. */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  sorting: sortingProp,
  onSortingChange,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  onRowClick,
  emptyState,
  className,
}: DataTableProps<T>) {
  const [sortingLocal, setSortingLocal] = useState<SortingState>([]);
  const [rowSelectionLocal, setRowSelectionLocal] = useState<RowSelectionState>({});

  const sorting = sortingProp ?? sortingLocal;
  const rowSelection = rowSelectionProp ?? rowSelectionLocal;

  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    if (onSortingChange) onSortingChange(next);
    else setSortingLocal(next);
  };

  const handleRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    const next = typeof updater === "function" ? updater(rowSelection) : updater;
    if (onRowSelectionChange) onRowSelectionChange(next);
    else setRowSelectionLocal(next);
  };

  const columnsWithSelection: ColumnDef<T, unknown>[] = onRowSelectionChange
    ? [
        {
          id: "select",
          size: 40,
          header: ({ table }) => (
            <Checkbox
              aria-label="Select all rows"
              checked={
                table.getIsAllRowsSelected()
                  ? true
                  : table.getIsSomeRowsSelected()
                    ? "indeterminate"
                    : false
              }
              onCheckedChange={(value) => table.toggleAllRowsSelected(!!value)}
            />
          ),
          cell: ({ row }) => (
            <Checkbox
              aria-label="Select row"
              checked={row.getIsSelected()}
              onCheckedChange={(value) => row.toggleSelected(!!value)}
            />
          ),
        },
        ...columns,
      ]
    : columns;

  const table = useReactTable({
    data,
    columns: columnsWithSelection,
    state: { sorting, rowSelection },
    onSortingChange: handleSortingChange,
    onRowSelectionChange: handleRowSelectionChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId,
  });

  if (data.length === 0) {
    return (
      <div data-slot="data-table" className={cn("flex items-center justify-center p-8", className)}>
        {emptyState || <div className="text-sm text-muted-foreground">No data available</div>}
      </div>
    );
  }

  return (
    <div data-slot="data-table" className={cn("overflow-hidden rounded-lg border border-border", className)}>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const isSortable = header.column.getCanSort();
                const sortDirection = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    onClick={isSortable ? header.column.getToggleSortingHandler() : undefined}
                    className={cn(
                      isSortable && "cursor-pointer select-none",
                      header.column.id === "select" && "w-10",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {isSortable && (
                        <span className="flex items-center">
                          {sortDirection === "asc" && <ArrowUp className="size-4 text-foreground" />}
                          {sortDirection === "desc" && <ArrowDown className="size-4 text-foreground" />}
                          {!sortDirection && (
                            <ChevronsUpDown className="size-4 text-muted-foreground opacity-50" />
                          )}
                        </span>
                      )}
                    </div>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? "selected" : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              className={cn(onRowClick && "cursor-pointer")}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
