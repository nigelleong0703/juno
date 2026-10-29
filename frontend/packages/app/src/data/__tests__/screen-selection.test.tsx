import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSelectedScreenAgent } from "../screens";

// GH5: the public computer projection omits embedded screens (they are fetched separately
// via useComputerScreens), so an explicit group-member pick must survive without
// `computer.screens`. The member selector already restricts the override to members.
describe("useSelectedScreenAgent", () => {
  it("honors the explicit override without computer.screens and falls back to the agent in view", () => {
    const computerWithoutScreens = {};
    const { result, rerender } = renderHook(
      ({ override }: { override?: string }) =>
        useSelectedScreenAgent(computerWithoutScreens, "agent-a", override),
      { initialProps: { override: undefined as string | undefined } },
    );

    expect(result.current).toBe("agent-a");

    rerender({ override: "agent-b" });
    expect(result.current).toBe("agent-b");

    rerender({ override: "" });
    expect(result.current).toBe("agent-a");

    rerender({ override: undefined });
    expect(result.current).toBe("agent-a");
  });

  it("honors the explicit override when computer is undefined", () => {
    const { result } = renderHook(() => useSelectedScreenAgent(undefined, "agent-a", "agent-b"));
    expect(result.current).toBe("agent-b");
  });
});
