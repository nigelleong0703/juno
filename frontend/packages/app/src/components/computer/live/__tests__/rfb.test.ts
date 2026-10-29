import { describe, expect, it, beforeEach } from "vitest";
import { createRfbAdapter, type RfbLike, type RfbOptions } from "../rfb";
import type { LiveScreenStateDetail } from "../../types";

/** A fake `@novnc/novnc` RFB that records construction and lets tests fire its events. */
class FakeRfb implements RfbLike {
  static instances: FakeRfb[] = [];
  static reset(): void {
    FakeRfb.instances = [];
  }

  viewOnly = false;
  scaleViewport = false;
  resizeSession = false;
  clipViewport = false;
  background = "";
  credentials?: { username?: string; password?: string; target?: string };
  disconnected = false;
  keys: string[] = [];
  pasted: string[] = [];
  sendKey(keysym: number, _code: string | null, down?: boolean): void {
    this.keys.push(`${keysym.toString(16)}${down === undefined ? "" : down ? "v" : "^"}`);
  }
  clipboardPasteFrom(text: string): void {
    this.pasted.push(text);
  }

  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(
    public target: HTMLElement,
    public url: string,
    public options?: RfbOptions,
  ) {
    FakeRfb.instances.push(this);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  emit(type: string, detail?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new CustomEvent(type, { detail }));
    }
  }
}

function collect(): { states: LiveScreenStateDetail[]; unsub: () => void } {
  const states: LiveScreenStateDetail[] = [];
  return { states, unsub: () => void states };
}

describe("createRfbAdapter", () => {
  let container: HTMLElement;

  beforeEach(() => {
    FakeRfb.reset();
    container = document.createElement("div");
  });

  it("constructs RFB with the endpoint, shared mode and password", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    adapter.connect({ url: "wss://host/ws", password: "s3cret" }, { viewOnly: true });

    const instance = FakeRfb.instances[0];
    expect(instance).toBeDefined();
    expect(instance?.target).toBe(container);
    expect(instance?.url).toBe("wss://host/ws");
    expect(instance?.options?.shared).toBe(true);
    expect(instance?.options?.credentials).toEqual({ password: "s3cret" });
    expect(instance?.viewOnly).toBe(true);
    expect(instance?.scaleViewport).toBe(true);
    expect(instance?.resizeSession).toBe(false);
    expect(instance?.clipViewport).toBe(true);
    expect(instance?.background).toBe("#0b1220");
  });

  it("copies with Ctrl+C and reports the remote clipboard; pastes by setting it then Ctrl+V", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    adapter.connect({ url: "wss://host/ws" }, { viewOnly: false });
    const instance = FakeRfb.instances[0];
    const copied: string[] = [];
    adapter.onClipboard((text) => copied.push(text));

    adapter.copy();
    expect(instance?.keys).toEqual(["ffe3v", "63", "ffe3^"]);
    instance?.emit("clipboard", { text: "hello" });
    expect(copied).toEqual(["hello"]);

    instance!.keys = [];
    adapter.paste("from phone");
    expect(instance?.pasted).toEqual(["from phone"]);
    expect(instance?.keys).toEqual(["ffe3v", "76", "ffe3^"]);
  });

  it("omits credentials when there is no password", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    expect(FakeRfb.instances[0]?.options?.credentials).toBeUndefined();
  });

  it("emits connecting then connected", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    const { states } = collect();
    adapter.onState((detail) => states.push(detail));
    // A late subscriber is replayed the current state first.
    expect(states.map((s) => s.state)).toEqual(["idle"]);

    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    expect(states.map((s) => s.state)).toEqual(["idle", "connecting"]);

    FakeRfb.instances[0]?.emit("connect");
    expect(states.map((s) => s.state)).toEqual(["idle", "connecting", "connected"]);
  });

  it("reports a security failure as an error", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    const { states } = collect();
    adapter.onState((detail) => states.push(detail));

    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    FakeRfb.instances[0]?.emit("securityfailure", { status: 1, reason: "bad password" });

    expect(states.at(-1)).toEqual({ state: "error", message: "bad password" });
  });

  it("carries the clean flag from a disconnect event", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    const { states } = collect();
    adapter.onState((detail) => states.push(detail));

    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    FakeRfb.instances[0]?.emit("disconnect", { clean: false });

    expect(states.at(-1)).toEqual({ state: "disconnected", clean: false });
  });

  it("toggles viewOnly without reconnecting", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    adapter.setViewOnly(false);
    expect(FakeRfb.instances).toHaveLength(1);
    expect(FakeRfb.instances[0]?.viewOnly).toBe(false);
  });

  it("disconnects cleanly and detaches listeners", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    const { states } = collect();
    adapter.onState((detail) => states.push(detail));

    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });
    const instance = FakeRfb.instances[0];
    adapter.disconnect();

    expect(instance?.disconnected).toBe(true);
    expect(instance?.listenerCount("connect")).toBe(0);
    expect(states.at(-1)).toEqual({ state: "disconnected", clean: true });
  });

  it("replays the current state to a late subscriber and unsubscribes", () => {
    const adapter = createRfbAdapter({ createRfb: FakeRfb, container });
    adapter.connect({ url: "wss://host/ws" }, { viewOnly: true });

    const seen: LiveScreenStateDetail[] = [];
    const unsubscribe = adapter.onState((detail) => seen.push(detail));
    expect(seen).toEqual([{ state: "connecting" }]);

    unsubscribe();
    FakeRfb.instances[0]?.emit("connect");
    expect(seen).toHaveLength(1);
  });
});
