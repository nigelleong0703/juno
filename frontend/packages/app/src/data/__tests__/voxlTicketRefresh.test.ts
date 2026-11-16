import { describe, expect, it } from "vitest";
import { voxlTicketRefreshDelay } from "../screens";

const now = Date.parse("2026-11-05T10:00:00.000Z");
const at = (secondsFromNow: number) => new Date(now + secondsFromNow * 1000).toISOString();

describe("voxlTicketRefreshDelay", () => {
  it("renews a voxl ticket a minute before it expires", () => {
    expect(voxlTicketRefreshDelay({ voxlUrl: "https://s/s/t/", expiresAt: at(300) }, now)).toBe(240_000);
  });

  it("never spins on an already-expired or about-to-expire ticket", () => {
    expect(voxlTicketRefreshDelay({ voxlUrl: "https://s/s/t/", expiresAt: at(20) }, now)).toBe(10_000);
    expect(voxlTicketRefreshDelay({ voxlUrl: "https://s/s/t/", expiresAt: at(-5) }, now)).toBe(10_000);
  });

  it("does not poll noVNC tickets (a refetch would reconnect the stream and wake an idle VM)", () => {
    expect(voxlTicketRefreshDelay({ expiresAt: at(300) }, now)).toBe(false);
    expect(voxlTicketRefreshDelay(undefined, now)).toBe(false);
  });
});
