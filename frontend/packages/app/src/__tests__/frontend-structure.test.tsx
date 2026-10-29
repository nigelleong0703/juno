import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewAgentTemplateDialog } from "../features/new-agent/NewAgentTemplateDialog";
import * as productionEntry from "../index";
import { t } from "../lib/i18n";

// vitest runs without globals, so testing-library's automatic cleanup is not registered.
afterEach(cleanup);

describe("frontend module boundaries", () => {
  it("keeps the removed dev/demo harness out of the production entry", () => {
    expect(Object.hasOwn(productionEntry, "ComputerPaneDevPage")).toBe(false);
    expect(Object.hasOwn(productionEntry, "MockDesktop")).toBe(false);
  });

  it("creates an agent from the chosen template", () => {
    const onSubmit = vi.fn();
    render(<NewAgentTemplateDialog open onOpenChange={() => {}} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText("Engineering & PRs"));
    fireEvent.click(screen.getByRole("button", { name: t("newAgent.fromTemplate") }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Patch",
      title: "Engineering & PRs",
      personality: expect.stringMatching(/\S/),
      instructions: expect.stringMatching(/\S/),
      templateSlug: "engineering-pr",
    });
  });
});
