import type { Routine } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApps, stubResizeObserver } from "../../apps/__tests__/appsTestKit";
import { RoutineEditor } from "../RoutineSheet";

stubResizeObserver();
afterEach(cleanup);

describe("routine history", () => {
  it("shows what was skipped while the server was offline as a quiet entry, not as a run that happened", async () => {
    const client = createMockClient({ seed: 5 });
    const [first] = (await client.routines.list()).items;
    const skipped = "Skipped: missed while offline (3 runs, the latest due 2026-10-28 08:00 UTC)";
    const routine: Routine = {
      ...(first as Routine),
      runs: [
        { id: "rr-skip", routineId: (first as Routine).id, status: "skipped", summary: skipped, startedAt: "2026-10-28T09:00:00.000Z", finishedAt: "2026-10-28T09:00:00.000Z" },
        { id: "rr-ok", routineId: (first as Routine).id, status: "completed", summary: "Sent the brief", startedAt: "2026-10-27T08:00:00.000Z" },
      ],
    };
    renderApps(client, "/routines/r", <RoutineEditor routine={routine} />);
    const skippedRow = (await screen.findByText(skipped)).closest("li") as HTMLElement;
    const doneRow = screen.getByText("Sent the brief").closest("li") as HTMLElement;
    expect(skippedRow.querySelector("span")?.className).toContain("bg-fg-subtle");
    expect(doneRow.querySelector("span")?.className).toContain("bg-success");
  });
});
