import type { Computer } from "@agent-desktop/client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerView } from "../ComputerView";

// CT2: the control footer must share the screen frame's stage so the connected shape can weld it
// to the frame edge, and the stage must follow the authoritative lease (or the computer's
// controller for standalone consumers). The pixel/motion acceptance lives in
// scripts/verify/CT2-control-render.mjs.

afterEach(cleanup);

const ISO = "2026-10-05T09:30:00.000Z";

function computer(overrides: Partial<Computer> = {}): Computer {
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
    ...overrides,
  };
}

function renderView(props: {
  computer: Computer;
  mode?: "control" | "watch";
  userInControl?: boolean;
}) {
  return render(
    <ComputerView
      computer={props.computer}
      mode={props.mode}
      userInControl={props.userInControl}
      empty={<span>no screen</span>}
      controlFooter={<div data-testid="control-pill">You have control</div>}
    />,
  );
}

describe("control shape stage", () => {
  it("mounts the footer and frame inside one stage keyed to the lease", () => {
    const { container } = renderView({ computer: computer({ controller: "user" }), mode: "control" });
    const stage = container.querySelector("[data-control]");
    expect(stage?.getAttribute("data-control")).toBe("user");
    expect(stage?.querySelector('[data-testid="screen-frame"]')).toBeTruthy();
    // The footer shares the frame's coordinate space; it is not a sibling of the whole view.
    expect(stage?.contains(screen.getByTestId("control-pill"))).toBe(true);
  });

  it("follows ownership, not the visible mode, without an explicit lease", () => {
    const agentDriven = renderView({ computer: computer(), mode: "watch" });
    expect(agentDriven.container.querySelector("[data-control]")?.getAttribute("data-control")).toBe("agent");
    expect(agentDriven.container.querySelector(".control-tab")).toBeTruthy();

    cleanup();
    // A user-held screen keeps the connected shape even while an explicit non-control mode shows:
    // mode alone would drop ownership during signin / needs-you / teach.
    const held = renderView({ computer: computer({ controller: "user" }), mode: "watch" });
    expect(held.container.querySelector("[data-control]")?.getAttribute("data-control")).toBe("user");

    cleanup();
    const override = renderView({ computer: computer(), mode: "watch", userInControl: true });
    expect(override.container.querySelector("[data-control]")?.getAttribute("data-control")).toBe("user");
  });

});
