import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../primitives";
import { cn } from "@/lib/utils";

export interface CopyFieldProps {
  value: string;
  label?: string;
  className?: string;
  onCopy?: (value: string) => void;
}

/** Read-only value with a copy-to-clipboard button that confirms briefly. */
export function CopyField({ value, label, className, onCopy }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.(value);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      // Clipboard is unavailable (insecure context, denied permission).
      console.error("CopyField: failed to write to clipboard", error);
    }
  };

  return (
    <div data-slot="copy-field" className={cn("flex flex-col gap-1.5", className)}>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
          {value}
        </code>
        <IconButton
          label={copied ? "Copied" : "Copy to clipboard"}
          size="sm"
          variant="ghost"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </IconButton>
      </div>
    </div>
  );
}
