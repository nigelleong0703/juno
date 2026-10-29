import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../primitives";
import { cn } from "@/lib/utils";

export interface CommandMenuItem {
  id: string;
  label: ReactNode;
  keywords?: string[];
  icon?: ReactNode;
  shortcut?: ReactNode;
  onSelect?: () => void;
}

export interface CommandMenuGroup {
  heading: string;
  items: CommandMenuItem[];
}

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
  groups?: CommandMenuGroup[];
  placeholder?: string;
  emptyMessage?: string;
  loading?: boolean;
  className?: string;
}

/**
 * Command palette composed from the shadcn Dialog + Command (cmdk) recipe.
 * Filtering, keyboard navigation and Escape-to-close come from cmdk and Radix.
 */
export function CommandMenu({
  open,
  onOpenChange,
  children,
  groups,
  placeholder = "Type a command or search…",
  emptyMessage = "No results",
  loading = false,
  className,
}: CommandMenuProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="command-menu"
        showCloseButton={false}
        className={cn("top-24 translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl", className)}
      >
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a command or navigate.
        </DialogDescription>
        <Command shouldFilter loop>
          <CommandInput placeholder={placeholder} />
          <CommandList className="max-h-96">
            <CommandEmpty>
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Loading…
                </span>
              ) : (
                emptyMessage
              )}
            </CommandEmpty>
            {children ??
              groups?.map((group) => (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.items.map((item) => {
                    const labelText =
                      typeof item.label === "string" ? item.label : item.id;
                    return (
                      <CommandItem
                        key={item.id}
                        value={`${labelText} ${item.keywords?.join(" ") ?? ""}`}
                        onSelect={() => {
                          item.onSelect?.();
                          onOpenChange(false);
                        }}
                      >
                        {item.icon && <span className="shrink-0">{item.icon}</span>}
                        <span className="truncate">{item.label}</span>
                        {item.shortcut && (
                          <span className="ml-auto text-xs text-muted-foreground">
                            {item.shortcut}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
