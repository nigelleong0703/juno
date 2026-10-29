import type { AgentCalendarItem, Routine } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { TooltipProvider } from "@agent-desktop/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { AutomationCalendar } from "../AutomationCalendar";
import { MAX_OCCURRENCES, calendarBlocks, expandRoutine } from "../occurrences";

function calendarItem(id: string, status: AgentCalendarItem["status"], at: string): AgentCalendarItem {
  return {
    id,
    agentId: "agent-juno",
    ownerId: "owner",
    kind: "follow_up",
    title: `Item ${id}`,
    at,
    timezone: "UTC",
    instructions: "",
    status,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date("2026-10-21T10:00:00.000Z"); // a Wednesday

function routine(cron: string, tz = "UTC", extra: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    agentId: "agent-juno",
    name: "Brief",
    instructions: "",
    trigger: { kind: "schedule", cron, human: cron, tz },
    delivery: { channel: "chat" },
    notify: { mode: "always" },
    enabled: true,
    status: "active",
    runs: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

describe("expandRoutine", () => {
  it("converts the cron from its own timezone", () => {
    const { occurrences } = expandRoutine(routine("0 9 * * *", "Asia/Tokyo"), NOW, new Date("2026-10-23T00:00:00.000Z"), NOW);
    expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-10-22T00:00:00.000Z"]);
  });

  it("collapses an hourly routine into a dense chip", () => {
    const result = expandRoutine(routine("0 * * * *"), NOW, new Date("2026-10-28T00:00:00.000Z"), NOW);
    expect(result).toEqual({ occurrences: [], dense: true });
  });

  it("caps expansion per range", () => {
    const { occurrences, dense } = expandRoutine(routine("0 0,4,8,12,16,20 * * *"), NOW, new Date("2027-01-21T00:00:00.000Z"), NOW);
    expect(dense).toBe(false);
    expect(occurrences).toHaveLength(MAX_OCCURRENCES);
  });

  it("takes the past from run history", () => {
    const run = { id: "run1", routineId: "r1", status: "failed" as const, summary: "x", startedAt: "2026-10-20T09:00:00.000Z" };
    const { occurrences } = expandRoutine(routine("0 9 * * *", "UTC", { runs: [run] }), new Date("2026-10-19T00:00:00.000Z"), new Date("2026-10-23T00:00:00.000Z"), NOW);
    expect(occurrences.filter((o) => o.past).map((o) => o.run?.status)).toEqual(["failed"]);
    expect(occurrences.filter((o) => !o.past)).toHaveLength(1);
  });

  it("does not draw a skipped entry as a run: it is a note about occurrences that never ran", () => {
    const skipped = { id: "skip", routineId: "r1", status: "skipped" as const, summary: "Skipped: missed while offline (2 runs)", startedAt: "2026-10-20T09:00:00.000Z" };
    const { occurrences } = expandRoutine(routine("0 9 * * *", "UTC", { runs: [skipped] }), new Date("2026-10-19T00:00:00.000Z"), new Date("2026-10-23T00:00:00.000Z"), NOW);
    expect(occurrences.filter((o) => o.past)).toEqual([]);
  });
});

describe("calendarBlocks", () => {
  it("hides cancelled items, flags missed ones and keeps only the range", () => {
    const from = new Date("2026-10-19T00:00:00.000Z");
    const to = new Date("2026-10-26T00:00:00.000Z");
    const blocks = calendarBlocks(
      [
        calendarItem("late", "scheduled", "2026-10-22T09:00:00.000Z"),
        calendarItem("gone", "cancelled", "2026-10-21T09:00:00.000Z"),
        calendarItem("miss", "missed", "2026-10-20T09:00:00.000Z"),
        calendarItem("out", "scheduled", "2026-11-20T09:00:00.000Z"),
      ],
      from,
      to,
    );
    expect(blocks.map((b) => [b.item.id, b.missed])).toEqual([["miss", true], ["late", false]]);
  });
});

function renderCalendar(items: AgentCalendarItem[], routines: Routine[] = []) {
  const client = createMockClient();
  vi.spyOn(client.calendar, "list").mockResolvedValue({ items });
  return render(
    <ClientProvider client={client} platform={webPlatform}>
      <TooltipProvider>
        <AutomationCalendar routines={routines} agents={[]} onOpen={() => {}} onSlot={() => {}} />
      </TooltipProvider>
    </ClientProvider>,
  );
}

describe("AutomationCalendar", () => {
  it("draws the agents' calendar items, leaving out cancelled ones, and flags missed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const noon = (day: number) => new Date(2026, 9, day, 12).toISOString(); // Oct 21 is the Wednesday in view
    renderCalendar([calendarItem("a", "scheduled", noon(21)), calendarItem("b", "cancelled", noon(21)), calendarItem("c", "missed", noon(22))]);
    await waitFor(() => expect(screen.getByText("Item a")).toBeTruthy());
    expect(screen.queryByText("Item b")).toBeNull();
    expect(screen.getByText("Item c")).toBeTruthy();
    expect(screen.getByText("Missed")).toBeTruthy();
  });

  it("shows a weekly routine on its weekday", () => {
    // Friday 09:00 in the viewer's own timezone, so the day column is the same everywhere.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    {
      const { container } = renderCalendar([], [routine("0 9 * * 5", tz)]);
      const columns = [...container.querySelectorAll<HTMLElement>("[data-testid^='day-']")];
      const withBlock = columns.filter((column) => within(column).queryByText("Brief"));
      expect(withBlock).toHaveLength(1);
      expect(columns.indexOf(withBlock[0] as HTMLElement)).toBe(4); // Mon..Sun -> Friday
    }
  });
});
