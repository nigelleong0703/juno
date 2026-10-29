import type { ReactNode } from "react";

export interface DesktopShellProps {
  children: ReactNode;
}

/**
 * The desktop window's frame.
 *
 * The chrome — the top row with the collapse toggle, the app's icon rail, the chat list —
 * is the app's own shell (`packages/app`), shared with the browser build, so the two
 * render the same structure. What is left here is the window: a plain full-screen column
 * that lets the native traffic lights sit over the shared top row.
 */
export function DesktopShell({ children }: DesktopShellProps) {
  return (
    <div data-slot="desktop-shell" className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <div className="desktop-shell-inner flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
