import { ThemeProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeFirstAgent } from "../ComposeFirstAgent";
import { FIRST_AGENT_COPY } from "../firstAgentCopy";
import { PlatformIntro } from "../PlatformIntro";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderIntro(onComplete: () => void = () => {}) {
  return render(
    <ThemeProvider defaultTheme="light">
      <PlatformIntro onComplete={onComplete} />
    </ThemeProvider>,
  );
}

function renderFirstAgent(overrides: Partial<ComponentProps<typeof ComposeFirstAgent>> = {}) {
  const props = {
    name: "",
    onNameChange: () => {},
    creating: false,
    onCreate: () => {},
    ...overrides,
  };
  return render(
    <ThemeProvider defaultTheme="light">
      <ComposeFirstAgent {...props} />
    </ThemeProvider>,
  );
}

describe("PlatformIntro scenes", () => {

  it("advances through all three scenes with Next and back with Back", () => {
    renderIntro();
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introNext));
    expect(screen.getByText(FIRST_AGENT_COPY.introScene2Title)).toBeTruthy();
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introNext));
    expect(screen.getByText(FIRST_AGENT_COPY.introScene3Title)).toBeTruthy();
    expect(screen.getByText(FIRST_AGENT_COPY.introScene3Note)).toBeTruthy();
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introBack));
    expect(screen.getByText(FIRST_AGENT_COPY.introScene2Title)).toBeTruthy();
  });

  it("jumps directly via scene dots", () => {
    renderIntro();
    fireEvent.click(screen.getByLabelText(FIRST_AGENT_COPY.introGoToScene + " 3"));
    expect(screen.getByText(FIRST_AGENT_COPY.introScene3Title)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(FIRST_AGENT_COPY.introGoToScene + " 1"));
    expect(screen.getByText(FIRST_AGENT_COPY.introScene1Title)).toBeTruthy();
  });

  it("supports ArrowRight and ArrowLeft keyboard navigation", () => {
    renderIntro();
    const root = document.querySelector('[data-slot="platform-intro"]');
    if (root === null) throw new Error("missing platform intro root");
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(screen.getByText(FIRST_AGENT_COPY.introScene2Title)).toBeTruthy();
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(screen.getByText(FIRST_AGENT_COPY.introScene1Title)).toBeTruthy();
  });

  it("never completes from Next alone; skip and start both complete", () => {
    const onComplete = vi.fn();
    renderIntro(onComplete);
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introNext));
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introSkip));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("start on the last scene completes", () => {
    const onComplete = vi.fn();
    renderIntro(onComplete);
    fireEvent.click(screen.getByLabelText(FIRST_AGENT_COPY.introGoToScene + " 3"));
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introStart));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("ComposeFirstAgent with intro", () => {
  it("shows the intro first, then the naming form after skip", () => {
    renderFirstAgent();
    expect(screen.getByText(FIRST_AGENT_COPY.introScene1Title)).toBeTruthy();
    expect(screen.queryByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel)).toBeNull();
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introSkip));
    expect(screen.getByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel)).toBeTruthy();
    expect(screen.queryByText(FIRST_AGENT_COPY.introScene1Title)).toBeNull();
  });

  it("preserves name editing, create action and Enter submit", () => {
    const onNameChange = vi.fn();
    const onCreate = vi.fn();
    renderFirstAgent({ onNameChange, onCreate });
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.introSkip));
    const input = screen.getByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    fireEvent.change(input, { target: { value: "Juno" } });
    expect(onNameChange).toHaveBeenCalledWith("Juno");
    fireEvent.click(screen.getByText(FIRST_AGENT_COPY.firstAgentCreate));
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

});
