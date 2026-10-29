import type { AgentEvent, Computer, MacStatus, ScreenResponse } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "../keys";
import { applyEvent } from "../liveSync";

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
});

const SINCE = "2026-10-29T10:00:00.000Z";

const screenChange = (screenId: string, holder: "agent" | "user", epoch: number): AgentEvent => ({
  type: "control.changed",
  ownerId: "owner-a",
  surface: { kind: "screen", screenId },
  holder,
  epoch,
  since: SINCE,
  phase: holder === "user" ? "taken" : "returned",
});

async function seedScreen(): Promise<{ computer: Computer; screen: ScreenResponse }> {
  const client = createMockClient({ seed: 5 });
  const computer = (await client.computers.list()).items[0] as Computer;
  const screen = await client.computers.allocateScreen(computer.id, computer.agentIds[0] as string);
  qc.setQueryData(qk.computer(computer.id), computer);
  qc.setQueryData(qk.computers(), [computer]);
  qc.setQueryData(qk.screen(computer.id, screen.agentId), screen);
  qc.setQueryData(qk.screens(computer.id), [screen]);
  return { computer, screen };
}

describe("control.changed", () => {
  it("puts the new holder and epoch into every cached copy of the screen, so the open pane flips at once", async () => {
    const { computer, screen } = await seedScreen();
    applyEvent(qc, screenChange(screen.id, "user", screen.controlEpoch + 1));

    const fetched = qc.getQueryData<ScreenResponse>(qk.screen(computer.id, screen.agentId));
    expect(fetched).toMatchObject({ controller: "user", controlEpoch: screen.controlEpoch + 1, controllerSince: SINCE });
    expect(qc.getQueryData<ScreenResponse[]>(qk.screens(computer.id))?.[0]?.controller).toBe("user");
    expect(qc.getQueryData<Computer>(qk.computer(computer.id))?.screens?.find((entry) => entry.id === screen.id)?.controller).toBe("user");
    expect(qc.getQueryData<Computer[]>(qk.computers())?.[0]?.screens?.find((entry) => entry.id === screen.id)?.controller).toBe("user");
  });

  it("ignores an event older than the epoch already known (a replay) and one for another screen", async () => {
    const { computer, screen } = await seedScreen();
    applyEvent(qc, screenChange(screen.id, "user", 5));
    applyEvent(qc, screenChange(screen.id, "agent", 4));
    applyEvent(qc, screenChange("another-screen", "agent", 9));
    expect(qc.getQueryData<ScreenResponse>(qk.screen(computer.id, screen.agentId))).toMatchObject({ controller: "user", controlEpoch: 5 });
    applyEvent(qc, screenChange(screen.id, "agent", 6));
    expect(qc.getQueryData<ScreenResponse>(qk.screen(computer.id, screen.agentId))).toMatchObject({ controller: "agent", controlEpoch: 6 });
  });

  it("marks the Mac stopped until the Mac itself resumes it", () => {
    const status: MacStatus = { paired: true, online: true };
    qc.setQueryData(qk.myMac(), status);
    const macEvent = (holder: "stopped" | "agent", epoch: number): AgentEvent => ({
      type: "control.changed",
      ownerId: "owner-a",
      surface: { kind: "mac", macId: "mac-a" },
      holder,
      epoch,
      since: SINCE,
      phase: holder === "stopped" ? "stopped" : "resumed",
    });
    applyEvent(qc, macEvent("stopped", 2));
    expect(qc.getQueryData<MacStatus>(qk.myMac())?.stopped).toEqual({ since: SINCE, epoch: 2 });
    // A replay of an older resume does not lift a newer stop.
    applyEvent(qc, macEvent("stopped", 4));
    applyEvent(qc, macEvent("agent", 3));
    expect(qc.getQueryData<MacStatus>(qk.myMac())?.stopped).toEqual({ since: SINCE, epoch: 4 });
    applyEvent(qc, macEvent("agent", 5));
    expect(qc.getQueryData<MacStatus>(qk.myMac())?.stopped).toBeUndefined();
  });
});
