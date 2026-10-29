import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Attachment } from "@agent-desktop/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

function renderComposer(args: { clearOnSend?: boolean; disabled?: boolean; onUploadFile?: (file: File) => Promise<Attachment> }) {
  const onSend = vi.fn();
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <Composer
          agents={[]}
          onSend={onSend}
          clearOnSend={args.clearOnSend}
          disabled={args.disabled}
          onUploadFile={args.onUploadFile}
        />
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { onSend };
}

function submitBox(box: HTMLElement): void {
  const form = box.closest("form");
  if (!form) throw new Error("composer form not found");
  fireEvent.submit(form);
}

describe("Composer draft retention", () => {
  it("clears the field after send by default", async () => {
    const { onSend } = renderComposer({});
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    submitBox(box);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  const pick = (name: string, size = 5): void => {
    const fileInput = Array.from(document.querySelectorAll('input[type="file"]')).at(-1);
    if (!(fileInput instanceof HTMLInputElement)) throw new Error("file input not found");
    const file = new File(["x".repeat(size)], name, { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
  };

  it("uploads a picked file and sends the server's attachment, not before the upload finishes", async () => {
    let finish: (attachment: Attachment) => void = () => {};
    const onUploadFile = vi.fn(() => new Promise<Attachment>((resolve) => { finish = resolve; }));
    const { onSend } = renderComposer({ onUploadFile });
    const box = screen.getByRole("textbox");
    pick("notes.txt");
    await waitFor(() => expect(screen.getByText("Uploading…")).toBeTruthy());
    submitBox(box);
    expect(onSend).not.toHaveBeenCalled();
    finish({ id: "lib_1", name: "notes.txt", kind: "file", mimeType: "text/plain", sizeBytes: 5 });
    await waitFor(() => expect(screen.queryByText("Uploading…")).toBeNull());
    submitBox(box);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ text: "", attachments: [expect.objectContaining({ id: "lib_1" })] });
  });

  it("shows a failed upload on the chip and never sends it", async () => {
    const onUploadFile = vi.fn(() => Promise.reject(new Error("boom")));
    const { onSend } = renderComposer({ onUploadFile });
    const box = screen.getByRole("textbox");
    pick("notes.txt");
    await waitFor(() => expect(screen.getByText("Upload failed")).toBeTruthy());
    submitBox(box);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("refuses a file over 10 MB without uploading it", async () => {
    const onUploadFile = vi.fn();
    renderComposer({ onUploadFile });
    pick("big.bin", 10 * 1024 * 1024 + 1);
    await waitFor(() => expect(screen.getByText("Over 10 MB")).toBeTruthy());
    expect(onUploadFile).not.toHaveBeenCalled();
  });

  it("does not send an empty draft with no text and no attachments", () => {
    const { onSend } = renderComposer({});
    const box = screen.getByRole("textbox");
    submitBox(box);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft for retry when clearOnSend is false", async () => {
    const { onSend } = renderComposer({ clearOnSend: false });
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello again" } });
    submitBox(box);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((box as HTMLTextAreaElement).value).toBe("hello again");
  });

  it("opens the add menu from the + button itself, with the attach item", async () => {
    renderComposer({});
    const plus = document.querySelector('button[aria-haspopup="menu"]');
    if (!(plus instanceof HTMLButtonElement)) throw new Error("add trigger not found");
    fireEvent.pointerDown(plus, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    // Anchored at the trigger: Radix labels the menu by the button that opened it.
    expect(menu.getAttribute("aria-labelledby")).toBe(plus.id);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Attach file"]);
  });

  it("disables the add menu together with the field", () => {
    renderComposer({ disabled: false });
    const openTrigger = document.querySelector('button[aria-haspopup="menu"]');
    if (!(openTrigger instanceof HTMLButtonElement)) throw new Error("add trigger not found");
    expect(openTrigger.disabled).toBe(false);
    cleanup();
    renderComposer({ disabled: true });
    const shutTrigger = document.querySelector('button[aria-haspopup="menu"]');
    if (!(shutTrigger instanceof HTMLButtonElement)) throw new Error("add trigger not found");
    expect(shutTrigger.disabled).toBe(true);
  });
});
