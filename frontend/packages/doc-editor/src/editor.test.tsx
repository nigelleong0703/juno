import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { parseIncoming } from "./bridge";
import { diffBlocks } from "./blockDiff";
import { DocumentEditor, type DocumentEditorHandle } from "./DocumentEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("block diff", () => {
  it("marks the blocks a draft adds and removes, and keeps the rest as context", () => {
    const saved = "# Plan\n\nKeep this.\n\nOld paragraph.";
    const draft = "# Plan\n\nKeep this.\n\nNew paragraph.\n\n```\ncode\n\nmore\n```";
    expect(diffBlocks(saved, draft)).toEqual([
      { kind: "same", text: "# Plan" },
      { kind: "same", text: "Keep this." },
      { kind: "added", text: "New paragraph." },
      { kind: "added", text: "```\ncode\n\nmore\n```" },
      { kind: "removed", text: "Old paragraph." },
    ]);
  });
});

describe("bridge messages", () => {
  it("accepts the three message shapes and ignores everything else", () => {
    expect(parseIncoming({ type: "setMarkdown", markdown: "# Hi" })).toEqual({ type: "setMarkdown", markdown: "# Hi" });
    expect(parseIncoming({ type: "command", command: "bold" })).toEqual({ type: "command", command: "bold" });
    expect(parseIncoming({ type: "command", command: "link", argument: "https://example.com" })).toEqual({ type: "command", command: "link", argument: "https://example.com" });
    expect(parseIncoming({ type: "setEditable", editable: false })).toEqual({ type: "setEditable", editable: false });
    expect(parseIncoming({ type: "command", command: "rm -rf" })).toBeNull();
    expect(parseIncoming({ type: "setMarkdown", markdown: 3 })).toBeNull();
    expect(parseIncoming("text")).toBeNull();
  });
});

function mount(markdown: string, onChange: (markdown: string) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const handle = createRef<DocumentEditorHandle>();
  const modes: string[] = [];
  const root = createRoot(host);
  act(() => root.render(<DocumentEditor markdown={markdown} resetKey={0} onChange={onChange} handleRef={handle} onModeChange={(m) => modes.push(m)} />));
  return { host, handle, modes, unmount: () => act(() => root.unmount()) };
}

describe("DocumentEditor", () => {
  it("opens the rich editor for Markdown it can round-trip", () => {
    const view = mount("# Title\n\nHello **world**.", vi.fn());
    expect(view.modes).toEqual(["rich"]);
    expect(view.host.querySelector(".doc-editor-content h1")?.textContent).toBe("Title");
    view.unmount();
  });

  it("falls back to plain Markdown when the editor would lose content, and keeps the text exact", () => {
    const html = "Intro\n\n<div class=\"x\">raw html</div>\n";
    const onChange = vi.fn();
    const view = mount(html, onChange);
    expect(view.modes).toEqual(["source"]);
    const field = view.host.querySelector("textarea");
    expect(field?.value).toBe(html);
    expect(view.handle.current?.mode).toBe("source");
    view.unmount();
  });
});
