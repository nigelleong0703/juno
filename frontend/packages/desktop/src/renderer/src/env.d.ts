import type { PlatformAdapter } from "@agent-desktop/app";

/** Actions the main process pushes to the renderer (tray click, notification click, deep link). */
export interface DesktopActionEvent {
  type: "open-request" | "deep-link" | "update-available";
  id?: string;
  /** The conversation an "open-request" action opens. */
  conversationId?: string;
  url?: string;
}

export interface DesktopBridge {
  onAction(listener: (event: DesktopActionEvent) => void): () => void;
  /** `muted`: the request's conversation is muted, so main must not pop a native notification for it. */
  setPending(items: Array<{ id: string; title: string; agentName?: string; conversationId?: string; muted?: boolean }>): void;
}

declare global {
  interface Window {
    startup?: { report(status: "renderer-ready" | "renderer-error"): void };
    /** Injected by the preload (packages/desktop/src/preload/index.ts). */
    platform: PlatformAdapter;
    /** Main-process actions the renderer subscribes to. */
    desktop?: DesktopBridge;
  }
}
