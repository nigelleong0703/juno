import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Canonical shadcn `cn()` helper. Kept at `@/lib/utils` so components pulled
 * from the shadcn registry work unchanged. `@/lib/cn` re-exports this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
