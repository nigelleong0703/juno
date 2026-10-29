import "../../vite-assets.js";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfFilePreviewProps {
  blob: Blob;
}

type PreviewState = "loading" | "ready" | "error";

export function PdfFilePreview({ blob }: PdfFilePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [state, setState] = useState<PreviewState>("loading");
  const [errorMessage, setErrorMessage] = useState("Couldn't render this PDF.");

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDocumentProxy(null);
    setPageNumber(1);
    setState("loading");
    setErrorMessage("Couldn't render this PDF.");
    const canvas = canvasRef.current;
    if (canvas) canvas.width = 0;

    async function load(): Promise<void> {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        // The canvas API does not create a scripting manager; XFA is explicitly disabled.
        loadingTask = getDocument({ data: bytes, enableXfa: false });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        setDocumentProxy(pdf);
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(isPasswordError(error) ? "This PDF is password-protected." : "Couldn't render this PDF.");
        setState("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  useEffect(() => {
    if (!documentProxy) return;
    const pdf = documentProxy;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    async function renderPage(): Promise<void> {
      try {
        const canvas = canvasRef.current;
        if (!canvas) throw new Error("Canvas unavailable");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context unavailable");
        const page: PDFPageProxy = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const width = Math.min(800, Math.max(1, canvas.parentElement?.clientWidth ?? 800));
        const scale = width / baseViewport.width;
        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) {
          setErrorMessage("Couldn't render this PDF.");
          setState("error");
        }
      }
    }

    setState("loading");
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [documentProxy, pageNumber]);

  return (
    <section data-slot="pdf-file-preview" className="w-full" aria-label="PDF preview">
      <div className="flex min-h-32 w-full justify-center overflow-auto rounded-lg bg-bg-subtle/40 p-2">
        <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} className={state === "ready" ? "block max-w-full" : "hidden"} />
        {state === "loading" && <p role="status" className="self-center py-8 text-sm text-fg-muted">Loading PDF preview…</p>}
        {state === "error" && <p role="alert" className="self-center py-8 text-sm text-fg-muted">{errorMessage}</p>}
      </div>
      {documentProxy && state === "ready" && (
        <nav aria-label="PDF pages" className="mt-2 flex items-center justify-center gap-3">
          <button type="button" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)}>
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <span className="text-xs text-fg-muted">Page {pageNumber} of {documentProxy.numPages}</span>
          <button type="button" aria-label="Next page" disabled={pageNumber >= documentProxy.numPages} onClick={() => setPageNumber((page) => page + 1)}>
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </nav>
      )}
    </section>
  );
}

function isPasswordError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "PasswordException";
}
