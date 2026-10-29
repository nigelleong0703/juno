import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "../primitives";
import { cn } from "@/lib/utils";

export interface SearchFieldProps {
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  shortcut?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}

/** Search input with a leading icon, an optional shortcut hint and a clear button. */
export function SearchField({
  value = "",
  onValueChange,
  placeholder = "Search...",
  shortcut,
  className,
  size = "md",
}: SearchFieldProps) {
  return (
    <div
      data-slot="search-field"
      className={cn("relative flex items-center", className)}
    >
      <div className="pointer-events-none absolute left-3 text-muted-foreground">
        <Search className="size-4" />
      </div>
      <Input
        type="text"
        value={value}
        onChange={(e) => onValueChange?.(e.currentTarget.value)}
        placeholder={placeholder}
        className={cn(
          "rounded-full border-transparent bg-muted pl-9 shadow-none dark:bg-muted",
          size === "sm" ? "h-8" : "h-9",
          value ? "pr-9" : shortcut ? "pr-12" : "pr-3",
        )}
      />
      {value && (
        <button
          type="button"
          className="absolute right-3 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => onValueChange?.("")}
          aria-label="Clear search"
        >
          <X className="size-4" />
        </button>
      )}
      {shortcut && !value && (
        <div className="pointer-events-none absolute right-3 text-xs text-muted-foreground">
          {shortcut}
        </div>
      )}
    </div>
  );
}
