import type { Agent, Computer } from "@agent-desktop/client";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ComputerView } from "../ComputerView";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../LiveScreen";

const canvases: HTMLCanvasElement[] = [];

vi.mock("@novnc/novnc", () => {
  class FakeRfb {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      const canvas = document.createElement("canvas");
      const wide = url.includes("wide");
      canvas.width = wide ? 1920 : 1280;
      canvas.height = wide ? 1080 : 800;
      canvas.setAttribute("width", String(canvas.width));
      canvas.setAttribute("height", String(canvas.height));
      target.appendChild(canvas);
      canvases.push(canvas);
    }
    disconnect(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  return { default: FakeRfb };
});

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
  canvases.length = 0;
  document.body.innerHTML = "";
});

const ISO = "2026-10-05T09:30:00.000Z";

function computer(): Computer {
  return {
    id: "computer-shared",
    agentIds: ["agent-juno"],
    activeAgentId: "agent-juno",
    screens: [],
    name: "Your computer",
    state: "running",
    controller: "agent",
    resources: {
      cpu: { used: 5, total: 100, unit: "%", cores: 8 },
      memory: { used: 512, total: 16384, unit: "MB" },
      disk: { used: 4, total: 128, unit: "GB" },
    },
    size: { vcpu: 8, ramGb: 16, diskGb: 128 },
    idlePauseMinutes: 30,
    updateSchedule: { kind: "manual" },
    uptimeSeconds: 60,
    os: "Debian 13 \u00b7 Xfce",
    resolution: "1364x1024",
    lastUpdatedAt: ISO,
  };
}

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    handle: name.toLowerCase(),
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "Research",
    status: "working",
    section: "Personal",
    pinned: false,
    lastActivity: "Browsing",
    unreadCount: 0,
    model: {
      planner: { provider: "openai", model: "gpt-6" },
      computer: { provider: "openai", model: "gpt-6" },
      fast: { provider: "openai", model: "gpt-6" },
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

function frameRatio(base: HTMLElement): string | null {
  const frame = base.querySelector('[data-testid="screen-frame"]');
  if (!(frame instanceof HTMLElement)) return null;
  return frame.getAttribute("style");
}

describe("ComputerView screen fit", () => {
  it("frames the live canvas at its intrinsic ratio and follows resizes", async () => {
    const { container } = render(
      <ComputerView
        computer={computer()}
        agent={agent("agent-juno", "Juno")}
        target={{ url: "wss://host/session" }}
      />,
    );
    await waitFor(() => expect(frameRatio(container)).toContain("1280 / 800"));
    const canvas = canvases[canvases.length - 1];
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("canvas missing");
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.setAttribute("width", "1920");
    canvas.setAttribute("height", "1080");
    await waitFor(() => expect(frameRatio(container)).toContain("1920 / 1080"));
  });

  it("keeps the ratio across same-agent ticket rotation without fallback flicker", async () => {
    const { container, rerender } = render(
      <ComputerView
        computer={computer()}
        agent={agent("agent-juno", "Juno")}
        target={{ url: "wss://host/session?t=one" }}
      />,
    );
    await waitFor(() => expect(frameRatio(container)).toContain("1280 / 800"));
    rerender(
      <ComputerView
        computer={computer()}
        agent={agent("agent-juno", "Juno")}
        target={{ url: "wss://host/session?t=two" }}
      />,
    );
    await waitFor(() => expect(canvases.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(frameRatio(container)).toContain("1280 / 800"));
    expect(frameRatio(container)).not.toContain(SCREEN_WIDTH + " / " + SCREEN_HEIGHT);
  });

  it("falls back for another agent or no target, and width-only rerenders do not reconnect", async () => {
    const first = agent("agent-juno", "Juno");
    const { container, rerender } = render(
      <ComputerView
        computer={computer()}
        agent={first}
        target={{ url: "wss://host/session" }}
        className="pane-narrow"
      />,
    );
    await waitFor(() => expect(frameRatio(container)).toContain("1280 / 800"));
    const connected = canvases.length;
    rerender(
      <ComputerView
        computer={computer()}
        agent={first}
        target={{ url: "wss://host/session" }}
        className="pane-wide"
      />,
    );
    expect(canvases.length).toBe(connected);
    rerender(
      <ComputerView
        computer={computer()}
        agent={agent("agent-patch", "Patch")}
        target={{ url: "wss://host/wide" }}
        className="pane-wide"
      />,
    );
    await waitFor(() => expect(frameRatio(container)).toContain("1920 / 1080"));
    rerender(
      <ComputerView
        computer={computer()}
        agent={agent("agent-patch", "Patch")}
        target={null}
        empty={<span>no screen</span>}
        className="pane-wide"
      />,
    );
    await waitFor(() =>
      expect(frameRatio(container)).toContain(SCREEN_WIDTH + " / " + SCREEN_HEIGHT),
    );
  });
});
