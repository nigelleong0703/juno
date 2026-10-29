import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  className?: string;
  /** Render as a two-column grid instead of stacked rows. */
  columns?: 1 | 2;
}

/** Definition list of label/value pairs. */
export function KeyValueList({ items, className, columns = 1 }: KeyValueListProps) {
  return (
    <dl
      data-slot="key-value-list"
      className={cn(
        "grid gap-x-6 gap-y-3",
        columns === 2 && "sm:grid-cols-2",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd
            className={cn(
              "truncate text-sm text-foreground",
              item.mono && "font-mono text-sm",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
