import { Eye, EyeOff, X } from "lucide-react";
import { useId, useState } from "react";
import { IconButton, Input, Label } from "../primitives";
import { cn } from "@/lib/utils";

export interface SecretFieldProps {
  /** Current typed value. The component is write-only: a stored secret is never read back. */
  value?: string;
  onChange?: (value: string) => void;
  /** Called when the user clears a stored or typed value. */
  onClear?: () => void;
  label?: string;
  placeholder?: string;
  /** An existing secret is present on the server; shown only as a masked marker. */
  hasStoredValue?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * Write-only secret input. There is deliberately no prop for reading a stored
 * secret back: an existing value is represented by a fixed masked marker, and
 * the user can only replace or clear it.
 */
export function SecretField({
  value,
  onChange,
  onClear,
  label,
  placeholder,
  hasStoredValue = false,
  disabled = false,
  className,
  id,
}: SecretFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [revealed, setRevealed] = useState(false);
  const [internal, setInternal] = useState("");

  const current = value ?? internal;
  const canClear = hasStoredValue || current.length > 0;

  const handleChange = (next: string) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  return (
    <div data-slot="secret-field" className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type={revealed ? "text" : "password"}
          value={current}
          onChange={(e) => handleChange(e.currentTarget.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <IconButton
          label={revealed ? "Hide" : "Show"}
          size="md"
          variant="outline"
          disabled={disabled}
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </IconButton>
        {canClear && (
          <IconButton
            label="Clear"
            size="md"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              handleChange("");
              onClear?.();
            }}
          >
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      {hasStoredValue && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">•••••••• stored</span>
          <span>A value is already set</span>
        </div>
      )}
    </div>
  );
}
