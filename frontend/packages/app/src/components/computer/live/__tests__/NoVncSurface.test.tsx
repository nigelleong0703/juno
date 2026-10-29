import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoVncSurface } from "../NoVncSurface";
import type { FramebufferSize, LiveScreenTarget } from "../../types";

const rfbInstances = vi.hoisted(() => [] as Array<EventTarget & { url: string }>);
const sentKeys = vi.hoisted(() => [] as Array<{ keysym: number; down: boolean | undefined }>);

vi.mock("@novnc/novnc", () => {
  // Mirrors the real client: the session mounts a nested _screen wrapper holding the
  // framebuffer canvas, which stays unready (0x0) until the first framebuffer update.
  class FakeRfb extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    wrapper: HTMLDivElement;
    canvas: HTMLCanvasElement;
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      super();
      this.wrapper = document.createElement("div");
      this.wrapper.style.cssText = "width:100%;height:100%;overflow:hidden";
      this.canvas = document.createElement("canvas");
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.wrapper.append(this.canvas);
      target.append(this.wrapper);
      rfbInstances.push(this);
    }
    disconnect(): void {
      this.wrapper.remove();
    }
    sendKey(keysym: number, _code: string | null, down?: boolean): void {
      sentKeys.push({ keysym, down });
    }
    clipboardPasteFrom(_text: string): void {}
  }
  return { default: FakeRfb };
});

afterEach(() => {
  cleanup();
  rfbInstances.length = 0;
});

function containerOf(base: HTMLElement): HTMLElement {
  const found = base.querySelector('[data-testid="novnc-container"]');
  if (found instanceof HTMLElement) return found;
  throw new Error("novnc container missing");
}

function appendCanvas(root: HTMLElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute("width", String(width));
  canvas.setAttribute("height", String(height));
  root.appendChild(canvas);
  return canvas;
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute("width", String(width));
  canvas.setAttribute("height", String(height));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Emulate noVNC's first framebuffer update on the newest session canvas. */
function paintLatestCanvas(root: HTMLElement, width: number, height: number): void {
  const canvases = root.querySelectorAll("canvas");
  const canvas = canvases.item(canvases.length - 1);
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("canvas missing");
  canvas.width = width;
  canvas.height = height;
}

describe("NoVncSurface framebuffer observer", () => {
  it("tracks the newest canvas when a reconnect leaves several behind", async () => {
    const seen: FramebufferSize[] = [];
    const { container } = render(
      <NoVncSurface
        target={{ url: "wss://host/pre" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    appendCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toEqual([{ width: 1280, height: 800 }]));
    appendCanvas(root, 1920, 1080);
    await waitFor(() =>
      expect(seen).toEqual([
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
      ]),
    );
  });

  it("reports canvas arrival 1280x800 then attribute update 1920x1080", async () => {
    const seen: FramebufferSize[] = [];
    const { container } = render(
      <NoVncSurface
        target={{ url: "wss://host/a" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    expect(seen).toHaveLength(0);
    appendCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toEqual([{ width: 1280, height: 800 }]));
    // The newest canvas is the one the test appended; an earlier one may be the frozen layer.
    const canvases = root.querySelectorAll("canvas");
    const canvas = canvases.item(canvases.length - 1);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("canvas missing");
    resizeCanvas(canvas, 1920, 1080);
    await waitFor(() =>
      expect(seen).toEqual([
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
      ]),
    );
  });

  it("ignores duplicate sizes and unrelated attribute mutations", async () => {
    const seen: FramebufferSize[] = [];
    const { container } = render(
      <NoVncSurface
        target={{ url: "wss://host/b" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    const canvas = appendCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toHaveLength(1));
    resizeCanvas(canvas, 1280, 800);
    canvas.setAttribute("data-hint", "same-pixels");
    await pause(50);
    expect(seen).toHaveLength(1);
  });

  it("disconnects the observer on unmount so late canvases never report", async () => {
    const spy = vi.spyOn(MutationObserver.prototype, "disconnect");
    try {
      const seen: FramebufferSize[] = [];
      const { container, unmount } = render(
        <NoVncSurface
          target={{ url: "wss://host/c" }}
          onFramebufferSizeChange={(size) => seen.push(size)}
        />,
      );
      const root = containerOf(container);
      appendCanvas(root, 1280, 800);
      await waitFor(() => expect(seen).toHaveLength(1));
      unmount();
      expect(spy).toHaveBeenCalled();
      appendCanvas(root, 1920, 1080);
      await pause(50);
      expect(seen).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not leak the old size to a new target; a fresh canvas reports", async () => {
    const seen: FramebufferSize[] = [];
    const { container, rerender } = render(
      <NoVncSurface
        target={{ url: "wss://host/old" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    appendCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toHaveLength(1));
    root.innerHTML = "";
    rerender(
      <NoVncSurface
        target={{ url: "wss://host/new" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    await pause(50);
    expect(seen).toHaveLength(1);
    appendCanvas(root, 1920, 1080);
    await waitFor(() =>
      expect(seen).toEqual([
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
      ]),
    );
  });
  it("ignores attribute mutations on a stale canvas after a newer one reported", async () => {
    const seen: FramebufferSize[] = [];
    const { container } = render(
      <NoVncSurface
        target={{ url: "wss://host/stale" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    const old = appendCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toEqual([{ width: 1280, height: 800 }]));
    appendCanvas(root, 1920, 1080);
    await waitFor(() =>
      expect(seen).toEqual([
        { width: 1280, height: 800 },
        { width: 1920, height: 1080 },
      ]),
    );
    resizeCanvas(old, 800, 600);
    await pause(50);
    expect(seen).toEqual([
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 },
    ]);
  });
  it("never reports a zero-size canvas but reports it once it turns positive", async () => {
    const seen: FramebufferSize[] = [];
    const { container } = render(
      <NoVncSurface
        target={{ url: "wss://host/zero" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    const root = containerOf(container);
    const canvas = appendCanvas(root, 0, 0);
    await pause(50);
    expect(seen).toHaveLength(0);
    resizeCanvas(canvas, 1280, 800);
    await waitFor(() => expect(seen).toEqual([{ width: 1280, height: 800 }]));
  });
});

/** Put the live surface into its error overlay by failing the current RFB session. */
function failLatestSurface(): void {
  const rfb = rfbInstances.at(-1);
  if (!rfb) throw new Error("noVNC surface never mounted");
  rfb.dispatchEvent(new CustomEvent("securityfailure", { detail: { reason: "ticket expired" } }));
}

function reconnectButton(): Promise<HTMLElement> {
  return screen.findByRole("button", { name: /reconnect/i });
}

describe("NoVncSurface reconnect", () => {
  it("refreshes the ticket first and never re-dials the expired URL", async () => {
    const fresh: LiveScreenTarget = { url: "wss://host/fresh" };
    const onReconnect = vi.fn(async () => fresh);
    const { rerender } = render(
      <NoVncSurface target={{ url: "wss://host/expired" }} onReconnect={onReconnect} />,
    );
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    failLatestSurface();
    fireEvent.click(await reconnectButton());
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    // The ticket changed, so the reconnect rides the target prop; nothing dials the dead URL.
    expect(rfbInstances.map((rfb) => rfb.url)).toEqual(["wss://host/expired"]);
    rerender(<NoVncSurface target={fresh} onReconnect={onReconnect} />);
    await waitFor(() =>
      expect(rfbInstances.map((rfb) => rfb.url)).toEqual(["wss://host/expired", "wss://host/fresh"]),
    );
  });

  it("forces a local reconnect when the refreshed ticket re-signs the same URL", async () => {
    const onReconnect = vi.fn(async () => ({ url: "wss://host/same" }));
    render(<NoVncSurface target={{ url: "wss://host/same" }} onReconnect={onReconnect} />);
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    failLatestSurface();
    fireEvent.click(await reconnectButton());
    await waitFor(() => expect(rfbInstances).toHaveLength(2));
    expect(rfbInstances.at(-1)?.url).toBe("wss://host/same");
  });

  it("surfaces a failed refresh, leaves the URL undialed and allows a retry", async () => {
    const onReconnect = vi.fn(async () => {
      throw new Error("ticket refresh failed");
    });
    render(<NoVncSurface target={{ url: "wss://host/fail" }} onReconnect={onReconnect} />);
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    failLatestSurface();
    fireEvent.click(await reconnectButton());
    await screen.findByText("ticket refresh failed");
    const retry = await reconnectButton();
    expect(retry.getAttribute("disabled")).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(2));
    // A failed refresh never falls back to the expired target.
    expect(rfbInstances).toHaveLength(1);
  });

  it("ignores duplicate clicks while a refresh is in flight", async () => {
    let release: (() => void) | undefined;
    const onReconnect = vi.fn(
      () =>
        new Promise<LiveScreenTarget>((resolve) => {
          release = () => resolve({ url: "wss://host/again" });
        }),
    );
    render(<NoVncSurface target={{ url: "wss://host/again" }} onReconnect={onReconnect} />);
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    failLatestSurface();
    const button = await reconnectButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect((await reconnectButton()).getAttribute("disabled")).not.toBeNull();
    release?.();
    await waitFor(() => expect(rfbInstances).toHaveLength(2));
  });

  it("falls back to a local reconnect when no owner refresh is injected", async () => {
    render(<NoVncSurface target={{ url: "wss://host/local" }} />);
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    failLatestSurface();
    fireEvent.click(await reconnectButton());
    await waitFor(() => expect(rfbInstances).toHaveLength(2));
    expect(rfbInstances.at(-1)?.url).toBe("wss://host/local");
  });
});

describe("NoVncSurface handover", () => {
  it("holds the veil and the previous framebuffer across a ticket rotation until the fresh canvas paints", async () => {
    const seen: FramebufferSize[] = [];
    const { container, rerender } = render(
      <NoVncSurface
        target={{ url: "wss://host/first" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    await waitFor(() => expect(rfbInstances).toHaveLength(1));
    const root = containerOf(container);
    act(() => rfbInstances[0]?.dispatchEvent(new Event("connect")));
    paintLatestCanvas(root, 1280, 800);
    await waitFor(() => expect(seen).toEqual([{ width: 1280, height: 800 }]));
    // The surface confirms paint on its next bounded probe tick (~100ms), which is what
    // marks the frame as held; let that land before rotating.
    await pause(150);

    rerender(
      <NoVncSurface
        target={{ url: "wss://host/second" }}
        onFramebufferSizeChange={(size) => seen.push(size)}
      />,
    );
    await waitFor(() => expect(rfbInstances).toHaveLength(2));
    // The rotated session is layered next to the held one, and starts hidden.
    expect(root.querySelectorAll('[data-rfb-layer="session"]')).toHaveLength(2);
    act(() => rfbInstances[1]?.dispatchEvent(new Event("connect")));
    // A protocol handshake is not paint: the spinner veil and the held frame stay.
    await screen.findByTestId("screen-reconnect");
    await pause(150);
    expect(screen.getByTestId("screen-reconnect")).toBeTruthy();

    paintLatestCanvas(root, 1280, 800);
    await waitFor(() => expect(screen.queryByTestId("screen-reconnect")).toBeNull());
    expect(seen.at(-1)).toEqual({ width: 1280, height: 800 });
  });
});

/** The device clipboard the browser exposes, replaced per test (jsdom has none). */
function installDeviceClipboard(overrides: Partial<Clipboard> = {}): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: vi.fn(async () => "text from the phone"),
      read: vi.fn(async () => []),
      writeText: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      ...overrides,
    },
  });
}

/** The session the surface dialed reports the protocol connected, so the control bar shows. */
function connectLatestSurface(): void {
  act(() => rfbInstances.at(-1)?.dispatchEvent(new Event("connect")));
}

describe("NoVncSurface clipboard (M-CLIP wiring)", () => {
  it("Copy sends Ctrl+C, then brings the computer's clipboard to this device through the bridge", async () => {
    const copy = vi.fn(async () => ({ kind: "text" as const, text: "from the computer" }));
    const writeText = vi.fn(async () => undefined);
    installDeviceClipboard({ writeText });
    render(
      <NoVncSurface target={{ url: "wss://host/copy" }} viewOnly={false} clipboard={{ copy, paste: vi.fn() }} />,
    );
    await waitFor(() => expect(rfbInstances.length).toBeGreaterThan(0));
    connectLatestSurface();
    sentKeys.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: /copy/i }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("from the computer"));
    expect(sentKeys.some((key) => key.keysym === 0x63)).toBe(true);
  });

  it("Paste sends an image from this device to the computer first, and only then Ctrl+V", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    // Keys already sent when the image reaches the computer: none, so the Ctrl+V below comes after the upload.
    let keysSentBeforeUpload = -1;
    const paste = vi.fn(async () => {
      keysSentBeforeUpload = sentKeys.length;
      return { kind: "image" as const, path: "Pictures/Pasted/a.png" };
    });
    installDeviceClipboard({ read: vi.fn(async () => [{ types: ["image/png"], getType: async () => png }]) as unknown as Clipboard["read"] });
    render(
      <NoVncSurface target={{ url: "wss://host/paste" }} viewOnly={false} clipboard={{ copy: vi.fn(), paste }} />,
    );
    await waitFor(() => expect(rfbInstances.length).toBeGreaterThan(0));
    connectLatestSurface();
    sentKeys.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: /paste/i }));
    await waitFor(() => expect(paste).toHaveBeenCalledWith({ kind: "image", mimeType: "image/png", contentBase64: "iVBORw==" }));
    await waitFor(() => expect(sentKeys.some((key) => key.keysym === 0x76)).toBe(true));
    expect(keysSentBeforeUpload).toBe(0);
  });
});
