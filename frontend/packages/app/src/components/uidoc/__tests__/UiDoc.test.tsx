import type { Request, UiDoc as UiDocData } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { RequestCard } from "../../request/RequestCard";
import { UiDoc } from "../UiDoc";

afterEach(cleanup);

function renderDoc(doc: UiDocData, answering?: Parameters<typeof UiDoc>[0]["answering"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ClientProvider client={createMockClient({ seed: 3 })} queryClient={queryClient}>
      <UiDoc doc={doc} showTitle answering={answering} />
    </ClientProvider>,
  );
}

const doc = (blocks: UiDocData["blocks"], extra: Partial<UiDocData> = {}): UiDocData => ({ version: 1, blocks, ...extra });

describe("UiDoc display blocks", () => {
  it("draws title, text and facts as label / value rows", () => {
    renderDoc(doc([{ type: "text", text: "Two options." }, { type: "facts", rows: [{ label: "RAM", value: "16 GB" }, { label: "Price", value: "S$899", emphasis: true }] }], { title: "Mac mini" }));
    expect(screen.getByText("Mac mini")).toBeTruthy();
    expect(screen.getByText("Two options.")).toBeTruthy();
    expect(screen.getByText("RAM").tagName).toBe("DT");
    expect(screen.getByText("S$899").className).toMatch(/font-semibold/u);
  });

  it("draws items with a total row and folds long lists behind Show more", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ name: `Item ${index + 1}`, price: `S$${index + 1}`, quantity: index === 0 ? 2 : undefined }));
    renderDoc(doc([{ type: "items", rows, total: { label: "Total", value: "S$36" } }]));
    expect(screen.getByText("Item 5")).toBeTruthy();
    expect(screen.queryByText("Item 6")).toBeNull();
    expect(screen.getByText("×2")).toBeTruthy();
    expect(screen.getByText("S$36")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(screen.getByText("Item 8")).toBeTruthy();
  });

  it("draws a table with column headers in a scroll container", () => {
    renderDoc(doc([{ type: "table", columns: ["Model", "RAM"], rows: [["M4", "16 GB"], ["M4 Pro", "24 GB"]] }]));
    expect(screen.getByRole("columnheader", { name: "RAM" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "M4 Pro" })).toBeTruthy();
    expect(screen.getByRole("table").parentElement?.className).toMatch(/overflow-x-auto/u);
  });

  it("tints notices by tone and draws links and groups", () => {
    renderDoc(
      doc([
        { type: "notice", tone: "warning", text: "Final sale." },
        { type: "link", url: "https://example.com/mini", title: "Apple Store", subtitle: "Mac mini" },
        { type: "group", title: "Option A", blocks: [{ type: "facts", rows: [{ label: "Chip", value: "M4" }] }] },
      ]),
    );
    expect(screen.getByRole("alert").className).toMatch(/bg-warning-subtle/u);
    expect(screen.getByRole("link", { name: /Apple Store/u }).getAttribute("href")).toBe("https://example.com/mini");
    expect(within(screen.getByRole("heading", { name: "Option A" }).parentElement as HTMLElement).getByText("M4")).toBeTruthy();
  });

  it("an unknown block type shows the server text fallback instead of dropping the card", () => {
    const future = { version: 1, text: "Chart: sales up 4%", blocks: [{ type: "text", text: "hi" }, { type: "chart", points: [1, 2] }] } as unknown as UiDocData;
    renderDoc(future);
    expect(screen.getByText("Chart: sales up 4%")).toBeTruthy();
    expect(screen.queryByText("hi")).toBeNull();
  });

  it("draws no interactive block without answering (a plain message)", () => {
    renderDoc(doc([{ type: "text", text: "hello" }, { type: "choices", id: "c", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }]));
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("UiDoc answers", () => {
  const choices = doc([{ type: "choices", id: "pick", options: [{ id: "a", label: "Basic", description: "16 GB" }, { id: "b", label: "Pro", style: "primary" }] }]);

  it("a single choice answers immediately with the block id and option id", () => {
    const onAnswer = vi.fn();
    renderDoc(choices, { onAnswer });
    fireEvent.click(screen.getByRole("radio", { name: /Pro/u }));
    expect(onAnswer).toHaveBeenCalledWith({ pick: "b" });
  });

  it("multiple choices toggle, then Submit sends a JSON array of ids", () => {
    const onAnswer = vi.fn();
    const multi = doc([{ type: "choices", id: "pick", multiple: true, options: [{ id: "a", label: "Basic" }, { id: "b", label: "Pro" }, { id: "c", label: "Max" }] }]);
    renderDoc(multi, { onAnswer });
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Max" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Basic" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith({ pick: '["a","c"]' });
  });

  const form = doc([
    {
      type: "fields",
      id: "form",
      fields: [
        { id: "name", label: "Name", kind: "text" },
        { id: "qty", label: "Quantity", kind: "number" },
        { id: "when", label: "Date", kind: "date" },
        { id: "size", label: "Size", kind: "select", options: ["S", "M"] },
        { id: "note", label: "Note", kind: "text", required: false },
      ],
    },
  ]);

  it("fields validate like the contract before sending, then answer keyed by field id", () => {
    const onAnswer = vi.fn();
    renderDoc(form, { onAnswer });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "M" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith({ name: "Ada", qty: "3", when: "2026-11-02", size: "M" });
  });

  it("shows server reasons per field until that field is edited", () => {
    renderDoc(form, { onAnswer: vi.fn(), errors: { name: "Already taken" } });
    expect(screen.getByText("Already taken")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bo" } });
    expect(screen.queryByText("Already taken")).toBeNull();
  });

  it("a question request card sends the answer and shows the choice once decided", () => {
    const base: Request = {
      id: "req-q",
      kind: "question",
      status: "pending",
      title: "Which Mac mini?",
      summary: "Pick one",
      agentId: "agent-juno",
      conversationId: "conv-juno",
      createdAt: "2026-10-06T00:00:00.000Z",
      payload: { kind: "question", ui: choices },
    };
    const onResolve = vi.fn();
    const { unmount } = render(<RequestCard request={base} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("radio", { name: /Basic/u }));
    expect(onResolve).toHaveBeenCalledWith({ action: "answer", answers: { pick: "a" } });
    unmount();
    render(<RequestCard request={{ ...base, status: "answered", payload: { kind: "question", ui: choices, answers: { pick: "a" } } }} defaultExpanded />);
    expect(screen.getByRole("radio", { name: /Basic/u }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });
});
