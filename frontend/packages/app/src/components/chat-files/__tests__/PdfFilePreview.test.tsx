import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfFilePreview } from "../PdfFilePreview";

const pdfMocks = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  getDocument: pdfMocks.getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "/assets/pdf.worker.mjs" }));

afterEach(() => {
  cleanup();
  pdfMocks.getDocument.mockReset();
});

function pdfTask<T>(promise: Promise<T>) {
  return { promise, destroy: vi.fn(async () => {}) };
}

describe("PdfFilePreview", () => {
  it("loads authenticated PDF bytes with scripting disabled and reports canvas failures", async () => {
    const documentProxy = {
      numPages: 2,
      getPage: vi.fn(async () => { throw new Error("unused"); }),
      destroy: vi.fn(async () => {}),
    };
    const task = pdfTask(Promise.resolve(documentProxy));
    pdfMocks.getDocument.mockReturnValue(task);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const blob = new Blob(["private pdf bytes"], { type: "application/pdf" });

    const { container } = render(<PdfFilePreview blob={blob} />);
    await screen.findByRole("alert");

    expect(pdfMocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: new Uint8Array(await blob.arrayBuffer()),
      enableXfa: false,
    }));
    expect(container.querySelector('[data-slot="pdf-file-preview"]')).not.toBeNull();
    expect(screen.getByText("Couldn't render this PDF.")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "PDF pages" })).toBeNull();
  });

  it("shows a truthful password-protected message and destroys the replaced loading task", async () => {
    const firstDocument = { numPages: 1, getPage: vi.fn() };
    const firstTask = pdfTask(Promise.resolve(firstDocument));
    pdfMocks.getDocument.mockReturnValueOnce(firstTask).mockImplementationOnce(() => pdfTask(
      Promise.reject(Object.assign(new Error("password required"), { name: "PasswordException" })),
    ));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { rerender } = render(<PdfFilePreview blob={new Blob(["first"])} />);
    await screen.findByRole("alert");

    rerender(<PdfFilePreview blob={new Blob(["second"])} />);
    expect(await screen.findByText("This PDF is password-protected.")).toBeDefined();
    expect(firstTask.destroy).toHaveBeenCalled();
  });

  it("cancels loading and destroys the loading task when unmounted", async () => {
    const task = pdfTask(new Promise(() => {}));
    pdfMocks.getDocument.mockReturnValue(task);
    const { unmount } = render(<PdfFilePreview blob={new Blob(["pending"])} />);
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledOnce());

    unmount();

    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
