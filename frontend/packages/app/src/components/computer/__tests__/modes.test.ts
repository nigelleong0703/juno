import type { Agent, Computer, Step } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import {
  deriveScenario,
  deriveScreenMode,
  modeIsInteractive,
  modePausesModel,
  resolveScreenPresence,
  resolveHeaderState,
  screenStreamUrl,
} from "../modes";
import { resolveAgentComputer, resolveComputerState } from "../useScreenState";

function computer(partial: Partial<Computer>): Computer {
  return {
    id: "computer-test",
    agentIds: ["agent-test"],
    activeAgentId: null,
    name: "Test computer",
    state: "running",
    controller: "agent",
    resources: {
      cpu: { used: 0, total: 100, unit: "%", cores: 8 },
      memory: { used: 0, total: 16 * 1024, unit: "MB" },
      disk: { used: 0, total: 128, unit: "GB" },
    },
    size: { vcpu: 8, ramGb: 16, diskGb: 128 },
    idlePauseMinutes: 30,
    updateSchedule: { kind: "manual" },
    uptimeSeconds: 0,
    os: "Debian 13 · Xfce",
    resolution: "1364x1024",
    lastUpdatedAt: new Date().toISOString(),
    ...partial,
  };
}


function agent(status: Agent["status"]): Pick<Agent, "status"> {
  return { status };
}

describe("deriveScreenMode", () => {
  const base = {
    computerState: "running" as const,
    userInControl: false,
    signinPending: false,
    needsYouPending: false,
    teaching: false,
  };

  it("watches by default", () => {
    expect(deriveScreenMode(base)).toBe("watch");
  });

  it("asleep wins over everything", () => {
    expect(
      deriveScreenMode({ ...base, computerState: "asleep", teaching: true, signinPending: true }),
    ).toBe("asleep");
  });

  it("orders teach > signin > needs-you > control > watch", () => {
    expect(deriveScreenMode({ ...base, teaching: true, signinPending: true })).toBe("teach");
    expect(deriveScreenMode({ ...base, signinPending: true, needsYouPending: true })).toBe("signin");
    expect(deriveScreenMode({ ...base, needsYouPending: true, userInControl: true })).toBe(
      "needs-you",
    );
    expect(deriveScreenMode({ ...base, userInControl: true })).toBe("control");
  });
});

describe("resolveHeaderState", () => {
  it("pending requests outrank machine state", () => {
    expect(resolveHeaderState({ computer: computer({ state: "asleep" }), pendingCount: 2 })).toBe(
      "needs-you",
    );
  });

  it("maps machine states", () => {
    expect(resolveHeaderState({ computer: computer({ state: "asleep" }), pendingCount: 0 })).toBe(
      "asleep",
    );
    expect(resolveHeaderState({ computer: computer({ state: "paused" }), pendingCount: 0 })).toBe(
      "paused",
    );
    expect(resolveHeaderState({ computer: computer({ state: "updating" }), pendingCount: 0 })).toBe(
      "paused",
    );
    expect(resolveHeaderState({ computer: computer({ state: "rebooting" }), pendingCount: 0 })).toBe(
      "paused",
    );
  });

  it("falls back to the agent's status", () => {
    expect(
      resolveHeaderState({
        computer: computer({ state: "running" }),
        agent: agent("working"),
        pendingCount: 0,
      }),
    ).toBe("working");
    expect(
      resolveHeaderState({
        computer: computer({ state: "running" }),
        agent: agent("idle"),
        pendingCount: 0,
      }),
    ).toBe("running");
  });

});

describe("deriveScenario", () => {
  it("uses the agent's signature page", () => {
    expect(deriveScenario("agent-juno")).toBe("research");
    expect(deriveScenario("agent-patch")).toBe("github");
    expect(deriveScenario("agent-ledger")).toBe("sheet");
    expect(deriveScenario("agent-echo")).toBe("docs");
    expect(deriveScenario("agent-scout")).toBe("profile");
    expect(deriveScenario("agent-atlas")).toBe("flights");
  });

  it("prefers a live browser step", () => {
    const step: Step = {
      id: "step-1",
      runId: "run-1",
      index: 0,
      kind: "browser",
      verb: "Opened",
      target: "github.com",
      status: "running",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      input: { url: "https://github.com/acme/agent-desktop/pull/1" },
    };
    expect(deriveScenario("agent-juno", step)).toBe("github");
  });

  it("keeps the signature page when a generic shell step is on screen", () => {
    const step: Step = {
      id: "step-2",
      runId: "run-1",
      index: 1,
      kind: "shell",
      verb: "Ran",
      target: "npm test",
      status: "running",
      startedAt: new Date().toISOString(),
      durationMs: 0,
    };
    // A generic step maps to "code"; it must not push Juno off her Firecracker docs page.
    expect(deriveScenario("agent-juno", step)).toBe("research");
    // …but an agent with no signature page still shows the generic page.
    expect(deriveScenario("agent-unknown", step)).toBe("code");
  });

  it("does not read a *.github.io docs host as a PR", () => {
    const step: Step = {
      id: "step-3",
      runId: "run-1",
      index: 0,
      kind: "browser",
      verb: "Opened",
      target: "firecracker-microvm.github.io",
      status: "running",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      input: { url: "https://firecracker-microvm.github.io/docs" },
    };
    expect(deriveScenario("agent-juno", step)).toBe("research");
  });

  it("falls back to desktop for unknown agents", () => {
    expect(deriveScenario("agent-unknown")).toBe("desktop");
  });
});

describe("mode predicates", () => {
  it("only control captures input", () => {
    expect(modeIsInteractive("control")).toBe(true);
    for (const mode of ["watch", "signin", "teach", "needs-you", "asleep"] as const) {
      expect(modeIsInteractive(mode)).toBe(false);
    }
  });

  it("signin pauses the model", () => {
    expect(modePausesModel("signin")).toBe(true);
    expect(modePausesModel("watch")).toBe(false);
  });
});

describe("screenStreamUrl", () => {
  it("reads an optional streamUrl defensively", () => {
    expect(screenStreamUrl(undefined)).toBeUndefined();
    expect(screenStreamUrl(computer({ id: "c1" }))).toBeUndefined();
    // A future `streamUrl` on Computer is read without a schema change.
    const withStream = { ...computer({ id: "c1" }), streamUrl: "wss://x/ws" };
    expect(screenStreamUrl(withStream)).toBe("wss://x/ws");
  });
});

describe("resolveScreenPresence", () => {
  it("maps the screen lifecycle to honest presence", () => {
    expect(resolveScreenPresence(null)).toBe("missing");
    expect(resolveScreenPresence(undefined)).toBe("missing");
    expect(resolveScreenPresence({ state: "live" })).toBe("ready");
    expect(resolveScreenPresence({ state: "starting" })).toBe("starting");
    expect(resolveScreenPresence({ state: "error" })).toBe("error");
    expect(resolveScreenPresence({ state: "asleep" })).toBe("asleep");
    expect(resolveScreenPresence({ state: "stopped" })).toBe("asleep");
  });
});

describe("resolveComputerState", () => {
  it("returns computer state", () => {
    const c = computer({ state: "running" });
    const result = resolveComputerState(c);
    expect(result?.computer).toBe(c);
    expect(result?.state).toBe("running");
    expect(result?.missing).toBe(false);
  });

  it("returns undefined for no computer", () => {
    expect(resolveComputerState(undefined)).toBeUndefined();
  });
});

describe("resolveAgentComputer", () => {
  it("finds the shared computer whose agentIds include the agent", () => {
    const shared = computer({ id: "computer-shared", agentIds: ["agent-juno", "agent-patch"] });
    expect(resolveAgentComputer([shared], "agent-patch")).toBe(shared);
    expect(resolveAgentComputer([shared], "agent-juno")).toBe(shared);
  });

  it("returns undefined when agent not found", () => {
    const shared = computer({ agentIds: ["agent-juno"] });
    expect(resolveAgentComputer([shared], "agent-unknown")).toBeUndefined();
  });

  it("returns undefined for empty list or no agentId", () => {
    const shared = computer({ agentIds: ["agent-juno"] });
    expect(resolveAgentComputer([], "agent-juno")).toBeUndefined();
    expect(resolveAgentComputer([shared], undefined)).toBeUndefined();
    expect(resolveAgentComputer(undefined, "agent-juno")).toBeUndefined();
  });

  it("finds a shared computer whose agentIds is empty", () => {
    const unlisted = computer({ agentIds: [] });
    expect(resolveAgentComputer([unlisted], "agent-juno")).toBe(unlisted);
  });
});
