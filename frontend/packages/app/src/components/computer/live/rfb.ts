import type {
  LiveScreenAdapter,
  LiveScreenStateDetail,
  LiveScreenStateHandler,
  LiveScreenTarget,
} from "../types";

/**
 * The imperative half of the noVNC integration: a `LiveScreenAdapter` built on an injected RFB
 * constructor. Keeping the RFB class injectable means the connection lifecycle (connect →
 * viewOnly → disconnect, plus state fan-out) is unit-testable without a real websocket.
 */

/** The slice of `@novnc/novnc`'s RFB that this adapter touches. */
export interface RfbLike {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  clipViewport: boolean;
  background: string;
  /** noVNC supports `credentials` for late-arriving passwords. */
  credentials?: { username?: string; password?: string; target?: string };
  disconnect(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface RfbOptions {
  shared?: boolean;
  credentials?: { username?: string; password?: string; target?: string };
  wsProtocols?: string[];
}

export type RfbConstructor = new (
  target: HTMLElement,
  url: string,
  options?: RfbOptions,
) => RfbLike;

export interface CreateRfbAdapterOptions {
  createRfb: RfbConstructor;
  /** Element the RFB canvas is appended to. */
  container: HTMLElement;
}

const BACKGROUND = "#0b1220";

/** Build a `LiveScreenAdapter` around an RFB constructor. */
export function createRfbAdapter(options: CreateRfbAdapterOptions): LiveScreenAdapter {
  const { createRfb, container } = options;
  const handlers = new Set<LiveScreenStateHandler>();
  const clipboardHandlers = new Set<(text: string) => void>();
  let rfb: RfbLike | null = null;
  let current: LiveScreenStateDetail = { state: "idle" };

  const emit = (detail: LiveScreenStateDetail): void => {
    current = detail;
    for (const handler of handlers) handler(detail);
  };

  // Bound listeners, so `removeEventListener` gets the same references back.
  const onConnect = (): void => emit({ state: "connected" });
  const onDisconnect = (event: Event): void => {
    const detail = (event as CustomEvent<{ clean?: boolean }>).detail;
    emit({ state: "disconnected", clean: detail?.clean ?? false });
  };
  const onSecurityFailure = (event: Event): void => {
    const detail = (event as CustomEvent<{ status?: number; reason?: string }>).detail;
    emit({
      state: "error",
      message: detail?.reason ?? `Security negotiation failed (${detail?.status ?? "unknown"})`,
    });
  };

  const onClipboard = (event: Event): void => {
    const text = (event as CustomEvent<{ text?: string }>).detail?.text ?? "";
    for (const handler of clipboardHandlers) handler(text);
  };

  /** Ctrl + a letter on the remote (the same chord iOS sends for Copy and Paste). */
  const ctrlChord = (keysym: number, code: string): void => {
    rfb?.sendKey(0xffe3, "ControlLeft", true);
    rfb?.sendKey(keysym, code);
    rfb?.sendKey(0xffe3, "ControlLeft", false);
  };

  function detach(instance: RfbLike): void {
    instance.removeEventListener("clipboard", onClipboard);
    instance.removeEventListener("connect", onConnect);
    instance.removeEventListener("disconnect", onDisconnect);
    instance.removeEventListener("securityfailure", onSecurityFailure);
  }

  return {
    connect(target: LiveScreenTarget, connectOptions: { viewOnly: boolean }) {
      if (rfb) {
        detach(rfb);
        rfb.disconnect();
        rfb = null;
      }

      emit({ state: "connecting" });

      const credentials = target.password ? { password: target.password } : undefined;
      const instance = new createRfb(container, target.url, { shared: true, credentials });

      instance.viewOnly = connectOptions.viewOnly;
      instance.scaleViewport = true;
      instance.resizeSession = false;
      instance.clipViewport = true;
      instance.background = BACKGROUND;

      instance.addEventListener("clipboard", onClipboard);
      instance.addEventListener("connect", onConnect);
      instance.addEventListener("disconnect", onDisconnect);
      instance.addEventListener("securityfailure", onSecurityFailure);

      rfb = instance;
    },

    setViewOnly(viewOnly: boolean) {
      if (rfb) rfb.viewOnly = viewOnly;
    },

    disconnect() {
      if (!rfb) return;
      detach(rfb);
      rfb.disconnect();
      rfb = null;
      emit({ state: "disconnected", clean: true });
    },

    copy() {
      ctrlChord(0x63, "KeyC");
    },

    pressPaste() {
      if (rfb) ctrlChord(0x76, "KeyV");
    },

    paste(text: string) {
      if (!rfb) return;
      rfb.clipboardPasteFrom(text);
      ctrlChord(0x76, "KeyV");
    },

    onClipboard(handler: (text: string) => void) {
      clipboardHandlers.add(handler);
      return () => clipboardHandlers.delete(handler);
    },

    onState(handler: LiveScreenStateHandler) {
      handlers.add(handler);
      // Replay the current state so a late subscriber is not left blank.
      handler(current);
      return () => handlers.delete(handler);
    },
  };
}
