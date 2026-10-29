import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Agent, ComposerPayload } from "@agent-desktop/client";
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

const ISO = "2026-10-06T00:00:00.000Z";

function makeAgent(input: { id: string; name: string; handle?: string; title?: string }): Agent {
  return {
    id: input.id,
    name: input.name,
    handle: input.handle ?? input.name.toLowerCase(),
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: input.title ?? "Aide",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "",
    unreadCount: 0,
    model: {
      planner: { provider: "openai", model: "gpt" },
      computer: { provider: "openai", model: "gpt" },
      fast: { provider: "openai", model: "gpt" },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const patchAgent = makeAgent({ id: "agent-patch", name: "Patch" });
const junoAgent = makeAgent({ id: "agent-juno", name: "Juno" });

/** Type into the field the way the existing composer tests do. */
function setField(textbox: HTMLElement, value: string): void {
  fireEvent.change(textbox, { target: { value } });
}

function submitForm(textbox: HTMLElement): void {
  const form = textbox.closest("form");
  if (!form) throw new Error("composer form not found");
  fireEvent.submit(form);
}

function lastPayload(send: ReturnType<typeof vi.fn>): ComposerPayload {
  const call = send.mock.calls[send.mock.calls.length - 1];
  if (!call) throw new Error("send was not called");
  return call[0] as ComposerPayload;
}

describe("Composer mentions", () => {
  it("sends real member mentions for explicitly typed full handles", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@patch please check @PATCH");
    submitForm(textbox);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastPayload(send).mentions).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("adds no mention metadata for emails or unknown handles", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "email name@patch and @unknown");
    submitForm(textbox);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect("mentions" in lastPayload(send)).toBe(false);
  });

  it("completes a query from the picker without submitting on Enter", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@pa");

    expect(await screen.findByRole("listbox")).toBeDefined();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    expect((textbox as HTMLTextAreaElement).value).toBe("Patch ");

    submitForm(textbox);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastPayload(send).text).toBe("@patch");
    expect(lastPayload(send).mentions).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("moves picker selection with arrow keys across candidates", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent, junoAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@");

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    const selected = await screen.findAllByRole("option");
    expect(selected[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect((textbox as HTMLTextAreaElement).value).toBe("Juno ");
    expect(send).not.toHaveBeenCalled();
  });

  it("closes the picker on Escape and inserts on option click", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "hi @p");

    expect(await screen.findByRole("listbox")).toBeDefined();
    fireEvent.keyDown(textbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    setField(textbox, "hi @pa");
    const option = await screen.findByRole("option");
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect((textbox as HTMLTextAreaElement).value).toBe("hi Patch ");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Composer named mentions", () => {
  it("shows the display name in the picker and draft, never the raw handle", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@pa");

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Patch");
    expect(option.textContent).not.toContain("@patch");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect((textbox as HTMLTextAreaElement).value).toBe("Patch ");
  });

  it("routes a shared display name to the explicitly selected member", async () => {
    const first = makeAgent({ id: "agent-sam-a", name: "Sam", handle: "sam-a" });
    const second = makeAgent({ id: "agent-sam-b", name: "Sam", handle: "sam-b" });
    const send = vi.fn();
    render(<Composer agents={[first, second]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@s");
    expect(await screen.findAllByRole("option")).toHaveLength(2);

    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect((textbox as HTMLTextAreaElement).value).toBe("Sam ");
    submitForm(textbox);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastPayload(send).text).toBe("@sam-b");
    expect(lastPayload(send).mentions).toEqual([
      { kind: "agent", id: "agent-sam-b", label: "@sam-b" },
    ]);
  });

  it("drops the mention when the selected member is no longer present", async () => {
    const send = vi.fn();
    const view = render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@pa");
    await screen.findByRole("option");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect((textbox as HTMLTextAreaElement).value).toBe("Patch ");

    view.rerender(<Composer agents={[]} onSend={send} />);
    submitForm(textbox);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastPayload(send).text).toBe("Patch");
    expect("mentions" in lastPayload(send)).toBe(false);
  });
});

describe("Composer picker identity", () => {
  it("shows titles and reveals handles only for same-name same-title rows", async () => {
    const eng = makeAgent({ id: "agent-sam-eng", name: "Sam", handle: "sam-eng", title: "Eng" });
    const design = makeAgent({
      id: "agent-sam-design",
      name: "Sam",
      handle: "sam-design",
      title: "Design",
    });
    const engTwo = makeAgent({ id: "agent-sam-eng2", name: "Sam", handle: "sam-eng2", title: "Eng" });
    const send = vi.fn();
    render(<Composer agents={[eng, design, engTwo]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@s");

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    const byText = (text: string): HTMLElement | undefined =>
      options.find((option) => option.textContent?.includes(text));
    expect(byText("Eng")?.textContent).toContain("@sam-eng");
    expect(byText("Design")?.textContent).not.toContain("@sam-design");
  });

  it("keeps every selected occurrence but dedupes the recipient ID", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@pa");
    await screen.findByRole("option");
    fireEvent.keyDown(textbox, { key: "Enter" });
    setField(textbox, `${(textbox as HTMLTextAreaElement).value}and @pa`);
    await screen.findByRole("option");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect((textbox as HTMLTextAreaElement).value).toBe("Patch and Patch ");
    submitForm(textbox);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastPayload(send).text).toBe("@patch and @patch");
    expect(lastPayload(send).mentions).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("announces the row name once for screen readers", async () => {
    const send = vi.fn();
    render(<Composer agents={[patchAgent]} onSend={send} />);
    const textbox = screen.getByRole("textbox");
    setField(textbox, "@pa");

    const option = await screen.findByRole("option");
    expect(option.textContent).toContain("Patch");
    expect(option.querySelector("[aria-label]")).toBeNull();
  });
});
