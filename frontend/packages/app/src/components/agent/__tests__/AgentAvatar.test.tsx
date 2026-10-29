import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "../AgentAvatar";
import { CHARACTERS } from "../../../characters";
import { defaultCharacter } from "../../../lib/avatars";

// vitest runs without globals, so testing-library's automatic cleanup is not registered.
afterEach(cleanup);

function poster(container: HTMLElement): string | null {
  return container.querySelector("img")?.getAttribute("src") ?? null;
}

describe("AgentAvatar characters", () => {

  it("without a saved character picks a stable one from the agent id", () => {
    const { container } = render(<AgentAvatar agentId="agent-b" size={40} />);
    expect(poster(container)).toBe(CHARACTERS[defaultCharacter("agent-b")].poster);
    expect(defaultCharacter("agent-b")).toBe(defaultCharacter("agent-b"));
  });

  it("never renders a generated svg portrait", () => {
    const { container } = render(<AgentAvatar agentId="agent-c" size={40} />);
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeNull();
  });
});
