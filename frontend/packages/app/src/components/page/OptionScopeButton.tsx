import { cn, Popover, PopoverContent, PopoverTrigger } from "@agent-desktop/ui";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { SCOPE_TRIGGER, ScopeRow } from "../agent/AgentScopeButton";

/** A scope capsule over plain options (a category, a status): same look and popover as the agent scope. */
export function OptionScopeButton({ options, value, onChange, label }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={cn(SCOPE_TRIGGER, "px-3.5")}>
          <span className="max-w-32 truncate">{chosen?.label ?? label}</span>
          <ChevronDown className="size-3.5 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5">
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {options.map((option) => (
            <ScopeRow
              key={option.value}
              label={option.label}
              selected={option.value === value}
              onPick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
