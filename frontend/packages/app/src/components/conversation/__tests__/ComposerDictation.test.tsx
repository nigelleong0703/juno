import type { ApiClient } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { Composer } from "../Composer";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

class FakeRecorder {
  static isTypeSupported = (type: string): boolean => type === "audio/webm;codecs=opus";
  mimeType = "audio/webm;codecs=opus";
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

describe("Composer dictation", () => {
  it("records, transcribes and appends the text to the field", async () => {
    const trackStop = vi.fn();
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) },
    });
    const transcribe = vi.fn().mockResolvedValue("你好 world");
    render(
      <ThemeProvider defaultTheme="dark">
        <ClientProvider client={{ transcribe } as unknown as ApiClient}>
          <TooltipProvider>
            <Composer agents={[]} onSend={vi.fn()} />
          </TooltipProvider>
        </ClientProvider>
      </ThemeProvider>,
    );
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "hello" } });

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" }));

    await waitFor(() => expect(field.value).toBe("hello 你好 world"));
    expect((transcribe.mock.calls[0]?.[0] as Blob).type).toBe("audio/webm");
    expect(trackStop).toHaveBeenCalled();
  });
});
