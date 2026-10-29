import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markOnboardingSeen, shouldShowOnboarding } from "../../lib/settingsStore";
import { OnboardingView, onboardingFinish } from "../onboarding/Onboarding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
// Node 26 leaves window.localStorage unavailable under jsdom; back it with an in-memory store.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
});

describe("onboarding finish choice", () => {
  it("web: Get started; desktop: connect to a server", () => {
    const click = vi.fn();
    const web = onboardingFinish(false, click);
    expect(web.label).toBe("Get started");
    web.onClick();
    expect(click).toHaveBeenCalled();
    expect(onboardingFinish(true, click).label).toBe("Connect to a Juno server");
  });
});

describe("onboarding seen gate", () => {
  it("shows once, and never to an install that already saved a server", () => {
    expect(shouldShowOnboarding()).toBe(true);
    markOnboardingSeen();
    expect(shouldShowOnboarding()).toBe(false);
  });

  it("does not show to an install that already saved a server", () => {
    window.localStorage.setItem("agent-desktop-server-url", "https://juno.example");
    expect(shouldShowOnboarding()).toBe(false);
  });
});

describe("onboarding pages", () => {
  it("walks three pages with Continue and arrow keys, and the last page offers the finish", () => {
    render(<OnboardingView finish={onboardingFinish(true, vi.fn())} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "You stay in control" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect to a Juno server" })).toBeDefined();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("Skip jumps to the last page", () => {
    render(<OnboardingView finish={onboardingFinish(true, vi.fn())} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("button", { name: "Connect to a Juno server" })).toBeDefined();
  });
});
