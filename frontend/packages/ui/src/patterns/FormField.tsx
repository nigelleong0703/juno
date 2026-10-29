import { cloneElement, isValidElement, useId } from "react";
import type { ReactNode } from "react";
import { Label } from "../primitives";
import { cn } from "@/lib/utils";

export interface FormFieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Helper text under the control; replaced by the error when one is set. */
  description?: ReactNode;
  /** When set, renders an error message and marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  /** Render children as-is without injecting aria props (custom controls). */
  raw?: boolean;
}

/**
 * Labelled form row. The control receives `id`, `aria-describedby` and
 * `aria-invalid` when it accepts them, so screen readers stay in sync.
 */
export function FormField({
  label,
  children,
  description,
  error,
  required,
  htmlFor,
  className,
  raw = false,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  const messageId = `${controlId}-description`;
  const hasMessage = Boolean(error || description);

  let control: ReactNode = children;
  if (!raw && isValidElement<Record<string, unknown>>(children)) {
    control = cloneElement(children, {
      id: children.props.id ?? controlId,
      "aria-describedby": children.props["aria-describedby"] ?? (hasMessage ? messageId : undefined),
      "aria-invalid": error ? true : children.props["aria-invalid"],
    });
  }

  return (
    <div data-slot="form-field" className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={controlId} className="text-sm text-foreground">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {control}
      {error ? (
        <p id={messageId} className="text-xs text-danger">
          {error}
        </p>
      ) : description ? (
        <p id={messageId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}
