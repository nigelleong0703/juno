import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColumnDef } from "@tanstack/react-table";
import { Grid3x3, List, Table2, X } from "lucide-react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { useRef, useState } from "react";
import { Button, Checkbox, SegmentedControl } from "../primitives";
import { DataTable } from "./DataTable";
import { cn } from "@/lib/utils";

export type DataViewMode = "list" | "table" | "grid";

export interface DataViewProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  mode: DataViewMode;
  onModeChange?: (mode: DataViewMode) => void;
  selectedIds?: Set<string> | string[];
  onSelectionChange?: (ids: Set<string>) => void;
  renderItem: (item: T) => ReactNode;
  columns?: ColumnDef<T, unknown>[];
  renderGridItem?: (item: T) => ReactNode;
  bulkActions?: ReactNode;
  emptyState?: ReactNode;
  loading?: boolean;
  error?: ReactNode;
  virtualize?: boolean;
  className?: string;
}

/** List / table / grid view over one data set, with selection and a bulk bar. */
export function DataView<T>({
  items,
  getItemId,
  mode,
  onModeChange,
  selectedIds: selectedIdsProp,
  onSelectionChange,
  renderItem,
  columns,
  renderGridItem,
  bulkActions,
  emptyState,
  loading,
  error,
  virtualize = true,
  className,
}: DataViewProps<T>) {
  const selectedIdsSet = new Set(
    selectedIdsProp instanceof Set ? selectedIdsProp : selectedIdsProp || [],
  );
  const [localSelectedIds, setLocalSelectedIds] = useState(selectedIdsSet);
  const selectedIds = onSelectionChange ? selectedIdsSet : localSelectedIds;
  const parentRef: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);

  const handleSelectionChange = (ids: Set<string>) => {
    if (onSelectionChange) onSelectionChange(ids);
    else setLocalSelectedIds(ids);
  };

  const handleSelectAll = (checked: boolean) => {
    handleSelectionChange(checked ? new Set(items.map(getItemId)) : new Set());
  };

  const handleToggleItem = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    handleSelectionChange(next);
  };

  if (error) {
    return (
      <div data-slot="data-view" className={cn("flex items-center justify-center p-4", className)}>
        {error}
      </div>
    );
  }

  if (loading && items.length === 0) {
    return (
      <div data-slot="data-view" className={cn("flex items-center justify-center p-8", className)}>
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div data-slot="data-view" className={cn("flex flex-col gap-4", className)}>
        {onModeChange && (
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="text-sm font-medium text-muted-foreground">View</div>
            <ModeSelector value={mode} onChange={onModeChange} />
          </div>
        )}
        {emptyState || (
          <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
            No items
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-slot="data-view" className={cn("flex flex-col gap-4", className)}>
      {(onSelectionChange || onModeChange) && (
        <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
          <div className="flex items-center gap-3">
            {onSelectionChange && (
              <>
                <Checkbox
                  aria-label="Select all"
                  checked={
                    selectedIds.size === items.length && items.length > 0
                      ? true
                      : selectedIds.size > 0 && selectedIds.size < items.length
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={handleSelectAll}
                />
                {selectedIds.size === 0 && (
                  <span className="text-sm text-muted-foreground">
                    {items.length} {items.length === 1 ? "item" : "items"}
                  </span>
                )}
              </>
            )}
          </div>
          {onModeChange && <ModeSelector value={mode} onChange={onModeChange} />}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-interactive-selected px-3 py-2">
          <div className="text-sm text-foreground">{selectedIds.size} selected</div>
          <div className="flex items-center gap-2">
            {bulkActions}
            <Button size="sm" variant="ghost" onClick={() => handleSelectionChange(new Set())}>
              <X className="size-4" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {mode === "list" && (
        <VirtualizedList
          items={items}
          getItemId={getItemId}
          renderItem={renderItem}
          selectedIds={selectedIds}
          onToggleSelection={handleToggleItem}
          virtualize={virtualize}
          parentRef={parentRef}
          selectable={Boolean(onSelectionChange)}
        />
      )}

      {mode === "table" && columns && (
        <DataTable
          columns={columns}
          data={items}
          getRowId={getItemId}
          rowSelection={Object.fromEntries(Array.from(selectedIds).map((id) => [id, true]))}
          onRowSelectionChange={
            onSelectionChange
              ? (rowSelection) => {
                  const next = new Set<string>();
                  Object.entries(rowSelection).forEach(([id, selected]) => {
                    if (selected) next.add(id);
                  });
                  handleSelectionChange(next);
                }
              : undefined
          }
        />
      )}

      {mode === "grid" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => {
            const id = getItemId(item);
            const isSelected = selectedIds.has(id);
            return (
              <div
                key={id}
                className={cn(
                  "relative rounded-lg border p-3 transition-colors duration-150 ease-out",
                  isSelected
                    ? "border-primary bg-interactive-selected"
                    : "border-border hover:bg-interactive-hover active:bg-interactive-pressed",
                )}
                onClick={() => {
                  if (onSelectionChange) handleToggleItem(id);
                }}
              >
                {onSelectionChange && (
                  <Checkbox
                    aria-label={isSelected ? "Deselect item" : "Select item"}
                    checked={isSelected}
                    onCheckedChange={() => handleToggleItem(id)}
                    className="absolute right-2 top-2"
                  />
                )}
                <div className={onSelectionChange ? "pr-6" : undefined}>
                  {renderGridItem ? renderGridItem(item) : renderItem(item)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface VirtualizedListProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  virtualize: boolean;
  parentRef: RefObject<HTMLDivElement | null>;
  selectable: boolean;
}

function VirtualizedList<T>({
  items,
  getItemId,
  renderItem,
  selectedIds,
  onToggleSelection,
  virtualize,
  parentRef,
  selectable,
}: VirtualizedListProps<T>) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    enabled: virtualize,
  });

  const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
  const totalSize = virtualize ? virtualizer.getTotalSize() : 0;

  const row = (item: T, key: string, style?: CSSProperties) => {
    const id = getItemId(item);
    const isSelected = selectedIds.has(id);
    return (
      <div
        key={key}
        style={style}
        className={cn(
          "flex items-center gap-3 px-3 py-2 transition-colors",
          isSelected && "bg-interactive-selected",
          selectable ? "cursor-pointer" : "hover:bg-interactive-hover active:bg-interactive-pressed",
        )}
        onClick={() => {
          if (selectable) onToggleSelection(id);
        }}
      >
        {selectable && (
          <Checkbox
            aria-label={isSelected ? "Deselect row" : "Select row"}
            checked={isSelected}
            onCheckedChange={() => onToggleSelection(id)}
          />
        )}
        <div className="min-w-0 flex-1 overflow-hidden">{renderItem(item)}</div>
      </div>
    );
  };

  if (!virtualize) {
    return (
      <div
        ref={parentRef}
        className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
      >
        {items.map((item) => row(item, getItemId(item)))}
      </div>
    );
  }

  if (!virtualItems) return null;

  return (
    <div
      ref={parentRef}
      className="max-h-96 overflow-y-auto rounded-lg border border-border bg-card"
    >
      <div style={{ height: `${totalSize}px` }} className="relative">
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          return row(item, String(virtualItem.key), {
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            transform: `translateY(${virtualItem.start}px)`,
          });
        })}
      </div>
    </div>
  );
}

interface ModeSelectorProps {
  value: DataViewMode;
  onChange: (mode: DataViewMode) => void;
}

function ModeSelector({ value, onChange }: ModeSelectorProps) {
  return (
    <SegmentedControl
      aria-label="View mode"
      value={value}
      onValueChange={(next) => onChange(next as DataViewMode)}
      items={[
        {
          value: "list",
          label: <span className="sr-only">List view</span>,
          icon: <List className="size-4" />,
        },
        {
          value: "table",
          label: <span className="sr-only">Table view</span>,
          icon: <Table2 className="size-4" />,
        },
        {
          value: "grid",
          label: <span className="sr-only">Grid view</span>,
          icon: <Grid3x3 className="size-4" />,
        },
      ]}
    />
  );
}
