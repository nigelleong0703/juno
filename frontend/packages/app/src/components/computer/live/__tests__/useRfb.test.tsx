import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RfbLike, RfbOptions } from "../rfb";
import { useRfb } from "../useRfb";

/**
 * Scripted paint state for a fake framebuffer canvas. jsdom ships no 2d context, so the public
 * paint probe is driven through a defined `getContext` that samples transparent or opaque.
 */
const canvasPaint = new WeakMap<HTMLCanvasElement, { painted: boolean }>();

function createFakeCanvas(): HTMLCanvasElement {
  const state = { painted: false };
  const canvas = document.createElement("canvas");
  // Mirror noVNC's unready canvas: the intrinsic size stays 0x0 until the first update.
  canvas.width = 0;
  canvas.height = 0;
  Object.defineProperty(canvas, "getContext", {
    value: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, state.painted ? 255 : 0]) }),
    }),
  });
  canvasPaint.set(canvas, state);
  return canvas;
}

/** Emulate noVNC's first framebuffer update: the canvas gains its real size and pixels. */
function paintCanvas(canvas: HTMLCanvasElement, width = 400, height = 300): void {
  const state = canvasPaint.get(canvas);
  if (state) state.painted = true;
  canvas.width = width;
  canvas.height = height;
}

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
  /** noVNC mounts a nested screen wrapper holding the framebuffer canvas. */
  screen: HTMLDivElement;
  canvas: HTMLCanvasElement;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(
    public target: HTMLElement,
    public url: string,
    public options?: RfbOptions,
  ) {
    this.screen = document.createElement("div");
    this.screen.style.cssText = "width:100%;height:100%;overflow:hidden";
    this.canvas = createFakeCanvas();
    this.screen.append(this.canvas);
    target.append(this.screen);
    FakeRfb.instances.push(this);
  }

  disconnect(): void {
    this.disconnected = true;
    this.screen.remove();
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, detail?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new CustomEvent(type, { detail }));
    }
  }
}

function makeRef(): { ref: { current: HTMLDivElement | null }; div: HTMLDivElement } {
  const div = document.createElement("div");
  document.body.appendChild(div);
  return { ref: { current: div }, div };
}

/** The per-session mount layers the hook stack inside the container, in DOM order. */
function sessions(div: HTMLElement): HTMLElement[] {
  return Array.from(div.querySelectorAll<HTMLElement>('[data-rfb-layer="session"]'));
}

describe("useRfb", () => {
  beforeEach(() => {
    FakeRfb.reset();
    document.body.innerHTML = "";
  });

  it("connects when a target is present and reports state", async () => {
    const { ref } = makeRef();
    const { result } = renderHook(() =>
      useRfb({ containerRef: ref, target: { url: "wss://host/ws" }, createRfb: FakeRfb }),
    );

    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1));
    expect(FakeRfb.instances[0]?.url).toBe("wss://host/ws");
    expect(result.current.state.state).toBe("connecting");

    act(() => FakeRfb.instances[0]?.emit("connect"));
    await waitFor(() => expect(result.current.state.state).toBe("connected"));
    // The handshake alone is not paint.
    expect(result.current.painted).toBe(false);

    const canvas = FakeRfb.instances[0]?.canvas;
    if (!canvas) throw new Error("canvas missing");
    paintCanvas(canvas);
    await waitFor(() => expect(result.current.painted).toBe(true));
  });

  it("does not connect without a target", () => {
    const { ref } = makeRef();
    renderHook(() => useRfb({ containerRef: ref, target: null, createRfb: FakeRfb }));
    expect(FakeRfb.instances).toHaveLength(0);
  });

  it("stays disconnected when disabled", () => {
    const { ref } = makeRef();
    renderHook(() =>
      useRfb({ containerRef: ref, target: { url: "wss://host/ws" }, enabled: false, createRfb: FakeRfb }),
    );
    expect(FakeRfb.instances).toHaveLength(0);
  });

  it("toggles viewOnly without reconnecting", async () => {
    const { ref } = makeRef();
    const { rerender } = renderHook(
      ({ viewOnly }: { viewOnly: boolean }) =>
        useRfb({ containerRef: ref, target: { url: "wss://host/ws" }, viewOnly, createRfb: FakeRfb }),
      { initialProps: { viewOnly: true } },
    );

    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1));
    expect(FakeRfb.instances[0]?.viewOnly).toBe(true);

    rerender({ viewOnly: false });
    await waitFor(() => expect(FakeRfb.instances[0]?.viewOnly).toBe(false));
    expect(FakeRfb.instances).toHaveLength(1);
  });

  it("disconnects cleanly on unmount", async () => {
    const { ref } = makeRef();
    const { unmount } = renderHook(() =>
      useRfb({ containerRef: ref, target: { url: "wss://host/ws" }, createRfb: FakeRfb }),
    );

    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1));
    const instance = FakeRfb.instances[0];
    unmount();
    expect(instance?.disconnected).toBe(true);
  });

  it("stacks a rotated session in its own layer and holds the painted frame until the fresh one paints", async () => {
    const { ref, div } = makeRef();
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useRfb({ containerRef: ref, target: { url }, createRfb: FakeRfb }),
      { initialProps: { url: "wss://host/one" } },
    );

    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1));
    const first = FakeRfb.instances[0];
    if (!first) throw new Error("first session missing");
    paintCanvas(first.canvas, 1280, 800);
    act(() => first.emit("connect"));
    await waitFor(() => expect(result.current.painted).toBe(true));

    const initial = sessions(div);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.style.position).toBe("absolute");
    expect(initial[0]?.style.visibility).toBe("visible");

    rerender({ url: "wss://host/two" });
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(2));
    const second = FakeRfb.instances[1];
    if (!second) throw new Error("second session missing");

    // Two overlapping absolute layers on the same container, never flex siblings: the held
    // frame stays on screen and the fresh one is hidden until its canvas actually paints.
    const rotated = sessions(div);
    expect(rotated).toHaveLength(2);
    expect(rotated[0]?.style.visibility).toBe("visible");
    expect(rotated[1]?.style.visibility).toBe("hidden");
    expect(first.disconnected).toBe(false);
    expect(result.current.painted).toBe(false);

    // A completed handshake on the fresh session is still not paint.
    act(() => second.emit("connect"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(result.current.painted).toBe(false);
    expect(sessions(div)[1]?.style.visibility).toBe("hidden");
    expect(first.disconnected).toBe(false);

    paintCanvas(second.canvas, 1280, 800);
    await waitFor(() => expect(result.current.painted).toBe(true));
    await waitFor(() => expect(first.disconnected).toBe(true));
    const settled = sessions(div);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.style.visibility).toBe("visible");
  });

  it("reports a truthful retry when a handshake never paints and keeps the held frame", async () => {
    const { ref, div } = makeRef();
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) =>
        useRfb({ containerRef: ref, target: { url }, createRfb: FakeRfb, paintTimeoutMs: 40 }),
      { initialProps: { url: "wss://host/one" } },
    );

    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1));
    const first = FakeRfb.instances[0];
    if (!first) throw new Error("first session missing");
    paintCanvas(first.canvas, 1280, 800);
    act(() => first.emit("connect"));
    await waitFor(() => expect(result.current.painted).toBe(true));

    rerender({ url: "wss://host/stuck" });
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(2));
    const second = FakeRfb.instances[1];
    if (!second) throw new Error("second session missing");
    // Handshake completes but the canvas never paints.
    act(() => second.emit("connect"));

    await waitFor(() => expect(result.current.state.state).toBe("error"));
    expect(result.current.state.message).toMatch(/painting/i);
    expect(result.current.painted).toBe(false);
    // The failed session is discarded; the held frame and its socket survive on screen.
    expect(first.disconnected).toBe(false);
    const held = sessions(div);
    expect(held).toHaveLength(1);
    expect(held[0]?.style.visibility).toBe("visible");
  });
});

