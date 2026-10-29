import { vi } from "vitest";

// jsdom has no WebSocket, and noVNC's RFB would attempt one the moment a live screen mounts. The
// computer surface still fetches a real ticket for every live screen; this inert stand-in only
// keeps the transport out of unit tests, without stubbing any product logic.
vi.mock("@novnc/novnc", () => {
  class FakeRfb {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    clipViewport = false;
    background = "";
    constructor(public target: HTMLElement, public url: string) {}
    disconnect(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  return { default: FakeRfb };
});

// jsdom has no object URLs. File previews create one after their bytes load, which can land after a test has
// finished and restored its own stub; an inert default keeps that late effect from failing the whole run.
if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:jsdom";
if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};
