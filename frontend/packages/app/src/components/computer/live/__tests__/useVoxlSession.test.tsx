import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LiveScreenTarget } from "../../types";
import { useVoxlSession } from "../useVoxlSession";

const target = (id: string, control: boolean): LiveScreenTarget => ({
  url: `wss://api/${id}`,
  voxlUrl: `https://screen.example/s/${id}/`,
  control,
});

describe("useVoxlSession", () => {
  it("keeps the running page when a refreshed ticket arrives for the same session", () => {
    const { result, rerender } = renderHook(({ t }) => useVoxlSession(t), {
      initialProps: { t: target("a", false) },
    });
    expect(result.current.src).toBe("https://screen.example/s/a/");
    rerender({ t: target("b", false) });
    expect(result.current.src).toBe("https://screen.example/s/a/");
    expect(result.current.attempt).toBe(0);
  });

  it("re-points onto the fresh ticket after take-over and after hand-back", () => {
    const { result, rerender } = renderHook(({ t }) => useVoxlSession(t), {
      initialProps: { t: target("ro", false) },
    });
    rerender({ t: target("rw", true) });
    expect(result.current).toMatchObject({ src: "https://screen.example/s/rw/", attempt: 1 });
    rerender({ t: target("ro2", false) });
    expect(result.current).toMatchObject({ src: "https://screen.example/s/ro2/", attempt: 2 });
  });

  it("reload swaps the page for a fresh ticket and remounts the frame", () => {
    const { result } = renderHook(() => useVoxlSession(target("a", true)));
    act(() => result.current.reload("https://screen.example/s/fresh/"));
    expect(result.current).toMatchObject({ src: "https://screen.example/s/fresh/", attempt: 1 });
  });
});
